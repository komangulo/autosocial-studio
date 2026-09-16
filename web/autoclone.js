/* Auto Clone — one-button pipeline UI. Relies on the global `API` helper. */
(function initAutoClone() {
  const $ = (id) => document.getElementById(id);

  const els = {
    username: $("autocloneUsername"),
    videoUrl: $("autocloneVideoUrl"),
    videoBtn: $("autocloneVideoBtn"),
    videoHint: $("autocloneVideoHint"),
    startBtn: $("autocloneStartBtn"),
    maxVideos: $("autocloneMaxVideos"),
    downloadOrder: $("autocloneDownloadOrder"),
    downloadThumbnail: $("autocloneDownloadThumbnail"),
    startMode: $("autocloneStartMode"),
    resetHistoryBtn: $("autocloneResetHistoryBtn"),
    intensity: $("autocloneIntensity"),
    metadataLanguage: $("autocloneMetadataLanguage"),
    uniquify: $("autocloneUniquify"),
    translate: $("autocloneTranslate"),
    karaoke: $("autocloneKaraoke"),
    cancelBtn: $("autocloneCancelBtn"),
    keyBtn: $("autocloneKeyBtn"),
    keyPanel: $("autocloneKeyPanel"),
    apiKey: $("autocloneApiKey"),
    saveKeyBtn: $("autocloneSaveKeyBtn"),
    keyStatus: $("autocloneKeyStatus"),
    keyBadge: $("autocloneKeyBadge"),
    barFill: $("autocloneBarFill"),
    stage: $("autocloneStage"),
    videos: $("autocloneVideos"),
    analysis: $("autocloneAnalysis"),
    destination: $("autocloneDestination"),
    destHint: $("autocloneDestHint"),
    openFolderBtn: $("autocloneOpenFolderBtn"),
    deepSeekKey: $("autocloneDeepSeekKey"),
    saveDeepSeekKeyBtn: $("autocloneSaveDeepSeekKeyBtn"),
    deepSeekStatus: $("autocloneDeepSeekStatus"), // DS[ui-els]
  };
  if (!els.startBtn) return;

  let events = null;
  let currentJobId = null;
  let renderedSignature = "";
  let lastJobId = null;

  const DEST_KEY = "autoclone.destination";
  const INTENSITY_KEY = "autoclone.intensity";
  const METADATA_LANGUAGE_KEY = "autoclone.metadataLanguage";
  const DOWNLOAD_ORDER_KEY = "autoclone.downloadOrder";
  const DOWNLOAD_THUMBNAIL_KEY = "autoclone.downloadThumbnail";
  const START_MODE_KEY = "autoclone.startMode";
  const KARAOKE_KEY = "autoclone.karaoke";

  function loadDestination() {
    try { return localStorage.getItem(DEST_KEY) || ""; } catch { return ""; }
  }
  function saveDestination(value) {
    try { localStorage.setItem(DEST_KEY, value); } catch { /* ignore */ }
  }
  function saveIntensity(value) {
    try { localStorage.setItem(INTENSITY_KEY, value); } catch { /* ignore */ }
  }
  function saveDownloadOrder(value) {
    try { localStorage.setItem(DOWNLOAD_ORDER_KEY, value); } catch { /* ignore */ }
  }
  function saveDownloadThumbnail(value) {
    try { localStorage.setItem(DOWNLOAD_THUMBNAIL_KEY, value ? "true" : "false"); } catch { /* ignore */ }
  }
  if (els.destination) els.destination.value = loadDestination();
  if (els.downloadOrder) {
    try {
      const saved = localStorage.getItem(DOWNLOAD_ORDER_KEY);
      if (saved === "oldest" || saved === "recent") els.downloadOrder.value = saved;
    } catch { /* ignore */ }
    els.downloadOrder.addEventListener("change", () => saveDownloadOrder(els.downloadOrder.value));
  }
  if (els.downloadThumbnail) {
    try { els.downloadThumbnail.checked = localStorage.getItem(DOWNLOAD_THUMBNAIL_KEY) === "true"; } catch { /* ignore */ }
    els.downloadThumbnail.addEventListener("change", () => saveDownloadThumbnail(els.downloadThumbnail.checked));
  }
  function saveStartMode(value) {
    try { localStorage.setItem(START_MODE_KEY, value); } catch { /* ignore */ }
  }
  if (els.karaoke) {
    try { els.karaoke.checked = localStorage.getItem(KARAOKE_KEY) === "true"; } catch { /* ignore */ }
    els.karaoke.addEventListener("change", () => {
      try { localStorage.setItem(KARAOKE_KEY, els.karaoke.checked ? "true" : "false"); } catch { /* ignore */ }
    });
  }
  if (els.startMode) {
    try {
      const saved = localStorage.getItem(START_MODE_KEY);
      if (saved === "continue" || saved === "restart") els.startMode.value = saved;
    } catch { /* ignore */ }
    els.startMode.addEventListener("change", () => saveStartMode(els.startMode.value));
  }
  if (els.intensity) {
    try {
      const saved = localStorage.getItem(INTENSITY_KEY);
      if (saved) els.intensity.value = saved;
    } catch { /* ignore */ }
    els.intensity.addEventListener("change", () => saveIntensity(els.intensity.value));
  }
  if (els.metadataLanguage) {
    try {
      const saved = localStorage.getItem(METADATA_LANGUAGE_KEY);
      if (saved) els.metadataLanguage.value = saved;
    } catch { /* ignore */ }
    els.metadataLanguage.addEventListener("change", () => {
      try { localStorage.setItem(METADATA_LANGUAGE_KEY, els.metadataLanguage.value); } catch { /* ignore */ }
    });
  }
  const esc = (value) => String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  function setBar(percent) {
    els.barFill.style.width = `${Math.max(0, Math.min(100, Number(percent) || 0))}%`;
  }

  async function refreshKeyState() {
    try {
      const data = await API.get("/api/competitor/settings");
      const hasKey = Boolean(data.settings?.hasGeminiKey);
      els.keyBadge.textContent = hasKey ? "IA lista" : "Sin API de IA";
      els.keyBadge.classList.toggle("ok", hasKey);
      els.keyBadge.classList.toggle("warn", !hasKey);
      if (els.keyStatus) {
        els.keyStatus.textContent = hasKey
          ? `API key guardada (${data.settings?.geminiKeyMasked || "oculta"}). El texto en pantalla se traducirá automáticamente.`
          : "No hay API key. Sin ella no se puede traducir el texto en pantalla.";
      }
      if (els.deepSeekStatus) {
        els.deepSeekStatus.textContent = data.settings?.hasDeepSeekKey
          ? `DeepSeek configurado (${data.settings?.deepSeekKeyMasked || "oculta"}).`
          : "DeepSeek sin configurar.";
      } // DS[ui-state]
      return hasKey;
    } catch {
      els.keyBadge.textContent = "Sin API de IA";
      return false;
    }
  }

  async function saveKey() {
    const key = els.apiKey.value.trim();
    if (!key) { els.keyStatus.textContent = "Escribe una API key válida."; return; }
    els.saveKeyBtn.disabled = true;
    try {
      await API.post("/api/competitor/settings", { geminiApiKey: key });
      els.apiKey.value = "";
      els.keyStatus.textContent = "API key guardada.";
      await refreshKeyState();
    } catch (error) {
      els.keyStatus.textContent = error.message;
    } finally {
      els.saveKeyBtn.disabled = false;
    }
  }

  async function saveDeepSeekKey() {
    const key = els.deepSeekKey.value.trim();
    if (!key) { els.deepSeekStatus.textContent = "Escribe la API key de DeepSeek."; return; }
    els.saveDeepSeekKeyBtn.disabled = true;
    try {
      await API.post("/api/competitor/settings", { deepSeekApiKey: key });
      els.deepSeekKey.value = "";
      els.deepSeekStatus.textContent = "API key de DeepSeek guardada.";
      await refreshKeyState();
    } catch (error) {
      els.deepSeekStatus.textContent = error.message;
    } finally {
      els.saveDeepSeekKeyBtn.disabled = false;
    }
  }

  function renderJob(job) { // DS[ui-save]
    if (!job) return;
    if (job.analysis && (job.analysis.summary || job.analysis.error)) {
      els.analysis.hidden = false;
      if (job.analysis.error) {
        els.analysis.innerHTML = `<div class="card"><div class="card-title">Análisis del perfil</div>
          <p class="autoclone-empty">No se pudo completar el análisis: ${esc(job.analysis.error)}</p></div>`;
      } else {
        els.analysis.innerHTML = `<div class="card">
          <div class="card-title">Análisis del perfil ${esc(job.handle)}</div>
          <p>${esc(job.analysis.summary || "")}</p>
          <div class="autoclone-metrics">
            <span><strong>${esc(job.analysis.metrics?.avgViews ?? "—")}</strong> vistas medias</span>
            <span><strong>${esc(job.analysis.metrics?.videoCount ?? job.videos?.length ?? "—")}</strong> vídeos</span>
            <span><strong>${esc(job.analysis.metrics?.engagementRate ?? "—")}</strong> engagement</span>
          </div>
        </div>`;
      }
    }

    const videos = job.videos || [];
    const signature = videos.map((v) => `${v.id}:${v.status}:${v.translated ? 1 : 0}:${v.textBoxes || 0}:${v.error || ""}:${(v.notes || []).join(";")}`).join("|");
    if (signature !== renderedSignature) {
      renderedSignature = signature;
      els.videos.innerHTML = videos.map((video, index) => {
        const label = video.status === "done" ? "Listo" : video.status === "error" ? "Error" : "Pendiente";
        const cls = video.status === "done" ? "ok" : video.status === "error" ? "err" : "wait";
        const tags = [];
        if (video.translated) tags.push(`texto traducido (${video.textBoxes})`);
        else if (video.status === "done") tags.push("sin texto traducible");
        if (video.karaoke) tags.push("karaoke");
        const notes = [...(video.notes || []), video.error].filter(Boolean);
        // "No translatable text" is just information, not an error, so it stays
        // in a neutral tone; real failures are shown in red.
        const onlyInfo = (note) => /no se detecto texto|sin texto traducible|no se pudo traducir/i.test(note);
        return `<div class="autoclone-video">
          <span class="autoclone-video-idx">${index + 1}</span>
          <div class="autoclone-video-body">
            <span class="autoclone-video-id">${esc(video.id)}</span>
            <span class="autoclone-video-tags">${tags.map(esc).join(" · ") || "—"}</span>
            ${notes.map((n) => `<span class="${onlyInfo(n) ? "autoclone-video-note" : "autoclone-video-err"}">${esc(n)}</span>`).join("")}
          </div>
          <span class="autoclone-video-status ${cls}">${label}</span>
          ${video.status === "done" ? `<a class="control-btn-small" href="/api/autoclone/jobs/${encodeURIComponent(job.id)}/download?video=${encodeURIComponent(video.id)}" download>Descargar</a>` : ""}
        </div>`;
      }).join("") || `<p class="autoclone-empty">Aún no hay vídeos en este lote.</p>`;
    }
  }

  async function pollJob() {
    if (!currentJobId) return;
    try {
      const data = await API.get(`/api/autoclone/jobs/${encodeURIComponent(currentJobId)}`);
      renderJob(data.job);
    } catch { /* job may not be flushed yet */ }
  }

  function connectEvents() {
    if (events) events.close();
    events = new EventSource("/api/autoclone/events");
    events.onmessage = (event) => {
      let progress;
      try { progress = JSON.parse(event.data); } catch { return; }
      if (progress.detail) els.stage.textContent = progress.detail;
      if (typeof progress.percent === "number") setBar(progress.percent);
      const running = !["idle", "done", "error", "cancelled"].includes(progress.stage);
      els.cancelBtn.hidden = !running;
      els.startBtn.disabled = running;
      if (progress.stage === "done" || progress.stage === "error" || progress.stage === "cancelled") {
        els.startBtn.disabled = false;
        els.cancelBtn.hidden = true;
        pollJob();
      } else if (["download", "translate", "uniquify"].includes(progress.stage)) {
        pollJob();
      }
    };
    events.onerror = () => { /* EventSource auto-reconnects */ };
  }

  async function start(override = {}) {
    const videoUrl = (override.videoUrl ?? els.videoUrl?.value ?? "").trim();
    const username = (override.username ?? els.username.value).trim();
    if (!videoUrl && !username) {
      els.stage.textContent = "Escribe un usuario de TikTok o pega la URL de un vídeo.";
      return;
    }
    const destinationRoot = els.destination?.value.trim() || "";
    els.startBtn.disabled = true;
    if (els.videoBtn) els.videoBtn.disabled = true;
    renderedSignature = "";
    els.videos.innerHTML = `<p class="autoclone-empty">Preparando el lote...</p>`;
    els.analysis.hidden = true;
    setBar(1);
    try {
      const data = await API.post("/api/autoclone/start", {
        username,
        videoUrl,
        maxVideos: Number(els.maxVideos.value) || 0,
         uniquify: els.uniquify.checked,
         translate: els.translate.checked,
         karaoke: Boolean(els.karaoke?.checked),
         uniquifyIntensity: els.intensity?.value || "media",
         metadataLanguage: els.metadataLanguage?.value || "es",
         downloadOrder: els.downloadOrder?.value || "oldest",
         downloadThumbnail: Boolean(els.downloadThumbnail?.checked),
         startMode: els.startMode?.value || "continue",
         destinationRoot,
      });
      currentJobId = data.id;
      lastJobId = data.id;
       saveDestination(destinationRoot);
       saveDownloadOrder(els.downloadOrder?.value || "oldest");
       saveDownloadThumbnail(Boolean(els.downloadThumbnail?.checked));
       saveStartMode(els.startMode?.value || "continue");
      saveIntensity(els.intensity?.value || "media");
      updateDestHint(data.handle || username, destinationRoot);
      els.stage.textContent = data.singleVideo
        ? `Clonando el vídeo indicado.${data.folder ? ` Guardando en ${data.folder}` : ""}`
        : (data.folder
          ? `Trabajo iniciado para ${data.handle}. Guardando en ${data.folder}`
          : `Trabajo iniciado para ${data.handle}.`);
      connectEvents();
    } catch (error) {
      els.startBtn.disabled = false;
      if (els.videoBtn) els.videoBtn.disabled = false;
      els.stage.textContent = error.message;
      setBar(0);
    }
  }

  function updateDestHint(username, destinationRoot) {
    if (!els.destHint) return;
    const clean = String(username || "").replace(/^@/, "").replace(/^https?:\/\/[^/]+\/?/, "").replace(/\/.*$/, "") || "usuario";
    if (destinationRoot) {
      const sep = destinationRoot.includes("\\") ? "\\" : "/";
      els.destHint.innerHTML = `Se guardarán en <b>${esc(destinationRoot.replace(/[\\/]+$/, ""))}${sep}${esc(clean)}</b>.`;
    } else {
      els.destHint.innerHTML = `Sin carpeta elegida, se guardarán en la carpeta interna <b>.runtime/autoclone</b>. Cada usuario tendrá su propia subcarpeta.`;
    }
  }

  async function openFolder() {
    try {
      const data = await API.post("/api/autoclone/open-folder", { jobId: lastJobId || currentJobId || "" });
      if (data.folder) els.stage.textContent = `Carpeta abierta: ${data.folder}`;
    } catch (error) {
      els.stage.textContent = error.message;
    }
  }

  // Show how many videos of this profile were already downloaded, so "where I
  // left off" is never a mystery.
  async function refreshHistory() {
    if (!els.resetHistoryBtn) return;
    const username = els.username.value.trim();
    if (!username) return;
    try {
      const data = await API.get(`/api/autoclone/history?username=${encodeURIComponent(username)}`);
      els.resetHistoryBtn.title = data.count
        ? `Ya descargados de este perfil: ${data.count}. Pulsa para empezar de cero.`
        : "Este perfil no tiene descargas anteriores.";
      els.resetHistoryBtn.innerHTML = `<i class="ph ph-arrow-counter-clockwise"></i> Reiniciar contador${data.count ? ` (${data.count})` : ""}`;
    } catch { /* ignore */ }
  }

  async function resetHistory() {
    const username = els.username.value.trim();
    if (!username) { els.stage.textContent = "Escribe un nombre de usuario de TikTok."; return; }
    if (!window.confirm(`¿Olvidar los vídeos ya descargados de ${username}? La próxima vez empezará desde el primero.`)) return;
    try {
      await API.post("/api/autoclone/history/reset", { username });
      els.stage.textContent = `Contador reiniciado para ${username}. La próxima descarga empezará desde el primero.`;
      await refreshHistory();
    } catch (error) {
      els.stage.textContent = error.message;
    }
  }

  async function cancel() {
    try { await API.post("/api/autoclone/cancel", {}); } catch { /* ignore */ }
  }

  els.startBtn.addEventListener("click", () => start());
  els.videoBtn?.addEventListener("click", () => {
    const url = (els.videoUrl?.value || "").trim();
    if (!url) { els.stage.textContent = "Pega la URL del vídeo de TikTok que quieres clonar."; return; }
    start({ videoUrl: url });
  });
  els.videoUrl?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      const url = els.videoUrl.value.trim();
      if (url) start({ videoUrl: url });
    }
  });
  els.cancelBtn.addEventListener("click", cancel);
  els.keyBtn.addEventListener("click", () => { els.keyPanel.hidden = !els.keyPanel.hidden; });
  els.saveKeyBtn.addEventListener("click", saveKey);
  els.saveDeepSeekKeyBtn?.addEventListener("click", saveDeepSeekKey); // DS[ui-bind]
  els.username.addEventListener("keydown", (event) => { if (event.key === "Enter") start(); });
  els.openFolderBtn?.addEventListener("click", openFolder);
  els.resetHistoryBtn?.addEventListener("click", resetHistory);
  els.username?.addEventListener("blur", refreshHistory);
  els.username?.addEventListener("change", refreshHistory);
  els.destination?.addEventListener("change", () => {
    saveDestination(els.destination.value.trim());
    updateDestHint(els.username.value.trim(), els.destination.value.trim());
  });
  updateDestHint("", loadDestination());

  document.addEventListener("autosocial:viewchange", (event) => {
    if (event.detail?.viewName === "autoclone") {
      refreshKeyState();
      API.get("/api/autoclone/progress").then((data) => {
        if (data.progress?.detail) els.stage.textContent = data.progress.detail;
        if (typeof data.progress?.percent === "number") setBar(data.progress.percent);
        if (data.running) connectEvents();
      }).catch(() => {});
    }
  });

  refreshKeyState();
  refreshHistory();
})();
