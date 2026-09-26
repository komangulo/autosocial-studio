"use strict";

// Vigilancia diaria de convocatorias de subvenciones (infosubvenciones.es / BDNS).
// Consulta la API publica del portal y filtra por:
//   - Region de impacto: ES3 - COMUNIDAD DE MADRID (id 26)
//   - Beneficiario elegible: PERSONAS FISICAS QUE NO DESARROLLAN ACTIVIDAD ECONOMICA (id 1)
//   - Dos grupos de organo convocante:
//       A) Comunidad de Madrid  -> tipoAdministracion=A (autonomica) + region 26
//       B) Administracion del Estado -> tipoAdministracion=C
//   - Solo convocatorias ABIERTAS (abierto=true en el detalle)
//   - Solo registradas en las ultimas 24 horas
//
// No usa navegador: solo HTTP a la API publica. Robusto y rapido.

const API_BASE = "https://www.infosubvenciones.es/bdnstrans/api";
const VPD = "GE";

// Identificadores verificados contra el portal real.
const REGION_COMUNIDAD_DE_MADRID = 26;
const BENEFICIARIO_PERSONAS_FISICAS_SIN_ACTIVIDAD = 1;

const GROUPS = {
  madrid: {
    id: "madrid",
    label: "Comunidad de Madrid",
    tipoAdministracion: "A",
  },
  estado: {
    id: "estado",
    label: "Administracion del Estado",
    tipoAdministracion: "C",
  },
};

