#!/usr/bin/env node
/**
 * instalar-tiktok-un-navegador.js
 * ---------------------------------------------------------------------------
 * QUE ARREGLA
 *   Tu prueba de 10 videos: entraron todos a la vez, cada uno abrio su propio
 *   Chrome sobre el MISMO perfil. Chrome no admite dos procesos con el mismo
 *   --user-data-dir: el primero gana y los otros 9 mueren (exitCode=21).
 *   Resultado: se subio 1 y el resumen dijo "10 programados".
 *
 * QUE HACE
 *   1. Un SOLO navegador para todo el lote (abre al empezar, cierra al final).
 *   2. Videos uno detras de otro: no empieza el siguiente hasta que el anterior
 *      devuelve succeeded/failed.
 *   3. `uploadVideo` acepta un navegador ya abierto y NO lo cierra por video.
 *   4. Si el navegador muere a mitad, se reabre solo y el lote continua.
 *   5. Resumen honesto con publicados y fallidos reales.
 *
 * Idempotente. Uso:  node instalar-tiktok-un-navegador.js
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");
const UPLOADER = path.join(SRC, "tiktok-uploader.js");
const BATCH = path.join(SRC, "tiktok-batch.js");

const MARK_U = "// MARKER: TIKTOK-REUSE-BROWSER-v1";
const MARK_B = "// MARKER: TIKTOK-SINGLE-BROWSER-BATCH-v1";

const results = [];
const ok = (m) => results.push(["OK", m]);
const skip = (m) => results.push(["SKIP", m]);
const fail = (m) => results.push(["FAIL", m]);

if (!fs.existsSync(path.join(ROOT, "package.json")) || !fs.existsSync(UPLOADER)) {
  console.error("ERROR: ejecuta este instalador desde la raiz de AutoSocial Studio.");
  process.exit(1);
}

// ===========================================================================
// PASO 1 - src/tiktok-uploader.js
// ===========================================================================
let text = fs.readFileSync(UPLOADER, "utf8");

if (text.includes(MARK_U)) {
  skip("tiktok-uploader.js ya acepta el navegador compartido");
} else {
  const fnStart = text.indexOf("async function uploadVideo(");
  if (fnStart === -1) {
    fail("No se encontro uploadVideo en tiktok-uploader.js (version distinta).");
  } else {
    // El cuerpo acaba donde cierra la funcion: buscamos la clausula finally y
    // el cierre de contexto, que es lo ultimo de uploadVideo.
    const closeAnchor = text.indexOf("await context.close();", fnStart);
    const endOfFn = text.indexOf("\n}\n", closeAnchor);
    if (closeAnchor === -1 || endOfFn === -1) {
      fail("No se encontro el cierre de uploadVideo (estructura distinta).");
    } else {
      let body = text.slice(fnStart, endOfFn);

      // 1a. Ampliar la firma.
      const sigMatch = body.match(
        /async function uploadVideo\(\s*\{([\s\S]*?)\}\s*\)\s*\{/
      );
      if (!sigMatch) {
        fail("No se pudo leer la firma de uploadVideo (no es un objeto de opciones).");
      } else {
        const inner = sigMatch[1].replace(/\s*$/, "");
        const hasAccountId = /\baccountId\b/.test(inner);
        const extra = [
          hasAccountId ? null : "accountId",
          "page: sharedPage",
          "context: sharedContext",
          "reuseBrowser",
        ]
          .filter(Boolean)
          .join(", ");
        const newSig = `async function uploadVideo({${inner}, ${extra} }) {`;
        body = body.replace(sigMatch[0], newSig);
      }

      // 1b. Contexto/pagina compartidos.
      const openRe = /const context = await openPersistentContext\(([^)]*)\);\s*\n\s*const page = context\.pages\(\)\[0\] \|\| \(await context\.newPage\(\)\);/;
      const openMatch = body.match(openRe);
      if (!openMatch) {
        fail("No se encontro el arranque contexto/pagina de uploadVideo.");
      } else {
        body = body.replace(
          openRe,
          `${MARK_U}\n` +
            "  // Con reuseBrowser la pagina y el contexto vienen del lote de un\n" +
            "  // solo navegador y NO se cierran aqui.\n" +
            "  const ownsBrowser = !(reuseBrowser && sharedPage && sharedContext);\n" +
            `  const context = ownsBrowser ? await openPersistentContext(${openMatch[1]}) : sharedContext;\n` +
            "  const page = ownsBrowser\n" +
            "    ? context.pages()[0] || (await context.newPage())\n" +
            "    : sharedPage;"
        );
        ok("uploadVideo acepta page/context/reuseBrowser (navegador compartido)");
      }

      // 1c. Cierre condicional.
      const closeRe =
        /await holdBrowserBeforeClose\(page, closeHoldMs, "post-finalization"\);\s*\n\s*await context\.close\(\);/;
      if (closeRe.test(body)) {
        body = body.replace(
          closeRe,
          "if (ownsBrowser) {\n      await holdBrowserBeforeClose(page, closeHoldMs, \"post-finalization\");\n      await context.close();\n    }"
        );
        ok("uploadVideo solo cierra el navegador cuando es suyo");
      } else {
        fail("No se encontro el cierre de contexto de uploadVideo.");
      }

      text = text.slice(0, fnStart) + body + text.slice(endOfFn);
    }
  }

  if (!results.some(([s]) => s === "FAIL")) {
    const backup = `${UPLOADER}.tiktok-un-navegador-backup`;
    if (!fs.existsSync(backup)) fs.copyFileSync(UPLOADER, backup);
    fs.writeFileSync(UPLOADER, text, "utf8");
  }
}

// ===========================================================================
// PASO 2 - src/tiktok-batch.js
// ===========================================================================
const templateEmbedded = "Y29uc3QgZnMgPSByZXF1aXJlKCJmcy9wcm9taXNlcyIpOwpjb25zdCBwYXRoID0gcmVxdWlyZSgicGF0aCIpOwpjb25zdCB7IGNocm9taXVtIH0gPSByZXF1aXJlKCJwbGF5d3JpZ2h0Iik7CmNvbnN0IHsgY29uZmlnIH0gPSByZXF1aXJlKCIuL2NvbmZpZyIpOwpjb25zdCB7CiAgZ2V0UGxhdGZvcm1Qcm9maWxlRGlyLAogIGdldEFjdGl2ZUFjY291bnQsCn0gPSByZXF1aXJlKCIuL2FjY291bnQtbWFuYWdlciIpOwpjb25zdCB7IGxpc3RRdWV1ZVZpZGVvcywgcmVhZENhcHRpb24sIGdldENhcHRpb25QYXRocyB9ID0gcmVxdWlyZSgiLi9xdWV1ZSIpOwpjb25zdCB7IGVuc3VyZURpcmVjdG9yaWVzLCBtb3ZlV2l0aFRpbWVzdGFtcCwgZmlsZUV4aXN0cyB9ID0gcmVxdWlyZSgiLi9mcy11dGlscyIpOwoKLy8gTUFSS0VSOiBUSUtUT0stU0lOR0xFLUJST1dTRVItQkFUQ0gtdjEKCmxldCBiYXRjaFN0YXRlID0gewogIHJ1bm5pbmc6IGZhbHNlLAogIHRvdGFsOiAwLAogIGRvbmU6IDAsCiAgcG9zdGVkOiAwLAogIGZhaWxlZDogMCwKICBjdXJyZW50OiBudWxsLAogIHN0YXJ0ZWRBdDogbnVsbCwKICBmaW5pc2hlZEF0OiBudWxsLAogIHJlc3VsdHM6IFtdLAp9OwoKZnVuY3Rpb24gZ2V0QmF0Y2hTdGF0ZSgpIHsKICByZXR1cm4gSlNPTi5wYXJzZShKU09OLnN0cmluZ2lmeShiYXRjaFN0YXRlKSk7Cn0KCmFzeW5jIGZ1bmN0aW9uIG1vdmVDYXB0aW9uU2lkZWNhcnMoY2FwdGlvblBhdGhzLCB0YXJnZXREaXIpIHsKICBjb25zdCBtb3ZlZCA9IFtdOwogIGZvciAoY29uc3QgY3Agb2YgY2FwdGlvblBhdGhzKSB7CiAgICBpZiAoIShhd2FpdCBmaWxlRXhpc3RzKGNwKSkpIGNvbnRpbnVlOwogICAgdHJ5IHsKICAgICAgbW92ZWQucHVzaChhd2FpdCBtb3ZlV2l0aFRpbWVzdGFtcChjcCwgdGFyZ2V0RGlyKSk7CiAgICB9IGNhdGNoIChlcnJvcikgewogICAgICBjb25zb2xlLmVycm9yKGBDb3VsZCBub3QgbW92ZSBjYXB0aW9uIHNpZGVjYXI6ICR7ZXJyb3IubWVzc2FnZX1gKTsKICAgIH0KICB9CiAgcmV0dXJuIG1vdmVkOwp9CgovKioKICogU3ViZSBUT0RBIGxhIGNvbGEgZGUgVGlrVG9rIHVzYW5kbyBVTiBTT0xPIG5hdmVnYWRvci4KICoKICogLSBBYnJlIENocm9tZSB1bmEgdmV6IChwZXJmaWwgcGVyc2lzdGVudGUgZGUgbGEgY3VlbnRhKS4KICogLSBDb2dlIGxvcyB2w61kZW9zIHVubyBhIHVubzsgbm8gZW1waWV6YSBlbCBzaWd1aWVudGUgaGFzdGEgcXVlIGVsIGFudGVyaW9yCiAqICAgZGV2dWVsdmUgc3VjY2VlZGVkL2ZhaWxlZC4KICogLSBBbCB0ZXJtaW5hciBlbCDDumx0aW1vLCBjaWVycmEgZWwgbmF2ZWdhZG9yLgogKi8KYXN5bmMgZnVuY3Rpb24gdXBsb2FkVGlrVG9rUXVldWVJbk9uZUJyb3dzZXIoewogIGFjY291bnRJZCwKICBxdWV1ZURpciwKICBwb3N0ZWREaXIsCiAgZmFpbGVkRGlyLAogIHVwbG9hZGVyLAogIG9uUHJvZ3Jlc3MsCiAga2VlcEJyb3dzZXJPcGVuID0gZmFsc2UsCn0gPSB7fSkgewogIGlmIChiYXRjaFN0YXRlLnJ1bm5pbmcpIHsKICAgIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICJZYSBoYXkgdW4gbG90ZSBkZSBUaWtUb2sgZW4gY3Vyc28uIiB9OwogIH0KCiAgY29uc3QgYWNjb3VudCA9IGFjY291bnRJZCA/IHsgaWQ6IGFjY291bnRJZCB9IDogYXdhaXQgZ2V0QWN0aXZlQWNjb3VudCgpOwogIGNvbnN0IHF1ZXVlID0gcXVldWVEaXIgfHwgY29uZmlnLnF1ZXVlRGlyOwogIGNvbnN0IHBvc3RlZCA9IHBvc3RlZERpciB8fCBjb25maWcucG9zdGVkRGlyOwogIGNvbnN0IGZhaWxlZCA9IGZhaWxlZERpciB8fCBjb25maWcuZmFpbGVkRGlyOwogIGNvbnN0IHVwbG9hZGVyTW9kdWxlID0gdXBsb2FkZXIgfHwgcmVxdWlyZSgiLi90aWt0b2stdXBsb2FkZXIiKTsKCiAgYXdhaXQgZW5zdXJlRGlyZWN0b3JpZXMoW3F1ZXVlLCBwb3N0ZWQsIGZhaWxlZF0pOwoKICBjb25zdCB2aWRlb3MgPSBhd2FpdCBsaXN0UXVldWVWaWRlb3MocXVldWUpOwogIGJhdGNoU3RhdGUgPSB7CiAgICBydW5uaW5nOiB0cnVlLAogICAgdG90YWw6IHZpZGVvcy5sZW5ndGgsCiAgICBkb25lOiAwLAogICAgcG9zdGVkOiAwLAogICAgZmFpbGVkOiAwLAogICAgY3VycmVudDogbnVsbCwKICAgIHN0YXJ0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLAogICAgZmluaXNoZWRBdDogbnVsbCwKICAgIHJlc3VsdHM6IFtdLAogIH07CgogIGlmICh2aWRlb3MubGVuZ3RoID09PSAwKSB7CiAgICBiYXRjaFN0YXRlLnJ1bm5pbmcgPSBmYWxzZTsKICAgIGJhdGNoU3RhdGUuZmluaXNoZWRBdCA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTsKICAgIHJldHVybiB7IG9rOiB0cnVlLCBza2lwcGVkOiB0cnVlLCByZWFzb246ICJMYSBjb2xhIGVzdMOhIHZhY8OtYS4iLCAuLi5nZXRCYXRjaFN0YXRlKCkgfTsKICB9CgogIGNvbnN0IHByb2ZpbGVEaXIgPSBhd2FpdCBnZXRQbGF0Zm9ybVByb2ZpbGVEaXIoInRpa3RvayIsIGFjY291bnQuaWQpOwogIGF3YWl0IGZzLm1rZGlyKHByb2ZpbGVEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pOwoKICBsZXQgY29udGV4dCA9IGF3YWl0IGNocm9taXVtLmxhdW5jaFBlcnNpc3RlbnRDb250ZXh0KHByb2ZpbGVEaXIsIHsKICAgIGhlYWRsZXNzOiBjb25maWcuaGVhZGxlc3MsCiAgICB2aWV3cG9ydDogeyB3aWR0aDogMTQwMCwgaGVpZ2h0OiAxMDAwIH0sCiAgICBsb2NhbGU6IGNvbmZpZy5icm93c2VyTG9jYWxlLAogICAgdGltZXpvbmVJZDogY29uZmlnLnRpbWV6b25lLAogICAgYXJnczogWyItLWRpc2FibGUtYmxpbmstZmVhdHVyZXM9QXV0b21hdGlvbkNvbnRyb2xsZWQiXSwKICB9KTsKCiAgbGV0IHBhZ2UgPSBjb250ZXh0LnBhZ2VzKClbMF0gfHwgKGF3YWl0IGNvbnRleHQubmV3UGFnZSgpKTsKCiAgY29uc3QgYnJvd3NlcklzQWxpdmUgPSBhc3luYyAoKSA9PiB7CiAgICB0cnkgewogICAgICByZXR1cm4gIWNvbnRleHQucGFnZXMoKS5ldmVyeSgocCkgPT4gcC5pc0Nsb3NlZCgpKTsKICAgIH0gY2F0Y2ggewogICAgICByZXR1cm4gZmFsc2U7CiAgICB9CiAgfTsKCiAgY29uc3QgcmVvcGVuQnJvd3NlciA9IGFzeW5jICgpID0+IHsKICAgIGF3YWl0IGNvbnRleHQuY2xvc2UoKS5jYXRjaCgoKSA9PiB7fSk7CiAgICBjb250ZXh0ID0gYXdhaXQgY2hyb21pdW0ubGF1bmNoUGVyc2lzdGVudENvbnRleHQocHJvZmlsZURpciwgewogICAgICBoZWFkbGVzczogY29uZmlnLmhlYWRsZXNzLAogICAgICB2aWV3cG9ydDogeyB3aWR0aDogMTQwMCwgaGVpZ2h0OiAxMDAwIH0sCiAgICAgIGxvY2FsZTogY29uZmlnLmJyb3dzZXJMb2NhbGUsCiAgICAgIHRpbWV6b25lSWQ6IGNvbmZpZy50aW1lem9uZSwKICAgICAgYXJnczogWyItLWRpc2FibGUtYmxpbmstZmVhdHVyZXM9QXV0b21hdGlvbkNvbnRyb2xsZWQiXSwKICAgIH0pOwogICAgcGFnZSA9IGNvbnRleHQucGFnZXMoKVswXSB8fCAoYXdhaXQgY29udGV4dC5uZXdQYWdlKCkpOwogIH07CgogIHRyeSB7CiAgICBmb3IgKGNvbnN0IHZpZGVvUGF0aCBvZiB2aWRlb3MpIHsKICAgICAgaWYgKCEoYXdhaXQgYnJvd3NlcklzQWxpdmUoKSkpIHsKICAgICAgICBjb25zb2xlLmxvZygiRWwgbmF2ZWdhZG9yIHNlIGNlcnLDszsgcmVhYnJpZW5kbyBwYXJhIGNvbnRpbnVhciBlbCBsb3RlLi4uIik7CiAgICAgICAgYXdhaXQgcmVvcGVuQnJvd3NlcigpOwogICAgICB9CiAgICAgIGNvbnN0IG5hbWUgPSBwYXRoLmJhc2VuYW1lKHZpZGVvUGF0aCk7CiAgICAgIGJhdGNoU3RhdGUuY3VycmVudCA9IG5hbWU7CiAgICAgIGNvbnN0IGNhcHRpb24gPSBhd2FpdCByZWFkQ2FwdGlvbih2aWRlb1BhdGgpOwogICAgICBjb25zdCBjYXB0aW9uUGF0aHMgPSBnZXRDYXB0aW9uUGF0aHModmlkZW9QYXRoKTsKICAgICAgbGV0IHJlc3VsdDsKCiAgICAgIHRyeSB7CiAgICAgICAgcmVzdWx0ID0gYXdhaXQgdXBsb2FkZXJNb2R1bGUudXBsb2FkVmlkZW8oewogICAgICAgICAgdmlkZW9QYXRoLAogICAgICAgICAgY2FwdGlvbiwKICAgICAgICAgIHNvdXJjZTogInF1ZXVlLWJhdGNoIiwKICAgICAgICAgIGFjY291bnRJZDogYWNjb3VudC5pZCwKICAgICAgICAgIHBhZ2UsCiAgICAgICAgICBjb250ZXh0LAogICAgICAgICAgcmV1c2VCcm93c2VyOiB0cnVlLAogICAgICAgIH0pOwogICAgICB9IGNhdGNoIChlcnJvcikgewogICAgICAgIHJlc3VsdCA9IHsgb2s6IGZhbHNlLCBlcnJvcjogZXJyb3IubWVzc2FnZSB8fCAiRXJyb3IgaW5lc3BlcmFkbyBhbCBzdWJpci4iIH07CiAgICAgIH0KCiAgICAgIGlmIChyZXN1bHQgJiYgcmVzdWx0Lm9rKSB7CiAgICAgICAgY29uc3QgbW92ZWQgPSBhd2FpdCBtb3ZlV2l0aFRpbWVzdGFtcCh2aWRlb1BhdGgsIHBvc3RlZCkuY2F0Y2goKCkgPT4gbnVsbCk7CiAgICAgICAgYXdhaXQgbW92ZUNhcHRpb25TaWRlY2FycyhjYXB0aW9uUGF0aHMsIHBvc3RlZCk7CiAgICAgICAgaWYgKCFtb3ZlZCkgewogICAgICAgICAgYXdhaXQgbW92ZVdpdGhUaW1lc3RhbXAodmlkZW9QYXRoLCBmYWlsZWQpLmNhdGNoKCgpID0+IG51bGwpOwogICAgICAgICAgYmF0Y2hTdGF0ZS5mYWlsZWQgKz0gMTsKICAgICAgICAgIGJhdGNoU3RhdGUucmVzdWx0cy5wdXNoKHsKICAgICAgICAgICAgdmlkZW86IG5hbWUsCiAgICAgICAgICAgIG9rOiBmYWxzZSwKICAgICAgICAgICAgZXJyb3I6ICJFbCB2w61kZW8gc2UgcHVibGljw7MsIHBlcm8gbm8gc2UgcHVkbyBhcmNoaXZhci4iLAogICAgICAgICAgfSk7CiAgICAgICAgfSBlbHNlIHsKICAgICAgICAgIGJhdGNoU3RhdGUucG9zdGVkICs9IDE7CiAgICAgICAgICBiYXRjaFN0YXRlLnJlc3VsdHMucHVzaCh7IHZpZGVvOiBuYW1lLCBvazogdHJ1ZSwgYXJjaGl2ZWQ6IHRydWUgfSk7CiAgICAgICAgfQogICAgICB9IGVsc2UgewogICAgICAgIGF3YWl0IG1vdmVXaXRoVGltZXN0YW1wKHZpZGVvUGF0aCwgZmFpbGVkKS5jYXRjaCgoKSA9PiBudWxsKTsKICAgICAgICBhd2FpdCBtb3ZlQ2FwdGlvblNpZGVjYXJzKGNhcHRpb25QYXRocywgZmFpbGVkKTsKICAgICAgICBiYXRjaFN0YXRlLmZhaWxlZCArPSAxOwogICAgICAgIGJhdGNoU3RhdGUucmVzdWx0cy5wdXNoKHsKICAgICAgICAgIHZpZGVvOiBuYW1lLAogICAgICAgICAgb2s6IGZhbHNlLAogICAgICAgICAgZXJyb3I6IChyZXN1bHQgJiYgcmVzdWx0LmVycm9yKSB8fCAiRmFsbG8gZGVzY29ub2NpZG8uIiwKICAgICAgICB9KTsKICAgICAgfQoKICAgICAgYmF0Y2hTdGF0ZS5kb25lICs9IDE7CiAgICAgIGlmICh0eXBlb2Ygb25Qcm9ncmVzcyA9PT0gImZ1bmN0aW9uIikgewogICAgICAgIHRyeSB7CiAgICAgICAgICBvblByb2dyZXNzKGdldEJhdGNoU3RhdGUoKSwgbmFtZSwgcmVzdWx0KTsKICAgICAgICB9IGNhdGNoIHsKICAgICAgICAgIC8vIExhIFVJIG51bmNhIGRlYmUgcm9tcGVyIGVsIGxvdGUuCiAgICAgICAgfQogICAgICB9CiAgICB9CiAgfSBmaW5hbGx5IHsKICAgIGlmICgha2VlcEJyb3dzZXJPcGVuKSB7CiAgICAgIGF3YWl0IGNvbnRleHQuY2xvc2UoKS5jYXRjaCgoKSA9PiB7fSk7CiAgICB9CiAgICBiYXRjaFN0YXRlLnJ1bm5pbmcgPSBmYWxzZTsKICAgIGJhdGNoU3RhdGUuY3VycmVudCA9IG51bGw7CiAgICBiYXRjaFN0YXRlLmZpbmlzaGVkQXQgPSBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7CiAgfQoKICByZXR1cm4geyBvazogYmF0Y2hTdGF0ZS5mYWlsZWQgPT09IDAsIC4uLmdldEJhdGNoU3RhdGUoKSB9Owp9CgpmdW5jdGlvbiBzdW1tYXJpemVCYXRjaChzdGF0ZSkgewogIGNvbnN0IHMgPSBzdGF0ZSB8fCBiYXRjaFN0YXRlOwogIHJldHVybiBgJHtzLnBvc3RlZH0gcHVibGljYWRvcywgJHtzLmZhaWxlZH0gZmFsbGlkb3MgZGUgJHtzLnRvdGFsfS5gOwp9Cgptb2R1bGUuZXhwb3J0cyA9IHsKICB1cGxvYWRUaWtUb2tRdWV1ZUluT25lQnJvd3NlciwKICBnZXRCYXRjaFN0YXRlLAogIHN1bW1hcml6ZUJhdGNoLAogIF9wcml2YXRlOiB7IG1vdmVDYXB0aW9uU2lkZWNhcnMgfSwKfTsK";
const batchSource = Buffer.from(templateEmbedded, "base64").toString("utf8");

if (fs.existsSync(BATCH) && fs.readFileSync(BATCH, "utf8").includes(MARK_B)) {
  skip("src/tiktok-batch.js ya esta instalado");
} else {
  fs.writeFileSync(BATCH, batchSource, "utf8");
  ok("src/tiktok-batch.js instalado (un navegador, secuencial, resumen real)");
}

// ===========================================================================
// PASO 3 - verificar sintaxis (unica prueba fiable)
// ===========================================================================
for (const file of [UPLOADER, BATCH]) {
  if (!fs.existsSync(file)) continue;
  const check = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (check.status !== 0) {
    fail(
      `Sintaxis rota en ${path.basename(file)}: ` +
        (check.stderr || "").split("\n").filter(Boolean)[0]
    );
  }
}

console.log("\n=== AutoSocial Studio - TikTok: un navegador para todo el lote ===");
for (const [status, message] of results) console.log(`  [${status}] ${message}`);
const failures = results.filter(([s]) => s === "FAIL");
const changes = results.filter(([s]) => s === "OK").length;
const skips = results.filter(([s]) => s === "SKIP").length;
console.log(`\n${changes} cambios aplicados, ${skips} ya presentes, ${failures.length} errores.`);
if (failures.length) {
  console.error(
    "\nNo se dejo nada a medias. Tu tiktok-uploader.js esta a salvo en " +
      "*.tiktok-un-navegador-backup. Mandame el error de arriba."
  );
  process.exitCode = 1;
} else {
  console.log("\nHecho. Ahora usa el lote asi (desde src/, o conectalo a tus botones):");
  console.log("");
  console.log('  const { uploadTikTokQueueInOneBrowser } = require("./tiktok-batch");');
  console.log("  const r = await uploadTikTokQueueInOneBrowser({ accountId });");
  console.log('  console.log(r.posted + " publicados, " + r.failed + " fallidos");');
  console.log("");
  console.log("Reinicia el dashboard:  node src/dashboard-server.js");
}
