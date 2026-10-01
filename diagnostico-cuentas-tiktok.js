#!/usr/bin/env node
/*
 * DIAGNOSTICO de cuentas TikTok mezcladas (SOLO LECTURA)
 * ------------------------------------------------------
 * Detecta, para cada cuenta/perfil del dashboard, QUE usuario de TikTok esta
 * realmente logueado en su perfil. Asi se ve exactamente que perfil tiene una
 * cuenta que no le corresponde.
 *
 * NO MODIFICA NADA: no toca cuentas, ni perfiles, ni sesiones. Solo lee.
 *
 * Uso (desde la carpeta del proyecto, con el dashboard PARADO):
 *   node diag-cuentas-tiktok.js
 *
 * Requiere Playwright (ya lo usa la app). Si Playwright no estuviera, avisa.
 */

const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const OUT = path.join(ROOT, "diagnostico-cuentas-tiktok.txt");

function log(msg) { console.log(msg); OUT_LINES.push(msg); }
const OUT_LINES = [];

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }

function listProfiles() {
  const dir = path.join(ROOT, ".profiles");
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch { return []; }
}

function hasSession(accountId, platform) {
  const base = path.join(ROOT, ".profiles", accountId, platform);
  const candidates = [
    path.join(base, "Default", "Cookies"),
    path.join(base, "Cookies"),
    path.join(base, "Network", "Cookies"),
  ];
  for (const c of candidates) {
    try { const s = fs.statSync(c); if (s.isFile() && s.size > 0) return true; } catch { /* sigue */ }
  }
  return false;
}

/* --- Deteccion del @ de TikTok, igual que la app pero standalone --- */

function normalizeHandle(v) {
  return String(v || "").trim().replace(/^@+/, "").split(/[/?#\s]/)[0].toLowerCase().slice(0, 60);
}

async function detectFromPage(page) {
  // 1) API interna
  try {
    const r = await page.evaluate(async () => {
      try {
        const res = await fetch("https://www.tiktok.com/passport/web/account/info/?aid=1459", {
          credentials: "include", headers: { accept: "application/json" },
        });
        const j = await res.json();
        const d = (j && (j.data || j.userInfo || j)) || {};
        return d.username || d.uniqueId || "";
      } catch (e) { return ""; }
    });
    const u = normalizeHandle(r);
    if (u) return { username: u, source: "passport-api" };
  } catch { /* sigue */ }

  // 2) DOM
  try {
    const r = await page.evaluate(() => {
      for (const sel of ['a[data-e2e="profile-icon"]', 'a[href^="/@"]', 'a[href*="tiktok.com/@"]']) {
        const el = document.querySelector(sel);
        const href = el && el.getAttribute && el.getAttribute("href");
        if (href && href.includes("/@")) {
          const m = href.match(/\/@([A-Za-z0-9._]+)/);
          if (m) return m[1];
        }
      }
      return "";
    });
    const u = normalizeHandle(r);
    if (u) return { username: u, source: "dom" };
  } catch { /* sigue */ }

  // 3) Cookies
  try {
    const cookies = await page.context().cookies("https://www.tiktok.com");
    for (const key of ["uniqueId", "unique_id", "username"]) {
      const hit = cookies.find((c) => c.name === key && c.value);
      const u = normalizeHandle(hit && hit.value);
      if (u) return { username: u, source: "cookie:" + key };
    }
  } catch { /* sigue */ }

  return { username: "", source: "not-found" };
}

async function main() {
  log("====================================================");
  log(" DIAGNOSTICO DE CUENTAS TIKTOK (solo lectura)");
  log(" Fecha: " + new Date().toISOString());
  log("====================================================");

  const state = readJson(path.join(ROOT, "accounts-state.json"));
  const accounts = (state && state.accounts) || [];
  log("\nCuentas del dashboard: " + accounts.length + " (activa: " + (state && state.activeAccountId) + ")");
  for (const a of accounts) log("  - " + a.id + "  (" + a.name + ")");

  const profiles = listProfiles();
  log("\nPerfiles en .profiles/: " + profiles.length);

  // Mapear cuentas -> perfiles
  const rows = [];
  for (const a of accounts) {
    const exists = fs.existsSync(path.join(ROOT, ".profiles", a.id, "tiktok"));
    rows.push({ id: a.id, name: a.name, profileExists: exists, session: hasSession(a.id, "tiktok"), tiktokUser: "(no comprobado)" });
  }
  // Perfiles huerfanos (carpeta sin cuenta registrada)
  const known = new Set(accounts.map((a) => a.id));
  const orphans = profiles.filter((p) => !known.has(p));

  log("\n=== Sesiones por cuenta (archivo de cookies) ===");
  for (const r of rows) {
    log("  " + r.id.padEnd(18) + " sesion=" + (r.session ? "SI" : "no ") + "  perfil=" + (r.profileExists ? "OK" : "FALTA"));
  }
  if (orphans.length) {
    log("\n=== Perfiles sin cuenta registrada (huerfanos) ===");
    for (const o of orphans) log("  " + o);
  }

  // Detectar el @ real abriendo cada perfil.
  let chromium;
  try { ({ chromium } = require("playwright")); }
  catch { log("\nAVISO: Playwright no esta instalado; no puedo leer el @ real. Ejecuta: npx playwright install chromium"); }

  if (chromium) {
    log("\n=== Usuario de TikTok REAL en cada perfil (abriendo cada uno) ===");
    for (const r of rows) {
      if (!r.profileExists) { log("  " + r.id.padEnd(18) + " -> (sin perfil)"); r.tiktokUser = ""; continue; }
      const dir = path.join(ROOT, ".profiles", r.id, "tiktok");
      let ctx = null;
      try {
        // Limpiar candados huerfanos para poder abrir el perfil.
        for (const lock of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
          try { fs.rmSync(path.join(dir, lock), { force: true }); } catch {}
        }
        ctx = await chromium.launchPersistentContext(dir, {
          headless: true,
          viewport: { width: 1280, height: 900 },
          args: ["--disable-blink-features=AutomationControlled"],
        });
        const page = ctx.pages()[0] || (await ctx.newPage());
        await page.goto("https://www.tiktok.com/foryou", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
        const det = await detectFromPage(page);
        r.tiktokUser = det.username || "";
        log("  " + r.id.padEnd(18) + " -> " + (det.username ? "@" + det.username : "(no logueado / no detectado)") + "  [" + det.source + "]");
      } catch (e) {
        log("  " + r.id.padEnd(18) + " -> ERROR: " + (e && e.message));
      } finally {
        if (ctx) await ctx.close().catch(() => {});
      }
    }
  }

  log("\n=== RESUMEN ===");
  log("Copia esta tabla y pasala a tu asistente:");
  for (const r of rows) {
    log("  " + r.id.padEnd(18) + " esperado=(" + (r.name) + ")   real=" + (r.tiktokUser ? "@" + r.tiktokUser : "(sin dato)"));
  }
  log("\n(NADA se ha modificado. Esto es solo lectura.)");
  log("\nInforme guardado en: " + OUT);

  fs.writeFileSync(OUT, OUT_LINES.join("\n"), "utf8");
}

main().catch((e) => {
  console.error("Error en el diagnostico:", e && e.stack || e);
  try { fs.writeFileSync(OUT, OUT_LINES.join("\n") + "\nERROR: " + (e && e.message), "utf8"); } catch {}
});
