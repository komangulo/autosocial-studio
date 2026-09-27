"use strict";

const fs = require("fs");
const path = require("path");

// Instalador de la pestana "Vigilancia diaria" en AutoSocial Studio.
// - Copia src/vigilancia/*  -> <proyecto>/src/vigilancia/
// - Copia web/vigilancia.js -> <proyecto>/web/vigilancia.js
// - Copia web/vigilancia.css-> <proyecto>/web/vigilancia.css
// - Anade el boton de menu y la seccion en web/index.html
// - Anade el router y el worker en src/dashboard-server.js
// Idempotente y con --revert.

const ROOT = findProjectRoot();
const HERE = __dirname;

// Localiza la raiz del proyecto (carpeta con package.json) subiendo desde el cwd
// y, si no, desde la carpeta del instalador. Asi funciona tanto si se ejecuta
// desde la raiz del proyecto como desde una subcarpeta.
function findProjectRoot() {
  const candidates = [process.cwd(), __dirname];
  for (const start of candidates) {
    let dir = start;
    for (let i = 0; i < 6; i += 1) {
      if (fs.existsSync(path.join(dir, "package.json")) && fs.existsSync(path.join(dir, "src"))) {
        return dir;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  // Respaldo: si el instalador esta en <proyecto>/algo/, sube un nivel.
  return path.resolve(__dirname, "..");
}

const MARKER_ROUTER = "// MARKER: VIGILANCIA-ROUTER-v1";
const MARKER_WORKER = "// MARKER: VIGILANCIA-WORKER-v1";
const MARKER_NAV = "<!-- MARKER: VIGILANCIA-NAV-v1 -->";
const MARKER_SECTION = "<!-- MARKER: VIGILANCIA-SECTION-v1 -->";

function log(...a) { console.log(...a); }

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function backupFile(file) {
  if (!fs.existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const b = `${file}.bak-vigilancia-${stamp}`;
  fs.copyFileSync(file, b);
  return b;
}

function patchDashboardServer() {
  const file = path.join(ROOT, "src", "dashboard-server.js");
  if (!fs.existsSync(file)) throw new Error("No encuentro src/dashboard-server.js. Ejecuta desde la raiz del proyecto.");
  let src = fs.readFileSync(file, "utf8");

  // Si ya existe una seccion de vigilancia mal colocada (fuera de <main>), la quitamos
  // para reinsertarla en el sitio correcto mas abajo.
  if (src.includes('id="view-vigilancia"')) {
    src = src.replace(/[ \t]*<!-- MARKER: VIGILANCIA-SECTION-v1 -->[\s\S]*?<\/section>/i, "");
    src = src.replace(/[ \t]*<section id="view-vigilancia"[\s\S]*?<\/section>/i, "");
  }
  if (src.includes(MARKER_ROUTER)) {
    log("  [=] dashboard-server.js ya parcheado.");
    return;
  }
  backupFile(file);

  // 1) require del modulo + creacion del worker, junto a otros require del bloque de routers.
  const anchorRequire = `const { createAutoCloneRouter } = require("./autoclone");`;
  if (!src.includes(anchorRequire)) throw new Error("No encuentro el ancla de autoclone en dashboard-server.js.");
  src = src.replace(
    anchorRequire,
    `${anchorRequire}\n// MARKER: VIGILANCIA-ROUTER-v1\nconst { createVigilanciaRouter, VigilanciaWorker } = require("./vigilancia");`
  );

  // 2) montar el router despues de autoclone.
  const anchorMount = `app.use("/api/autoclone", createAutoCloneRouter(express, { getActiveAccount, worker: autonomousWorker }));`;
  if (!src.includes(anchorMount)) throw new Error("No encuentro el ancla de montaje de autoclone.");
  src = src.replace(
    anchorMount,
    `${anchorMount}\n  // MARKER: VIGILANCIA-WORKER-v1\n  const vigilanciaWorker = new VigilanciaWorker({ rootDir: path.join(__dirname, "..") });\n  try { vigilanciaWorker.schedule(); vigilanciaWorker.catchUp?.(); } catch (e) { console.error("[vigilancia] no se pudo programar:", e.message); }\n  app.use("/api/vigilancia", createVigilanciaRouter(express, { rootDir: path.join(__dirname, ".."), worker: vigilanciaWorker }));`
  );

  fs.writeFileSync(file, src, "utf8");
  log("  [+] dashboard-server.js parcheado (router + worker).");
}

function patchIndexHtml() {
  const file = path.join(ROOT, "web", "index.html");
  if (!fs.existsSync(file)) throw new Error("No encuentro web/index.html.");
  let src = fs.readFileSync(file, "utf8");

  // 1) Limpiar cualquier seccion/menu/scripts de vigilancia previos (reinstalacion).
  src = src.replace(/\s*<!-- MARKER: VIGILANCIA-NAV-v1 -->/g, "");
  src = src.replace(/[ \t]*<div class="nav-label">Vigilancia<\/div>\s*<button class="nav-item" data-view="vigilancia">[\s\S]*?<\/button>/gi, "");
  src = src.replace(/[ \t]*<!-- MARKER: VIGILANCIA-SECTION-v1 -->[\s\S]*?<section id="view-vigilancia"[\s\S]*?<\/section>/i, "");
  src = src.replace(/[ \t]*<link rel="stylesheet" href="vigilancia\.css">/gi, "");
  src = src.replace(/[ \t]*<script src="vigilancia\.js"><\/script>/gi, "");

  backupFile(file);

  // 2) Boton de menu: ultimo item del <nav class="nav-menu">.
  const navMatch = /<nav\b[^>]*class="[^"]*nav-menu[^"]*"[^>]*>([\s\S]*?)<\/nav>/i.exec(src);
  if (!navMatch) throw new Error("No encuentro el <nav class=\"nav-menu\"> en web/index.html.");
  const button = `
        <div class="nav-label">Vigilancia</div>
        <button class="nav-item" data-view="vigilancia">
          <i class="ph ph-binoculars"></i>
          <span>Subvenciones</span>
        </button>
        ${MARKER_NAV}
`;
  src = src.replace(navMatch[0], navMatch[0].replace(/<\/nav>\s*$/i, `${button}</nav>`));

  // 3) Seccion: DENTRO de <main class="main-content">, justo antes del cierre real.
  const section = `
    ${MARKER_SECTION}
    <section id="view-vigilancia" class="view-section">
      <header class="view-header">
        <div>
          <h2>Vigilancia diaria de subvenciones</h2>
          <span class="view-subtitle">Convocatorias de la Comunidad de Madrid (region ES3) para personas fisicas que no desarrollan actividad economica, solo abiertas. Revision automatica cada dia a las 10:00 y envio por correo.</span>
        </div>
        <div class="vig-actions">
          <button id="vig-run" class="vig-btn vig-btn-primary">Comprobar ahora</button>
          <button id="vig-preview" class="vig-btn">Previsualizar correo</button>
          <button id="vig-save" class="vig-btn">Guardar ajustes</button>
        </div>
      </header>

      <div class="vig-grid">
        <div class="vig-card">
          <h3>Ajustes</h3>
          <label class="vig-row"><span>Activar revision diaria</span><input type="checkbox" id="vig-enabled"></label>
          <label class="vig-row"><span>Hora (0-23)</span><input type="number" id="vig-hour" min="0" max="23"></label>
          <label class="vig-row"><span>Minuto (0-59)</span><input type="number" id="vig-minute" min="0" max="59"></label>
          <label class="vig-row"><span>Ventana (horas)</span><input type="number" id="vig-window" min="1" max="2160"></label>
          <label class="vig-row"><span>Enviar a</span><input type="email" id="vig-to" placeholder="correo@dominio.com"></label>
          <label class="vig-row"><span>Inbox AgentMail</span><input type="text" id="vig-inbox" placeholder="inbox@agentmail.to"></label>
          <label class="vig-row"><span>API key AgentMail</span><input type="password" id="vig-apikey" placeholder="(ya configurada)"></label>
          <div id="vig-status" class="vig-status"></div>
        </div>

        <div class="vig-card">
          <h3>Resultado de la ultima revision</h3>
          <div id="vig-last" class="vig-last">Sin datos todavia.</div>
          <h3 style="margin-top:20px">Historial</h3>
          <div id="vig-history" class="vig-history"></div>
        </div>
      </div>
    </section>
`;
  // Buscar el ULTIMO </main> (el que cierra el contenedor principal).
  const mainClose = src.lastIndexOf("</main>");
  if (mainClose === -1) throw new Error("No encuentro </main> en web/index.html.");
  src = src.slice(0, mainClose) + section + "    " + src.slice(mainClose);

  // 4) Assets antes de </body>.
  const assets = `
    <link rel="stylesheet" href="vigilancia.css">
    <script src="vigilancia.js"></script>
`;
  const bodyClose = src.lastIndexOf("</body>");
  if (bodyClose === -1) throw new Error("No encuentro </body> en web/index.html.");
  src = src.slice(0, bodyClose) + assets + "  " + src.slice(bodyClose);

  fs.writeFileSync(file, src, "utf8");
  log("  [+] web/index.html parcheado (menu + seccion dentro de main).");
}
function main() {
  const revert = process.argv.includes("--revert");
  if (revert) {
    log("Revirtiendo...");
    const files = [
      path.join(ROOT, "src", "dashboard-server.js"),
      path.join(ROOT, "web", "index.html"),
    ];
    for (const f of files) {
      const dir = path.dirname(f);
      const base = path.basename(f);
      const baks = fs.readdirSync(dir).filter(n => n.startsWith(base + ".bak-vigilancia-")).sort();
      if (!baks.length) { log(`  [!] sin backup de ${f}`); continue; }
      const latest = path.join(dir, baks[baks.length - 1]);
      fs.copyFileSync(latest, f);
      log(`  [<] ${base} restaurado desde ${path.basename(latest)}`);
    }
    const vdir = path.join(ROOT, "src", "vigilancia");
    if (fs.existsSync(vdir)) {
      fs.rmSync(vdir, { recursive: true, force: true });
      log("  [<] src/vigilancia eliminado");
    }
    for (const f of ["vaccion.js", "vigilancia.js", "vigilancia.css"]) {
      const p = path.join(ROOT, "web", f);
      if (fs.existsSync(p) && f !== "vaccion.js") { fs.rmSync(p, { force: true }); log(`  [<] web/${f} eliminado`); }
    }
    log("Reversion completada. Reinicia el dashboard.");
    return;
  }

  log("Instalando Vigilancia diaria...");
  copyDir(path.join(HERE, "src", "vigilancia"), path.join(ROOT, "src", "vigilancia"));
  log("  [+] src/vigilancia/ copiado.");
  for (const f of ["vigilancia.js", "vigilancia.css"]) {
    fs.copyFileSync(path.join(HERE, "web", f), path.join(ROOT, "web", f));
    log(`  [+] web/${f} copiado.`);
  }
  patchDashboardServer();
  patchIndexHtml();
  log("\nListo. Reinicia el dashboard (npm run dashboard) y abre la pestana 'Subvenciones'.");
  log("Para deshacer: node instalar-vigilancia.js --revert");
}

main();