function log(...args) {
  console.log("[vigilancia]", ...args);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function buildSearchUrl(group, { page = 0, pageSize = 100 } = {}) {
  const params = new URLSearchParams({
    vpd: VPD,
    page: String(page),
    pageSize: String(pageSize),
    order: "fechaRecepcion",
    direccion: "desc",
    regiones: String(REGION_COMUNIDAD_DE_MADRID),
    tiposBeneficiario: String(BENEFICIARIO_PERSONAS_FISICAS_SIN_ACTIVIDAD),
    tipoAdministracion: group.tipoAdministracion,
  });
  return `${API_BASE}/convocatorias/busqueda?${params.toString()}`;
}

function buildDetailUrl(numero) {
  const params = new URLSearchParams({ vpd: VPD, numConv: String(numero) });
  return `${API_BASE}/convocatorias?${params.toString()}`;
}

function publicUrl(numero) {
  return `https://www.infosubvenciones.es/bdnstrans/GE/es/convocatorias/${encodeURIComponent(numero)}`;
}

async function fetchJson(url, { timeoutMs = 25000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} en ${url}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Descarga todas las paginas del grupo y devuelve solo las registradas
// dentro de la ventana [sinceIso, today].
async function fetchGroupSince(group, sinceIso, { maxPages = 40, pageSize = 100 } = {}) {
  const out = [];
  for (let page = 0; page < maxPages; page += 1) {
    const data = await fetchJson(buildSearchUrl(group, { page, pageSize }));
    const items = Array.isArray(data.content) ? data.content : [];
    if (items.length === 0) break;

    let reachedOlder = false;
    for (const item of items) {
      const fecha = String(item.fechaRecepcion || "").slice(0, 10);
      if (fecha && fecha < sinceIso) {
        reachedOlder = true;
        break;
      }
      out.push(item);
    }
    if (reachedOlder) break;
    if (page + 1 >= (data.totalPages || 1)) break;
  }
  return out;
}

async function fetchDetail(numero) {
  try {
    const j = await fetchJson(buildDetailUrl(numero));
    const tipos = Array.isArray(j.tiposBeneficiarios)
      ? j.tiposBeneficiarios.map((t) => t.descripcion)
      : [];
    return {
      ok: true,
      abierto: j.abierto === true,
      tiposBeneficiarios: tipos,
      fechaInicio: j.fechaInicioSolicitud || null,
      fechaFin: j.fechaFinSolicitud || null,
      presupuestoTotal: j.presupuestoTotal || null,
      organo: j.organo || null,
      regiones: Array.isArray(j.regiones) ? j.regiones.map((r) => r.descripcion) : [],
      fondos: Array.isArray(j.fondos) ? j.fondos.map((f) => f.descripcion) : [],
    };
  } catch (error) {
    return { ok: false, error: error.message, abierto: null };
  }
}

// Tiene el beneficiario objetivo? (comprueba el detalle si esta disponible)
function includesTargetBeneficiary(detail) {
  if (!detail || !detail.ok || !detail.tiposBeneficiarios) return null;
  return detail.tiposBeneficiarios.some((t) =>
    /PERSONAS F[IÍ]SICAS QUE NO DESARROLLAN ACTIVIDAD ECON[OÓ]MICA/i.test(t)
  );
}

// Concurrencia limitada para consultar los detalles.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let index = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Ejecuta una vigilancia.
 * @param {object} opts
 * @param {Date} [opts.now]
 * @param {string} [opts.windowHours=24] ventana hacia atras en horas
 * @param {function} [opts.onProgress]
 * @returns {Promise<{ since: string, today: string, groups: object[], total: number, items: object[] }>}
 */
async function runWatch({ now = new Date(), windowHours = 24, onProgress } = {}) {
  const today = now.toISOString().slice(0, 10);
  const sinceDate = new Date(now.getTime() - windowHours * 3600 * 1000);
  const since = sinceDate.toISOString().slice(0, 10);

  const groups = [];
  const allItems = [];

  for (const group of Object.values(GROUPS)) {
    onProgress?.({ stage: "search", group: group.id });
    const raw = await fetchGroupSince(group, since);
    onProgress?.({ stage: "detail", group: group.id, count: raw.length });

    const withDetail = await mapLimit(raw, 6, async (item) => {
      const detail = await fetchDetail(item.numeroConvocatoria);
      return { item, detail };
    });

    const accepted = [];
    for (const { item, detail } of withDetail) {
      const open = detail.ok ? detail.abierto === true : null;
      const benf = includesTargetBeneficiary(detail);
      // Solo abiertas. Si el detalle fallo, se descarta (no podemos confirmar).
      if (open !== true) continue;
      if (benf === false) continue;

      accepted.push({
        grupo: group.id,
        grupoLabel: group.label,
        numero: item.numeroConvocatoria,
        descripcion: item.descripcion,
        descripcionLeng: item.descripcionLeng || null,
        fechaRecepcion: item.fechaRecepcion,
        organo: item.nivel3 || (detail.organo && detail.organo.nivel3) || "",
        administracion: item.nivel1 || "",
        comunidad: item.nivel2 || "",
        regiones: detail.regiones || [],
        tiposBeneficiarios: detail.tiposBeneficiarios || [],
        fechaInicio: detail.fechaInicio,
        fechaFin: detail.fechaFin,
        presupuestoTotal: detail.presupuestoTotal,
        fondos: detail.fondos || [],
        url: publicUrl(item.numeroConvocatoria),
      });
    }

    groups.push({ id: group.id, label: group.label, found: raw.length, accepted: accepted.length });
    allItems.push(...accepted);
  }

  allItems.sort((a, b) => {
    if (a.grupo !== b.grupo) return a.grupo === "madrid" ? -1 : 1;
    return String(b.fechaRecepcion).localeCompare(String(a.fechaRecepcion));
  });

  return { since, today, windowHours, groups, total: allItems.length, items: allItems };
}

module.exports = {
  API_BASE,
  REGION_COMUNIDAD_DE_MADRID,
  BENEFICIARIO_PERSONAS_FISICAS_SIN_ACTIVIDAD,
  GROUPS,
  buildSearchUrl,
  buildDetailUrl,
  publicUrl,
  fetchJson,
  fetchGroupSince,
  fetchDetail,
  runWatch,
};
