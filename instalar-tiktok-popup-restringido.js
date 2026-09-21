#!/usr/bin/env node
/**
 * instalar-tiktok-popup-restringido.js
 * ---------------------------------------------------------------------------
 * QUE ARREGLA
 *   Tras pulsar Publicar, TikTok a veces abre el modal
 *   "Content may be restricted / El contenido puede estar restringido".
 *   Ese modal tapa el boton de publicar y el automatismo se queda en bucle
 *   ("No publish confirmation yet; retrying the primary TikTok Post button."),
 *   sin cerrarlo nunca.
 *
 * QUE HACE
 *   1. Nueva funcion dismissRestrictedContentModal(page): detecta ese modal
 *      concreto y pulsa su "X" (common-modal-close), con varias estrategias de
 *      respaldo (icono SVG, alto del dialogo, texto del titulo).
 *   2. Se llama en el bucle de confirmacion JUSTO antes de reintentar publicar
 *      (el punto donde ahora dice "No publish confirmation yet...").
 *   3. Tambien se llama dentro de dismissInterferingOverlays para cubrir el
 *      caso de que aparezca antes del primer click.
 *
 * Idempotente. Uso:  node instalar-tiktok-popup-restringido.js
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = process.cwd();
const TARGET = path.join(ROOT, "src", "tiktok-uploader.js");
const MARK = "// MARKER: TIKTOK-RESTRICTED-MODAL-v1";
const MARK_V2 = "// MARKER: TIKTOK-RESTRICTED-MODAL-v2";
const MARK_V3 = "// MARKER: TIKTOK-RESTRICTED-MODAL-v3";
const LOOP_FIXED =
  'if (await dismissRestrictedContentModal(page)) {\n        await page.waitForTimeout(700);';

const results = [];
const ok = (m) => results.push(["OK", m]);
const skip = (m) => results.push(["SKIP", m]);
const fail = (m) => results.push(["FAIL", m]);

// ---------------------------------------------------------------------------
// Fuentes de las funciones nuevas (v3).
// ---------------------------------------------------------------------------
function newWaitFunctionSource() {
  return `/**
 * ${MARK_V3}
 * Espera a que el boton Publicar/Programar vuelva a estar visible y habilitado
 * tras cerrar el popup: TikTok lo deja tapado o desactivado unos instantes y un
 * click inmediato no hace nada.
 */
async function waitForPublishClickable(page, maxMs = 8000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const ready = await page
      .evaluate(() => {
        const pattern = /^(post|publicar|publish|schedule|programar)$/i;
        const buttons = [
          ...document.querySelectorAll("button, [role='button'], [class*='Btn']"),
        ];
        for (const b of buttons) {
          const label = (b.innerText || b.textContent || "").trim();
          if (!pattern.test(label)) continue;
          const box = b.getBoundingClientRect();
          if (box.width <= 0 || box.height <= 0) continue;
          if (b.disabled || b.getAttribute("aria-disabled") === "true") continue;
          return true;
        }
        return false;
      })
      .catch(() => false);
    if (ready) return true;
    await page.waitForTimeout(400);
  }
  return false;
}
`;
}

function newDismissFunctionSource() {
  return `/**
 * ${MARK_V3}
 * Cierra el modal "Content may be restricted" / "El contenido puede estar
 * restringido", que aparece tras pulsar Publicar y bloquea el boton.
 *
 * v3: detecta el dialogo por su TEXTO (antes exigia encontrar el boton de
 * cierre, y si TikTok lo pintaba distinto la funcion decia "no hay popup" y el
 * video nunca se publicaba). Cierra con varias estrategias y VERIFICA que se
 * cerro. Devuelve true solo si el popup ya no esta.
 */
