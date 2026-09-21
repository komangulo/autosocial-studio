#!/usr/bin/env node
/**
 * instalar-tiktok-fix-total.js
 * ---------------------------------------------------------------------------
 * ARREGLA TODO DE UNA VEZ (idempotente):
 *
 *  A) PROGRAMACION FIABLE: sustituye el "esperar a que procese" por texto
 *     (que da falsos positivos con "Uploading" y bloquea 20 min) por una
 *     espera por ESTADO: el video esta listo cuando aparece "Uploaded" o
 *     desaparece el boton de subida. Ademas, antes de programar comprueba
 *     que el radio "Schedule" quedo activo, y si no, lo activa.
 *
 *  B) NO CERRAR EL NAVEGADOR SI FALLA LA PROGRAMACION: antes el finally
 *     cerraba siempre y no se veia el motivo. Ahora, en modo programacion,
 *     si falla se deja abierto y se guarda captura.
 *
 *  C) UN SOLO NAVEGADOR PARA TODO EL LOTE (uploadVideo acepta page/context
 *     ya abiertos y no los cierra).
 *
 *  D) CIERRA EL POPUP "Content may be restricted" (la X es un div sin texto)
 *     justo antes de reintentar publicar.
 *
 * Uso:  node instalar-tiktok-fix-total.js
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = process.cwd();
const TARGET = path.join(ROOT, "src", "tiktok-uploader.js");

const M_WAIT = "// MARKER: TIKTOK-WAIT-READY-BY-STATE-v2";
const M_KEEP = "// MARKER: TIKTOK-KEEP-BROWSER-ON-SCHEDULE-FAIL-v1";
const M_REUSE = "// MARKER: TIKTOK-REUSE-BROWSER-v1";
const M_MODAL = "// MARKER: TIKTOK-RESTRICTED-MODAL-v1";

const results = [];
const ok = (m) => results.push(["OK", m]);
const skip = (m) => results.push(["SKIP", m]);
const fail = (m) => results.push(["FAIL", m]);

if (!fs.existsSync(path.join(ROOT, "package.json")) || !fs.existsSync(TARGET)) {
  console.error("ERROR: ejecuta este instalador desde la raiz de AutoSocial Studio.");
  process.exit(1);
}

let text = fs.readFileSync(TARGET, "utf8");
const original = text;

function replaceOnce(from, to, okMsg, id) {
  if (text.includes(id)) {
    skip(`${okMsg} (ya aplicado)`);
    return true;
  }
  const idx = text.indexOf(from);
  if (idx === -1) {
    fail(`No encontre el bloque para: ${okMsg}`);
    return false;
  }
  text = text.slice(0, idx) + to + " " + id + text.slice(idx + from.length);
  ok(okMsg);
  return true;
}

// ===========================================================================
// A) waitForVideoProcessing -> espera por ESTADO, no por texto
// ===========================================================================
if (text.includes(M_WAIT)) {
  skip("espera de procesado por estado (ya aplicado)");
} else {
  const fnStart = text.indexOf("async function waitForVideoProcessing(");
  if (fnStart === -1) {
    fail("No encontre waitForVideoProcessing.");
  } else {
    const endIdx = text.indexOf("async function setNativeSchedule(", fnStart);
    if (endIdx === -1) {
      fail("No encontre el final de waitForVideoProcessing.");
    } else {
      const NEWS = `async function waitForVideoProcessing(page, maxMs = 600000) {
  ${M_WAIT}
  // Espera por ESTADO real del editor, no por texto suelto ("uploading" da
  // falsos positivos y bloquea 20 min). Listo cuando:
  //   - aparece "Uploaded" (verde) en la ficha del video, o
  //   - ya no hay barra/aviso de subida activo y el caption existe.
  const isReady = async () => {
    try {
      return await page.evaluate(() => {
        const visible = (el) => el && el.offsetParent !== null;
        const txt = (document.body.innerText || "");
        const badTexts = [
          /checking in progress/i,
          /this will take about/i,
          /longer videos may take/i,
          /may take more time/i,
          /comprobando/i,
          /tardar[a]? aproximadamente/i,
        ];
        // 1. Si hay aviso explicito de procesado, NO esta listo.
        const leaves = [...document.querySelectorAll("span, div, p, [role='alert']")]
          .filter((el) => visible(el) && el.children.length === 0);
        for (const el of leaves) {
          const t = (el.textContent || "").trim();
          if (!t || t.length > 200) continue;
          if (badTexts.some((p) => p.test(t))) return false;
        }
        // 2. Senal positiva: "Uploaded" visible y sin "Uploading".
        const uploaded = /\\buploaded\\b/i.test(txt);
        const uploading = /\\buploading\\b|subiendo\\.\\.\\./i.test(txt);
        if (uploaded && !uploading) return true;
        // 3. Si existe el input de caption y no hay aviso, damos por listo.
        const caption =
          document.querySelector('div[contenteditable="true"]') ||
          document.querySelector('[data-e2e="caption-input"]');
        if (caption && !uploading) return true;
        return false;
      });
    } catch {
      return false;
    }
  };

  const deadline = Date.now() + Math.max(60000, Number(maxMs) || 600000);
  let waited = 0;
  while (Date.now() < deadline) {
    if (await isReady()) {
      if (waited > 0) console.log("TikTok: video listo (Uploaded).");
      return true;
    }
    await page.waitForTimeout(3000);
    waited += 3000;
    if (waited % 60000 === 0) {
      console.log(\`  ...TikTok sigue procesando (\${Math.round(waited / 1000)}s)\`);
    }
  }
  console.log("TikTok: no se confirmo el fin del procesado; se intenta programar igual.");
  return false;
}

`;
      text = text.slice(0, fnStart) + NEWS + text.slice(endIdx);
      ok("espera de procesado reescrita: por estado (Uploaded), tope 10 min");
    }
  }
}

// ===========================================================================
// B) El bloque de programacion en uploadVideo: dar por bueno y no cerrar
// ===========================================================================
if (text.includes(M_KEEP)) {
  skip("programacion robusta (ya aplicada)");
} else {
  const oldBlock = `    if (scheduleMode) {
      // // MARKER: TIKTOK-WAIT-PROCESSING-v1
      // TikTok no deja fijar fecha/hora mientras procesa el video. Esperamos a
      // que termine ("Checking in progress" desaparece) antes de programar.
      await waitForVideoProcessing(page);`;
  if (text.includes(oldBlock)) {
    const newBlock = `    if (scheduleMode) {
      ${M_KEEP}
      // Espera por estado (no por texto) antes de tocar la programacion.
      await waitForVideoProcessing(page);
      // Asegura que el radio "Schedule" quedo activo antes de programar.
      await ensureScheduleRadioOn(page);`;
    text = text.replace(oldBlock, newBlock);
    ok("espera por estado + activar radio Schedule antes de programar");
  } else {
    fail("No encontre el bloque de programacion en uploadVideo.");
  }
}

// ===========================================================================
// C) No cerrar el navegador si falla la programacion (ver el motivo)
// ===========================================================================
if (text.includes(M_KEEP)) {
  // Ya aplicado arriba o antes; parcheamos el finally de forma independiente.
}
{
  const oldFinally = `    await holdBrowserBeforeClose(page, closeHoldMs, "post-finalization");
    await context.close();
  }
}

module.exports = {`;
  const newFinally = `    ${M_KEEP}
    // Si fallo la PROGRAMACION, no cerrar: deja la ventana abierta para ver
    // el motivo y guarda la captura. En publicacion normal si se cierra.
    const failedSchedule = Boolean(lastScheduleError);
    if (ownsBrowser && !(scheduleMode && failedSchedule && config.keepBrowserOnScheduleFail !== false)) {
      await holdBrowserBeforeClose(page, closeHoldMs, "post-finalization");
      await context.close();
    } else if (scheduleMode && failedSchedule) {
      console.log("Programacion fallida: se deja el navegador ABIERTO para revisarlo.");
    } else if (!ownsBrowser) {
      // Navegador compartido: nunca lo cierra el uploader.
    }
  }
}

module.exports = {`;
  if (text.includes(oldFinally)) {
    text = text.replace(oldFinally, newFinally);
    ok("el navegador no se cierra si falla la programacion (queda abierto)");
  } else if (text.includes("failedSchedule")) {
    skip("no-cerrar en fallo de programacion (ya aplicado)");
  } else {
    fail("No encontre el finally de uploadVideo.");
  }

  // Declarar lastScheduleError y capturarlo en el bloque de programacion.
  if (!text.includes("let lastScheduleError = null;")) {
    text = text.replace(
      "  const scheduleMode = Boolean(scheduledAt);",
      "  const scheduleMode = Boolean(scheduledAt);\n  let lastScheduleError = null; // " +
        M_KEEP.replace("// ", "")
    );
    // Capturar el error: anadir catch al throw del schedule.
    const oldThrow = `      if (!scheduleResult) {
        throw scheduleError || new Error("No se pudo programar la fecha/hora.");
      }`;
    if (text.includes(oldThrow)) {
      text = text.replace(
        oldThrow,
        `      if (!scheduleResult) {
        lastScheduleError = scheduleError || new Error("No se pudo programar la fecha/hora.");
        throw lastScheduleError;
      }`
      );
      ok("el error de programacion queda registrado para no cerrar el navegador");
    } else {
      fail("No encontre el throw de programacion.");
    }
  }
}

// ===========================================================================
// D) ensureScheduleRadioOn (comprueba/activa el radio Schedule)
// ===========================================================================
if (!text.includes("async function ensureScheduleRadioOn")) {
  const anchor = "async function enableScheduleMode(page) {";
  if (text.includes(anchor)) {
    const fn = `/**
 * ${M_KEEP}
 * Comprueba que el radio "Schedule" de "When to post" esta activo. Si esta en
 * "Now", lo activa. Evita llegar a programar con el formulario en "Now"
 * (que es lo que hacia que no se pusiera la fecha/hora).
 */
