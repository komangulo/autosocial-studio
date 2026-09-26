"use strict";

// Envio de correo via AgentMail (https://docs.agentmail.to).
// Endpoint: POST /v0/inboxes/{inbox_id}/messages/send
// Auth: Bearer <api_key>

const AGENTMAIL_API = "https://api.agentmail.to/v0";

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtMoney(value) {
  if (value == null || value === "") return "";
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return "";
  return new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n);
}

function fmtDate(value) {
  if (!value) return "";
  const s = String(value).slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
}

function buildSubject(result, { now = new Date() } = {}) {
  const d = fmtDate(now.toISOString());
  const n = result.total || 0;
  if (n === 0) return `Subvenciones Madrid (ES3) - ${d}: sin novedades`;
  return `Subvenciones Madrid (ES3) - ${d}: ${n} nueva${n === 1 ? "" : "s"}`;
}

function renderItemText(item, index) {
  const lines = [];
  lines.push(`${index + 1}. [${item.grupoLabel}] ${item.descripcion}`);
  lines.push(`   Codigo BDNS: ${item.numero}`);
  if (item.organo) lines.push(`   Organo: ${item.organo}`);
  if (item.fechaInicio || item.fechaFin) {
    lines.push(`   Plazo: ${fmtDate(item.fechaInicio) || "?"} -> ${fmtDate(item.fechaFin) || "abierto"}`);
  }
  if (item.presupuestoTotal) lines.push(`   Presupuesto: ${fmtMoney(item.presupuestoTotal)}`);
  if (item.tiposBeneficiarios && item.tiposBeneficiarios.length) {
    lines.push(`   Beneficiarios: ${item.tiposBeneficiarios.join(" | ")}`);
  }
  lines.push(`   Enlace: ${item.url}`);
  return lines.join("\n");
}

function renderText(result, { now = new Date() } = {}) {
  const d = fmtDate(now.toISOString());
  const parts = [];
  parts.push(`Vigilancia diaria de subvenciones - Comunidad de Madrid (region de impacto ES3)`);
  parts.push(`Fecha: ${d}`);
  parts.push(`Ventana: ultimas ${result.windowHours || 24} horas (registradas desde ${fmtDate(result.since)})`);
  parts.push("");
  const madrid = (result.items || []).filter((i) => i.grupo === "madrid");
  const estado = (result.items || []).filter((i) => i.grupo === "estado");
  parts.push(`Criterios: PERSONAS FISICAS QUE NO DESARROLLAN ACTIVIDAD ECONOMICA + ABIERTAS`);
  parts.push(`Grupo A - Comunidad de Madrid: ${madrid.length}`);
  parts.push(`Grupo B - Administracion del Estado: ${estado.length}`);
  parts.push(`Total: ${result.total}`);
  parts.push("");

  if (result.total === 0) {
    parts.push("Hoy no hay convocatorias nuevas que cumplan los criterios.");
  } else {
    for (const grupo of ["madrid", "estado"]) {
      const items = grupo === "madrid" ? madrid : estado;
      if (!items.length) continue;
      parts.push("=".repeat(70));
      parts.push(grupo === "madrid" ? "GRUPO A - COMUNIDAD DE MADRID" : "GRUPO B - ADMINISTRACION DEL ESTADO");
      parts.push("=".repeat(70));
      items.forEach((item, i) => parts.push(renderItemText(item, i)));
      parts.push("");
    }
  }
  parts.push("--");
  parts.push("Generado automaticamente por AutoSocial Studio - Vigilancia.");
  return parts.join("\n");
}

