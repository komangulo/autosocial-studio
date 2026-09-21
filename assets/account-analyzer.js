// Account analyzer for AutoSocial Studio.
// MARKER: ACCTAN-v1
//
// Extracts a public X profile's recent posts and replies using the account's
// saved Playwright session (.profiles/<accountId>/x), then produces a content
// "DNA" report: pillars, tone, sentiment, structure, hooks and CTAs.
//
// Works for ANY handle: the handle is a parameter, stored per profile, and can
// be changed at any time. Nothing is hard-coded to a single account.

const fs = require("fs/promises");
const path = require("path");
const { config } = require("./config");

const STORE_DIR = path.resolve(config.projectRoot, ".runtime", "account-analysis");
const MANUAL_DIR = path.resolve(config.projectRoot, ".runtime", "account-analysis", "manuals");
const REPORT_DIR = path.resolve(config.projectRoot, ".runtime", "account-analysis", "reports");
const MAX_POSTS = 400;
const SCROLL_PAUSE_MS = 1800;
const MAX_SCROLLS = 60;

function nowIso() { return new Date().toISOString(); }
function safeHandle(handle) { return String(handle || "").replace(/^@/, "").trim().replace(/[^A-Za-z0-9_]/g, ""); }
function storePath(handle) { return path.join(STORE_DIR, `${safeHandle(handle).toLowerCase()}.json`); }
function manualPath(handle) { return path.join(MANUAL_DIR, `${safeHandle(handle).toLowerCase()}.md`); }
// Un informe por analisis, con fecha y hora en el nombre: <cuenta>__<YYYYMMDD-HHMMSS>.json
function reportDir(handle) { return path.join(REPORT_DIR, safeHandle(handle).toLowerCase()); }
function reportStamp(date) {
  const d = date || new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function reportPath(handle, stamp) { return path.join(reportDir(handle), `${stamp}.json`); }
function reportManualPath(handle, stamp) { return path.join(reportDir(handle), `${stamp}.md`); }

let activeJob = null;

async function ensureDirs() {
  await fs.mkdir(STORE_DIR, { recursive: true });
  await fs.mkdir(MANUAL_DIR, { recursive: true });
  await fs.mkdir(REPORT_DIR, { recursive: true });
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return fallback; }
}
async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(tmp, file);
}

// ---------------------------------------------------------------------------
// Extraction (runs in the browser via Playwright)
// ---------------------------------------------------------------------------

function extractionScript(handle, maxPosts) {
  return `(() => {
    const HANDLE = ${JSON.stringify(handle.toLowerCase())};
    const MAX = ${maxPosts};
    const seen = new Set();
    const items = [];
    const cells = [...document.querySelectorAll('article, [data-testid="cellInnerDiv"]')];
    for (const cell of cells) {
      if (items.length >= MAX) break;
      const links = [...cell.querySelectorAll('a[href*="/status/"]')].map((a) => a.getAttribute("href"));
      const statusLink = links.find((h) => /^\\/[A-Za-z0-9_]+\\/status\\/\\d+$/.test(h || ""));
      if (!statusLink) continue;
      const author = statusLink.split("/")[1].toLowerCase();
      const id = statusLink.split("/").pop();
      if (seen.has(id)) continue;
      const textEl = cell.querySelector('[data-testid="tweetText"]');
      const timeEl = cell.querySelector("time");
      const text = textEl ? textEl.innerText.trim() : (cell.innerText || "").trim();
      if (!text) continue;
      seen.add(id);
      const isOwn = author === HANDLE;
      const socialContext = cell.querySelector('[data-testid="socialContext"]');
      const engagement = {};
      for (const label of ["reply", "retweet", "like", "bookmark"]) {
        const node = cell.querySelector('[data-testid="' + label + '"]');
        const value = node ? (node.innerText || "").trim() : "";
        engagement[label] = value;
      }
      items.push({
        id,
        url: "https://x.com" + statusLink,
        author,
        own: isOwn,
        isReply: Boolean(socialContext) || !isOwn,
        socialContext: socialContext ? socialContext.innerText.trim().slice(0, 120) : "",
        text: text.slice(0, 2000),
        datetime: timeEl ? timeEl.getAttribute("datetime") : null,
        hasImage: Boolean(cell.querySelector('[data-testid="tweetPhoto"]')),
        hasVideo: Boolean(cell.querySelector('[data-testid="videoPlayer"], video')),
        emojis: (text.match(/\\p{Extended_Pictographic}/gu) || []).length,
        length: text.length,
        engagement,
      });
    }
    return items;
  })()`;
}