async function ensureScheduleRadioOn(page) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const state = await page.evaluate(() => {
      const radio = document.querySelector(
        "input[name='postSchedule'][value='schedule'], input[type='radio'][value='schedule']"
      );
      if (!radio) return "missing";
      const on = radio.checked || radio.getAttribute("aria-checked") === "true";
      return on ? "on" : "off";
    }).catch(() => "missing");

    if (state === "on") return true;
    if (state === "missing") {
      await page.waitForTimeout(700);
      continue;
    }
    // Esta en "Now": activar Schedule.
    await page.evaluate(() => {
      const radio = document.querySelector(
        "input[name='postSchedule'][value='schedule'], input[type='radio'][value='schedule']"
      );
      if (!radio) return;
      radio.click();
      if (!(radio.checked || radio.getAttribute("aria-checked") === "true")) {
        const wrap = radio.closest("label, [role='radio']") || radio.parentElement || radio;
        wrap.click();
      }
    }).catch(() => {});
    await page.waitForTimeout(900);
  }
  console.log("Aviso: no se pudo confirmar que el radio Schedule este activo; se intentara programar igual.");
  return false;
}

${anchor}`;
    text = text.replace(anchor, fn);
    ok("ensureScheduleRadioOn anadida (activa Schedule si estaba en Now)");
  } else {
    fail("No encontre enableScheduleMode para insertar ensureScheduleRadioOn.");
  }
}

// ===========================================================================
// E) Popup "Content may be restricted"
// ===========================================================================
if (text.includes(M_MODAL)) {
  skip("cierre del popup de contenido restringido (ya aplicado)");
} else {
  const anchor = "async function dismissInterferingOverlays(page) {";
  if (text.includes(anchor)) {
    const fn = `/**
 * ${M_MODAL}
 * Cierra el modal "Content may be restricted" (la X es un div con SVG, sin
 * texto ni aria-label, por eso el codigo anterior no la encontraba).
 */
