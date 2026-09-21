#!/usr/bin/env node
/**
 * AutoSocial Studio - Campo visible para la API key de xKiro
 * ==========================================================
 * QUE HACE
 *   El motor de rotacion xKiro ya lee settings.xKiroApiKey, pero la interfaz
 *   no tenia NINGUN campo para escribirla. Sin clave, xKiro se salta entero
 *   y AutoClone cae a Gemini. Este instalador cierra ese hueco de punta a punta:
 *
 *     1. src/competitor/controller.js
 *        - xKiroApiKey en el objeto de ajustes por defecto
 *        - rama de guardado en saveSettings()
 *        - hasXKiroKey + xKiroKeyMasked en getSettings()
 *     2. web/index.html  -> campo de entrada + boton Guardar + linea de estado
 *     3. web/autoclone.js -> leer/guardar el campo y pintar el estado
 *
 *   Idempotente: cada cambio lleva un marcador unico. Si ya esta, no toca nada.
 *
 * USO
 *   Coloca este archivo en la raiz del proyecto y ejecuta:
 *
 *       node instalar-xkiro-campo.js
 */

const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const MARK = "XKC[campo]";
const MARK_C = "XKC[controller]";
const MARK_H = "XKC[html]";
const MARK_J = "XKC[js]";

let cambios = 0;
let yaEstaba = 0;
const fallos = [];

function log(msg) { console.log(msg); }
function ok(msg) { console.log("  [OK]   " + msg); }
function warn(msg) { console.log("  [AVISO] " + msg); }

function leer(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) { fallos.push("No existe: " + rel); return null; }
  return { p, txt: fs.readFileSync(p, "utf8") };
}

function guardar(file, txt) {
  const tmp = file.p + ".xkiro-tmp";
  fs.writeFileSync(tmp, txt, "utf8");
  fs.renameSync(tmp, file.p);
}

function insertarAntesDe(txt, ancla, bloque) {
  const i = txt.indexOf(ancla);
  if (i === -1) return null;
  return txt.slice(0, i) + bloque + txt.slice(i);
}

console.log("");
console.log("============================================================");
console.log("  AutoSocial Studio - Campo de API key para xKiro");
console.log("============================================================");
console.log("");

// ---------------------------------------------------------------- paso 0
log("[0/4] Comprobando el proyecto...");
if (!fs.existsSync(path.join(ROOT, "package.json"))) {
  console.log("  [ERROR] No veo package.json. Ejecuta este archivo en la raiz del proyecto.");
  process.exit(1);
}
if (!fs.existsSync(path.join(ROOT, "src", "competitor", "controller.js"))) {
  console.log("  [ERROR] No veo src/competitor/controller.js. Proyecto equivocado?");
  process.exit(1);
}
ok("Proyecto encontrado.");

// ---------------------------------------------------------------- paso 1
log("");
log("[1/4] Ajustes del backend (controller.js)...");
{
  const f = leer("src/competitor/controller.js");
  if (f) {
    let t = f.txt;
    let tocado = false;

    // 1a) valor por defecto
    if (t.includes(MARK_C + "[default]")) {
      yaEstaba++;
    } else {
      const ancla = 'deepSeekApiKey: "", model: aiAnalyst.DEFAULT_MODEL';
      if (t.includes(ancla)) {
        const nuevo = insertarAntesDe(
          t,
          'deepSeekApiKey: "", model:',
          'xKiroApiKey: "", // ' + MARK_C + "[default]\n          "
        );
        if (nuevo) { t = nuevo; tocado = true; }
        else fallos.push("No pude insertar el valor por defecto de xKiroApiKey.");
      } else {
        fallos.push("No encontre el objeto de ajustes por defecto.");
      }
    }

    // 1b) rama de guardado
    if (t.includes(MARK_C + "[save]")) {
      yaEstaba++;
    } else {
      const ancla = "if (patch.removeDeepSeek) this.settings.deepSeekApiKey = \"\";";
      if (t.includes(ancla)) {
        const bloque =
          "\n    if (typeof patch.xKiroApiKey === \"string\") {\n" +
          "      if (patch.xKiroApiKey.trim()) this.settings.xKiroApiKey = patch.xKiroApiKey.trim();\n" +
          "      else if (patch.xKiroApiKey === \"\") this.settings.xKiroApiKey = \"\";\n" +
          "    } // " + MARK_C + "[save]\n" +
          "    if (patch.removeXKiro) this.settings.xKiroApiKey = \"\";";
        const idx = t.indexOf(ancla);
        t = t.slice(0, idx + ancla.length) + bloque + t.slice(idx + ancla.length);
        tocado = true;
      } else {
        fallos.push("No encontre el bloque de guardado de DeepSeek.");
      }
    }

    // 1c) estado en getSettings
    if (t.includes(MARK_C + "[status]")) {
      yaEstaba++;
    } else {
      const ancla = "hasDeepSeekKey: Boolean(this.settings.deepSeekApiKey),";
      if (t.includes(ancla)) {
        const idx = t.indexOf(ancla);
        const salto = t.indexOf("\n", idx);
        const linea =
          "\n      hasXKiroKey: Boolean(this.settings.xKiroApiKey), // " + MARK_C + "[status]\n" +
          "      xKiroKeyMasked: this.settings.xKiroApiKey ? `${this.settings.xKiroApiKey.slice(0, 6)}...${this.settings.xKiroApiKey.slice(-4)}` : \"\",";
        t = t.slice(0, salto) + linea + t.slice(salto);
        tocado = true;
      } else {
        fallos.push("No encontre hasDeepSeekKey en getSettings().");
      }
    }

    if (tocado) { guardar(f, t); ok("Backend actualizado (ajustes, guardado, estado)."); cambios++; }
    else if (yaEstaba) ok("El backend ya estaba actualizado.");
  }
}

