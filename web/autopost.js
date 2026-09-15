/* Auto Post — schedule Auto Clone videos to TikTok by days and times. */
(function initAutoPost() {
  const $ = (id) => document.getElementById(id);

  const els = {
    folder: $("apFolder"),
    chooseBtn: $("apChooseBtn"),
    loadBtn: $("apLoadBtn"),
    useDestBtn: $("apUseDestBtn"),
    days: $("apDays"),
    times: $("apTimes"),
    max: $("apMax"),
    timezone: $("apTimezone"),
    caption: $("apCaption"),
    hashtags: $("apHashtags"),
    locationMadrid: $("apLocationMadrid"),
    locationCustom: $("apLocationCustom"),
    aiGenerated: $("apAiGenerated"),
    previewBtn: $("apPreviewBtn"),
    scheduleBtn: $("apScheduleBtn"),
    startBtn: $("apStartBtn"),
    stopBtn: $("apStopBtn"),
    logBtn: $("apLogBtn"),
    logCopyBtn: $("apLogCopyBtn"),
    logBox: $("apLogBox"),
    message: $("apMessage"),
    plan: $("apPlan"),
    accountBadge: $("apAccountBadge"),
    loginBtn: $("ttLoginBtn"),
    loginBanner: $("ttLoginBanner"),
    loginTitle: $("ttLoginTitle"),
    loginMessage: $("ttLoginMessage"),
    loginBadge: $("ttLoginStateBadge"),
    loginCheckBtn: $("ttLoginCheckBtn"),
    loginCloseBtn: $("ttLoginCloseBtn"),
  };
  if (!els.scheduleBtn) return;

  const esc = (value) => String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  const FOLDER_KEY = "autoclone.destination";

  function rememberedFolder() {
    try { return localStorage.getItem(FOLDER_KEY) || ""; } catch { return ""; }
  }
  function selectedDays() {
    return [...els.days.querySelectorAll("input:checked")].map((input) => input.value);
  }
  function selectedTimes() {
    return els.times.value.split(/[,\n]/).map((t) => t.trim()).filter(Boolean);
  }
  function selectedHashtags() {
    return (els.hashtags?.value || "")
      .split(/[\s,]+/)
      .map((t) => t.trim().replace(/^#+/, ""))
      .filter(Boolean);
  }
  // "Madrid, Spain" when the checkbox is on; otherwise the custom text (if any).
  function selectedLocation() {
    if (els.locationMadrid?.checked) return "Madrid, Spain";
    const custom = (els.locationCustom?.value || "").trim();
    if (custom) return custom;
    return "";
  }
  function isAiGenerated() {
    return Boolean(els.aiGenerated?.checked);
  }

  async function refreshAccount() {
    try {
      const data = await API.get("/api/accounts");
      const account = data?.activeAccount;
      if (account?.id) {
        els.accountBadge.textContent = account.name || account.id;
        els.accountBadge.classList.add("active");
      } else {
        els.accountBadge.textContent = "Sin cuenta activa";
      }
    } catch {
      els.accountBadge.textContent = "Sin cuenta activa";
    }
  }

  function setMessage(text, kind = "") {
    els.message.textContent = text;
    els.message.style.color = kind === "error" ? "var(--status-bad)" : kind === "ok" ? "var(--status-good)" : "";
  }

  async function loadVideos(showMessage = true) {
    const folder = els.folder.value.trim() || rememberedFolder();
    if (!folder) { setMessage("Escribe o elige la carpeta de vídeos.", "error"); return; }
    try {
      const check = await API.post("/api/autoclone/check-folder", { folder });
      if (showMessage) setMessage(`Carpeta correcta: ${check.videoCount} vídeo(s) encontrados.`, "ok");
    } catch (error) {
      setMessage(`No encuentro esa carpeta. Pulsa «Elegir carpeta…» o revisa la ruta. (${error.message})`, "error");
      return [];
    }
    try {
      const data = await API.post("/api/autoclone/schedule/list", { folder });
      if (showMessage) {
        const withMeta = Number(data.withMeta) || 0;
        const total = data.videos.length;
        const metaNote = withMeta > 0
          ? ` ${withMeta} de ${total} llevan su propio título/descripción/hashtags.`
          : " Ninguno trae texto propio; se usará el caption del dashboard.";
        setMessage(`${total} vídeos encontrados en la carpeta.${metaNote}`, "ok");
      }
      return data.videos;
    } catch (error) {
      setMessage(error.message, "error");
      return [];
    }
  }

  function renderPlan(plan) {
    if (!plan?.length) { els.plan.innerHTML = ""; return; }
    els.plan.innerHTML = plan.map((item, index) => `
      <div class="autopost-plan-row">
        <span class="autopost-plan-idx">${index + 1}</span>
        <span class="autopost-plan-video">${esc(item.videoName)}</span>
        <span class="autopost-plan-when">${esc(item.local || item.at)}</span>
      </div>`).join("");
  }

  async function preview() {
    const folder = els.folder.value.trim() || rememberedFolder();
    if (!folder) { setMessage("Escribe o elige la carpeta de vídeos.", "error"); return; }
    els.previewBtn.disabled = true;
    try {
      const data = await API.post("/api/autoclone/schedule/preview", {
        folder,
        days: selectedDays(),
        times: selectedTimes(),
        maxPerRun: Number(els.max.value) || 0,
        timezone: els.timezone.value.trim(),
        hashtags: selectedHashtags(),
        location: selectedLocation(),
        aiGenerated: isAiGenerated(),
      });
      renderPlan(data.plan);
      const extras = [];
      if (data.location) extras.push(`localización «${data.location}»`);
      if (data.hashtags?.length) extras.push(`hashtags ${data.hashtags.map((t) => `#${t}`).join(" ")}`);
      const suffix = extras.length ? ` · ${extras.join(" · ")}` : "";
      setMessage(`Programación prevista: ${data.plan.length} vídeos (de ${data.total}) en zona ${data.timezone}${suffix}.`, "ok");
    } catch (error) {
      setMessage(error.message, "error");
    } finally {
      els.previewBtn.disabled = false;
    }
  }

  async function schedule() {
    const folder = els.folder.value.trim() || rememberedFolder();
    if (!folder) { setMessage("Escribe o elige la carpeta de vídeos.", "error"); return; }
    const days = selectedDays();
    if (!days.length) { setMessage("Elige al menos un día.", "error"); return; }
    if (!selectedTimes().length) { setMessage("Escribe al menos una hora (ej. 10:00).", "error"); return; }
    els.scheduleBtn.disabled = true;
    setMessage("Programando…");
    try {
      const data = await API.post("/api/autoclone/schedule", {
        folder,
        days,
        times: selectedTimes(),
        maxPerRun: Number(els.max.value) || 0,
        timezone: els.timezone.value.trim(),
        captionTemplate: els.caption.value.trim(),
        hashtags: selectedHashtags(),
        location: selectedLocation(),
        aiGenerated: isAiGenerated(),
      });
      renderPlan((data.created || []).map((c) => ({ videoName: c.videoName, local: c.local })));
      const ok = data.created.filter((c) => c.jobId).length;
      setMessage(`Programados ${ok} de ${data.total} vídeos. Se publicarán solos en TikTok.`, "ok");
    } catch (error) {
      setMessage(error.message, "error");
    } finally {
      els.scheduleBtn.disabled = false;
    }
  }

  // ---------------------------------------------------- TikTok login

  async function checkLoginStatus(silent = false) {
    try {
      const data = await API.get("/api/tiktok/login/status");
      const open = Boolean(data?.open);
      const saved = Boolean(data?.saved);
      const launching = Boolean(data?.launching);
      const error = data?.error || "";
      if (els.loginBadge) {
        if (launching) {
          els.loginBadge.textContent = "Abriendo…";
          els.loginBadge.className = "status-badge warn";
        } else if (open) {
          els.loginBadge.textContent = "Ventana abierta";
          els.loginBadge.className = "status-badge active";
        } else if (saved) {
          els.loginBadge.textContent = "Sesión guardada";
          els.loginBadge.className = "status-badge active";
        } else {
          els.loginBadge.textContent = "Sin sesión";
          els.loginBadge.className = "status-badge warn";
        }
      }
      if (els.loginMessage) {
        if (error) {
          els.loginMessage.textContent = /Executable doesn't exist|playwright install/i.test(error)
            ? "No se encontró el navegador. Ejecuta «npx playwright install chromium» en la carpeta del proyecto y vuelve a intentarlo. También vale tener Google Chrome o Edge instalado."
            : `No se pudo abrir la ventana: ${error.split("\n")[0]}`;
        } else if (launching) {
          els.loginMessage.textContent = "Abriendo Chromium… espera unos segundos.";
        } else if (open) {
          els.loginMessage.textContent = "Chromium está abierto en TikTok. Inicia sesión con tu cuenta y vuelve aquí cuando termines; la ventana puedes dejarla abierta.";
        } else if (saved) {
          els.loginMessage.textContent = "Sesión de TikTok guardada en esta cuenta. Ya puedes programar y publicar vídeos.";
        } else {
          els.loginMessage.textContent = "Sin sesión de TikTok. Pulsa «Iniciar sesión en TikTok» para abrir Chromium e iniciar sesión.";
        }
      }
      return data;
    } catch (error) {
      if (!silent && els.loginMessage) els.loginMessage.textContent = error.message;
      return null;
    }
  }

  let loginPollTimer = null;

  function pollLoginUntilSettled() {
    if (loginPollTimer) clearInterval(loginPollTimer);
    let attempts = 0;
    loginPollTimer = setInterval(async () => {
      attempts += 1;
      const data = await checkLoginStatus(true);
      if (!data?.launching || attempts > 20) {
        clearInterval(loginPollTimer);
        loginPollTimer = null;
      }
    }, 1500);
  }

  async function openLogin() {
    if (els.loginBanner) els.loginBanner.hidden = false;
    els.loginBtn.disabled = true;
    if (els.loginTitle) els.loginTitle.textContent = "Sesión de TikTok";
    if (els.loginMessage) els.loginMessage.textContent = "Abriendo Chromium… espera unos segundos.";
    try {
      await API.post("/api/tiktok/login", {});
      pollLoginUntilSettled();
    } catch (error) {
      if (els.loginMessage) els.loginMessage.textContent = error.message;
    } finally {
      els.loginBtn.disabled = false;
    }
  }

  async function closeLogin() {
    try {
      await API.post("/api/tiktok/login/close", {});
      if (els.loginMessage) els.loginMessage.textContent = "Ventana de Chromium cerrada.";
      await checkLoginStatus(true);
    } catch (error) {
      if (els.loginMessage) els.loginMessage.textContent = error.message;
    }
  }

  async function chooseFolder() {
    els.chooseBtn.disabled = true;
    setMessage("Abriendo el selector de carpetas del equipo…");
    try {
      const data = await API.post("/api/autoclone/choose-folder", { startPath: els.folder.value.trim() || rememberedFolder() });
      if (data?.cancelled) { setMessage("No elegiste ninguna carpeta."); return; }
      if (!data?.folder) { setMessage("No se pudo abrir el selector. Escribe o pega la ruta a mano.", "error"); return; }
      els.folder.value = data.folder;
      setMessage(`Carpeta elegida: ${data.folder}`, "ok");
      await loadVideos(true);
    } catch (error) {
      setMessage(`No se pudo abrir el selector. Escribe o pega la ruta a mano. (${error.message})`, "error");
    } finally {
      els.chooseBtn.disabled = false;
    }
  }

  let startPollTimer = null;

  function renderStartProgress(run) {
    if (!run) return;
    const parts = [];
    if (run.total) parts.push(`${run.done || 0}/${run.total} programados`);
    if (run.failed) parts.push(`${run.failed} con error`);
    if (run.lastVideoName) parts.push(`último: ${run.lastVideoName}`);
    if (run.lastScheduledAt) parts.push(`para ${run.lastScheduledAt}`);
    setMessage(parts.join(" · ") || "Programando…", run.failed ? "error" : "ok");
  }

  async function startNow() {
    const folder = els.folder.value.trim() || rememberedFolder();
    if (!folder) { setMessage("Escribe o elige la carpeta de vídeos.", "error"); return; }
    const days = selectedDays();
    if (!days.length) { setMessage("Elige al menos un día.", "error"); return; }
    if (!selectedTimes().length) { setMessage("Escribe al menos una hora (ej. 10:00).", "error"); return; }

    els.startBtn.disabled = true;
    setMessage("Iniciando… la app irá subiendo y programando cada vídeo en TikTok uno detrás de otro.");
    try {
      const data = await API.post("/api/autoclone/schedule/start", {
        folder,
        days,
        times: selectedTimes(),
        maxPerRun: Number(els.max.value) || 0,
        timezone: els.timezone.value.trim(),
        captionTemplate: els.caption.value.trim(),
        hashtags: selectedHashtags(),
        location: selectedLocation(),
        aiGenerated: isAiGenerated(),
      });
      renderStartProgress(data?.run);
      if (startPollTimer) clearInterval(startPollTimer);
      startPollTimer = setInterval(async () => {
        try {
          const status = await API.get("/api/autoclone/schedule/status");
          const run = status?.startRun;
          renderStartProgress(run);
          if (!run?.running) {
            clearInterval(startPollTimer);
            startPollTimer = null;
            els.startBtn.disabled = false;
            if (run?.error) setMessage(`Terminó con un error: ${run.error}`, "error");
            else setMessage(`Listo. ${run?.done || 0} vídeos programados en TikTok. Ya puedes apagar el PC.`, "ok");
          }
        } catch (error) {
          clearInterval(startPollTimer);
          startPollTimer = null;
          els.startBtn.disabled = false;
          setMessage(error.message, "error");
        }
      }, 2500);
    } catch (error) {
      els.startBtn.disabled = false;
      setMessage(error.message, "error");
    }
  }

  async function stopNow() {
    els.stopBtn.disabled = true;
    setMessage("Parando… no se abrirán más ventanas.");
    try {
      await API.post("/api/autoclone/schedule/stop", {});
      if (startPollTimer) { clearInterval(startPollTimer); startPollTimer = null; }
      els.startBtn.disabled = false;
      setMessage("Parado. Al reabrir la app NO se reanudará solo. Pulsa «Programar todo» para volver a empezar.", "ok");
    } catch (error) {
      setMessage(error.message, "error");
    } finally {
      els.stopBtn.disabled = false;
    }
  }

  async function loadDebugLog() {
    try {
      const data = await API.get("/api/autoclone/schedule/log");
      if (els.logBox) {
        els.logBox.style.display = "block";
        els.logBox.value = data?.log?.trim()
          ? data.log
          : `(vacío)\n\nNo hay registro todavía. El archivo se crea al programar un vídeo.\nRuta: ${data?.path || "schedule-debug.log"}`;
        els.logBox.scrollTop = els.logBox.scrollHeight;
      }
    } catch (error) {
      if (els.logBox) { els.logBox.style.display = "block"; els.logBox.value = error.message; }
    }
  }

  async function copyDebugLog() {
    try {
      const data = await API.get("/api/autoclone/schedule/log");
      await navigator.clipboard.writeText(data?.log || "");
      setMessage("Registro copiado al portapapeles.", "ok");
    } catch (error) {
      setMessage(`No se pudo copiar: ${error.message}`, "error");
    }
  }

  els.loginBtn?.addEventListener("click", openLogin);
  els.loginCheckBtn?.addEventListener("click", () => checkLoginStatus(false));
  els.loginCloseBtn?.addEventListener("click", closeLogin);

  els.loadBtn.addEventListener("click", () => loadVideos(true));
  els.chooseBtn?.addEventListener("click", chooseFolder);
  els.previewBtn.addEventListener("click", preview);
  els.scheduleBtn.addEventListener("click", schedule);
  els.startBtn?.addEventListener("click", startNow);
  els.stopBtn?.addEventListener("click", stopNow);
  els.logBtn?.addEventListener("click", loadDebugLog);
  els.logCopyBtn?.addEventListener("click", copyDebugLog);  els.useDestBtn.addEventListener("click", () => {
    const dest = rememberedFolder();
    if (!dest) { setMessage("Primero elige una carpeta de destino en Auto Clone.", "error"); return; }
    els.folder.value = dest;
    loadVideos(true);
  });

  // Remember hashtags and location so they persist between sessions.
  const OPTIONS_KEY = "autoclone.postOptions";
  function savePostOptions() {
    try {
      localStorage.setItem(OPTIONS_KEY, JSON.stringify({
        hashtags: els.hashtags?.value || "",
        locationMadrid: Boolean(els.locationMadrid?.checked),
        locationCustom: els.locationCustom?.value || "",
        aiGenerated: Boolean(els.aiGenerated?.checked),
      }));
    } catch { /* ignore */ }
  }
  function restorePostOptions() {
    try {
      const saved = JSON.parse(localStorage.getItem(OPTIONS_KEY) || "{}");
      if (saved.hashtags && els.hashtags) els.hashtags.value = saved.hashtags;
      if (saved.locationMadrid && els.locationMadrid) els.locationMadrid.checked = true;
      if (saved.locationCustom && els.locationCustom) els.locationCustom.value = saved.locationCustom;
      if (saved.aiGenerated && els.aiGenerated) els.aiGenerated.checked = true;
    } catch { /* ignore */ }
  }
  els.hashtags?.addEventListener("input", savePostOptions);
  els.locationMadrid?.addEventListener("change", savePostOptions);
  els.locationCustom?.addEventListener("input", savePostOptions);
  els.aiGenerated?.addEventListener("change", savePostOptions);
  restorePostOptions();

  document.addEventListener("autosocial:viewchange", (event) => {
    if (event.detail?.viewName === "tiktok") {
      if (!els.folder.value) els.folder.value = rememberedFolder();
      refreshAccount();
      checkLoginStatus(true);
      if (els.loginBanner) els.loginBanner.hidden = false;
    }
  });

  if (!els.folder.value) els.folder.value = rememberedFolder();
  refreshAccount();
})();