async function openProfilePage(page, handle) {
  await page.goto(`https://x.com/${handle}`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(4000);
  return page.url();
}

async function collectPosts(page, handle, maxPosts, onProgress) {
  const collected = new Map();
  let scrolls = 0;
  let stagnant = 0;
  while (collected.size < maxPosts && scrolls < MAX_SCROLLS) {
    const batch = await page.evaluate(extractionScript(handle, maxPosts));
    let added = 0;
    for (const item of batch) {
      if (!collected.has(item.id)) { collected.set(item.id, item); added += 1; }
    }
    if (typeof onProgress === "function") onProgress(collected.size);
    if (added === 0) stagnant += 1; else stagnant = 0;
    if (stagnant >= 5) break;
    await page.evaluate("window.scrollBy(0, window.innerHeight * 1.6)");
    await page.waitForTimeout(SCROLL_PAUSE_MS);
    scrolls += 1;
  }
  return [...collected.values()];
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

const STOPWORDS = new Set(("de la que el en y a los del se las por un para con no una su al lo es mas pero sus le ya o este si porque esta entre cuando muy sin sobre tambien me hasta hay donde quien desde todo nos durante todos uno les ni contra otros ese eso ante ellos e esto mi antes algunos que unos yo otro otras otra el tanto esa estos mucho quienes nada muchos cual poco ella estar estas algunas algo nosotros my the and for you that with this your are have from they will not but can all just his her she him its our out get got one two how why what when who are was were been being do does did have has had i is it be as at on in to of or if so we us he me my you your them their there here about into over after before more most some such only own same than too very s t don now d ll m o re ve y ain aren couldn didn doesn hadn hasn haven isn ma mightn mustn needn shan shouldn wasn weren won wouldn https http com www x t co rt amp via").split(/\s+/));

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[@#]\w+/g, " ")
    .replace(/[^a-z0-9áéíóúñü\s]/gi, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w));
}

const POSITIVE = ["love","great","amazing","best","awesome","good","happy","excited","win","winning","beautiful","thanks","thank","cool","nice","perfect","incredible","proud","success","growth","fun","enjoy","brilliant","recommend","helpful"].map((w) => w);
const NEGATIVE = ["hate","bad","worst","terrible","awful","sad","angry","fail","failed","failure","problem","issue","bug","broken","scam","stupid","wrong","annoying","frustrating","decline","crisis","worry","scared","afraid","warn","risk"].map((w) => w);

function sentimentOf(tokens) {
  let pos = 0; let neg = 0;
  for (const token of tokens) {
    if (POSITIVE.includes(token)) pos += 1;
    if (NEGATIVE.includes(token)) neg += 1;
  }
  const total = pos + neg;
  if (!total) return { label: "neutral", score: 0, pos, neg };
  const score = (pos - neg) / total;
  return { label: score > 0.2 ? "positivo" : score < -0.2 ? "negativo" : "neutral", score: Number(score.toFixed(2)), pos, neg };
}

function topKeywords(tokens, limit = 40) {
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([word, count]) => ({ word, count }));
}

const TOPIC_RULES = [
  { topic: "Inteligencia artificial", words: ["ai","gpt","llm","model","models","openai","anthropic","claude","gemini","prompt","prompts","agent","agents","machine","learning","neural","chatgpt","midjourney","diffusion","inference","tokens","embedding","copilot","deepseek","grok"] },
  { topic: "Indie hacking / SaaS", words: ["saas","startup","startups","indie","hacker","hackers","launch","launched","mrr","arr","revenue","product","products","founder","founders","bootstrapped","customers","churn","growth","pricing","stripe","acquisition","solopreneur"] },
  { topic: "Programación / producto", words: ["code","coding","developer","dev","devs","programming","ship","shipped","build","built","building","bug","bugs","feature","features","javascript","python","react","api","database","deploy","framework","app","apps","software"] },
  { topic: "Nómada digital / viajes", words: ["nomad","nomads","travel","traveling","thailand","bali","portugal","lisbon","visa","country","countries","city","cities","airport","flight","hotel","abroad","expat"] },
  { topic: "Fotografía / imagen", words: ["photo","photos","photography","image","images","camera","lens","headshot","portrait","render","rendering","upscale"] },
  { topic: "Negocio / dinero", words: ["money","dollars","income","profit","invest","investment","market","markets","economy","inflation","tax","taxes","bank","crypto","bitcoin","etf","stock","stocks","valuation"] },
  { topic: "Política / sociedad", words: ["government","regulation","regulatory","law","laws","policy","politician","politics","election","vote","freedom","censorship","immigration","court","senate","congress"] },
];