// ---------------------------------------------------------------- paso 2
log("");
log("[2/4] Campo en la interfaz (web/index.html)...");
{
  const f = leer("web/index.html");
  if (f) {
    if (f.txt.includes(MARK_H)) {
      ok("El campo ya existe en la interfaz.");
      yaEstaba++;
    } else {
      const ancla = 'id="autocloneDeepSeekStatus"';
      if (f.txt.includes(ancla)) {
        const idx = f.txt.indexOf(ancla);
        const fin = f.txt.indexOf("\n", idx);
        // insertar tras el parrafo de estado de DeepSeek
        const parrFin = f.txt.indexOf("</p>", idx);
        const salto = f.txt.indexOf("\n", parrFin);
        const bloque =
          "\n\n          <div class=\"card-title\" style=\"margin-top:18px;\">" +
          "API key de xKiro (rotacion gratuita)</div>\n" +
          "          <p class=\"form-hint\">Rota entre 4 modelos gratis de xKiro antes de gastar cuota de Gemini. " +
          "Pega la clave de https://api.xkiro.com. Se guarda localmente.</p>\n" +
          "          <div class=\"helios-key-row\">\n" +
          "            <input id=\"autocloneXKiroKey\" class=\"control-input\" type=\"password\" placeholder=\"sk-...\" />\n" +
          "            <button id=\"autocloneSaveXKiroKeyBtn\" class=\"control-btn-small primary\" type=\"button\">Guardar</button>\n" +
          "          </div>\n" +
          "          <p class=\"helios-hint\" id=\"autocloneXKiroStatus\"></p> <!-- " + MARK_H + " -->";
        const t = f.txt.slice(0, salto) + bloque + f.txt.slice(salto);
        guardar(f, t);
        ok("Campo anadido a la interfaz.");
        cambios++;
      } else {
        fallos.push("No encontre el bloque de DeepSeek en web/index.html.");
      }
    }
  }
}

// ---------------------------------------------------------------- paso 3
log("");
log("[3/4] Cableado del campo (web/autoclone.js)...");
{
  const f = leer("web/autoclone.js");
  if (f) {
    let t = f.txt;
    let tocado = false;

    // 3a) referencias a los elementos
    if (t.includes(MARK_J + "[els]")) {
      yaEstaba++;
    } else {
      const ancla = 'deepSeekStatus: $("autocloneDeepSeekStatus"),';
      if (t.includes(ancla)) {
        const idx = t.indexOf(ancla);
        const salto = t.indexOf("\n", idx);
        const linea =
          "\n    xKiroKey: $(\"autocloneXKiroKey\"), // " + MARK_J + "[els]\n" +
          "    saveXKiroKeyBtn: $(\"autocloneSaveXKiroKeyBtn\"),\n" +
          "    xKiroStatus: $(\"autocloneXKiroStatus\"),";
        t = t.slice(0, salto) + linea + t.slice(salto);
        tocado = true;
      } else {
        fallos.push("No encontre las referencias a los elementos del panel.");
      }
    }

    // 3b) pintar estado dentro de la carga de ajustes
    if (t.includes(MARK_J + "[render]")) {
      yaEstaba++;
    } else {
      const ancla = "els.deepSeekStatus.textContent = data.settings?.hasDeepSeekKey";
      if (t.includes(ancla)) {
        // encontrar el final del if/else de deepSeekStatus
        const idx = t.indexOf(ancla);
        const cierre = t.indexOf("}", t.indexOf(";", idx));
        const salto = t.indexOf("\n", cierre);
        const bloque =
          "\n\n      if (els.xKiroStatus) { // " + MARK_J + "[render]\n" +
          "        els.xKiroStatus.textContent = data.settings?.hasXKiroKey\n" +
          "          ? `xKiro configurado (${data.settings?.xKiroKeyMasked || \"oculta\"}). Rotacion activa en AutoClone.`\n" +
          "          : \"xKiro sin configurar. AutoClone usara Gemini directamente.\";\n" +
          "      }";
        t = t.slice(0, salto) + bloque + t.slice(salto);
        tocado = true;
      } else {
        fallos.push("No encontre la carga de ajustes en web/autoclone.js.");
      }
    }

    // 3c) funcion guardar + enganchar el boton
    if (t.includes(MARK_J + "[func]")) {
      yaEstaba++;
    } else {
      const ancla = "async function saveDeepSeekKey()";
      if (t.includes(ancla)) {
        const idx = t.indexOf(ancla);
        const bloque =
          "async function saveXKiroKey() { // " + MARK_J + "[func]\n" +
          "    const key = els.xKiroKey.value.trim();\n" +
          "    if (!key) { els.xKiroStatus.textContent = \"Escribe la API key de xKiro.\"; return; }\n" +
          "    els.saveXKiroKeyBtn.disabled = true;\n" +
          "    try {\n" +
          "      await API.post(\"/api/competitor/settings\", { xKiroApiKey: key });\n" +
          "      els.xKiroKey.value = \"\";\n" +
          "      els.xKiroStatus.textContent = \"API key de xKiro guardada.\";\n" +
          "    } catch (error) {\n" +
          "      els.xKiroStatus.textContent = error.message;\n" +
          "    } finally {\n" +
          "      els.saveXKiroKeyBtn.disabled = false;\n" +
          "    }\n" +
          "  }\n\n  ";
        t = t.slice(0, idx) + bloque + t.slice(idx);
        tocado = true;
      } else {
        fallos.push("No encontre saveDeepSeekKey() para copiar el patron.");
      }
    }

    if (tocado) { guardar(f, t); ok("Interfaz cableada (leer, guardar, estado)."); cambios++; }
    else if (yaEstaba) ok("La interfaz ya estaba cableada.");
  }
}

