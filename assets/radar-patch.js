// Fragmentos de codigo que el instalador inyecta en los archivos del proyecto.
//
// MARKER: RADAR-PATCH-v1

// --- postTweetRich: publica texto + imagenes (usado por el radar) ----------
// Se inserta justo antes de "async function firstVisibleLocator" en x-auth.js.
const XAUTH_POST_RICH = `
/**
 * Publica un texto con imagenes del post original.
 * MARKER: XAP-POST-RICH-v1
 * Si falla la descarga o el adjuntado de una imagen, publica solo el texto.
 */
async function postTweetRich(text, images) {
  const account = await getActiveAccount();
  const body = String(text || "").trim();
  if (!body) throw new Error("El texto del post esta vacio.");
  const list = Array.isArray(images) ? images.filter(Boolean).slice(0, 4) : [];

  return withSession(async (context) => {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(COMPOSE_URL, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForTimeout(2500);

    const editor = await firstVisibleLocator(page, [
      '[data-testid="tweetTextarea_0"]',
      'div[role="textbox"][contenteditable="true"]',
      'div[contenteditable="true"]',
    ]);
    if (!editor) throw new Error("No se encontro el cuadro de redaccion de X (sesion caducada?).");

    if (list.length) {
      try {
        const paths = [];
        const os = require("os");
        const fsp = require("fs/promises");
        const pathMod = require("path");
        for (let i = 0; i < list.length; i++) {
          const res = await context.request.get(list[i], { timeout: 20000 });
          if (!res.ok()) continue;
          const buf = await res.body();
          const ct = res.headers()["content-type"] || "image/jpeg";
          const ext = ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : "jpg";
          const file = pathMod.join(os.tmpdir(), "radar-" + Date.now() + "-" + i + "." + ext);
          await fsp.writeFile(file, buf);
          paths.push(file);
        }
        if (paths.length) {
          const input = page.locator('input[type="file"]').first();
          await input.setInputFiles(paths);
          await page.waitForTimeout(5000);
        }
      } catch (e) {
        console.error("[x-auth] no se pudieron adjuntar imagenes:", e.message);
      }
    }

    await editor.click();
    await editor.type(body, { delay: 18 });
    await page.waitForTimeout(600);

    const button = await firstVisibleLocator(page, [
      '[data-testid="tweetButton"]',
      '[data-testid="tweetButtonInline"]',
    ]);
    if (!button) throw new Error("No se encontro el boton de publicar de X.");
    try {
      await button.click();
    } catch (error) {
      throw new Error("No se pudo pulsar Publicar: " + error.message);
    }
    await confirmPublished(page);

    return { ok: true, accountId: account.id, length: body.length, images: list.length };
  });
}

`;

module.exports = { XAUTH_POST_RICH };