async function dismissRestrictedContentModal(page) {
  const isOpen = async () => {
    try {
      return await page.evaluate(() => {
        const titlePattern = /content may be restricted|el contenido puede estar restringido|puede estar restringido|contenido restringido/i;
        const reasons = [/unoriginal|low-quality|qr code|poco original|baja calidad|codigo qr/i, /violation reason|motivo de la infraccion/i];
        const dialogs = [...document.querySelectorAll('[role="dialog"], [class*="modal" i], [class*="Modal" i]')].filter((el) => el.offsetParent !== null);
        for (const d of dialogs) {
          const body = (d.innerText || "").trim();
          if (!body) continue;
          if (titlePattern.test(body) || reasons.some((p) => p.test(body))) {
            if (d.querySelector(".common-modal-close, [class*='common-modal-close']")) return true;
          }
        }
        return false;
      });
    } catch {
      return false;
    }
  };

  let closedAny = false;
  for (let pass = 0; pass < 4; pass += 1) {
    if (!(await isOpen())) break;
    let clicked = false;
    const byClass = page.locator(".common-modal-close, [class*='common-modal-close']").first();
    if ((await byClass.count().catch(() => 0)) > 0) {
      await byClass.click({ timeout: 1500 }).catch(() => {});
      clicked = true;
    }
    if (!clicked) {
      const icon = page.locator(".common-modal-close-icon, [class*='common-modal-close-icon']").first();
      if ((await icon.count().catch(() => 0)) > 0) {
        await icon.click({ timeout: 1500, force: true }).catch(() => {});
        clicked = true;
      }
    }
    if (!clicked) {
      await page.evaluate(() => {
        const c = document.querySelector(".common-modal-close, [class*='common-modal-close']");
        if (c) c.click();
      }).catch(() => {});
    }
    if (!clicked) break;
    closedAny = true;
    await page.waitForTimeout(600);
  }
  if (closedAny) {
    console.log("TikTok: cerrado el popup de contenido restringido; reintentando publicar.");
  }
  return closedAny;
}