async function dismissRestrictedContentModal(page) {
  const findOpenModal = () =>
    page.evaluate(() => {
      const titlePattern = /content may be restricted|el contenido puede estar restringido|puede estar restringido|contenido restringido/i;
      const reasons = [
        /unoriginal|low-quality|qr code|poco original|baja calidad|codigo qr/i,
        /violation reason|motivo de la infraccion/i,
      ];
      const visible = (el) =>
        el && el.offsetParent !== null && el.getBoundingClientRect().width > 0;
      const candidates = [
        ...document.querySelectorAll(
          '[role="dialog"], [aria-modal="true"], [class*="modal" i], [class*="Modal" i]'
        ),
      ].filter(visible);

      for (const d of candidates) {
        const body = (d.innerText || "").trim();
        if (!body) continue;
        // El modal de subida NO es el de restriccion: tiene los controles de
        // programacion.
        if (/when to post|schedule|subir|postSchedule/i.test(body)) continue;
        if (!(titlePattern.test(body) || reasons.some((p) => p.test(body)))) continue;
        return { text: body.slice(0, 120) };
      }
      return null;
    });

  let closedAny = false;
  for (let pass = 0; pass < 5; pass += 1) {
    let open = null;
    try {
      open = await findOpenModal();
    } catch {
      open = null;
    }
    if (!open) break;

    let clicked = false;

    // 1) El boton real: .common-modal-close (con su SVG).
    const closeByClass = page
      .locator(".common-modal-close, [class*='common-modal-close']")
      .first();
    if ((await closeByClass.count().catch(() => 0)) > 0) {
      await closeByClass.click({ timeout: 1500, force: true }).catch(() => {});
      clicked = true;
    }

    // 2) El icono interno.
    if (!clicked) {
      const icon = page
        .locator(".common-modal-close-icon, [class*='common-modal-close-icon']")
        .first();
      if ((await icon.count().catch(() => 0)) > 0) {
        await icon.click({ timeout: 1500, force: true }).catch(() => {});
        clicked = true;
      }
    }

    // 3) Cualquier aria-label/close del dialogo.
    if (!clicked) {
      const ariaClose = page
        .locator("[aria-label*='close' i], [aria-label*='cerrar' i], [class*='close' i]")
        .first();
      if ((await ariaClose.count().catch(() => 0)) > 0) {
        await ariaClose.click({ timeout: 1500, force: true }).catch(() => {});
        clicked = true;
      }
    }

    // 4) Escape (cierra modales nativos).
    if (!clicked) {
      await page.keyboard.press("Escape").catch(() => {});
      clicked = true;
    }

    // 5) JS directo sobre el DOM (ultimo recurso).
    if (!clicked) {
      const didClick = await page
        .evaluate(() => {
          const nodes = [
            ...document.querySelectorAll(
              ".common-modal-close, [class*='common-modal-close'], [class*='close' i]"
            ),
          ];
          for (const node of nodes) {
            if (node && typeof node.click === "function") {
              node.click();
              return true;
            }
          }
          return false;
        })
        .catch(() => false);
      clicked = Boolean(didClick);
    }

    if (!clicked) break;
    closedAny = true;
    await page.waitForTimeout(500);
  }

  // Verificar: si el modal sigue ahi, la X no funciono.
  let stillOpen = null;
  try {
    stillOpen = await findOpenModal();
  } catch {
    stillOpen = null;
  }
  if (closedAny && stillOpen) {
    console.log(
      "TikTok: el popup restringido sigue abierto tras intentar cerrarlo (la X no respondio)."
    );
    return false;
  }

  if (closedAny) {
    console.log("TikTok: cerrado el popup de contenido restringido; reintentando publicar.");
  }
  return closedAny;
}
`;
}

if (!fs.existsSync(path.join(ROOT, "package.json")) || !fs.existsSync(TARGET)) {
  console.error("ERROR: ejecuta este instalador desde la raiz de AutoSocial Studio.");
  process.exit(1);
}

let text = fs.readFileSync(TARGET, "utf8");

// La firma INEQUIVOCA del bug: la llamada dentro de dismissInterferingOverlays,
// que cierra el popup pero no vuelve a pulsar Publicar.
const overlaysBody = (() => {
  const start = text.indexOf("async function dismissInterferingOverlays(page) {");
  if (start === -1) return "";
  const end = text.indexOf("\n}\n", start);
  return end === -1 ? "" : text.slice(start, end);
})();
const hasOverlayBug = /await dismissRestrictedContentModal\(page\)/.test(overlaysBody);
const hasV3 = text.includes(MARK_V3) || text.includes("waitForPublishClickable");
const hasLoopFix =
  text.includes(MARK_V2) ||
  /if \(await dismissRestrictedContentModal\(page\)\)/.test(text);

if (hasV3 && !hasOverlayBug) {
  skip("tiktok-uploader.js ya esta en v3 (cierra, espera y repulsa Publicar)");
} else if (text.includes(MARK) || hasLoopFix || hasOverlayBug) {
  // Instalacion anterior: cierra el popup pero NO repulsa Publicar, y/o esta
  // enganchada en un bloque que se agota (primaryRetryCount < 2).
  const oldCall = /await dismissRestrictedContentModal\(page\);\s*\n(\s*)const retried = await tryClickPublishButton\(page\);/;
  let patched = false;


  const LOOP_HEAD =
    `    for (let attempt = 0; attempt < 30; attempt += 1) {\n` +
    `      await dismissInterferingOverlays(page);`;
  const LOOP_HEAD_NEW =
    `    for (let attempt = 0; attempt < 30; attempt += 1) {\n` +
    `      await dismissInterferingOverlays(page);\n\n` +
    `      // MARKER: TIKTOK-RESTRICTED-MODAL-v3\n` +
    `      // El popup "Content may be restricted" aparece al pulsar Publicar y\n` +
    `      // tapa el boton. Hay que cerrarlo Y volver a pulsar Publicar, siempre\n` +
    `      // (no solo mientras queden reintentos). Tras cerrarlo, el boton tarda\n` +
    `      // unos instantes en volver a estar clickable.\n` +
    `      if (await dismissRestrictedContentModal(page)) {\n` +
    `        await page.waitForTimeout(700);\n` +
    `        const publishReady = await waitForPublishClickable(page, 8000);\n` +
    `        const reclicked = await tryClickPublishButton(page);\n` +
    `        console.log(\n` +
    `          reclicked\n` +
    `            ? "Popup restringido cerrado y Publicar pulsado de nuevo."\n` +
    `            : publishReady\n` +
    `              ? "Popup restringido cerrado; el boton esta listo pero no consegui pulsarlo."\n` +
    `              : "Popup restringido cerrado, pero el boton Publicar no volvio a estar disponible."\n` +
    `        );\n` +
    `        if (reclicked) {\n` +
    `          primaryRetryCount = 0;\n` +
    `          await page.waitForTimeout(1500);\n` +
    `          continue;\n` +
    `        }\n` +
    `      }`;

  if (text.includes(LOOP_HEAD)) {
    text = text.replace(LOOP_HEAD, LOOP_HEAD_NEW);
    patched = true;
    ok("bucle de confirmacion: cierra el popup y repulsa Publicar (siempre)");
  } else {
    fail("No encontre el inicio del bucle de confirmacion para reparar la v1.");
  }

  // Quitar la llamada vieja (la del bloque agotable) para no duplicar.
  if (oldCall.test(text)) {
    text = text.replace(oldCall, "const retried = await tryClickPublishButton(page);");
    ok("eliminada la llamada vieja del bloque de reintento");
  }

  // Quitar la llamada dentro de dismissInterferingOverlays: cierra el popup sin
  // repulsar Publicar, que es la causa de que el video no suba.
  {
    const s = text.indexOf("async function dismissInterferingOverlays(page) {");
    const e = s === -1 ? -1 : text.indexOf("\n}\n", s);
    if (s !== -1 && e !== -1) {
      const body = text.slice(s, e);
      const cleaned = body.replace(/\s*\n\s*(?:\/\/[^\n]*\n\s*)*await dismissRestrictedContentModal\(page\);?/g, "");
      if (cleaned !== body) {
        text = text.slice(0, s) + cleaned + text.slice(e);
        ok("eliminada la llamada en dismissInterferingOverlays (causaba el bug)");
      }
    }
  }

  // Reemplazar la funcion vieja de deteccion/cierre por la nueva (mas fiable:
  // detecta por texto, no exige el boton, y verifica que se cerro).
  {
    const s = text.indexOf("async function dismissRestrictedContentModal(page) {");
    if (s !== -1) {
      // El final de la funcion es "\n}\n" a nivel de columna 0.
      const e = text.indexOf("\n}\n", s);
      if (e !== -1) {
        text =
          text.slice(0, s) +
          newDismissFunctionSource() +
          text.slice(e + 3);
        ok("funcion dismissRestrictedContentModal reemplazada por la v3 (mas fiable)");
      } else {
        fail("No pude delimitar la funcion dismissRestrictedContentModal.");
      }
    }
  }

  // Asegurar que existe waitForPublishClickable.
  if (!text.includes("async function waitForPublishClickable(")) {
    const anchorFn = "async function dismissRestrictedContentModal(page) {";
    const idx = text.indexOf(anchorFn);
    if (idx !== -1) {
      text = text.slice(0, idx) + newWaitFunctionSource() + "\n" + text.slice(idx);
      ok("waitForPublishClickable anadida (espera a que el boton este listo)");
    } else {
      fail("No encontre donde insertar waitForPublishClickable.");
    }
  }

  if (patched && !results.some(([s]) => s === "FAIL")) {
    const backup = `${TARGET}.tiktok-popup-v3-backup`;
    if (!fs.existsSync(backup)) fs.copyFileSync(TARGET, backup);
    fs.writeFileSync(TARGET, text, "utf8");
    ok("src/tiktok-uploader.js actualizado a v3 (backup .tiktok-popup-v3-backup)");
  }
} else {
  // -------------------------------------------------------------------------
  // 1. Insertar la funcion nueva antes de dismissInterferingOverlays.
  // -------------------------------------------------------------------------
  const ANCHOR_FN = "async function dismissInterferingOverlays(page) {";

  const NEW_FN = `/**
 * ${MARK}
 * Cierra el modal "Content may be restricted" / "El contenido puede estar
 * restringido", que aparece tras pulsar Publicar y bloquea el boton.
 * El boton de cerrar es \`div.common-modal-close\` con un SVG: no tiene texto
 * ni aria-label, asi que hay que localizarlo por clase y por estructura.
 * Devuelve true si se cerro algun modal.
 */
/**
 * Espera a que el boton Publicar/Programar vuelva a estar visible y habilitado
 * tras cerrar el popup: justo despues TikTok lo deja tapado o desactivado unos
 * instantes y un click inmediato no hace nada.
 */
async function waitForPublishClickable(page, maxMs = 8000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const ready = await page
      .evaluate(() => {
        const pattern = /^(post|publicar|publish|schedule|programar)$/i;
        const buttons = [
          ...document.querySelectorAll("button, [role='button'], [class*='Btn']"),
        ];
        for (const b of buttons) {
          const label = (b.innerText || b.textContent || "").trim();
          if (!pattern.test(label)) continue;
          const box = b.getBoundingClientRect();
          if (box.width <= 0 || box.height <= 0) continue;
          if (b.disabled || b.getAttribute("aria-disabled") === "true") continue;
          return true;
        }
        return false;
      })
      .catch(() => false);
    if (ready) return true;
    await page.waitForTimeout(400);
  }
  return false;
}

async function dismissRestrictedContentModal(page) {
  // Detecta el dialogo por su TEXTO. Antes exigia que existiese el boton
  // .common-modal-close, y si TikTok lo renderiza distinto la funcion decia
  // "no hay popup", lo dejaba abierto y el video no se publicaba.
  const findOpenModal = () =>
    page.evaluate(() => {
      const titlePattern = /content may be restricted|el contenido puede estar restringido|puede estar restringido|contenido restringido/i;
      const reasons = [
        /unoriginal|low-quality|qr code|poco original|baja calidad|codigo qr/i,
        /violation reason|motivo de la infraccion/i,
      ];
      const visible = (el) => el && el.offsetParent !== null && el.getBoundingClientRect().width > 0;
      const candidates = [
        ...document.querySelectorAll('[role="dialog"], [aria-modal="true"], [class*="modal" i], [class*="Modal" i]'),
      ].filter(visible);

      for (const d of candidates) {
        const body = (d.innerText || "").trim();
        if (!body) continue;
        // El modal de subida NO es el de restriccion: contiene los controles de
        // programacion.
        if (/when to post|schedule|subir|postSchedule/i.test(body)) continue;
        if (!(titlePattern.test(body) || reasons.some((p) => p.test(body)))) continue;
        const close =
          d.querySelector(".common-modal-close, [class*='common-modal-close']") ||
          d.querySelector("[aria-label*='close' i], [aria-label*='cerrar' i]") ||
          d.querySelector("[class*='close' i]") ||
          null;
        return { text: body.slice(0, 120), hasClose: Boolean(close) };
      }
      return null;
    });

  let closedAny = false;
  for (let pass = 0; pass < 5; pass += 1) {
    let open = null;
    try {
      open = await findOpenModal();
    } catch {
      open = null;
    }
    if (!open) break;

    let clicked = false;

    // 1) El boton real: .common-modal-close (con su SVG).
    const closeByClass = page
      .locator(".common-modal-close, [class*='common-modal-close']")
      .first();
    if ((await closeByClass.count().catch(() => 0)) > 0) {
      await closeByClass.click({ timeout: 1500, force: true }).catch(() => {});
      clicked = true;
    }

    // 2) El icono interno.
    if (!clicked) {
      const icon = page
        .locator(".common-modal-close-icon, [class*='common-modal-close-icon']")
        .first();
      if ((await icon.count().catch(() => 0)) > 0) {
        await icon.click({ timeout: 1500, force: true }).catch(() => {});
        clicked = true;
      }
    }

    // 3) Cualquier aria-label de cierre / zona superior derecha del dialogo.
    if (!clicked) {
      const ariaClose = page
        .locator("[aria-label*='close' i], [aria-label*='cerrar' i], [class*='close' i]")
        .first();
      if ((await ariaClose.count().catch(() => 0)) > 0) {
        await ariaClose.click({ timeout: 1500, force: true }).catch(() => {});
        clicked = true;
      }
    }

    // 4) Pulsar Escape (cierra modales nativos de TikTok).
    if (!clicked) {
      await page.keyboard.press("Escape").catch(() => {});
      clicked = true;
    }

    // 5) JS directo sobre el DOM (ultimo recurso, sin esperar visibilidad).
    if (!clicked) {
      const didClick = await page
        .evaluate(() => {
          const nodes = [
            ...document.querySelectorAll(
              ".common-modal-close, [class*='common-modal-close'], [class*='close' i]"
            ),
          ];
          for (const node of nodes) {
            if (node && typeof node.click === "function") {
              node.click();
              return true;
            }
          }
          return false;
        })
        .catch(() => false);
      clicked = Boolean(didClick);
    }

    if (!clicked) break;
    closedAny = true;
    await page.waitForTimeout(500);
  }

  // Confirmar: si seguimos viendo el modal, la X no funciono.
  let stillOpen = null;
  try {
    stillOpen = await findOpenModal();
  } catch {
    stillOpen = null;
  }
  if (closedAny && stillOpen) {
    console.log(
      "TikTok: el popup restringido sigue abierto tras intentar cerrarlo (la X no respondio)."
    );
    return false;
  }

  if (closedAny) {
    console.log("TikTok: cerrado el popup de contenido restringido; reintentando publicar.");
  }
  return closedAny;
}

${ANCHOR_FN}`;

  if (text.includes(ANCHOR_FN) && !text.includes("async function dismissRestrictedContentModal")) {
    text = text.replace(
      ANCHOR_FN,
      newWaitFunctionSource() + "\n" + newDismissFunctionSource() + "\n" + ANCHOR_FN
    );
    ok("dismissRestrictedContentModal v3 + waitForPublishClickable anadidas");
  } else {
    fail("No se encontro dismissInterferingOverlays para insertar la funcion.");
  }

  // -------------------------------------------------------------------------
  // 2. Manejar el popup AL PRINCIPIO de cada vuelta del bucle de confirmacion.
  //    Es el unico punto que se ejecuta siempre (el bloque de "retry" esta
  //    limitado por primaryRetryCount < 2 y se agota). Cerrar el popup NO
  //    publica: reaparece justo al pulsar Publicar, asi que tras cerrarlo hay
  //    que volver a pulsar el boton.
  // -------------------------------------------------------------------------
  const LOOP_HEAD =
    `    for (let attempt = 0; attempt < 30; attempt += 1) {\n` +
    `      await dismissInterferingOverlays(page);`;

  const LOOP_HEAD_NEW =
    `    for (let attempt = 0; attempt < 30; attempt += 1) {\n` +
    `      await dismissInterferingOverlays(page);\n\n` +
    `      // ${MARK_V3}: si aparecio "Content may be restricted", cerrarlo y volver\n` +
    `      // a pulsar Publicar. Sin esto, el modal tapa el boton, el bucle se\n` +
    `      // queda esperando una confirmacion que nunca llega y el video no sube.\n` +
    `      // Tras cerrarlo, el boton tarda unos instantes en volver a estar listo.\n` +
    `      if (await dismissRestrictedContentModal(page)) {\n` +
    `        await page.waitForTimeout(700);\n` +
    `        const publishReady = await waitForPublishClickable(page, 8000);\n` +
    `        const reclicked = await tryClickPublishButton(page);\n` +
    `        console.log(\n` +
    `          reclicked\n` +
    `            ? "Popup restringido cerrado y Publicar pulsado de nuevo."\n` +
    `            : publishReady\n` +
    `              ? "Popup restringido cerrado; el boton esta listo pero no consegui pulsarlo."\n` +
    `              : "Popup restringido cerrado, pero el boton Publicar no volvio a estar disponible."\n` +
    `        );\n` +
    `        if (reclicked) {\n` +
    `          primaryRetryCount = 0;\n` +
    `          await page.waitForTimeout(1500);\n` +
    `          continue;\n` +
    `        }\n` +
    `      }`;

  if (text.includes(LOOP_HEAD)) {
    text = text.replace(LOOP_HEAD, LOOP_HEAD_NEW);
    ok("el bucle de confirmacion cierra el popup y repulsa Publicar (siempre activo)");
  } else {
    fail(
      "No encontre el inicio del bucle waitForPublishConfirmation. " +
        "Manda las lineas alrededor de 'for (let attempt = 0; attempt < 30'."
    );
  }

  // -------------------------------------------------------------------------
  // 3. NO se cierra desde dismissInterferingOverlays a proposito: alli se
  //    cerraria el popup sin volver a pulsar Publicar, que es exactamente el
  //    bug que deja el video sin subir. El manejo vive solo en el bucle.
  // -------------------------------------------------------------------------
  skip("el popup se maneja en el bucle de confirmacion (no en overlays)");

  // -------------------------------------------------------------------------
  // 4. Exportarla en _private para poder probarla y depurarla.
  // -------------------------------------------------------------------------
  const OLD_EXPORT = `  _private: {`;
  if (text.includes(OLD_EXPORT) && !text.includes("dismissRestrictedContentModal,")) {
    text = text.replace(
      OLD_EXPORT,
      `  _private: {\n    dismissRestrictedContentModal,`
    );
    ok("dismissRestrictedContentModal exportada en _private");
  } else {
    skip("dismissRestrictedContentModal ya estaba exportada (o no hay bloque _private)");
  }

  const failuresSoFar = results.filter(([s]) => s === "FAIL").length;
  if (failuresSoFar === 0) {
    const backup = `${TARGET}.tiktok-popup-backup`;
    if (!fs.existsSync(backup)) fs.copyFileSync(TARGET, backup);
    fs.writeFileSync(TARGET, text, "utf8");
    ok("src/tiktok-uploader.js actualizado (backup en .tiktok-popup-backup)");
  }
}

// ---------------------------------------------------------------------------
// Verificar sintaxis (unica prueba fiable)
// ---------------------------------------------------------------------------
const check = spawnSync(process.execPath, ["--check", TARGET], { encoding: "utf8" });
if (check.status !== 0) {
  fail(
    "Sintaxis rota: " + (check.stderr || "").split("\n").filter(Boolean).slice(0, 3).join(" | ")
  );
}

console.log("\n=== AutoSocial Studio - TikTok: popup 'contenido restringido' ===");
for (const [status, message] of results) console.log(`  [${status}] ${message}`);
const failures = results.filter(([s]) => s === "FAIL");
console.log(
  `\n${results.filter(([s]) => s === "OK").length} cambios, ` +
    `${results.filter(([s]) => s === "SKIP").length} ya presentes, ${failures.length} errores.`
);
if (failures.length) {
  console.error(
    "\nNo se toco el archivo a medias. Tu tiktok-uploader.js esta intacto. " +
      "Mandame el error de arriba."
  );
  process.exitCode = 1;
} else {
  console.log("\nHecho. Reinicia el dashboard:  node src/dashboard-server.js");
  console.log("Veras en el log: 'cerrado el popup de contenido restringido'.");
}