function classifyTopics(tokens) {
  const counts = new Map();
  for (const token of tokens) {
    for (const rule of TOPIC_RULES) {
      if (rule.words.includes(token)) counts.set(rule.topic, (counts.get(rule.topic) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([topic, count]) => ({ topic, count }));
}

function hookTypes(posts) {
  const stats = { pregunta: 0, dato: 0, afirmacion: 0, historia: 0, otro: 0 };
  for (const post of posts) {
    const first = String(post.text || "").split(/\n/)[0].trim();
    if (/\?$/.test(first)) stats.pregunta += 1;
    else if (/^\d|%|\$|€/.test(first)) stats.dato += 1;
    else if (/^(i |yo |we |creo|pienso|think|belie)/i.test(first)) stats.afirmacion += 1;
    else if (first.length > 0 && first.length < 60 && !first.includes(".")) stats.historia += 1;
    else stats.otro += 1;
  }
  return stats;
}

function ctaTypes(posts) {
  const patterns = {
    enlaces: /https?:\/\//i,
    preguntas: /\?/,
    follow: /\bfollow\b|\bsigue\b/i,
    comentar: /\bcomment\b|\bcomenta\b|\breply\b|\bresponde\b/i,
    probar: /\btry\b|\bprueba\b|\bcheck out\b|\bmira\b|\bvisit\b|\bvisita\b/i,
  };
  const stats = {};
  for (const [label, re] of Object.entries(patterns)) {
    stats[label] = posts.filter((p) => re.test(p.text)).length;
  }
  return stats;
}

function formatBreakdown(posts) {
  const own = posts.filter((p) => p.own && !p.isReply);
  const replies = posts.filter((p) => p.isReply || !p.own);
  const withImage = posts.filter((p) => p.hasImage).length;
  const withVideo = posts.filter((p) => p.hasVideo).length;
  const multiline = posts.filter((p) => p.text.includes("\n")).length;
  const withHashtag = posts.filter((p) => /#\w/.test(p.text)).length;
  const withMention = posts.filter((p) => /@\w/.test(p.text)).length;
  const withEmoji = posts.filter((p) => /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(p.text)).length;
  const lengths = posts.map((p) => p.length).sort((a, b) => a - b);
  const avg = lengths.length ? Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length) : 0;
  const median = lengths.length ? lengths[Math.floor(lengths.length / 2)] : 0;
  const short = posts.filter((p) => p.length <= 120).length;
  const medium = posts.filter((p) => p.length > 120 && p.length <= 280).length;
  const long = posts.filter((p) => p.length > 280).length;
  const threads = posts.filter((p) => /🧵|thread|\d\/\d|1\//i.test(p.text)).length;
  return {
    total: posts.length,
    originalPosts: own.length,
    replies: replies.length,
    avgLength: avg,
    medianLength: median,
    lengthBuckets: { cortos: short, medios: medium, largos: long },
    withImage,
    withVideo,
    multiline,
    withHashtag,
    withMention,
    withEmoji,
    emojiRatio: posts.length ? Number((withEmoji / posts.length).toFixed(2)) : 0,
    possibleThreads: threads,
  };
}

function postingRhythm(posts) {
  const byHour = new Array(24).fill(0);
  const byWeekday = new Array(7).fill(0);
  let first = null; let last = null;
  for (const post of posts) {
    if (!post.datetime) continue;
    const date = new Date(post.datetime);
    if (Number.isNaN(date.getTime())) continue;
    byHour[date.getUTCHours()] += 1;
    byWeekday[date.getUTCDay()] += 1;
    if (!first || date < first) first = date;
    if (!last || date > last) last = date;
  }
  const days = first && last ? Math.max(1, (last - first) / 86400000) : 1;
  return {
    byHourUtc: byHour,
    byWeekday: byWeekday,
    postsPerDay: Number((posts.length / days).toFixed(2)),
    firstPost: first ? first.toISOString() : null,
    lastPost: last ? last.toISOString() : null,
    spanDays: Math.round(days),
  };
}

function analyze(posts) {
  const original = posts.filter((p) => p.own && !p.isReply);
  const conversation = posts.filter((p) => p.isReply || !p.own);
  const tokens = original.flatMap((p) => tokenize(p.text));
  const allTokens = posts.flatMap((p) => tokenize(p.text));
  return {
    generatedAt: nowIso(),
    format: formatBreakdown(posts),
    topics: classifyTopics(allTokens),
    keywords: topKeywords(tokens, 40),
    sentiment: sentimentOf(allTokens),
    hooks: hookTypes(original),
    ctas: ctaTypes(posts),
    rhythm: postingRhythm(posts),
    sampleOriginal: original.slice(0, 25).map((p) => ({ text: sanitizeSample(p.text), datetime: p.datetime, length: p.length })),
    sampleConversation: conversation.slice(0, 15).map((p) => ({ text: sanitizeSample(p.text), author: "cuenta", datetime: p.datetime })),
  };
}

// Quita de las muestras todo lo que nunca debe acabar en un post:
// arrobas, enlaces, correos y hashtags. Deja el texto legible.
function sanitizeSample(text) {
  return String(text || "")
    .replace(/https?:\/\/\S+/gi, "[enlace]")
    .replace(/\bwww\.\S+/gi, "[enlace]")
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, "[correo]")
    .replace(/(^|\s)@[A-Za-z0-9_]{1,15}\b/g, "$1[usuario]")
    .replace(/(^|\s)#([\p{L}\p{N}_]+)/gu, "$1$2")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

function buildManual(handle, profile, analysis, posts) {
  const f = analysis.format;
  const topics = analysis.topics.length
    ? analysis.topics.map((t) => `- **${t.topic}** — ${t.count} menciones`).join("\n")
    : "- (sin datos suficientes)";
  const keywords = analysis.keywords.slice(0, 25).map((k) => k.word).join(", ");
  const hours = analysis.rhythm.byHourUtc
    .map((count, hour) => ({ hour, count }))
    .filter((h) => h.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 6)
    .map((h) => `${String(h.hour).padStart(2, "0")}:00 UTC (${h.count})`)
    .join(", ");
  const weekdays = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"];

  return `# Manual de ADN (cuenta de referencia)

<!--
AVISO PARA LA IA -- LEER ANTES DE USAR
Este bloque y todas las lineas que empiezan por "<!-- REF:" son SOLO informativas.
NUNCA copies, cites ni incluyas su contenido en un post publicado.
En concreto, un post generado NUNCA debe contener:
  - nombres de usuario, arrobas ni menciones (@cualquiera)
  - enlaces, URLs, dominios ni correos
  - hashtags
  - el nombre de la cuenta de referencia ni ninguna marca ajena
Los textos de muestra van saneados: donde habia un usuario pone [usuario] y donde
habia un enlace pone [enlace]. Esos marcadores tampoco deben aparecer en un post.
-->

<!-- REF: cuenta de referencia = una cuenta publica estudiada, NO el autor del post futuro -->
<!-- REF: origen = perfil publico de X leido con la sesion del usuario -->
<!-- REF: generado = ${analysis.generatedAt} -->
<!-- REF: muestra = ${f.total} publicaciones (${f.originalPosts} propias, ${f.replies} respuestas) en ${analysis.rhythm.spanDays} dias -->

> Este documento describe **como comunica** la cuenta, no **que dice**.
> El contenido que se genere a partir de el es original y nuevo, y no debe
> mencionar a la cuenta de referencia ni incluir enlaces.

---

## 1. Pilares de contenido

${topics}

Palabras mas frecuentes en sus posts propios: ${keywords || "(sin datos)"}

## 2. Tono y voz

Analisis automatico (afinar manualmente tras leer la muestra):

- Longitud media: **${f.avgLength} caracteres** (mediana ${f.medianLength}).
- Posts cortos (<=120): ${f.lengthBuckets.cortos} · Medios (121-280): ${f.lengthBuckets.medios} · Largos (>280): ${f.lengthBuckets.largos}.
- Usa saltos de linea en ${f.multiline} de ${f.total} publicaciones.
- Emojis en ${f.withEmoji} de ${f.total} (ratio ${f.emojiRatio}).
- Hashtags en ${f.withHashtag} · Menciones en ${f.withMention}.
- Imagen en ${f.withImage} · Video en ${f.withVideo}.

## 3. Analisis de sentimiento

- Predominante: **${analysis.sentiment.label}** (score ${analysis.sentiment.score}).
- Terminos positivos detectados: ${analysis.sentiment.pos} · negativos: ${analysis.sentiment.neg}.

## 4. Estructura y patrones

- Formato: ${f.originalPosts} posts propios frente a ${f.replies} respuestas (proporcion ${f.total ? Math.round((f.originalPosts / f.total) * 100) : 0}/${f.total ? Math.round((f.replies / f.total) * 100) : 0}).
- Hilos detectados: ${f.possibleThreads}.

Ganchos de apertura:
- Preguntas: ${analysis.hooks.pregunta}
- Datos/cifras: ${analysis.hooks.dato}
- Afirmaciones en primera persona: ${analysis.hooks.afirmacion}
- Frases cortas: ${analysis.hooks.historia}
- Otros: ${analysis.hooks.otro}

## 5. Comunicacion con la audiencia

- Con enlace: ${analysis.ctas.enlaces}
- Con pregunta: ${analysis.ctas.preguntas}
- Invita a seguir: ${analysis.ctas.follow}
- Invita a comentar: ${analysis.ctas.comentar}
- Invita a probar/visitar: ${analysis.ctas.probar}

## 6. Ritmo de publicacion

- Frecuencia estimada: **${analysis.rhythm.postsPerDay} publicaciones/dia**.
- Ventana analizada: ${analysis.rhythm.firstPost || "?"} a ${analysis.rhythm.lastPost || "?"}.
- Horas mas activas: ${hours || "(sin datos)"}.
- Dias mas activos: ${analysis.rhythm.byWeekday.map((c, i) => `${weekdays[i]} (${c})`).sort().slice(-3).join(", ")}.

## 7. Muestra de posts propios (texto saneado — solo para estudiar el estilo)

${analysis.sampleOriginal.map((p, i) => `${i + 1}. (${p.length} car.) ${p.text.replace(/\n/g, " ").slice(0, 280)}`).join("\n") || "(sin muestra)"}

## 8. Muestra de conversacion (texto saneado — solo para estudiar el estilo)

${analysis.sampleConversation.map((p, i) => `${i + 1}. ${p.text.replace(/\n/g, " ").slice(0, 200)}`).join("\n") || "(sin muestra)"}

---

## Prompt maestro derivado

\`\`\`
Escribe en espanol de Espana, imitando el tono y la voz de la cuenta de referencia.
Temas: ${analysis.topics.slice(0, 4).map((t) => t.topic).join(", ") || "segun la referencia"}.
Longitud objetivo: alrededor de ${f.avgLength} caracteres (nunca mas de 280).
${f.emojiRatio < 0.15 ? "Usa emojis con moderacion." : "Usa emojis de forma natural."}
${f.multiline / Math.max(f.total, 1) > 0.4 ? "Usa saltos de linea para respirar el texto." : "Escribe en parrafos compactos."}

PROHIBIDO TERMINANTEMENTE en el post:
- nombres de usuario, arrobas o menciones (@cualquiera)
- enlaces, URLs, dominios o correos electronicos
- hashtags
- el nombre de ninguna cuenta, marca o persona real
- los marcadores [usuario], [enlace] o [correo]

Prohibido tambien: introducciones formales, resumenes, "en el mundo actual",
"es importante destacar", "descubre como", "no te lo pierdas", listas de tres
puntos y cualquier muletilla de IA.
Devuelve solo el texto del post.
\`\`\`
`;
}

// ---------------------------------------------------------------------------
// Job control
// ---------------------------------------------------------------------------

async function getStatus() {
  if (!activeJob) return { running: false };
  return { ...activeJob };
}

async function listProfiles() {
  await ensureDirs();
  let files = [];
  try { files = await fs.readdir(STORE_DIR); } catch { return []; }
  const profiles = [];
  for (const file of files) {
    if (!file.endsWith(".json") || file.endsWith(".tmp")) continue;
    const data = await readJson(path.join(STORE_DIR, file), null);
    if (!data || !data.handle) continue;
    profiles.push({
      handle: data.handle,
      analyzedAt: data.analysis?.generatedAt || data.fetchedAt,
      posts: data.analysis?.format?.total || 0,
      originals: data.analysis?.format?.originalPosts || 0,
      replies: data.analysis?.format?.replies || 0,
      topTopics: (data.analysis?.topics || []).slice(0, 3).map((t) => t.topic),
      manual: manualPath(data.handle),
    });
  }
  return profiles.sort((a, b) => String(b.analyzedAt).localeCompare(String(a.analyzedAt)));
}

async function get(handle) {
  await ensureDirs();
  const data = await readJson(storePath(handle), null);
  if (!data) return null;
  let manual = "";
  try { manual = await fs.readFile(manualPath(handle), "utf8"); } catch {}
  return { ...data, manual };
}

async function remove(handle) {
  await fs.rm(storePath(handle), { force: true });
  await fs.rm(manualPath(handle), { force: true });
  await fs.rm(reportDir(handle), { recursive: true, force: true });
  return { ok: true, handle: safeHandle(handle) };
}

// --- Historial de informes (cada analisis se guarda con fecha y hora) --------

function stampLabel(stamp) {
  // "20260918-163045" -> "18/09/2026 16:30:45"
  const m = String(stamp).match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
  if (!m) return stamp;
  return `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}:${m[6]}`;
}

async function saveReport(handle, record, manual) {
  await ensureDirs();
  const stamp = reportStamp(new Date());
  const dir = reportDir(handle);
  await fs.mkdir(dir, { recursive: true });
  await writeJson(reportPath(handle, stamp), { ...record, stamp, reportAt: nowIso() });
  await fs.writeFile(reportManualPath(handle, stamp), manual, "utf8");
  return stamp;
}

/**
 * Lista los informes guardados. Sin handle, devuelve todos (agrupables por
 * cuenta); con handle, solo los de esa cuenta. Orden: mas reciente primero.
 */
async function listReports(handle) {
  await ensureDirs();
  const out = [];
  let accounts = [];
  try { accounts = await fs.readdir(REPORT_DIR); } catch { return []; }
  for (const account of accounts) {
    if (handle && account.toLowerCase() !== safeHandle(handle).toLowerCase()) continue;
    const dir = path.join(REPORT_DIR, account);
    let files = [];
    try { files = await fs.readdir(dir); } catch { continue; }
    for (const file of files) {
      if (!file.endsWith(".json") || file.endsWith(".tmp")) continue;
      const data = await readJson(path.join(dir, file), null);
      if (!data || !data.handle) continue;
      const stamp = data.stamp || file.replace(/\.json$/, "");
      out.push({
        handle: data.handle,
        stamp,
        label: stampLabel(stamp),
        analyzedAt: data.analysis?.generatedAt || data.fetchedAt || "",
        posts: data.analysis?.format?.total || 0,
        originals: data.analysis?.format?.originalPosts || 0,
        replies: data.analysis?.format?.replies || 0,
        maxPosts: data.maxPosts || 0,
        topTopics: (data.analysis?.topics || []).slice(0, 3).map((t) => t.topic),
        manual: reportManualPath(data.handle, stamp),
      });
    }
  }
  return out.sort((a, b) => String(b.stamp).localeCompare(String(a.stamp)));
}

async function getReport(handle, stamp) {
  await ensureDirs();
  const clean = safeHandle(handle);
  const data = await readJson(reportPath(clean, stamp), null);
  if (!data) return null;
  let manual = "";
  try { manual = await fs.readFile(reportManualPath(clean, stamp), "utf8"); } catch {}
  return { ...data, manual, stamp };
}

async function removeReport(handle, stamp) {
  await fs.rm(reportPath(handle, stamp), { force: true });
  await fs.rm(reportManualPath(handle, stamp), { force: true });
  return { ok: true, handle: safeHandle(handle), stamp };
}

/**
 * Carga un informe del historial como el vigente: pasa a ser el que usan el
 * dashboard y la publicacion diaria, sin volver a analizar.
 */
async function useReport(handle, stamp) {
  const report = await getReport(handle, stamp);
  if (!report) throw new Error("Ese informe no existe en el historial.");
  await writeJson(storePath(handle), report);
  await fs.mkdir(MANUAL_DIR, { recursive: true });
  await fs.writeFile(manualPath(handle), report.manual || "", "utf8");
  return { ok: true, handle: safeHandle(handle), stamp };
}

async function start(handle, options = {}) {
  const clean = safeHandle(handle);
  if (!clean) throw new Error("Indica un usuario de X valido (sin espacios).");
  if (activeJob?.running) throw new Error(`Ya hay un analisis en curso: @${activeJob.handle}`);

  const maxPosts = Math.max(20, Math.min(MAX_POSTS, Number(options.maxPosts) || 300));
  activeJob = {
    running: true, handle: clean, startedAt: nowIso(),
    collected: 0, maxPosts, phase: "abriendo perfil", error: null, done: null,
  };

  run(clean, maxPosts).catch((error) => {
    if (activeJob) { activeJob.running = false; activeJob.error = error.message; activeJob.phase = "error"; }
  });
  return { ...activeJob };
}

async function run(handle, maxPosts) {
  await ensureDirs();
  const xAuth = require("./x-auth");
  const session = await xAuth.getSessionStatus();
  if (!session.saved) {
    throw new Error("Necesitas iniciar sesion en X (recuadro Sesion de X, en esta misma pestana) antes de analizar una cuenta.");
  }

  const { context, page, close, reused } = await xAuth.openScratchContext();
  console.log(`[acct-analyzer] iniciando @${handle} (${maxPosts} publicaciones)${reused ? " reutilizando la ventana abierta" : ""}`);
  try {
    activeJob.phase = "cargando perfil";
    const finalUrl = await openProfilePage(page, handle);
    if (/\/i\/flow\/login|\/login/.test(finalUrl)) {
      throw new Error("X pidio iniciar sesion otra vez. Vuelve a guardar tu sesion con el boton Iniciar sesion.");
    }

    activeJob.phase = "recogiendo publicaciones";
    const posts = await collectPosts(page, handle, maxPosts, (count) => {
      if (activeJob) activeJob.collected = count;
      if (count % 10 === 0) console.log(`[acct-analyzer] @${handle}: ${count}/${maxPosts} publicaciones`);
    });
    activeJob.collected = posts.length;
    console.log(`[acct-analyzer] @${handle}: recogidas ${posts.length} publicaciones`);
    if (!posts.length) {
      throw new Error("No se pudo extraer ninguna publicacion. Comprueba que el usuario existe y que la sesion de X sigue activa.");
    }

    activeJob.phase = "analizando";
    const analysis = analyze(posts);

    activeJob.phase = "generando manual";
    const manual = buildManual(handle, null, analysis, posts);

    const record = {
      handle,
      fetchedAt: nowIso(),
      source: `perfil publico de X`,
      maxPosts,
      analysis,
      posts: posts.map((p) => ({ id: p.id, text: sanitizeSample(p.text), datetime: p.datetime, isReply: p.isReply, own: p.own, likes: p.engagement?.like || "" })),
      counts: { total: posts.length, original: analysis.format.originalPosts, replies: analysis.format.replies },
    };
    await writeJson(storePath(handle), record);
    await fs.mkdir(MANUAL_DIR, { recursive: true });
    await fs.writeFile(manualPath(handle), manual, "utf8");
    // Guarda una copia en el historial, con fecha y hora en el nombre.
    const stamp = await saveReport(handle, record, manual);
    console.log(`[acct-analyzer] @${handle}: informe guardado en reports/${handle.toLowerCase()}/${stamp}.json`);

    activeJob.running = false;
    activeJob.phase = "terminado";
    activeJob.done = nowIso();
    activeJob.collected = posts.length;
    activeJob.manual = manualPath(handle);
    activeJob.stamp = stamp;
  } finally {
    await close().catch(() => {});
  }
}

module.exports = {
  MAX_POSTS,
  start,
  run,
  getStatus,
  listProfiles,
  get,
  remove,
  analyze,
  buildManual,
  safeHandle,
  manualPath,
  storePath,
  saveReport,
  listReports,
  getReport,
  removeReport,
  useReport,
  reportStamp,
  stampLabel,
};