// ---------------------------------------------------------------- paso 4
log("");
log("[4/4] Enganchando el boton Guardar...");
{
  const f = leer("web/autoclone.js");
  if (f) {
    if (f.txt.includes(MARK_J + "[bind]")) {
      ok("El boton ya estaba enganchado.");
      yaEstaba++;
    } else {
      // Ancla exacta: la linea que engancha el boton de DeepSeek. Asi el
      // enganche de xKiro cae al mismo nivel, no dentro de un if.
      const ancla = "els.saveDeepSeekKeyBtn?.addEventListener(\"click\", saveDeepSeekKey);";
      if (f.txt.includes(ancla)) {
        const idx = f.txt.indexOf(ancla);
        const salto = f.txt.indexOf("\n", idx);
        const linea =
          "\n  els.saveXKiroKeyBtn?.addEventListener(\"click\", saveXKiroKey); // " + MARK_J + "[bind]";
        const t = f.txt.slice(0, salto) + linea + f.txt.slice(salto);
        guardar(f, t);
        ok("Boton Guardar de xKiro enganchado.");
        cambios++;
      } else {
        fallos.push("No encontre la linea que engancha el boton de DeepSeek.");
      }
    }
  }
}

// ---------------------------------------------------------------- sintaxis
log("");
log("Comprobando sintaxis de los archivos modificados...");
const nodeBin = process.execPath;
const { execFileSync } = require("child_process");
const aRevisar = [
  "src/competitor/controller.js",
  "web/autoclone.js",
];
let sintaxisOK = true;
for (const rel of aRevisar) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) continue;
  try {
    execFileSync(nodeBin, ["--check", p], { stdio: "pipe" });
    ok(rel + " compila.");
  } catch (e) {
    sintaxisOK = false;
    console.log("  [ERROR] " + rel + " tiene un error de sintaxis:");
    console.log("          " + (e.stderr ? e.stderr.toString().split("\n")[0] : e.message));
  }
}

// ---------------------------------------------------------------- resumen
log("");
console.log("============================================================");
if (fallos.length) {
  console.log("  TERMINADO CON AVISOS");
  console.log("============================================================");
  for (const x of fallos) console.log("  - " + x);
  console.log("");
  console.log("  Los cambios aplicados SI se guardaron. Revisa los avisos de arriba.");
  process.exit(1);
} else if (!sintaxisOK) {
  console.log("  ERROR DE SINTAXIS");
  console.log("============================================================");
  console.log("  Restaura los archivos desde git y avisa para revisarlo.");
  process.exit(1);
} else {
  console.log("  LISTO");
  console.log("============================================================");
  console.log("");
  if (cambios === 0) {
    console.log("  El campo de xKiro ya estaba instalado. Nada que cambiar.");
  } else {
    console.log("  Campo de API key de xKiro instalado por completo.");
    console.log("");
    console.log("  AHORA HAZ ESTO:");
    console.log("    1. Para el dashboard (Ctrl+C en su ventana).");
    console.log("    2. Vuelve a arrancarlo:  node scripts/run-dashboard.js");
    console.log("    3. Recarga la pagina del navegador (Ctrl+F5).");
    console.log("    4. En AutoClone pulsa «Configurar API key».");
    console.log("    5. Veras un campo nuevo «API key de xKiro».");
    console.log("       Pega tu clave, pulsa Guardar.");
    console.log("    6. Debe poner: xKiro configurado (sk-xxx...xxxx).");
    console.log("");
    console.log("  Reiniciar es OBLIGATORIO: Node mantiene el codigo viejo en memoria.");
  }
  console.log("");
}