${anchor}`;
    text = text.replace(anchor, fn);
    ok("dismissRestrictedContentModal anadida");
  } else {
    fail("No encontre dismissInterferingOverlays.");
  }

  // Llamarla antes de reintentar publicar.
  const oldRetry = `        console.log("No publish confirmation yet; retrying the primary TikTok Post button.");
        const retried = await tryClickPublishButton(page);`;
  if (text.includes(oldRetry)) {
    text = text.replace(
      oldRetry,
      `        console.log("No publish confirmation yet; retrying the primary TikTok Post button.");
        // ${M_MODAL}: cerrar el modal de contenido restringido antes de reintentar.
        await dismissRestrictedContentModal(page);
        const retried = await tryClickPublishButton(page);`
    );
    ok("el reintento de publicar cierra antes el popup");
  } else {
    fail("No encontre el reintento de publicar.");
  }
}

// ===========================================================================
// F) Un solo navegador: uploadVideo acepta page/context y no los cierra
// ===========================================================================
if (text.includes(M_REUSE)) {
  skip("navegador compartido (ya aplicado)");
} else {
  const fnStart = text.indexOf("async function uploadVideo(");
  if (fnStart === -1) {
    fail("No encontre uploadVideo.");
  } else {
    // La firma es un objeto de opciones: capturamos hasta el "})" que la cierra.
    const sigStart = text.indexOf("(", fnStart);
    const sigEndMark = text.indexOf("})", sigStart);
    if (sigStart === -1 || sigEndMark === -1) {
      fail("No pude leer la firma de uploadVideo.");
    } else if (text.slice(sigStart, sigEndMark).includes("reuseBrowser")) {
      skip("firma de uploadVideo ya ampliada");
    } else {
      const sig = text.slice(sigStart, sigEndMark);
      const needsAccountId = !/\baccountId\b/.test(sig);
      const additions = [
        needsAccountId ? "accountId" : null,
        "page: sharedPage",
        "context: sharedContext",
        "reuseBrowser",
      ]
        .filter(Boolean)
        .join(", ");
      const newSig = sig.replace(/\s*$/, "") + ", " + additions;
      text = text.slice(0, sigStart) + newSig + text.slice(sigEndMark);
      ok("firma de uploadVideo ampliada (page/context/reuseBrowser)");
    }
  }

  const oldOpen = `  const context = await openPersistentContext(accountId);
  const page = context.pages()[0] || (await context.newPage());`;
  if (text.includes(oldOpen)) {
    text = text.replace(
      oldOpen,
      `  ${M_REUSE}
  // Con reuseBrowser la pagina y el contexto vienen del lote (un solo
  // navegador para todos los videos) y NO se cierran aqui.
  const ownsBrowser = !(reuseBrowser && sharedPage && sharedContext);
  const context = ownsBrowser ? await openPersistentContext(accountId) : sharedContext;
  const page = ownsBrowser
    ? context.pages()[0] || (await context.newPage())
    : sharedPage;`
    );
    ok("uploadVideo usa el navegador compartido");
  } else {
    fail("No encontre el arranque de contexto en uploadVideo.");
  }
}

// ===========================================================================
// G) Exportar las funciones nuevas en _private (para depurar y probar)
// ===========================================================================
if (!text.includes("dismissRestrictedContentModal,\n")) {
  const anchor = "  _private: {";
  if (text.includes(anchor)) {
    text = text.replace(
      anchor,
      `${anchor}\n    ensureScheduleRadioOn,\n    dismissRestrictedContentModal,`
    );
    ok("funciones nuevas exportadas en _private");
  }
}

// ===========================================================================
// Escribir y verificar
// ===========================================================================
if (text !== original && !results.some(([s]) => s === "FAIL")) {
  const backup = `${TARGET}.tiktok-fix-total-backup`;
  if (!fs.existsSync(backup)) fs.copyFileSync(TARGET, backup);
  fs.writeFileSync(TARGET, text, "utf8");
  ok("src/tiktok-uploader.js actualizado (backup .tiktok-fix-total-backup)");
}

const check = spawnSync(process.execPath, ["--check", TARGET], { encoding: "utf8" });
if (check.status !== 0) {
  fail("SINTAXIS ROTA: " + (check.stderr || "").split("\n").filter(Boolean).slice(0, 3).join(" | "));
}

console.log("\n=== AutoSocial Studio - TikTok: FIX TOTAL ===");
for (const [s, m] of results) console.log(`  [${s}] ${m}`);
const failures = results.filter(([s]) => s === "FAIL");
console.log(
  `\n${results.filter(([s]) => s === "OK").length} cambios, ` +
    `${results.filter(([s]) => s === "SKIP").length} ya presentes, ${failures.length} errores.`
);
if (failures.length) {
  console.error("\nAbortado: no se dejo el archivo a medias. Copia de seguridad intacta.");
  process.exitCode = 1;
} else {
  console.log("\nReinicia el dashboard:  node src/dashboard-server.js");
}