function renderHtml(result, { now = new Date() } = {}) {
  const tooMany = (result.items || []).length > 300;
  const rawJson = Buffer.from(JSON.stringify(result, null, 2)).toString("base64");

  const madrid = (result.items || []).filter((i) => i.grupo === "madrid");
  const estado = (result.items || []).filter((i) => i.grupo === "estado");

  const rowHtml = (item) => `
    <tr>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;vertical-align:top">
        <a href="${escapeHtml(item.url)}" style="color:#0b63ce;text-decoration:none;font-weight:600">${escapeHtml(item.descripcion)}</a>
        <div style="color:#666;font-size:12px;margin-top:3px">BDNS ${escapeHtml(item.numero)}${item.organo ? " &middot; " + escapeHtml(item.organo) : ""}</div>
      </td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;vertical-align:top;white-space:nowrap;font-size:13px">
        ${item.fechaFin ? escapeHtml(fmtDate(item.fechaFin)) : '<span style="color:#137333">abierto</span>'}
      </td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;vertical-align:top;white-space:nowrap;font-size:13px">
        ${item.presupuestoTotal ? escapeHtml(fmtMoney(item.presupuestoTotal)) : ""}
      </td>
    </tr>`;

  const sectionHtml = (label, items) => {
    if (!items.length) return "";
    const shown = tooMany ? items.slice(0, 300) : items;
    return `
      <h2 style="font-size:15px;margin:22px 0 6px;color:#111">${escapeHtml(label)} (${items.length})</h2>
      <table style="border-collapse:collapse;width:100%;font-family:Arial,sans-serif;font-size:14px">
        <tr>
          <th align="left" style="padding:6px 10px;border-bottom:2px solid #ddd;font-size:12px;color:#666">CONVOCATORIA</th>
          <th align="left" style="padding:6px 10px;border-bottom:2px solid #ddd;font-size:12px;color:#666">FIN PLAZO</th>
          <th align="left" style="padding:6px 10px;border-bottom:2px solid #ddd;font-size:12px;color:#666">PRESUPUESTO</th>
        </tr>
        ${shown.map(rowHtml).join("")}
      </table>
      ${tooMany && items.length > 300 ? `<div style="color:#a15c00;font-size:13px;margin-top:6px">Mostrando las primeras 300 de ${items.length}. El listado completo va adjunto.</div>` : ""}`;
  };

  const emptyBlock = `
    <div style="padding:16px;background:#f3f7f3;border:1px solid #d6e6d6;border-radius:8px;color:#137333;font-family:Arial,sans-serif;font-size:15px">
      Hoy no hay convocatorias nuevas que cumplan los criterios.
    </div>`;

  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f5f6f8">
  <div style="max-width:760px;margin:0 auto;padding:22px">
    <div style="background:#0b3d91;color:#fff;padding:16px 18px;border-radius:10px 10px 0 0;font-family:Arial,sans-serif">
      <div style="font-size:18px;font-weight:700">Vigilancia de subvenciones</div>
      <div style="font-size:13px;opacity:.9;margin-top:3px">Region de impacto ES3 - Comunidad de Madrid &middot; ${escapeHtml(fmtDate(now.toISOString()))}</div>
    </div>
    <div style="background:#fff;padding:16px 18px;border:1px solid #e3e6ea;border-top:none;border-radius:0 0 10px 10px;font-family:Arial,sans-serif">
      <div style="font-size:13px;color:#555;margin-bottom:10px">
        Criterios: beneficiario <b>personas fisicas que no desarrollan actividad economica</b>, solo <b>abiertas</b>. Ventana: ultimas ${escapeHtml(String(result.windowHours || 24))} h.
      </div>
      <div style="display:flex;gap:10px;margin-bottom:8px">
        <div style="flex:1;background:#f0f4fb;border-radius:8px;padding:10px 12px">
          <div style="font-size:12px;color:#555">Comunidad de Madrid</div>
          <div style="font-size:22px;font-weight:700;color:#0b3d91">${madrid.length}</div>
        </div>
        <div style="flex:1;background:#f0f4fb;border-radius:8px;padding:10px 12px">
          <div style="font-size:12px;color:#555">Administracion del Estado</div>
          <div style="font-size:22px;font-weight:700;color:#0b3d91">${estado.length}</div>
        </div>
      </div>
      ${result.total === 0 ? emptyBlock : sectionHtml("Grupo A - Comunidad de Madrid", madrid) + sectionHtml("Grupo B - Administracion del Estado", estado)}
      <div style="color:#888;font-size:12px;margin-top:18px">Generado automaticamente por AutoSocial Studio - Vigilancia.</div>
    </div>
  </div>
</body></html>`;

  const attachments = [];
  if (tooMany && result.items.length > 300) {
    const csv = buildCsv(result);
    attachments.push({
      filename: `subvenciones-madrid-${result.today || fmtDate(now.toISOString()).replace(/\//g, "-")}.csv`,
      content_type: "text/csv",
      content: Buffer.from(csv, "utf8").toString("base64"),
    });
  }
  // Adjunto JSON siempre, para que quede constancia completa.
  attachments.push({
    filename: `subvenciones-madrid-${result.today || fmtDate(now.toISOString()).replace(/\//g, "-")}.json`,
    content_type: "application/json",
    content: rawJson,
  });

  return { html, attachments };
}

function buildCsv(result) {
  const head = ["Grupo", "Descripcion", "BDNS", "Organo", "Fecha registro", "Inicio", "Fin", "Presupuesto", "Beneficiarios", "Enlace"];
  const esc = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
  const rows = (result.items || []).map((i) =>
    [i.grupoLabel, i.descripcion, i.numero, i.organo, i.fechaRecepcion, i.fechaInicio || "", i.fechaFin || "", i.presupuestoTotal || "", (i.tiposBeneficiarios || []).join(" | "), i.url].map(esc).join(",")
  );
  return [head.map(esc).join(","), ...rows].join("\r\n");
}

/**
 * Envía el correo del informe.
 * @param {object} opts
 * @param {object} opts.config { apiKey, inboxId, to }
 * @param {object} opts.result resultado de runWatch()
 * @param {Date} [opts.now]
 */
async function sendReport({ config, result, now = new Date(), dryRun = false }) {
  if (!config || !config.apiKey || !config.inboxId || !config.to) {
    throw new Error("Falta configuracion de correo (apiKey, inboxId, to).");
  }
  const subject = buildSubject(result, { now });
  const text = renderText(result, { now });
  const { html, attachments } = renderHtml(result, { now });

  if (dryRun) {
    return { ok: true, dryRun: true, subject, text, html, attachments };
  }

  const url = `${AGENTMAIL_API}/inboxes/${encodeURIComponent(config.inboxId)}/messages/send`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      to: config.to,
      subject,
      text,
      html,
      attachments,
    }),
  });

  const bodyText = await res.text();
  let body = null;
  try { body = JSON.parse(bodyText); } catch { body = { raw: bodyText }; }
  if (!res.ok) {
    throw new Error(`AgentMail ${res.status}: ${bodyText.slice(0, 300)}`);
  }
  return { ok: true, subject, messageId: body.message_id, threadId: body.thread_id };
}

module.exports = {
  AGENTMAIL_API,
  buildSubject,
  renderText,
  renderHtml,
  buildCsv,
  sendReport,
};
