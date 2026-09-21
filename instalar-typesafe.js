#!/usr/bin/env node
/**
 * instalar-typesafe.js — integra el cliente TypeSafe (System One / Jev)
 * en AutoSocial Studio. Idempotente y seguro.
 *
 * QUE HACE
 *  1. Copia src/typesafe.js al proyecto (cliente HTTP, lee la clave de .env).
 *  2. Anade TYPESAFE_API_KEY a .env (si falta) sin tocar el resto del archivo.
 *  3. Documenta la variable en .env.example (sin valor).
 *  4. Verifica que .gitignore ignora .env.
 *  5. Comprueba sintaxis con node --check.
 *
 * USO (desde la raiz del proyecto):
 *   node instalar-typesafe.js
 *   node instalar-typesafe.js --key ts_xxx   (escribe la clave y prueba conexion)
 *
 * La clave NUNCA sale del servidor: no se expone en el navegador.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = process.cwd();
const MARK = "TYPESAFE_API_KEY";
const args = process.argv.slice(2);
const keyArg = (() => {
  const i = args.indexOf("--key");
  return i !== -1 ? args[i + 1] : null;
})();

function log(msg) { console.log(msg); }
function fail(msg) { console.error("\n[ERROR] " + msg); process.exit(1); }

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function readIfExists(p) { try { return fs.readFileSync(p, "utf8"); } catch { return null; } }

// --- 0. Estamos en la raiz del proyecto? ---------------------------------
if (!fs.existsSync(path.join(ROOT, "src", "dashboard-server.js"))) {
  fail("No encuentro src/dashboard-server.js. Ejecuta este script desde la raiz de autosocial-studio.");
}
log("Proyecto detectado en: " + ROOT);

// --- 1. Copiar src/typesafe.js -------------------------------------------
const moduleSrc = path.join(__dirname, "typesafe.js");
if (!fs.existsSync(moduleSrc)) fail("Falta typesafe.js junto a este instalador.");
const moduleDst = path.join(ROOT, "src", "typesafe.js");
ensureDir(path.dirname(moduleDst));
fs.writeFileSync(moduleDst, fs.readFileSync(moduleSrc));
log("OK  src/typesafe.js instalado.");

// --- 2. Anadir TYPESAFE_API_KEY a .env -----------------------------------
const envPath = path.join(ROOT, ".env");
let env = readIfExists(envPath);
if (env === null) {
  const example = readIfExists(path.join(ROOT, ".env.example"));
  env = example ? example : "";
  log("AVISO .env no existia: lo creo (basado en .env.example).");
}
if (env.length && !env.endsWith("\n")) env += "\n";
const hasKeyLine = new RegExp("^\\s*" + MARK + "\\s*=", "m").test(env);
if (keyArg) {
  if (hasKeyLine) {
    env = env.replace(new RegExp("^\\s*" + MARK + "\\s*=.*$", "m"), MARK + "=" + keyArg);
    log("OK  " + MARK + " actualizada en .env.");
  } else {
    env += "\n# TypeSafe (System One / Jev). Solo servidor. https://docs.typesafe.ai\n" + MARK + "=" + keyArg + "\n";
    log("OK  " + MARK + " anadida a .env.");
  }
  fs.writeFileSync(envPath, env);
} else if (!hasKeyLine) {
  env += "\n# TypeSafe (System One / Jev). Pega aqui tu clave. Solo servidor. https://docs.typesafe.ai\n" + MARK + "=\n";
  fs.writeFileSync(envPath, env);
  log("OK  " + MARK + " anadida a .env (falta el valor: usa --key o edita .env).");
} else {
  log("OK  " + MARK + " ya estaba en .env (no la toco).");
}

// --- 3. Documentar en .env.example ---------------------------------------
const exPath = path.join(ROOT, ".env.example");
let ex = readIfExists(exPath);
if (ex !== null && !new RegExp("^\\s*#?\\s*" + MARK + "\\s*=", "m").test(ex)) {
  if (ex.length && !ex.endsWith("\n")) ex += "\n";
  ex += "\n# TypeSafe System One (Jev) — decisones tipadas. Solo servidor.\n# " + MARK + "=ts_...\n";
  fs.writeFileSync(exPath, ex);
  log("OK  variable documentada en .env.example.");
}

// --- 4. .gitignore debe ignorar .env -------------------------------------
const gi = readIfExists(path.join(ROOT, ".gitignore")) || "";
if (!/^\.env\s*$/m.test(gi)) {
  log("AVISO .gitignore no ignora .env. Anade '.env' antes de commitear para no subir la clave.");
} else {
  log("OK  .env esta ignorado por git.");
}

// --- 5. node --check -----------------------------------------------------
try {
  execFileSync(process.execPath, ["--check", moduleDst], { stdio: "pipe" });
  log("OK  node --check src/typesafe.js");
} catch (e) {
  fail("src/typesafe.js no compila: " + (e.stderr ? e.stderr.toString() : e.message));
}

// --- 6. Prueba opcional de conexion --------------------------------------
if (keyArg) {
  (async () => {
    try {
      // El modulo carga .env por su cuenta; forzamos su relectura por si el
      // archivo acaba de escribirse en este mismo proceso.
      delete require.cache[require.resolve(moduleDst)];
      const typesafe = require(moduleDst);
      if (!typesafe.configured()) {
        fail("La clave se escribio, pero el modulo no la lee. Revisa .env (valor vacio o con comillas).");
      }
      const out = await typesafe.ask({
        state: "Hola, quiero saber si este texto es un anuncio de cartas coleccionables.",
        questions: {
          es_anuncio_tcg: { type: "noul", instructions: "¿Es un anuncio relacionado con cartas coleccionables (TCG)?" },
          tema: { type: "choice", instructions: "¿Cual es el tema principal?", criteria: { tcg: "Cartas coleccionables", otro: "Cualquier otro tema" } },
        },
      });
      log("\nPRUEBA OK — modelo: " + out.model);
      log(JSON.stringify(out.answers, null, 2));
      log("Tokens: " + JSON.stringify(out.usage));
    } catch (e) {
      fail("La clave se guardo, pero la prueba fallo: " + e.message);
    }
  })();
} else {
  log("\nListo. Cuando tengas la clave:  node instalar-typesafe.js --key ts_xxx");
}
