"use strict";

// Pestana "Vigilancia diaria de subvenciones" para AutoSocial Studio.
// Se integra en el menu principal con data-view="vigilancia".

(function () {
  const API = "/api/vigilancia";

  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  async function api(path, opts) {
    const res = await fetch(API + path, {
      headers: { "Content-Type": "application/json" },
      ...opts,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || `Error ${res.status}`);
    return data;
  }

  function status(msg, kind) {
    const box = el("vig-status");
    if (!box) return;
    box.textContent = msg || "";
    box.className = "vig-status" + (kind ? " vig-" + kind : "");
  }

  async function loadSettings() {
    const { settings } = await api("/settings");
    el("vig-enabled").checked = !!settings.enabled;
    el("vig-hour").value = settings.hour;
    el("vig-minute").value = settings.minute;
    el("vig-window").value = settings.windowHours;
    el("vig-to").value = settings.to || "";
    el("vig-inbox").value = settings.inboxId || "";
    el("vig-apikey").placeholder = settings.hasApiKey ? "(ya configurada - vacio = no cambiar)" : "pega aqui la API key";
  }

  async function loadStatus() {
    const s = await api("/status");
    const parts = [];
    parts.push(s.enabled ? "Programada: " + String(s.hour).padStart(2, "0") + ":" + String(s.minute).padStart(2, "0") + " (Europe/Madrid)" : "Programacion desactivada");
    parts.push(s.scheduled ? "cron activo" : "cron inactivo");
    if (s.to) parts.push("-> " + s.to);
    if (s.hasApiKey) parts.push("correo listo");
    el("vig-status").textContent = parts.join(" · ");
    el("vig-status").className = "vig-status " + (s.enabled && s.hasApiKey ? "vig-ok" : "vig-warn");
  }

  function renderResult(entry) {
    const box = el("vig-last");
    if (!entry) { box.textContent = "Sin datos todavia. Pulsa 'Comprobar ahora'."; return; }
    if (entry.error) { box.innerHTML = `<div class="vig-err">Error: ${esc(entry.error)}</div>`; return; }
    const g = entry.groups || [];
    const madrid = (g.find((x) => x.id === "madrid") || {}).accepted || 0;
    const estado = (g.find((x) => x.id === "estado") || {}).accepted || 0;
    const items = entry.items || [];
    let html = `<div class="vig-stat"><span>Fecha</span><b>${esc((entry.at || "").replace("T", " ").slice(0, 16))}</b></div>
      <div class="vig-stat"><span>Comunidad de Madrid</span><b>${madrid}</b></div>
      <div class="vig-stat"><span>Administracion del Estado</span><b>${estado}</b></div>
      <div class="vig-stat"><span>Total nuevas</span><b>${entry.total || 0}</b></div>`;
    if (items.length) {
      html += `<table class="vig-table"><thead><tr><th>Convocatoria</th><th>Organo</th><th>Fin plazo</th></tr></thead><tbody>`;
      for (const it of items) {
        html += `<tr><td><a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.descripcion)}</a><div class="vig-meta">BDNS ${esc(it.numero)} · ${esc(it.grupoLabel)}</div></td><td>${esc((it.organo || "").slice(0, 60))}</td><td>${it.fechaFin ? esc(it.fechaFin) : '<span class="vig-open">abierto</span>'}</td></tr>`;
      }
      html += `</tbody></table>`;
    }
    box.innerHTML = html;
  }

  function renderHistory(items) {
    const box = el("vig-history");
    if (!items || !items.length) { box.textContent = "Sin historial."; return; }
    box.innerHTML = items.map((h) => {
      const g = h.groups || [];
      const madrid = (g.find((x) => x.id === "madrid") || {}).accepted || 0;
      const estado = (g.find((x) => x.id === "estado") || {}).accepted || 0;
      const when = (h.at || "").replace("T", " ").slice(0, 16);
      const summary = h.error ? `<span class="vig-err">error</span>` : `${h.total || 0} (M:${madrid} / E:${estado})`;
      const mail = h.mail && h.mail.ok ? " · correo enviado" : "";
      return `<div class="vig-hist-row"><span>${esc(when)}</span><b>${summary}</b><span class="vig-meta">${esc(h.trigger || "")}${mail}</span></div>`;
    }).join("");
  }

  // Carga los datos cada vez que se entra en la vista. app.js ya muestra la
  // seccion (clase .view-section + .active); aqui solo recargamos los datos.
  function attachViewBridge() {
    const section = el("view-vigilancia");
    if (!section || section.__vigBridge) return;
    section.__vigBridge = true;

    const onShow = () => {
      loadStatus().catch(() => {});
      api("/history?limit=30")
        .then(({ items }) => { renderResult(items[0]); renderHistory(items); })
        .catch(() => {});
    };

    document.addEventListener("autosocial:viewchange", (ev) => {
      const view = ev && ev.detail && (ev.detail.view || ev.detail.viewName);
      if (view === "vigilancia") onShow();
    });

    // Respaldo por clic en el menu.
    document.addEventListener("click", (ev) => {
      const btn = ev.target && ev.target.closest ? ev.target.closest('[data-view="vigilancia"]') : null;
      if (btn) onShow();
    }, true);

    if (location.hash === "#vigilancia") onShow();
  }

  async function init() {
    if (!el("view-vigilancia")) return;
    attachViewBridge();
    try {
      await loadSettings();
      await loadStatus();
      const { items } = await api("/history?limit=30");
      renderResult(items[0]);
      renderHistory(items);
    } catch (e) {
      status("No se pudo cargar la vigilancia: " + e.message, "err");
    }

    el("vig-save").addEventListener("click", async () => {
      try {
        status("Guardando...", "warn");
        const patch = {
          enabled: el("vig-enabled").checked,
          hour: Number(el("vig-hour").value),
          minute: Number(el("vig-minute").value),
          windowHours: Number(el("vig-window").value),
          to: el("vig-to").value.trim(),
          inboxId: el("vig-inbox").value.trim(),
        };
        const key = el("vig-apikey").value.trim();
        if (key) patch.apiKey = key;
        await api("/settings", { method: "POST", body: JSON.stringify(patch) });
        await loadStatus();
        status("Ajustes guardados.", "ok");
      } catch (e) { status("Error al guardar: " + e.message, "err"); }
    });

    el("vig-run").addEventListener("click", async () => {
      try {
        status("Comprobando convocatorias y enviando correo...", "warn");
        el("vig-run").disabled = true;
        const out = await api("/run", { method: "POST", body: JSON.stringify({ sendEmail: true }) });
        status(`Hecho: ${out.total} nuevas. Correo enviado.`, "ok");
        const { items } = await api("/history?limit=30");
        renderResult(items[0]);
        renderHistory(items);
      } catch (e) { status("Error: " + e.message, "err"); }
      finally { el("vig-run").disabled = false; }
    });

    el("vig-preview").addEventListener("click", async () => {
      try {
        status("Generando previsualizacion...", "warn");
        const out = await api("/preview?windowHours=" + Number(el("vig-window").value || 24));
        const w = window.open("", "_blank");
        if (w) {
          w.document.write(`<pre style="white-space:pre-wrap;font:13px/1.5 monospace;padding:18px">${esc(out.text)}</pre>`);
          w.document.title = out.subject;
          w.document.close();
        }
        status("Previsualizacion abierta en una pestana nueva.", "ok");
      } catch (e) { status("Error: " + e.message, "err"); }
    });
  }

  window.__vigilanciaInit = init;
  if (document.readyState !== "loading") {
    // Se inicializa cuando el usuario entra en la vista; tambien se puede llamar al arrancar.
    setTimeout(() => { try { init(); } catch {} }, 800);
  } else {
    document.addEventListener("DOMContentLoaded", () => setTimeout(() => { try { init(); } catch {} }, 800));
  }
})();
