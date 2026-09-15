/**
 * AndroidClone view controller.
 *
 * Talks to the local /api/androidclone/* router: environment checks, AI
 * provider settings, project creation, the six-phase pipeline and live
 * progress over SSE. Loaded after app.js so it can reuse API/escapeHtml.
 */

const AndroidClone = {
  projectId: null,
  eventSource: null,
  catalog: [],
  settings: null,
  busy: false,

  els: {
    badge: document.getElementById("acDepsBadge"),
    depsList: document.getElementById("acDepsList"),
    depsRefreshBtn: document.getElementById("acDepsRefreshBtn"),
    settingsToggleBtn: document.getElementById("acSettingsToggleBtn"),
    settingsPanel: document.getElementById("acSettingsPanel"),
    providerList: document.getElementById("acProviderList"),
    visionProvider: document.getElementById("acVisionProvider"),
    visionModel: document.getElementById("acVisionModel"),
    codeProvider: document.getElementById("acCodeProvider"),
    codeModel: document.getElementById("acCodeModel"),
    packagePrefix: document.getElementById("acPackagePrefix"),
    maxFrames: document.getElementById("acMaxFrames"),
    repairAttempts: document.getElementById("acRepairAttempts"),
    saveSettingsBtn: document.getElementById("acSaveSettingsBtn"),
    settingsStatus: document.getElementById("acSettingsStatus"),
    projectName: document.getElementById("acProjectName"),
    adUrl: document.getElementById("acAdUrl"),
    videoFile: document.getElementById("acVideoFile"),
    createBtn: document.getElementById("acCreateBtn"),
    projectsList: document.getElementById("acProjectsList"),
    progress: document.getElementById("acProgress"),
    projectDetail: document.getElementById("acProjectDetail"),
    logs: document.getElementById("acLogs"),
    phaseButtons: document.querySelectorAll("[data-ac-phase]"),
  },

  init() {
    if (!this.els.depsList) return;

    this.els.depsRefreshBtn?.addEventListener("click", () => this.refreshDeps());
    this.els.settingsToggleBtn?.addEventListener("click", () => {
      this.els.settingsPanel.hidden = !this.els.settingsPanel.hidden;
      if (!this.els.settingsPanel.hidden) this.loadSettings();
    });
    this.els.saveSettingsBtn?.addEventListener("click", () => this.saveSettings());
    this.els.createBtn?.addEventListener("click", () => this.createProject());
    this.els.projectsList?.addEventListener("click", (event) => this.handleProjectsClick(event));
    this.els.phaseButtons?.forEach((button) => {
      button.addEventListener("click", () => this.runPhase(button.dataset.acPhase));
    });

    document.addEventListener("autosocial:viewchange", (event) => {
      if (event.detail?.viewName !== "androidclone") return;
      this.refreshDeps();
      this.loadSettings();
      this.loadProjects();
      this.openEvents();
    });

    this.refreshDeps();
    this.loadSettings();
    this.loadProjects();
    this.openEvents();
  },

  log(message, level = "info") {
    if (!this.els.logs) return;
    const row = document.createElement("div");
    row.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    if (level === "error") row.style.color = "#ff8a80";
    if (level === "ok") row.style.color = "#69f0ae";
    this.els.logs.prepend(row);
  },

  showProgress(progress) {
    const el = this.els.progress;
    if (!el) return;
    if (!progress || progress.stage === "idle") {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    const percent = typeof progress.percent === "number" ? progress.percent : null;
    el.innerHTML = `<div class="competitor-progress-head"><span class="competitor-spinner"></span>
      <strong>${escapeHtml(progress.stage || "")}</strong>
      <span>${escapeHtml(progress.detail || "")}</span></div>
      ${percent !== null ? `<div class="competitor-bar"><div style="width:${Math.max(0, Math.min(100, percent))}%"></div></div>` : ""}`;
  },

  openEvents() {
    if (this.eventSource) return;
    try {
      const source = new EventSource("/api/androidclone/events");
      source.onmessage = (event) => {
        try {
          const progress = JSON.parse(event.data);
          this.showProgress(progress);
          if (progress.detail) this.log(progress.detail, progress.stage === "error" ? "error" : "info");
        } catch { /* ignore malformed frames */ }
      };
      source.onerror = () => { /* browser retries automatically */ };
      this.eventSource = source;
    } catch { /* EventSource unavailable */ }
  },

  async refreshDeps() {
    try {
      const data = await API.get("/api/androidclone/deps");
      const deps = data.deps || {};
      const items = [
        ["ytDlp", "yt-dlp"], ["ffmpeg", "FFmpeg"], ["ffprobe", "ffprobe"],
        ["java", "JDK 17"], ["androidSdk", "Android SDK"], ["androidCli", "Android CLI"],
      ];
      this.els.depsList.innerHTML = items.map(([key, label]) => {
        const dep = deps[key] || {};
        return `<div class="ac-dep ${dep.found ? "ok" : "bad"}">
          <div><div class="ac-dot"></div></div>
          <div style="flex:1"><strong>${escapeHtml(label)}</strong>
            <small>${escapeHtml(dep.path || (dep.found ? "ok" : "no encontrado"))}</small></div>
          ${!dep.found && dep.installMethod ? `<button class="control-btn-small ac-install" data-ac-install="${key}">Instalar</button>` : ""}
        </div>`;
      }).join("");
      this.els.depsList.querySelectorAll("[data-ac-install]").forEach((button) => {
        button.addEventListener("click", () => this.installDep(button.dataset.acInstall));
      });
      if (this.els.badge) {
        const buildable = Boolean(deps.canBuild);
        this.els.badge.textContent = deps.ready ? "Entorno listo" : `${(deps.missing || []).length} pendientes`;
        this.els.badge.classList.toggle("active", deps.ready);
        this.els.badge.classList.toggle("error", !buildable);
      }
    } catch (error) {
      this.log(`No se pudo comprobar el entorno: ${error.message}`, "error");
    }
  },

  async installDep(id) {
    this.log(`Instalando ${id}...`);
    try {
      const data = await API.post("/api/androidclone/deps/install", { id });
      this.log(`Instalado: ${data.result?.method || "ok"}`, "ok");
      await this.refreshDeps();
    } catch (error) {
      this.log(`Fallo al instalar ${id}: ${error.message}`, "error");
    }
  },

  async loadSettings() {
    try {
      const [providers, settings] = await Promise.all([
        API.get("/api/androidclone/providers"),
        API.get("/api/androidclone/settings"),
      ]);
      this.catalog = providers.providers || [];
      this.settings = settings.settings || {};
      this.renderSettings();
    } catch (error) {
      this.log(`No se pudo cargar los ajustes: ${error.message}`, "error");
    }
  },

  renderSettings() {
    const active = this.settings || {};
    const keys = active.providerKeys || {};
    this.els.providerList.innerHTML = this.catalog.map((provider) => {
      const status = keys[provider.id];
      const vision = provider.supportsVision ? "vision" : "solo texto";
      return `<div class="ac-provider">
        <div><strong>${escapeHtml(provider.label)}</strong><small>${vision}${provider.free ? " · gratis" : ""}</small></div>
        <input class="control-input" type="password" data-ac-key="${provider.id}"
          placeholder="${status ? `${status.masked} (guardada)` : provider.keyHint}" />
        <button class="control-btn-small" data-ac-save-key="${provider.id}" type="button">Guardar</button>
      </div>`;
    }).join("");

    const option = (provider, selected) =>
      `<option value="${provider.id}" ${provider.id === selected ? "selected" : ""}>${escapeHtml(provider.label)}</option>`;
    const visionProviders = this.catalog.filter((p) => p.supportsVision);
    this.els.visionProvider.innerHTML = visionProviders.map((p) => option(p, active.vision?.provider)).join("");
    this.els.codeProvider.innerHTML = this.catalog.map((p) => option(p, active.code?.provider)).join("");

    this.fillModelSelect(this.els.visionModel, active.vision?.provider, active.vision?.model, true);
    this.fillModelSelect(this.els.codeModel, active.code?.provider, active.code?.model, false);

    this.els.visionProvider.onchange = () => {
      this.fillModelSelect(this.els.visionModel, this.els.visionProvider.value, "", true);
    };
    this.els.codeProvider.onchange = () => {
      this.fillModelSelect(this.els.codeModel, this.els.codeProvider.value, "", false);
    };

    this.els.packagePrefix.value = active.packagePrefix || "com.autosocial.generated";
    this.els.maxFrames.value = active.maxFrames ?? 40;
    this.els.repairAttempts.value = active.repairAttempts ?? 3;

    this.els.providerList.querySelectorAll("[data-ac-save-key]").forEach((button) => {
      button.addEventListener("click", () => this.saveProviderKey(button.dataset.acSaveKey));
    });
  },

  providerById(id) {
    return this.catalog.find((provider) => provider.id === id) || null;
  },

  /** Populate a model <select> with the models a provider actually offers. */
  fillModelSelect(select, providerId, selectedModel, requireVision) {
    if (!select) return;
    const provider = this.providerById(providerId);
    let models = provider?.models ? [...provider.models] : [];
    if (requireVision) models = models.filter((model) => model.vision);
    const chosen = selectedModel || models[0]?.id || "";
    if (chosen && !models.some((model) => model.id === chosen)) {
      models.unshift({ id: chosen, label: `${chosen} (guardado)` });
    }
    if (!models.length) {
      select.innerHTML = '<option value="">Sin modelos para este proveedor</option>';
      return;
    }
    select.innerHTML = models.map((model) => {
      const suffix = model.free ? " · gratis" : "";
      const vision = model.vision ? " · vision" : "";
      return `<option value="${escapeHtml(model.id)}" ${model.id === chosen ? "selected" : ""}>${escapeHtml(model.label || model.id)}${suffix}${vision}</option>`;
    }).join("");
  },

  async saveProviderKey(providerId) {
    const input = this.els.providerList.querySelector(`[data-ac-key="${providerId}"]`);
    const apiKey = input?.value.trim() || "";
    if (!apiKey) return;
    try {
      await API.post("/api/androidclone/settings", { provider: providerId, apiKey });
      input.value = "";
      this.els.settingsStatus.textContent = `Clave de ${providerId} guardada.`;
      await this.loadSettings();
    } catch (error) {
      this.els.settingsStatus.textContent = `Error: ${error.message}`;
    }
  },

  async saveSettings() {
    const payload = {
      vision: { provider: this.els.visionProvider.value, model: this.els.visionModel.value.trim() },
      code: { provider: this.els.codeProvider.value, model: this.els.codeModel.value.trim() },
      packagePrefix: this.els.packagePrefix.value.trim(),
      maxFrames: Number(this.els.maxFrames.value) || 40,
      repairAttempts: Number(this.els.repairAttempts.value) || 3,
    };
    try {
      await API.post("/api/androidclone/settings", payload);
      this.els.settingsStatus.textContent = "Ajustes guardados.";
      await this.loadSettings();
    } catch (error) {
      this.els.settingsStatus.textContent = `Error: ${error.message}`;
    }
  },

  activeProvider() {
    return this.els.visionProvider?.value || "gemini";
  },

  hasKeyFor(providerId) {
    const keys = this.settings?.providerKeys || {};
    return Boolean(keys[providerId]);
  },

  async createProject() {
    const name = this.els.projectName.value.trim();
    const adUrl = this.els.adUrl.value.trim();
    const file = this.els.videoFile?.files?.[0];
    if (!name && !adUrl && !file) {
      alert("Indica un nombre, una URL de anuncio o sube un video.");
      return;
    }
    if (!this.hasKeyFor(this.activeProvider())) {
      alert("Configura primero una API key de IA (boton \"Configurar IA\").");
      return;
    }
    this.els.createBtn.disabled = true;
    try {
      const data = await API.post("/api/androidclone/projects", { name, adUrl });
      this.projectId = data.project.id;
      this.log(`Proyecto creado: ${this.projectId}`, "ok");
      if (file) await this.uploadVideo(file);
      this.els.projectName.value = "";
      this.els.adUrl.value = "";
      if (this.els.videoFile) this.els.videoFile.value = "";
      await this.loadProjects();
      await this.loadDetail();
    } catch (error) {
      this.log(`No se pudo crear el proyecto: ${error.message}`, "error");
    } finally {
      this.els.createBtn.disabled = false;
    }
  },

  async uploadVideo(file) {
    this.log(`Subiendo ${file.name} (${Math.round(file.size / 1024 / 1024)} MB)...`);
    const res = await fetch("/api/androidclone/upload", {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream", "X-Filename": file.name },
      body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Subida fallida (${res.status})`);
    await API.post(`/api/androidclone/projects/${encodeURIComponent(this.projectId)}/ingest`, { adFile: data.path });
    this.log("Video subido y asociado al proyecto.", "ok");
  },

  async loadProjects() {
    try {
      const data = await API.get("/api/androidclone/projects");
      const projects = data.projects || [];
      if (!projects.length) {
        this.els.projectsList.innerHTML = '<p class="helios-hint">Sin proyectos todavia.</p>';
        return;
      }
      this.els.projectsList.innerHTML = projects.map((project) => {
        const build = project.build || {};
        const status = build.ok ? "APK listo" : (project.activePhase ? `fase ${project.activePhase}` : "nuevo");
        return `<div class="ac-project-item ${project.id === this.projectId ? "active" : ""}" data-ac-project="${escapeHtml(project.id)}">
          <div><strong>${escapeHtml(project.name || project.id)}</strong>
            <small>${escapeHtml(status)} · ${escapeHtml(project.updatedAt ? new Date(project.updatedAt).toLocaleString() : "")}</small></div>
          <button class="control-btn-small danger" data-ac-delete="${escapeHtml(project.id)}" type="button">Borrar</button>
        </div>`;
      }).join("");
    } catch (error) {
      this.log(`No se pudieron cargar los proyectos: ${error.message}`, "error");
    }
  },

  handleProjectsClick(event) {
    const del = event.target.closest("[data-ac-delete]");
    if (del) {
      event.stopPropagation();
      this.deleteProject(del.dataset.acDelete);
      return;
    }
    const item = event.target.closest("[data-ac-project]");
    if (item) {
      this.projectId = item.dataset.acProject;
      this.loadProjects();
      this.loadDetail();
    }
  },

  async deleteProject(id) {
    if (!confirm("¿Borrar este proyecto y sus archivos?")) return;
    try {
      await API.request(`/api/androidclone/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (this.projectId === id) this.projectId = null;
      await this.loadProjects();
      this.els.projectDetail.innerHTML = '<p class="helios-hint">Selecciona un proyecto.</p>';
    } catch (error) {
      this.log(`No se pudo borrar: ${error.message}`, "error");
    }
  },

  async loadDetail() {
    if (!this.projectId) return;
    try {
      const data = await API.get(`/api/androidclone/projects/${encodeURIComponent(this.projectId)}`);
      const project = data.project || {};
      const video = project.video || {};
      const build = project.build || {};
      const artifact = (name, label) =>
        `<a class="control-btn-small" href="/api/androidclone/projects/${encodeURIComponent(this.projectId)}/artifacts/${name}" target="_blank" rel="noopener">${label}</a>`;
      this.els.projectDetail.innerHTML = `
        <h4>${escapeHtml(project.name || project.id)}</h4>
        <div>Fase actual: <strong>${escapeHtml(String(project.activePhase || "-"))}</strong></div>
        ${video.durationSeconds ? `<div>Video: ${video.width}×${video.height}, ${Number(video.durationSeconds).toFixed(1)}s</div>` : ""}
        ${project.frames ? `<div>Fotogramas: ${project.frames.count}</div>` : ""}
        ${project.vision?.category ? `<div>Tipo detectado: ${escapeHtml(project.vision.category)}</div>` : ""}
        ${project.scaffold?.screens ? `<div>Pantallas generadas: ${project.scaffold.screens}</div>` : ""}
        ${build.ok ? `<div class="ac-apk">APK generado. ${artifact("apk", "Descargar APK")}</div>` : ""}
        ${!build.ok && build.errorTail ? `<details><summary>Ultimo error de build</summary><pre>${escapeHtml(build.errorTail)}</pre></details>` : ""}
        <div class="ac-phases" style="margin-top:10px">
          ${project.scaffold ? artifact("plan.md", "Ver plan.md") : ""}
          ${project.vision ? artifact("vision.json", "Ver vision.json") : ""}
        </div>`;
    } catch (error) {
      this.log(`No se pudo cargar el proyecto: ${error.message}`, "error");
    }
  },

  async runPhase(phase) {
    if (!this.projectId) { alert("Crea o selecciona un proyecto primero."); return; }
    if (this.busy) { this.log("Ya hay una fase en curso.", "error"); return; }
    this.busy = true;
    this.els.phaseButtons.forEach((button) => { button.disabled = true; });
    const endpoints = {
      ingest: `/api/androidclone/projects/${this.projectId}/ingest`,
      frames: `/api/androidclone/projects/${this.projectId}/frames`,
      vision: `/api/androidclone/projects/${this.projectId}/vision`,
      plan: `/api/androidclone/projects/${this.projectId}/plan`,
      scaffold: `/api/androidclone/projects/${this.projectId}/scaffold`,
      build: `/api/androidclone/projects/${this.projectId}/build`,
      run: `/api/androidclone/projects/${this.projectId}/run`,
    };
    this.log(`Ejecutando: ${phase}...`);
    try {
      await API.post(endpoints[phase], phase === "frames" ? { mode: "fps" } : {});
      this.log(`Fase "${phase}" completada.`, "ok");
      await this.loadProjects();
      await this.loadDetail();
    } catch (error) {
      this.log(`La fase "${phase}" fallo: ${error.message}`, "error");
    } finally {
      this.busy = false;
      this.els.phaseButtons.forEach((button) => { button.disabled = false; });
    }
  },
};

document.addEventListener("DOMContentLoaded", () => AndroidClone.init());
