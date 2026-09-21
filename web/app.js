const API = {
  async request(endpoint, options = {}) {
    const res = await fetch(endpoint, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `API Error: ${res.status}`);
    return data;
  },
  get(endpoint) { return this.request(endpoint); },
  post(endpoint, body) {
    return this.request(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  },
};

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const Router = {
  init() {
    const navItems = document.querySelectorAll(".nav-item");
    navItems.forEach((btn) => {
      btn.addEventListener("click", () => {
        const view = btn.dataset.view;
        this.navigate(view);
      });
    });
  },

  navigate(viewName) {
    document.querySelectorAll(".nav-item").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.view === viewName);
    });
    document.querySelectorAll(".view-section").forEach((sec) => {
      sec.classList.toggle("active", sec.id === `view-${viewName}`);
    });
    document.querySelector(".main-content")?.classList.toggle("studio-mode", viewName === "long-video" || viewName === "helios");
    document.dispatchEvent(new CustomEvent("autosocial:viewchange", { detail: { viewName } }));
  },
};

const UI = {
  accountState: {
    tiktok: { loginOpen: false, sessionSaved: false, schedulerRunning: false },
    instagram: { loginOpen: false, sessionSaved: false, schedulerRunning: false },
    youtube: { loginOpen: false, sessionSaved: false, schedulerRunning: false },
    brands: [],
    activeBrandId: null,
    activeBrandName: "",
  },
  xDirty: new Set(),
  flowDirty: new Set(),
  flowConfigLoadSequence: 0,
  flowDownloadsSignature: "",
  scheduleDraftDirty: {
    tiktok: false,
    instagram: false,
    youtube: false,
  },

  els: {
    brandSelect: document.getElementById("brandSelect"),
    addBrandBtn: document.getElementById("addBrandBtn"),
    brandCreateRow: document.getElementById("brandCreateRow"),
    brandNameInput: document.getElementById("brandNameInput"),
    saveBrandBtn: document.getElementById("saveBrandBtn"),
    cancelBrandBtn: document.getElementById("cancelBrandBtn"),
    activeBrandLabel: document.getElementById("activeBrandLabel"),
    statusBadge: document.getElementById("statusBadge"),
    setupRefreshBtn: document.getElementById("setupRefreshBtn"),
    setupSummaryIcon: document.getElementById("setupSummaryIcon"),
    setupSummaryTitle: document.getElementById("setupSummaryTitle"),
    setupSummaryMeta: document.getElementById("setupSummaryMeta"),
    setupMetrics: document.getElementById("setupMetrics"),
    setupChecksList: document.getElementById("setupChecksList"),
    setupSessionsList: document.getElementById("setupSessionsList"),
    setupFoldersList: document.getElementById("setupFoldersList"),
    setupNextSteps: document.getElementById("setupNextSteps"),

    pendingCount: document.getElementById("pendingCount"),
    successCount: document.getElementById("successCount"),
    failedCount: document.getElementById("failedCount"),
    activeAccountsCount: document.getElementById("activeAccountsCount"),
    overviewProfilesContainer: document.getElementById("overviewProfilesContainer"),

    ttQueueList: document.getElementById("ttQueueList"),
    ttQueueCount: document.getElementById("ttQueueCount"),
    ttJobVideo: document.getElementById("ttJobVideo"),
    ttJobDate: document.getElementById("ttJobDate"),
    ttJobCaption: document.getElementById("ttJobCaption"),
    ttJobCreateBtn: document.getElementById("ttJobCreateBtn"),
    ttJobMessage: document.getElementById("ttJobMessage"),
    autonomousWorkerBadge: document.getElementById("autonomousWorkerBadge"),
    autonomousJobsList: document.getElementById("autonomousJobsList"),
    logsContainer: document.getElementById("logsContainer"),
    ttLogsContainer: document.getElementById("ttLogsContainer"),
    accountsTableBody: document.getElementById("accountsTableBody"),
    managedAccountsTableBody: document.getElementById("managedAccountsTableBody"),
    createTempMailAccountBtn: document.getElementById("createTempMailAccountBtn"),
    accountVaultMessage: document.getElementById("accountVaultMessage"),
    accountWeeklyBadge: document.getElementById("accountWeeklyBadge"),
    accountOnboardingPanel: document.getElementById("accountOnboardingPanel"),
    accountOnboardingBadge: document.getElementById("accountOnboardingBadge"),
    accountOnboardingMessage: document.getElementById("accountOnboardingMessage"),
    accountRetryCaptureBtn: document.getElementById("accountRetryCaptureBtn"),
    accountCloseBrowserBtn: document.getElementById("accountCloseBrowserBtn"),

    ttRunBtn: document.getElementById("ttRunBtn"),
    ttStartBtn: document.getElementById("ttStartBtn"),
    ttStopBtn: document.getElementById("ttStopBtn"),
    ttCronInput: document.getElementById("ttCronInput"),
    ttUpdateScheduleBtn: document.getElementById("ttUpdateScheduleBtn"),
    ttPlanType: document.getElementById("ttPlanType"),
    ttPlanTime: document.getElementById("ttPlanTime"),
    ttPlanTimes: document.getElementById("ttPlanTimes"),
    ttPlanWeekday: document.getElementById("ttPlanWeekday"),
    ttPlanApplyBtn: document.getElementById("ttPlanApplyBtn"),
    ttPendingCount: document.getElementById("ttPendingCount"),
    ttPostedCount: document.getElementById("ttPostedCount"),
    ttFailedCount: document.getElementById("ttFailedCount"),
    ttSchedulerState: document.getElementById("ttSchedulerState"),
    ttTimezoneLabel: document.getElementById("ttTimezoneLabel"),
    ttLastRunLabel: document.getElementById("ttLastRunLabel"),
    ttInstantPostToggle: document.getElementById("ttInstantPostToggle"),
    ttAutoAddSoundToggle: document.getElementById("ttAutoAddSoundToggle"),
    ttSoundQueryInput: document.getElementById("ttSoundQueryInput"),
    ttSoundQuerySaveBtn: document.getElementById("ttSoundQuerySaveBtn"),
    ttRandomQueueToggle: document.getElementById("ttRandomQueueToggle"),
    igRunBtn: document.getElementById("igRunBtn"),
    igStartBtn: document.getElementById("igStartBtn"),
    igStopBtn: document.getElementById("igStopBtn"),
    igCronInput: document.getElementById("igCronInput"),
    igUpdateScheduleBtn: document.getElementById("igUpdateScheduleBtn"),
    igPlanType: document.getElementById("igPlanType"),
    igPlanTime: document.getElementById("igPlanTime"),
    igPlanTimes: document.getElementById("igPlanTimes"),
    igPlanWeekday: document.getElementById("igPlanWeekday"),
    igPlanApplyBtn: document.getElementById("igPlanApplyBtn"),
    igPendingCount: document.getElementById("igPendingCount"),
    igPostedCount: document.getElementById("igPostedCount"),
    igFailedCount: document.getElementById("igFailedCount"),
    igSchedulerState: document.getElementById("igSchedulerState"),
    igTimezoneLabel: document.getElementById("igTimezoneLabel"),
    igLastRunLabel: document.getElementById("igLastRunLabel"),
    igInstantPostToggle: document.getElementById("igInstantPostToggle"),
    igRandomQueueToggle: document.getElementById("igRandomQueueToggle"),
    igQueueList: document.getElementById("igQueueList"),
    igLogsContainer: document.getElementById("igLogsContainer"),
    ytRunBtn: document.getElementById("ytRunBtn"),
    ytStartBtn: document.getElementById("ytStartBtn"),
    ytStopBtn: document.getElementById("ytStopBtn"),
    ytCronInput: document.getElementById("ytCronInput"),
    ytUpdateScheduleBtn: document.getElementById("ytUpdateScheduleBtn"),
    ytPlanType: document.getElementById("ytPlanType"),
    ytPlanTime: document.getElementById("ytPlanTime"),
    ytPlanTimes: document.getElementById("ytPlanTimes"),
    ytPlanWeekday: document.getElementById("ytPlanWeekday"),
    ytPlanApplyBtn: document.getElementById("ytPlanApplyBtn"),
    ytPendingCount: document.getElementById("ytPendingCount"),
    ytPostedCount: document.getElementById("ytPostedCount"),
    ytFailedCount: document.getElementById("ytFailedCount"),
    ytSchedulerState: document.getElementById("ytSchedulerState"),
    ytTimezoneLabel: document.getElementById("ytTimezoneLabel"),
    ytLastRunLabel: document.getElementById("ytLastRunLabel"),
    ytInstantPostToggle: document.getElementById("ytInstantPostToggle"),
    ytRandomQueueToggle: document.getElementById("ytRandomQueueToggle"),
    ytQueueList: document.getElementById("ytQueueList"),
    ytLogsContainer: document.getElementById("ytLogsContainer"),

    uniqStartBtn: document.getElementById("uniqStartBtn"),
    uniqStopBtn: document.getElementById("uniqStopBtn"),
    uniqOpenInputBtn: document.getElementById("uniqOpenInputBtn"),
    uniqOpenOutputBtn: document.getElementById("uniqOpenOutputBtn"),
    uniqInputDir: document.getElementById("uniqInputDir"),
    uniqOutputDir: document.getElementById("uniqOutputDir"),
    uniqLogoImage: document.getElementById("uniqLogoImage"),
    uniqIntensity: document.getElementById("uniqIntensity"),
    uniqCropPercent: document.getElementById("uniqCropPercent"),
    uniqNoiseStrength: document.getElementById("uniqNoiseStrength"),
    uniqOverlayOpacity: document.getElementById("uniqOverlayOpacity"),
    uniqOverlaySize: document.getElementById("uniqOverlaySize"),
    uniqMirror: document.getElementById("uniqMirror"),
    uniqState: document.getElementById("uniqState"),
    uniqProgress: document.getElementById("uniqProgress"),
    uniqSucceeded: document.getElementById("uniqSucceeded"),
    uniqFailed: document.getElementById("uniqFailed"),
    uniqInputFiles: document.getElementById("uniqInputFiles"),
    uniqOutputFiles: document.getElementById("uniqOutputFiles"),
    uniqLogs: document.getElementById("uniqLogs"),

    adStartBtn: document.getElementById("adStartBtn"),
    adStopBtn: document.getElementById("adStopBtn"),
    adChannel: document.getElementById("adChannel"),
    adInterval: document.getElementById("adInterval"),
    adMaxVideos: document.getElementById('adMaxVideos'),
    adPlatTiktok: document.getElementById('adPlatTiktok'),
    adPlatInstagram: document.getElementById("adPlatInstagram"),
    adPlatYoutube: document.getElementById("adPlatYoutube"),
    adSaveSettingsBtn: document.getElementById("adSaveSettingsBtn"),
    adWatcherState: document.getElementById("adWatcherState"),
    adTotalDownloaded: document.getElementById("adTotalDownloaded"),
    adLastCheck: document.getElementById("adLastCheck"),
    adLogsContainer: document.getElementById("adLogsContainer"),
    defaultCaptionInput: document.getElementById("defaultCaptionInput"),
    defaultCaptionSaveBtn: document.getElementById("defaultCaptionSaveBtn"),

    // Profile Downloader
    pdChannel: document.getElementById("pdChannel"),
    pdMaxVideos: document.getElementById("pdMaxVideos"),
    pdMinViews: document.getElementById("pdMinViews"),
    pdStartBtn: document.getElementById("pdStartBtn"),
    pdScanBtn: document.getElementById("pdScanBtn"),
    pdOpenFolderBtn: document.getElementById("pdOpenFolderBtn"),
    pdLogsContainer: document.getElementById("pdLogsContainer"),
    pdStatusBadge: document.getElementById("pdStatusBadge"),
    xWorkerBadge: document.getElementById("xWorkerBadge"),
    xUsername: document.getElementById("xUsername"), xPostsPerDay: document.getElementById("xPostsPerDay"),
    xDailyTimes: document.getElementById("xDailyTimes"), xPostingMode: document.getElementById("xPostingMode"), xAccountTier: document.getElementById("xAccountTier"), xContentMode: document.getElementById("xContentMode"), xSearchTopic: document.getElementById("xSearchTopic"),
    xMasterPrompt: document.getElementById("xMasterPrompt"), // MARKER: XAP-LANG-ELS-v1 xLanguage: document.getElementById("xLanguage"), xAiProvider: document.getElementById("xAiProvider"), xAiModel: document.getElementById("xAiModel"),
    xAiKey: document.getElementById("xAiKey"), xAccessToken: document.getElementById("xAccessToken"), xBearerToken: document.getElementById("xBearerToken"), xEnabled: document.getElementById("xEnabled"),
    xSaveBtn: document.getElementById("xSaveBtn"), xGenerateBtn: document.getElementById("xGenerateBtn"), xClearQueueBtn: document.getElementById("xClearQueueBtn"), xLiveStatus: document.getElementById("xLiveStatus"), xReferenceUser: document.getElementById("xReferenceUser"),
    xReferenceText: document.getElementById("xReferenceText"), xReferenceUrl: document.getElementById("xReferenceUrl"), xReferenceBtn: document.getElementById("xReferenceBtn"),
    xReferencesList: document.getElementById("xReferencesList"),
    aiChainBadge: document.getElementById("aiChainBadge"), aiChainList: document.getElementById("aiChainList"), aiChainEnabled: document.getElementById("aiChainEnabled"), aiProviderGrid: document.getElementById("aiProviderGrid"), aiTestProvider: document.getElementById("aiTestProvider"), aiTestBtn: document.getElementById("aiTestBtn"), aiTestResult: document.getElementById("aiTestResult"), aiLastTest: document.getElementById("aiLastTest"),
    xLoginBanner: document.getElementById("xLoginBanner"), xLoginTitle: document.getElementById("xLoginTitle"), xLoginMessage: document.getElementById("xLoginMessage"), xLoginStateBadge: document.getElementById("xLoginStateBadge"), xLoginBtn: document.getElementById("xLoginBtn"), xLoginSaveBtn: document.getElementById("xLoginSaveBtn"), xLoginCloseBtn: document.getElementById("xLoginCloseBtn"), xCookiesInput: document.getElementById("xCookiesInput"), xCookiesBtn: document.getElementById("xCookiesBtn"), xRetryBtn: document.getElementById("xRetryBtn"),
    // MARKER: XAP-BIND-v1, xQueueCount: document.getElementById("xQueueCount"), xQueueList: document.getElementById("xQueueList"), xLogs: document.getElementById("xLogs"),
    flowSessionBadge: document.getElementById("flowSessionBadge"),
    flowAccountName: document.getElementById("flowAccountName"),
    flowAccountId: document.getElementById("flowAccountId"),
    flowSessionMessage: document.getElementById("flowSessionMessage"),
    flowLoginBtn: document.getElementById("flowLoginBtn"),
    flowCloseBtn: document.getElementById("flowCloseBtn"),
    flowRefreshBtn: document.getElementById("flowRefreshBtn"),
    flowFixedPromptTemplate: document.getElementById("flowFixedPromptTemplate"),
    flowDynamicInstructions: document.getElementById("flowDynamicInstructions"),
    flowGeminiApiKey: document.getElementById("flowGeminiApiKey"),
    flowGeminiKeyStatus: document.getElementById("flowGeminiKeyStatus"),
    flowGeminiKeyRemoveBtn: document.getElementById("flowGeminiKeyRemoveBtn"),
    flowPromptPreviewBtn: document.getElementById("flowPromptPreviewBtn"),
    flowPromptPreview: document.getElementById("flowPromptPreview"),
    flowPreviewPhrase: document.getElementById("flowPreviewPhrase"),
    flowPreviewFinalPrompt: document.getElementById("flowPreviewFinalPrompt"),
    flowReferenceInput: document.getElementById("flowReferenceInput"),
    flowReferenceName: document.getElementById("flowReferenceName"),
    flowReferenceRemoveBtn: document.getElementById("flowReferenceRemoveBtn"),
    flowConfigSaveBtn: document.getElementById("flowConfigSaveBtn"),
    flowConfigMessage: document.getElementById("flowConfigMessage"),
    flowEnabled: document.getElementById("flowEnabled"),
    flowVideosPerDay: document.getElementById("flowVideosPerDay"),
    flowDailyTime: document.getElementById("flowDailyTime"),
    flowTimezone: document.getElementById("flowTimezone"),
    flowPublicationTimes: document.getElementById("flowPublicationTimes"),
    flowAutoPublish: document.getElementById("flowAutoPublish"),
    flowCaption: document.getElementById("flowCaption"),
    flowRunNowBtn: document.getElementById("flowRunNowBtn"),
    flowOpenDownloadsBtn: document.getElementById("flowOpenDownloadsBtn"),
    flowDownloadsPath: document.getElementById("flowDownloadsPath"),
    flowDownloadsList: document.getElementById("flowDownloadsList"),
    flowPipelineBadge: document.getElementById("flowPipelineBadge"),
    flowJobsList: document.getElementById("flowJobsList"),
    competitorTarget: document.getElementById("competitorTarget"),
    competitorDepth: document.getElementById("competitorDepth"),
    competitorAnalyzeBtn: document.getElementById("competitorAnalyzeBtn"),
    competitorBrand: document.getElementById("competitorBrand"),
    competitorLanguage: document.getElementById("competitorLanguage"),
    competitorKeyBtn: document.getElementById("competitorKeyBtn"),
    competitorHistoryBtn: document.getElementById("competitorHistoryBtn"),
    competitorProgress: document.getElementById("competitorProgress"),
    competitorKeyPanel: document.getElementById("competitorKeyPanel"),
    competitorApiKey: document.getElementById("competitorApiKey"),
    competitorSaveKeyBtn: document.getElementById("competitorSaveKeyBtn"),
    competitorRemoveKeyBtn: document.getElementById("competitorRemoveKeyBtn"),
    competitorKeyStatus: document.getElementById("competitorKeyStatus"),
    competitorModel: document.getElementById("competitorModel"),
    competitorModelsBtn: document.getElementById("competitorModelsBtn"),
    competitorSaveModelBtn: document.getElementById("competitorSaveModelBtn"),
    competitorModelStatus: document.getElementById("competitorModelStatus"),
    competitorKeyBadge: document.getElementById("competitorKeyBadge"),
    competitorReportsList: document.getElementById("competitorReportsList"),
    competitorResult: document.getElementById("competitorResult"),
  },

  init() {
    Router.init();
    this.bindEvents();
    this.updateFriendlyScheduleVisibility("tiktok");
    this.updateFriendlyScheduleVisibility("instagram");
    this.updateFriendlyScheduleVisibility("youtube");
    if (this.els.ttJobDate && !this.els.ttJobDate.value) {
      const date = new Date(Date.now() + 60 * 60 * 1000);
      date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
      this.els.ttJobDate.value = date.toISOString().slice(0, 16);
    }
    this.startPolling();
    this.renderAccounts();
    this.initCompetitor();
  },

  bindEvents() {
    if (this.els.xSaveBtn) this.els.xSaveBtn.addEventListener("click", () => this.saveXConfig());
    if (this.els.xGenerateBtn) this.els.xGenerateBtn.addEventListener("click", () => this.generateX());
    if (this.els.xClearQueueBtn) this.els.xClearQueueBtn.addEventListener("click", () => this.clearXQueue());
    ["xUsername", "xPostsPerDay", "xDailyTimes", "xPostingMode", "xAccountTier", "xContentMode", "xSearchTopic", /* MARKER: XAP-LANG-DIRTY-v1 */ "xLanguage", "xMasterPrompt", "xAiProvider", "xAiModel", "xEnabled"].forEach((key) => {
      const element = this.els[key];
      if (element) {
        element.addEventListener("input", () => this.xDirty.add(key));
        element.addEventListener("change", () => this.xDirty.add(key));
      }
    });
    // MARKER: XAP-HANDLERS-v1
    if (this.els.xLoginBtn) this.els.xLoginBtn.addEventListener("click", () => this.xLoginOpen());
    if (this.els.xLoginSaveBtn) this.els.xLoginSaveBtn.addEventListener("click", () => this.xLoginSave());
    if (this.els.xLoginCloseBtn) this.els.xLoginCloseBtn.addEventListener("click", () => this.xLoginClose());
    if (this.els.xCookiesBtn) this.els.xCookiesBtn.addEventListener("click", () => this.xImportCookies());
    if (this.els.xRetryBtn) this.els.xRetryBtn.addEventListener("click", () => this.xRetryFailed());
    if (this.els.aiTestBtn) this.els.aiTestBtn.addEventListener("click", () => this.testAiProvider());
    if (this.els.aiChainEnabled) this.els.aiChainEnabled.addEventListener("change", () => this.toggleAiChain(this.els.aiChainEnabled.checked));
    if (this.els.xReferenceBtn) this.els.xReferenceBtn.addEventListener("click", () => this.addXReference());
    if (this.els.flowLoginBtn) this.els.flowLoginBtn.addEventListener("click", () => this.openFlowLogin());
    if (this.els.flowCloseBtn) this.els.flowCloseBtn.addEventListener("click", () => this.closeFlowLogin());
    if (this.els.flowRefreshBtn) this.els.flowRefreshBtn.addEventListener("click", () => this.refreshFlowStatus());
    if (this.els.flowConfigSaveBtn) this.els.flowConfigSaveBtn.addEventListener("click", () => this.saveFlowConfig().catch(() => {}));
    if (this.els.flowPromptPreviewBtn) this.els.flowPromptPreviewBtn.addEventListener("click", () => this.previewFlowPrompt());
    if (this.els.flowRunNowBtn) this.els.flowRunNowBtn.addEventListener("click", () => this.runFlowNow());
    if (this.els.flowOpenDownloadsBtn) this.els.flowOpenDownloadsBtn.addEventListener("click", () => this.openFlowDownloads());
    if (this.els.ttJobCreateBtn) this.els.ttJobCreateBtn.addEventListener("click", () => this.createAutonomousJob());
    if (this.els.autonomousJobsList) this.els.autonomousJobsList.addEventListener("click", (event) => this.handleJobAction(event));
    if (this.els.flowJobsList) this.els.flowJobsList.addEventListener("click", (event) => this.handleJobAction(event));
    ["flowFixedPromptTemplate", "flowDynamicInstructions", "flowEnabled", "flowVideosPerDay", "flowDailyTime", "flowTimezone", "flowPublicationTimes", "flowAutoPublish", "flowCaption"].forEach((key) => {
      const element = this.els[key];
      if (element) {
        element.addEventListener("input", () => this.flowDirty.add(key));
        element.addEventListener("change", () => this.flowDirty.add(key));
      }
    });
    if (this.els.flowGeminiKeyRemoveBtn) this.els.flowGeminiKeyRemoveBtn.addEventListener("click", () => {
      if (this.els.flowGeminiApiKey) this.els.flowGeminiApiKey.value = "";
      this.els.flowGeminiKeyRemoveBtn.dataset.remove = "true";
      if (this.els.flowGeminiKeyStatus) {
        this.els.flowGeminiKeyStatus.textContent = "Will be removed on save";
        this.els.flowGeminiKeyStatus.classList.remove("success");
      }
    });
    if (this.els.flowGeminiApiKey) this.els.flowGeminiApiKey.addEventListener("input", () => {
      if (!this.els.flowGeminiApiKey.value) return;
      if (this.els.flowGeminiKeyRemoveBtn) this.els.flowGeminiKeyRemoveBtn.dataset.remove = "false";
      if (this.els.flowGeminiKeyStatus) {
        this.els.flowGeminiKeyStatus.textContent = "New key not saved";
        this.els.flowGeminiKeyStatus.classList.remove("success");
      }
    });
    if (this.els.flowReferenceRemoveBtn) this.els.flowReferenceRemoveBtn.addEventListener("click", () => {
      this.els.flowReferenceInput.value = "";
      this.els.flowReferenceName.textContent = "Image will be removed when you save";
      this.els.flowReferenceRemoveBtn.dataset.remove = "true";
      this.flowDirty.add("flowReference");
    });
    if (this.els.flowReferenceInput) this.els.flowReferenceInput.addEventListener("change", () => {
      const file = this.els.flowReferenceInput.files?.[0];
      if (file) {
        this.els.flowReferenceName.textContent = `${file.name} (${Math.round(file.size / 1024)} KB)`;
        this.els.flowReferenceRemoveBtn.dataset.remove = "false";
        this.flowDirty.add("flowReference");
      }
    });
    if (this.els.brandSelect) {
      this.els.brandSelect.addEventListener("change", (event) =>
        this.handleBrandSelect(event.target.value)
      );
    }
    if (this.els.addBrandBtn) {
      this.els.addBrandBtn.addEventListener("click", () => this.handleAddBrand());
    }
    if (this.els.saveBrandBtn) {
      this.els.saveBrandBtn.addEventListener("click", () => this.handleCreateBrand());
    }
    if (this.els.cancelBrandBtn) {
      this.els.cancelBrandBtn.addEventListener("click", () => this.hideBrandCreator());
    }
    if (this.els.brandNameInput) {
      this.els.brandNameInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          this.handleCreateBrand();
        } else if (event.key === "Escape") {
          this.hideBrandCreator();
        }
      });
    }

    if (this.els.ttStartBtn) {
      this.els.ttStartBtn.addEventListener("click", () => this.handleAction("/api/start"));
    }
    if (this.els.ttStopBtn) {
      this.els.ttStopBtn.addEventListener("click", () => this.handleAction("/api/stop"));
    }
    if (this.els.ttRunBtn) {
      this.els.ttRunBtn.addEventListener("click", () => this.handleAction("/api/run-once"));
    }
    if (this.els.ttUpdateScheduleBtn) {
      this.els.ttUpdateScheduleBtn.addEventListener("click", () =>
        this.handleUpdateSchedule(true)
      );
    }
    if (this.els.ttPlanType) {
      this.els.ttPlanType.addEventListener("change", () =>
        this.handleFriendlyScheduleDraftChange("tiktok")
      );
    }
    if (this.els.ttPlanTime) {
      this.els.ttPlanTime.addEventListener("change", () =>
        this.handleFriendlyScheduleDraftChange("tiktok")
      );
    }
    if (this.els.ttPlanWeekday) {
      this.els.ttPlanWeekday.addEventListener("change", () =>
        this.handleFriendlyScheduleDraftChange("tiktok")
      );
    }
    if (this.els.ttPlanTimes) {
      this.els.ttPlanTimes.addEventListener("input", () =>
        this.handleFriendlyScheduleDraftChange("tiktok")
      );
    }
    if (this.els.ttPlanApplyBtn) {
      this.els.ttPlanApplyBtn.addEventListener("click", () =>
        this.handleFriendlySchedule("tiktok")
      );
    }
    if (this.els.ttInstantPostToggle) {
      this.els.ttInstantPostToggle.addEventListener("change", (e) =>
        this.handleInstantPostToggle("tiktok", e.target.checked)
      );
    }

    if (this.els.ttAutoAddSoundToggle) {
      this.els.ttAutoAddSoundToggle.addEventListener("change", async (e) => {
        try {
          const result = await API.post("/api/settings/save", {
            payload: { AUTO_ADD_SOUND: e.target.checked }
          });
          if (result?.ok === false && result?.error) {
            alert(result.error);
            e.target.checked = !e.target.checked; // Revert visually on error
          }
          this.refresh();
        } catch (err) {
          alert(`Failed to save auto-add sound setting: ${err.message}`);
          e.target.checked = !e.target.checked;
        }
      });
    }
    if (this.els.setupRefreshBtn) {
      this.els.setupRefreshBtn.addEventListener("click", () => this.refreshSetupHealth());
    }
    if (this.els.setupFoldersList) {
      this.els.setupFoldersList.addEventListener("click", (event) =>
        this.handleSetupFolderClick(event)
      );
    }
    document.addEventListener("autosocial:viewchange", (event) => {
      if (event.detail?.viewName === "setup") {
        this.refreshSetupHealth();
      }
      if (event.detail?.viewName === "helios") {
        window.dispatchEvent(new Event("resize"));
      }
    });

    if (this.els.ttSoundQuerySaveBtn) {
      this.els.ttSoundQuerySaveBtn.addEventListener("click", () =>
        this.handleSaveTextSetting(
          "DEFAULT_SOUND_QUERY",
          this.els.ttSoundQueryInput,
          this.els.ttSoundQuerySaveBtn,
          "Save Sound",
          "Sound query"
        )
      );
    }

    if (this.els.ttRandomQueueToggle) {
      this.els.ttRandomQueueToggle.addEventListener("change", (e) =>
        this.handleRandomQueueToggle(e.target.checked)
      );
    }

    if (this.els.igStartBtn) {
      this.els.igStartBtn.addEventListener("click", () =>
        this.handleAction("/api/instagram/start")
      );
    }
    if (this.els.igStopBtn) {
      this.els.igStopBtn.addEventListener("click", () =>
        this.handleAction("/api/instagram/stop")
      );
    }
    if (this.els.igRunBtn) {
      this.els.igRunBtn.addEventListener("click", () =>
        this.handleAction("/api/instagram/run-once")
      );
    }
    if (this.els.igUpdateScheduleBtn) {
      this.els.igUpdateScheduleBtn.addEventListener("click", () =>
        this.handleUpdateSchedule(false, true)
      );
    }
    if (this.els.igPlanType) {
      this.els.igPlanType.addEventListener("change", () =>
        this.handleFriendlyScheduleDraftChange("instagram")
      );
    }
    if (this.els.igPlanTime) {
      this.els.igPlanTime.addEventListener("change", () =>
        this.handleFriendlyScheduleDraftChange("instagram")
      );
    }
    if (this.els.igPlanWeekday) {
      this.els.igPlanWeekday.addEventListener("change", () =>
        this.handleFriendlyScheduleDraftChange("instagram")
      );
    }
    if (this.els.igPlanTimes) {
      this.els.igPlanTimes.addEventListener("input", () =>
        this.handleFriendlyScheduleDraftChange("instagram")
      );
    }
    if (this.els.igPlanApplyBtn) {
      this.els.igPlanApplyBtn.addEventListener("click", () =>
        this.handleFriendlySchedule("instagram")
      );
    }
    if (this.els.igInstantPostToggle) {
      this.els.igInstantPostToggle.addEventListener("change", () =>
        this.handleInstantPostToggle("instagram", this.els.igInstantPostToggle.checked)
      );
    }
    if (this.els.igRandomQueueToggle) {
      this.els.igRandomQueueToggle.addEventListener("change", () =>
        this.handleRandomQueueToggle(this.els.igRandomQueueToggle.checked)
      );
    }
    if (this.els.ytStartBtn) {
      this.els.ytStartBtn.addEventListener("click", () =>
        this.handleAction("/api/youtube/start")
      );
    }
    if (this.els.ytStopBtn) {
      this.els.ytStopBtn.addEventListener("click", () =>
        this.handleAction("/api/youtube/stop")
      );
    }
    if (this.els.ytRunBtn) {
      this.els.ytRunBtn.addEventListener("click", () =>
        this.handleAction("/api/youtube/run-once")
      );
    }
    if (this.els.ytUpdateScheduleBtn) {
      this.els.ytUpdateScheduleBtn.addEventListener("click", () =>
        this.handleUpdateSchedule(false, false, true)
      );
    }
    if (this.els.ytPlanType) {
      this.els.ytPlanType.addEventListener("change", () =>
        this.handleFriendlyScheduleDraftChange("youtube")
      );
    }
    if (this.els.ytPlanTime) {
      this.els.ytPlanTime.addEventListener("change", () =>
        this.handleFriendlyScheduleDraftChange("youtube")
      );
    }
    if (this.els.ytPlanWeekday) {
      this.els.ytPlanWeekday.addEventListener("change", () =>
        this.handleFriendlyScheduleDraftChange("youtube")
      );
    }
    if (this.els.ytPlanTimes) {
      this.els.ytPlanTimes.addEventListener("input", () =>
        this.handleFriendlyScheduleDraftChange("youtube")
      );
    }
    if (this.els.ytPlanApplyBtn) {
      this.els.ytPlanApplyBtn.addEventListener("click", () =>
        this.handleFriendlySchedule("youtube")
      );
    }
    if (this.els.ytInstantPostToggle) {
      this.els.ytInstantPostToggle.addEventListener("change", () =>
        this.handleInstantPostToggle("youtube", this.els.ytInstantPostToggle.checked)
      );
    }
    if (this.els.ytRandomQueueToggle) {
      this.els.ytRandomQueueToggle.addEventListener("change", () =>
        this.handleRandomQueueToggle(this.els.ytRandomQueueToggle.checked)
      );
    }
    if (this.els.accountsTableBody) {
      this.els.accountsTableBody.addEventListener("click", (event) =>
        this.handleAccountsTableClick(event)
      );
    }
    if (this.els.managedAccountsTableBody) {
      this.els.managedAccountsTableBody.addEventListener("click", (event) =>
        this.handleManagedAccountsClick(event)
      );
    }
    if (this.els.createTempMailAccountBtn) {
      this.els.createTempMailAccountBtn.addEventListener("click", () =>
        this.createTempMailAccount()
      );
    }
    if (this.els.accountRetryCaptureBtn) {
      this.els.accountRetryCaptureBtn.addEventListener("click", () =>
        this.retryTempMailCapture()
      );
    }
    if (this.els.accountCloseBrowserBtn) {
      this.els.accountCloseBrowserBtn.addEventListener("click", () =>
        this.closeAccountBrowser()
      );
    }

    if (this.els.uniqStartBtn) {
      this.els.uniqStartBtn.addEventListener("click", () => this.handleUniquifierStart());
    }
    if (this.els.uniqStopBtn) {
      this.els.uniqStopBtn.addEventListener("click", () => this.handleUniquifierStop());
    }
    if (this.els.uniqOpenInputBtn) {
      this.els.uniqOpenInputBtn.addEventListener("click", () =>
        this.handleOpenFolder("input", this.els.uniqInputDir?.value)
      );
    }
    if (this.els.uniqOpenOutputBtn) {
      this.els.uniqOpenOutputBtn.addEventListener("click", () =>
        this.handleOpenFolder("output", this.els.uniqOutputDir?.value)
      );
    }

    // Auto-download events
    if (this.els.adStartBtn) {
      this.els.adStartBtn.addEventListener("click", () => this.handleAutoDownloadAction("/api/autodownload/start"));
    }
    if (this.els.adStopBtn) {
      this.els.adStopBtn.addEventListener("click", () => this.handleAutoDownloadAction("/api/autodownload/stop"));
    }
    if (this.els.adSaveSettingsBtn) {
      this.els.adSaveSettingsBtn.addEventListener("click", () => this.handleAutoDownloadSave());
    }
    if (this.els.defaultCaptionSaveBtn) {
      this.els.defaultCaptionSaveBtn.addEventListener("click", () =>
        this.handleSaveTextSetting(
          "DEFAULT_CAPTION",
          this.els.defaultCaptionInput,
          this.els.defaultCaptionSaveBtn,
          "Save Caption",
          "Default caption"
        )
      );
    }

    // Profile Downloader Listeners
    if (this.els.pdStartBtn) {
      this.els.pdStartBtn.addEventListener("click", () => this.handleProfileDownloadStart(false));
    }
    if (this.els.pdScanBtn) {
      this.els.pdScanBtn.addEventListener("click", () => this.handleProfileDownloadStart(true));
    }
    if (this.els.pdOpenFolderBtn) {
      this.els.pdOpenFolderBtn.addEventListener("click", () => this.handleProfileDownloadOpenFolder());
    }
  },

  async handleAddBrand() {
    if (!this.els.brandCreateRow) {
      const name = prompt("Brand name?");
      if (!name || !name.trim()) return;
      try {
        const result = await API.post("/api/accounts/add", { name: name.trim() });
        if (result?.ok === false && result?.error) {
          alert(result.error);
        }
        await this.refresh();
      } catch (err) {
        alert(`Could not add brand: ${err.message}`);
      }
      return;
    }

    this.els.brandCreateRow.classList.remove("hidden");
    if (this.els.brandNameInput) {
      this.els.brandNameInput.value = "";
      this.els.brandNameInput.focus();
    }
  },

  hideBrandCreator() {
    if (!this.els.brandCreateRow) return;
    this.els.brandCreateRow.classList.add("hidden");
    if (this.els.brandNameInput) {
      this.els.brandNameInput.value = "";
    }
  },

  async handleCreateBrand() {
    const name = this.els.brandNameInput?.value?.trim();
    if (!name) return;
    try {
      const result = await API.post("/api/accounts/add", { name });
      if (result?.ok === false && result?.error) {
        alert(result.error);
        return;
      }
      this.hideBrandCreator();
      await this.refresh();
    } catch (err) {
      alert(`Could not add brand: ${err.message}`);
    }
  },

  async handleBrandSelect(accountId) {
    if (!accountId || accountId === this.accountState.activeBrandId) return;
    this.flowConfigLoadSequence += 1;
    try {
      await API.post("/api/accounts/select", { accountId });
      this.flowDirty.clear();
      this.flowDownloadsSignature = "";
      if (this.els.flowGeminiApiKey) this.els.flowGeminiApiKey.value = "";
      if (this.els.flowGeminiKeyRemoveBtn) this.els.flowGeminiKeyRemoveBtn.dataset.remove = "false";
      if (this.els.flowPromptPreview) this.els.flowPromptPreview.classList.add("hidden");
      await this.refresh();
      document.dispatchEvent(new CustomEvent("autosocial:accountchange", { detail: { accountId } }));
      if (this.isViewActive("setup")) {
        await this.refreshSetupHealth();
      }
    } catch (err) {
      alert(`Could not switch brand: ${err.message}`);
    }
  },

  isViewActive(viewName) {
    return document.getElementById(`view-${viewName}`)?.classList.contains("active");
  },

  statusMeta(status) {
    const map = {
      ok: { label: "Ready", icon: "ph-check-circle", className: "ok" },
      warn: { label: "Needs attention", icon: "ph-warning-circle", className: "warn" },
      fail: { label: "Blocked", icon: "ph-x-circle", className: "fail" },
    };
    return map[status] || map.warn;
  },

  async refreshSetupHealth() {
    if (this.els.setupRefreshBtn) {
      this.els.setupRefreshBtn.disabled = true;
      this.els.setupRefreshBtn.innerHTML = '<i class="ph ph-circle-notch"></i> Checking';
    }

    try {
      const health = await API.get("/api/setup/health");
      this.renderSetupHealth(health);
    } catch (err) {
      if (this.els.setupSummaryTitle) this.els.setupSummaryTitle.textContent = "Setup check failed";
      if (this.els.setupSummaryMeta) this.els.setupSummaryMeta.textContent = err.message;
      if (this.els.setupChecksList) {
        this.els.setupChecksList.innerHTML = `
          <div class="setup-empty error">Could not load setup health: ${escapeHtml(err.message)}</div>
        `;
      }
    } finally {
      if (this.els.setupRefreshBtn) {
        this.els.setupRefreshBtn.disabled = false;
        this.els.setupRefreshBtn.innerHTML = '<i class="ph ph-arrows-clockwise"></i> Refresh';
      }
    }
  },

  renderSetupHealth(health) {
    if (!health || typeof health !== "object") return;
    const summary = this.statusMeta(health.overall);
    const activeBrand = health.activeAccount?.name || "Default";
    const updated = health.generatedAt ? new Date(health.generatedAt).toLocaleTimeString() : "just now";

    if (this.els.setupSummaryIcon) {
      this.els.setupSummaryIcon.className = `setup-summary-icon ${summary.className}`;
      this.els.setupSummaryIcon.innerHTML = `<i class="ph ${summary.icon}"></i>`;
    }
    if (this.els.setupSummaryTitle) {
      this.els.setupSummaryTitle.textContent =
        health.overall === "ok" ? "This workstation is ready" : "Review setup items before posting";
    }
    if (this.els.setupSummaryMeta) {
      this.els.setupSummaryMeta.textContent = `Active brand: ${activeBrand} - Last checked ${updated}`;
    }
    if (this.els.setupMetrics) {
      const counts = health.counts || {};
      this.els.setupMetrics.innerHTML = `
        <div class="setup-metric">
          <span class="setup-metric-value ok">${counts.ok ?? 0}</span>
          <span class="setup-metric-label">Ready</span>
        </div>
        <div class="setup-metric">
          <span class="setup-metric-value warn">${counts.warn ?? 0}</span>
          <span class="setup-metric-label">Warnings</span>
        </div>
        <div class="setup-metric">
          <span class="setup-metric-value fail">${counts.fail ?? 0}</span>
          <span class="setup-metric-label">Blocking</span>
        </div>
      `;
    }

    if (this.els.setupChecksList) {
      this.els.setupChecksList.innerHTML = (health.checks || [])
        .map((check) => {
          const meta = this.statusMeta(check.status);
          return `
            <div class="setup-check-item ${meta.className}">
              <div class="setup-check-icon"><i class="ph ${meta.icon}"></i></div>
              <div class="setup-check-body">
                <div class="setup-check-title">${escapeHtml(check.label)}</div>
                <div class="setup-check-detail">${escapeHtml(check.detail)}</div>
                ${check.status === "ok" ? "" : `<div class="setup-check-action">${escapeHtml(check.action)}</div>`}
              </div>
            </div>
          `;
        })
        .join("");
    }

    if (this.els.setupSessionsList) {
      this.els.setupSessionsList.innerHTML = (health.sessions || [])
        .map((session) => {
          const meta = this.statusMeta(session.saved ? "ok" : "warn");
          return `
            <div class="setup-check-item ${meta.className}">
              <div class="setup-check-icon"><i class="ph ${meta.icon}"></i></div>
              <div class="setup-check-body">
                <div class="setup-check-title">${escapeHtml(session.label)}</div>
                <div class="setup-check-detail">${escapeHtml(session.saved ? "Saved session found" : "No saved session yet")}</div>
                <div class="setup-path">${escapeHtml(session.profileDir)}</div>
              </div>
            </div>
          `;
        })
        .join("");
    }

    if (this.els.setupFoldersList) {
      this.els.setupFoldersList.innerHTML = (health.folders || [])
        .map((folder) => {
          const meta = this.statusMeta(folder.exists ? "ok" : "fail");
          return `
            <div class="setup-folder-item">
              <div class="setup-folder-main">
                <div class="setup-folder-title">
                  <span class="setup-check-icon ${meta.className}"><i class="ph ${meta.icon}"></i></span>
                  ${escapeHtml(folder.label)}
                </div>
                <div class="setup-check-detail">${escapeHtml(folder.hint)}</div>
                <div class="setup-path">${escapeHtml(folder.path)}</div>
                <div class="setup-folder-meta">${folder.pendingCount ?? 0} video file(s) - ${escapeHtml((folder.supported || []).join(", "))}</div>
              </div>
              <button class="control-btn-small" data-setup-folder="${escapeHtml(folder.key)}">
                <i class="ph ph-folder-open"></i> Open
              </button>
            </div>
          `;
        })
        .join("");
    }

    if (this.els.setupNextSteps) {
      this.els.setupNextSteps.innerHTML = (health.nextSteps || [])
        .map(
          (step, index) => `
            <div class="setup-step">
              <span class="setup-step-number">${index + 1}</span>
              <span>${escapeHtml(step)}</span>
            </div>
          `
        )
        .join("");
    }
  },

  async handleSetupFolderClick(event) {
    const button = event.target.closest("button[data-setup-folder]");
    if (!button) return;
    button.disabled = true;
    try {
      await API.post("/api/setup/open-folder", { key: button.dataset.setupFolder });
    } catch (err) {
      alert(`Could not open folder: ${err.message}`);
    } finally {
      button.disabled = false;
    }
  },

  async handleAction(endpoint) {
    try {
      const result = await API.post(endpoint);
      if (result && result.skipped && result.reason) {
        alert(result.reason);
      } else if (result && result.ok === false && result.error) {
        alert(result.error);
      }
      this.refresh();
    } catch (err) {
      alert(`Action failed: ${err.message}`);
    }
  },

  getPlatformScheduleControls(platform) {
    const map = {
      tiktok: {
        type: this.els.ttPlanType,
        time: this.els.ttPlanTime,
        times: this.els.ttPlanTimes,
        weekday: this.els.ttPlanWeekday,
        cronInput: this.els.ttCronInput,
      },
      instagram: {
        type: this.els.igPlanType,
        time: this.els.igPlanTime,
        times: this.els.igPlanTimes,
        weekday: this.els.igPlanWeekday,
        cronInput: this.els.igCronInput,
      },
      youtube: {
        type: this.els.ytPlanType,
        time: this.els.ytPlanTime,
        times: this.els.ytPlanTimes,
        weekday: this.els.ytPlanWeekday,
        cronInput: this.els.ytCronInput,
      },
    };
    return map[platform];
  },

  getPlatformEndpoints(platform) {
    const map = {
      tiktok: { schedule: "/api/schedule", runOnce: "/api/run-once" },
      instagram: { schedule: "/api/instagram/schedule", runOnce: "/api/instagram/run-once" },
      youtube: { schedule: "/api/youtube/schedule", runOnce: "/api/youtube/run-once" },
    };
    return map[platform];
  },

  markScheduleDraftDirty(platform, dirty = true) {
    if (!Object.prototype.hasOwnProperty.call(this.scheduleDraftDirty, platform)) return;
    this.scheduleDraftDirty[platform] = dirty;
  },

  isScheduleDraftDirty(platform) {
    return Boolean(this.scheduleDraftDirty[platform]);
  },

  handleFriendlyScheduleDraftChange(platform) {
    this.markScheduleDraftDirty(platform, true);
    this.updateFriendlyScheduleVisibility(platform);
  },

  updateFriendlyScheduleVisibility(platform) {
    const controls = this.getPlatformScheduleControls(platform);
    if (
      !controls?.type ||
      !controls?.time ||
      !controls?.times ||
      !controls?.weekday ||
      !controls?.cronInput
    ) {
      return;
    }
    const mode = controls.type.value;
    controls.weekday.style.display = mode === "weekly" ? "" : "none";
    controls.time.style.display = /^every\d+h$/.test(mode) || mode === "dailyTimes" ? "none" : "";
    controls.times.style.display = mode === "dailyTimes" ? "" : "none";
    controls.cronInput.disabled = mode !== "custom";
  },

  parseCronToFriendly(cronExpression) {
    const cron = (cronExpression || "").trim();
    const daily = cron.match(/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/);
    if (daily) {
      const minute = String(Number(daily[1])).padStart(2, "0");
      const hour = String(Number(daily[2])).padStart(2, "0");
      return { mode: "daily", time: `${hour}:${minute}` };
    }

    const weekly = cron.match(/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+([0-6])$/);
    if (weekly) {
      const minute = String(Number(weekly[1])).padStart(2, "0");
      const hour = String(Number(weekly[2])).padStart(2, "0");
      return { mode: "weekly", time: `${hour}:${minute}`, weekday: weekly[3] };
    }

    const everyNh = cron.match(/^(\d{1,2})\s+\*\/(\d{1,2})\s+\*\s+\*\s+\*$/);
    if (everyNh) {
      const step = Number(everyNh[2]);
      if ([2, 3, 4, 6, 8, 12].includes(step)) {
        return { mode: `every${step}h` };
      }
    }

    return { mode: "custom" };
  },

  applyFriendlyScheduleFromCron(platform, cronExpression) {
    if (this.isScheduleDraftDirty(platform)) {
      this.updateFriendlyScheduleVisibility(platform);
      return;
    }
    const controls = this.getPlatformScheduleControls(platform);
    if (!controls?.type) return;
    const parsed = this.parseCronToFriendly(cronExpression);
    if (controls.type && document.activeElement !== controls.type) {
      controls.type.value = parsed.mode;
    }
    if (controls.time && parsed.time && document.activeElement !== controls.time) {
      controls.time.value = parsed.time;
    }
    if (controls.weekday && parsed.weekday && document.activeElement !== controls.weekday) {
      controls.weekday.value = parsed.weekday;
    }
    this.updateFriendlyScheduleVisibility(platform);
  },

  applySchedulePlanFromStatus(platform, statusData) {
    const controls = this.getPlatformScheduleControls(platform);
    if (!controls?.type) return;
    const plan = statusData?.schedulePlan;
    if (plan?.type === "daily-times") {
      if (!this.isScheduleDraftDirty(platform)) {
        controls.type.value = "dailyTimes";
        if (controls.times && document.activeElement !== controls.times) {
          controls.times.value = (plan.times || []).join(", ");
        }
      }
      this.updateFriendlyScheduleVisibility(platform);
      return;
    }

    this.applyFriendlyScheduleFromCron(platform, statusData?.cronExpression || "");
  },

  buildCronFromFriendly(mode, timeValue, weekdayValue) {
    const everyMatch = /^every(\d+)h$/.exec(mode || "");
    if (everyMatch) {
      const step = Number(everyMatch[1]);
      if ([2, 3, 4, 6, 8, 12].includes(step)) {
        return `0 */${step} * * *`;
      }
    }
    if (mode === "daily" || mode === "weekly") {
      const [hourRaw, minuteRaw] = (timeValue || "12:00").split(":");
      const hour = Math.min(Math.max(Number(hourRaw) || 0, 0), 23);
      const minute = Math.min(Math.max(Number(minuteRaw) || 0, 0), 59);
      if (mode === "daily") {
        return `${minute} ${hour} * * *`;
      }
      const weekday = ["0", "1", "2", "3", "4", "5", "6"].includes(String(weekdayValue))
        ? String(weekdayValue)
        : "1";
      return `${minute} ${hour} * * ${weekday}`;
    }
    return null;
  },

  parseTimesInput(value) {
    return String(value || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  },

  async handleFriendlySchedule(platform) {
    const controls = this.getPlatformScheduleControls(platform);
    const endpoints = this.getPlatformEndpoints(platform);
    if (!controls?.type || !endpoints) return;

    const mode = controls.type.value;
    if (mode === "once") {
      this.markScheduleDraftDirty(platform, false);
      await this.handleAction(endpoints.runOnce);
      return;
    }

    if (mode === "dailyTimes") {
      const parsedTimes = this.parseTimesInput(controls.times?.value);
      if (!parsedTimes.length) {
        alert("Please enter at least one time, e.g. 09:30, 13:15, 20:45");
        return;
      }
      try {
        await API.post(`${endpoints.schedule}-plan`, {
          type: "daily-times",
          times: parsedTimes,
        });
        this.markScheduleDraftDirty(platform, false);
        await this.refresh();
      } catch (err) {
        alert(`Schedule update failed: ${err.message}`);
      }
      return;
    }

    if (mode === "custom") {
      const cronExpression = controls.cronInput?.value?.trim();
      if (!cronExpression) {
        alert("Please enter a cron expression.");
        return;
      }
      try {
        await API.post(endpoints.schedule, { expression: cronExpression });
        this.markScheduleDraftDirty(platform, false);
        await this.refresh();
      } catch (err) {
        alert(`Schedule update failed: ${err.message}`);
      }
      return;
    }

    const cronExpression = this.buildCronFromFriendly(
      mode,
      controls.time?.value,
      controls.weekday?.value
    );
    if (!cronExpression) return;
    try {
      await API.post(endpoints.schedule, { expression: cronExpression });
      this.markScheduleDraftDirty(platform, false);
      await this.refresh();
    } catch (err) {
      alert(`Schedule update failed: ${err.message}`);
    }
  },

  async handleUpdateSchedule(
    fromTikTokView,
    fromInstagramView = false,
    fromYouTubeView = false
  ) {
    const platform = fromYouTubeView
      ? "youtube"
      : fromInstagramView
        ? "instagram"
        : "tiktok";
    const input = platform === "youtube"
      ? this.els.ytCronInput
      : platform === "instagram"
        ? this.els.igCronInput
        : this.els.ttCronInput;
    const saveBtn = platform === "youtube"
      ? this.els.ytUpdateScheduleBtn
      : platform === "instagram"
        ? this.els.igUpdateScheduleBtn
        : this.els.ttUpdateScheduleBtn;
    if (!input || !saveBtn) return;

    const expression = input.value.trim();
    if (!expression) return;

    try {
      const defaultLabel = "Save Schedule";
      saveBtn.textContent = "Saved!";
      setTimeout(() => {
        saveBtn.textContent = defaultLabel;
      }, 2000);

      const endpoint = fromYouTubeView
        ? "/api/youtube/schedule"
        : fromInstagramView
          ? "/api/instagram/schedule"
          : "/api/schedule";
      await API.post(endpoint, { expression });
      this.markScheduleDraftDirty(platform, false);
      this.refresh();
    } catch (err) {
      alert(`Schedule update failed: ${err.message}`);
    }
  },

  buildUniquifierOptions() {
    const options = {};
    const num = (el) => {
      const raw = el?.value?.trim();
      if (raw === undefined || raw === null || raw === "") return undefined;
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    };
    const crop = num(this.els.uniqCropPercent);
    const noise = num(this.els.uniqNoiseStrength);
    const opacity = num(this.els.uniqOverlayOpacity);
    const size = num(this.els.uniqOverlaySize);
    if (crop !== undefined) options.cropPercent = crop;
    if (noise !== undefined) options.noiseStrength = noise;
    if (opacity !== undefined) options.overlayOpacity = String(opacity);
    if (size !== undefined) options.overlaySize = size;
    if (this.els.uniqMirror?.checked) options.mirror = true;
    return options;
  },

  async handleUniquifierStart() {
    try {
      await API.post("/api/uniquifier/start", {
        inputDir: this.els.uniqInputDir?.value?.trim(),
        outputDir: this.els.uniqOutputDir?.value?.trim(),
        logoImage: this.els.uniqLogoImage?.value?.trim(),
        intensity: this.els.uniqIntensity?.value || "suave",
        options: this.buildUniquifierOptions(),
      });
      await this.refresh();
    } catch (err) {
      alert(`Uniquifier start failed: ${err.message}`);
    }
  },

  async handleUniquifierStop() {
    try {
      await API.post("/api/uniquifier/stop");
      await this.refresh();
    } catch (err) {
      alert(`Uniquifier stop failed: ${err.message}`);
    }
  },

  async handleOpenFolder(kind, folderPath) {
    try {
      await API.post("/api/uniquifier/open-folder", {
        kind,
        folderPath: folderPath || undefined,
      });
    } catch (err) {
      alert(`Could not open folder: ${err.message}`);
    }
  },

  async handleInstantPostToggle(platform, enabled) {
    const endpointMap = {
      tiktok: "/api/instant-post",
      instagram: "/api/instagram/instant-post",
      youtube: "/api/youtube/instant-post",
    };
    const toggleMap = {
      tiktok: this.els.ttInstantPostToggle,
      instagram: this.els.igInstantPostToggle,
      youtube: this.els.ytInstantPostToggle,
    };
    try {
      await API.post(endpointMap[platform], { enabled });
      this.refresh();
    } catch (err) {
      alert(`Could not toggle instant post: ${err.message}`);
      if (toggleMap[platform]) {
        toggleMap[platform].checked = !enabled;
      }
    }
  },

  async handleRandomQueueToggle(enabled) {
    const toggles = [
      this.els.ttRandomQueueToggle,
      this.els.igRandomQueueToggle,
      this.els.ytRandomQueueToggle,
    ].filter(Boolean);
    try {
      const result = await API.post("/api/settings/save", {
        payload: { RANDOM_QUEUE_ORDER: enabled },
      });
      if (result?.ok === false && result?.error) {
        throw new Error(result.error);
      }
      this.refresh();
    } catch (err) {
      alert(`Could not update random queue order: ${err.message}`);
      toggles.forEach((toggle) => {
        toggle.checked = !enabled;
      });
    }
  },

  async handleSaveTextSetting(envKey, inputEl, buttonEl, idleLabel, label) {
    if (!inputEl) return;

    try {
      const result = await API.post("/api/settings/save", {
        payload: { [envKey]: inputEl.value || "" },
      });
      if (result?.ok === false && result?.error) {
        throw new Error(result.error);
      }
      if (buttonEl) {
        buttonEl.innerHTML = '<i class="ph ph-check"></i> Saved!';
        setTimeout(() => {
          buttonEl.textContent = idleLabel;
        }, 2000);
      }
      this.refresh();
    } catch (err) {
      alert(`${label} save failed: ${err.message}`);
    }
  },

  async handleInstagramLogin() {
    await this.handlePlatformLogin("instagram");
  },

  async handleYouTubeLogin() {
    await this.handlePlatformLogin("youtube");
  },

  async handlePlatformLogin(platform) {
    const endpointMap = {
      tiktok: "/api/tiktok/login",
      instagram: "/api/instagram/login",
      youtube: "/api/youtube/login",
    };
    const labelMap = {
      tiktok: "TikTok",
      instagram: "Instagram",
      youtube: "YouTube",
    };
    try {
      const result = await API.post(endpointMap[platform]);
      if (result.alreadyOpen) {
        alert(`${labelMap[platform]} login browser is already open.`);
      } else {
        alert(`${labelMap[platform]} Chromium opened. Please log in there once.`);
      }
      await this.refresh();
    } catch (err) {
      alert(`${labelMap[platform]} login failed: ${err.message}`);
    }
  },

  async handlePlatformCloseLogin(platform) {
    const endpointMap = {
      tiktok: "/api/tiktok/login/close",
      instagram: "/api/instagram/login/close",
      youtube: "/api/youtube/login/close",
    };
    const labelMap = {
      tiktok: "TikTok",
      instagram: "Instagram",
      youtube: "YouTube",
    };
    try {
      const result = await API.post(endpointMap[platform]);
      if (!result.alreadyClosed) {
        alert(`${labelMap[platform]} login browser closed.`);
      }
      await this.refresh();
    } catch (err) {
      alert(`Could not close ${labelMap[platform]} login browser: ${err.message}`);
    }
  },

  async handleAccountsTableClick(event) {
    const button = event.target.closest("button[data-platform][data-action]");
    if (!button) return;
    const { platform, action } = button.dataset;
    if (action === "login") {
      await this.handlePlatformLogin(platform);
      return;
    }
    if (action === "close") {
      await this.handlePlatformCloseLogin(platform);
    }
  },

  startPolling() {
    this.refresh();
    setInterval(() => this.refresh(), 3000);
  },

  // MARKER: XAP-RENDER-v1
  async refreshXSession() {
    try {
      const data = await API.get("/api/x-autopilot/session");
      this.renderXSession(data);
    } catch (error) {
      if (this.els.xLoginStateBadge) this.els.xLoginStateBadge.textContent = "Sin sesion";
    }
  },

  renderXSession(data) {
    if (!this.els.xLoginStateBadge) return;
    const session = data?.session || {};
    const ready = Boolean(session.saved);
    this.els.xLoginStateBadge.textContent = ready ? "Sesion guardada" : (session.open ? "Ventana abierta" : "Sin sesion");
    this.els.xLoginStateBadge.className = "status-badge" + (ready ? " success" : "");
    if (this.els.xLoginMessage) {
      this.els.xLoginMessage.textContent = ready
        ? "Sesion de X lista. La publicacion automatica usara esta cuenta."
        : "Aun no hay sesion guardada. Inicia sesion en la ventana de X o pega tus cookies.";
    }
    const worker = data?.worker ? "worker activo" : "worker detenido";
    if (this.els.xLoginTitle) this.els.xLoginTitle.textContent = "Sesion de X (Twitter) - " + worker;
  },

  async xLoginOpen() { try { await API.post("/api/x-autopilot/login", {}); await this.refreshXSession(); } catch (error) { alert(error.message); } },
  async xLoginSave() { try { const r = await API.post("/api/x-autopilot/login/save", {}); if (r && r.ok === false) throw new Error(r.error); await this.refreshXSession(); } catch (error) { alert(error.message); } },
  async xLoginClose() { try { await API.post("/api/x-autopilot/login/close", {}); await this.refreshXSession(); } catch (error) { alert(error.message); } },
  async xImportCookies() {
    const value = this.els.xCookiesInput?.value || "";
    if (!value.trim()) { alert("Pega tus cookies primero."); return; }
    try {
      const r = await API.post("/api/x-autopilot/cookies", { cookies: value });
      if (r && r.ok === false) throw new Error(r.error);
      if (this.els.xCookiesInput) this.els.xCookiesInput.value = "";
      await this.refreshXSession();
    } catch (error) { alert(error.message); }
  },
  async xRetryFailed() { try { await API.post("/api/x-autopilot/retry", {}); await this.refreshXAutopilot(); } catch (error) { alert(error.message); } },

  async refreshXAutopilot() { try { const data = await API.get("/api/x-autopilot"); this.renderXAutopilot(data); } catch {} },

  // MARKER: AICFG-LOGIC-v1
  aiConfig: null,

  async loadAiConfig() {
    try {
      this.aiConfig = await API.get("/api/ai-config");
      this.renderAiConfig(this.aiConfig);
      return this.aiConfig;
    } catch (error) {
      if (this.els.aiChainBadge) this.els.aiChainBadge.textContent = "Error: " + error.message;
      return null;
    }
  },

  renderAiConfig(data) {
    if (!data) return;
    const chain = data.chain || [];
    if (this.els.aiChainBadge) {
      this.els.aiChainBadge.textContent = chain.length
        ? chain.length + " modelos listos"
        : "Sin proveedores";
      this.els.aiChainBadge.className = "status-badge" + (chain.length ? " success" : "");
    }
    if (this.els.aiChainEnabled) this.els.aiChainEnabled.checked = data.enabled !== false;

    if (this.els.aiChainList) {
      const steps = [];
      const seen = new Set();
      for (const item of chain) {
        if (seen.has(item.provider)) continue;
        seen.add(item.provider);
        steps.push(`<span class="ai-chain-step ${item.free ? "free" : ""}">${escapeHtml(item.label)}${item.free ? " · gratis" : ""}</span>`);
      }
      this.els.aiChainList.innerHTML = steps.length
        ? steps.join('<span class="ai-chain-arrow">→</span>')
        : '<span class="form-hint">Aun no hay ninguna clave guardada. Empieza por xKiro, que es gratis.</span>';
    }

    if (this.els.aiProviderGrid) {
      this.els.aiProviderGrid.innerHTML = (data.providers || []).map((provider) => {
        const status = data.providerKeys?.[provider.id] || {};
        const modelList = (provider.models || []).map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.label || m.id)}</option>`).join("");
        return `
          <div class="card">
            <div class="card-title" style="display:flex; align-items:center; gap:8px;">
              ${escapeHtml(provider.label)}
              ${provider.free ? '<span class="tag-free">gratis</span>' : ""}
              ${status.configured ? '<span class="tag-ok">lista</span>' : ""}
            </div>
            <p class="form-hint">${escapeHtml(provider.keyHint || "")}</p>
            <div class="helios-key-row">
              <input id="aiKey_${provider.id}" class="control-input" type="password"
                placeholder="${status.configured ? escapeHtml(status.masked) : "Pega tu clave"}" />
              <button class="control-btn-small primary" data-ai-save="${provider.id}">Guardar</button>
              <button class="control-btn-small danger" data-ai-remove="${provider.id}">Quitar</button>
            </div>
            <div class="helios-key-row" style="margin-top:8px;">
              <select class="control-input" id="aiModel_${provider.id}">${modelList}</select>
            </div>
          </div>`;
      }).join("");

      this.els.aiProviderGrid.querySelectorAll("[data-ai-save]").forEach((button) => {
        button.addEventListener("click", () => this.saveAiKey(button.dataset.aiSave));
      });
      this.els.aiProviderGrid.querySelectorAll("[data-ai-remove]").forEach((button) => {
        button.addEventListener("click", () => this.removeAiKey(button.dataset.aiRemove));
      });
    }

    if (this.els.aiTestProvider) {
      this.els.aiTestProvider.innerHTML = (data.providers || [])
        .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.label)}</option>`)
        .join("");
    }
    if (this.els.aiLastTest) {
      const last = data.lastTest;
      this.els.aiLastTest.textContent = last
        ? `Ultima prueba: ${last.provider}/${last.model} · ${last.ms}ms · "${String(last.sample || "").slice(0, 40)}"`
        : "Aun no has probado ninguna clave.";
    }
  },

  async saveAiKey(providerId) {
    const input = document.getElementById("aiKey_" + providerId);
    const value = input?.value.trim() || "";
    if (!value) { alert("Pega la clave primero."); return; }
    try {
      await API.post("/api/ai-config", { providerKeys: { [providerId]: value } });
      input.value = "";
      await this.loadAiConfig();
    } catch (error) { alert(error.message); }
  },

  async removeAiKey(providerId) {
    try {
      await API.post("/api/ai-config", { removeProviders: [providerId] });
      await this.loadAiConfig();
    } catch (error) { alert(error.message); }
  },

  async testAiProvider() {
    const provider = this.els.aiTestProvider?.value;
    if (!provider) return;
    if (this.els.aiTestResult) this.els.aiTestResult.textContent = "Probando...";
    try {
      const data = await API.post("/api/ai-config/test", { provider });
      const last = data.lastTest || {};
      if (this.els.aiTestResult) this.els.aiTestResult.textContent = `OK · ${last.model} · ${last.ms}ms`;
      this.renderAiConfig(data);
    } catch (error) {
      if (this.els.aiTestResult) this.els.aiTestResult.textContent = "Fallo: " + error.message;
    }
  },

  async toggleAiChain(enabled) {
    try {
      const data = await API.post("/api/ai-config", { enabled: Boolean(enabled) });
      this.renderAiConfig(data);
    } catch (error) { alert(error.message); }
  },

    // MARKER: ACCTAN-JS-v1
  acctProfiles: [],
  acctSelected: null,
  acctPoll: null,
  acctSession: { saved: false, open: false },

  async refreshAcctSession() {
    try {
      const data = await API.get("/api/x-autopilot/session");
      this.acctSession = data.session || { saved: false, open: false };
    } catch {
      this.acctSession = { saved: false, open: false };
    }
    this.renderAcctSession();
    return this.acctSession;
  },

  renderAcctSession() {
    const s = this.acctSession || {};
    const saved = Boolean(s.saved);
    if (this.els.acctSessionBadge) {
      this.els.acctSessionBadge.textContent = saved ? "Sesion guardada" : (s.open ? "Ventana abierta" : "Sin sesion");
      this.els.acctSessionBadge.className = "status-badge" + (saved ? " success" : "");
    }
    if (this.els.acctSessionMessage) {
      this.els.acctSessionMessage.textContent = saved
        ? "Sesion de X lista. Ya puedes analizar cualquier cuenta."
        : "Necesitas iniciar sesion en X aqui mismo para poder leer los posts de una cuenta.";
    }
    if (this.els.acctStartBtn) {
      this.els.acctStartBtn.disabled = !saved;
      this.els.acctStartBtn.style.opacity = saved ? "1" : "0.5";
      this.els.acctStartBtn.style.cursor = saved ? "pointer" : "not-allowed";
      this.els.acctStartBtn.title = saved ? "Analizar la cuenta" : "Primero inicia sesion en X";
    }
    if (this.els.acctSessionWarning) {
      this.els.acctSessionWarning.style.display = saved ? "none" : "block";
    }
  },

  async acctLoginOpen() {
    try {
      await API.post("/api/x-autopilot/login", {});
      await this.refreshAcctSession();
      this.setAcctProgress("Ventana de X abierta. Inicia sesion en ella y luego pulsa Guardar sesion.");
    } catch (error) { this.setAcctProgress("Error: " + error.message, true); }
  },

  async acctLoginSave() {
    try {
      const r = await API.post("/api/x-autopilot/login/save", {});
      if (r && r.ok === false) throw new Error(r.error);
      await this.refreshAcctSession();
      this.setAcctProgress("Sesion guardada. Ya puedes analizar una cuenta.");
    } catch (error) { this.setAcctProgress("Error: " + error.message, true); }
  },

  async acctLoginClose() {
    try {
      await API.post("/api/x-autopilot/login/close", {});
      await this.refreshAcctSession();
    } catch (error) { alert(error.message); }
  },

  async loadAccountAnalysis() {
    try {
      const data = await API.get("/api/account-analysis");
      this.acctProfiles = data.profiles || [];
      this.renderAccountProfiles();
      if (data.job && data.job.running) this.startAcctPolling();
      else if (data.job && data.job.error) this.setAcctProgress("Error: " + data.job.error, true);
      return data;
    } catch (error) {
      if (this.els.acctAnalysisBadge) this.els.acctAnalysisBadge.textContent = "Error";
      return null;
    }
  },

  renderAccountProfiles() {
    const list = this.els.acctProfileList;
    if (!list) return;
    if (this.els.acctAnalysisBadge) {
      this.els.acctAnalysisBadge.textContent = this.acctProfiles.length
        ? this.acctProfiles.length + " cuenta(s)"
        : "Sin analisis";
      this.els.acctAnalysisBadge.className = "status-badge" + (this.acctProfiles.length ? " success" : "");
    }
    if (!this.acctProfiles.length) {
      list.innerHTML = '<div class="setup-empty">Todavia no has analizado ninguna cuenta.</div>';
      return;
    }
    list.innerHTML = this.acctProfiles.map((p) => `
      <div class="x-reference-item" style="cursor:pointer;" data-acct="${escapeHtml(p.handle)}">
        <strong>@${escapeHtml(p.handle)}</strong>
        <span>${p.posts} publicaciones · ${p.originals} propias · ${p.replies} respuestas</span>
        <span class="form-hint">${escapeHtml((p.topTopics || []).join(" · "))}</span>
      </div>`).join("");
    list.querySelectorAll("[data-acct]").forEach((node) => {
      node.addEventListener("click", () => this.openAccountProfile(node.dataset.acct));
    });
  },

  async openAccountProfile(handle) {
    try {
      const data = await API.get("/api/account-analysis/" + encodeURIComponent(handle));
      this.acctSelected = data.data;
      this.renderAccountDetail();
    } catch (error) { alert(error.message); }
  },

  renderAccountDetail() {
    const data = this.acctSelected;
    if (!data) return;
    const a = data.analysis || {};
    const f = a.format || {};
    if (this.els.acctDetailTitle) this.els.acctDetailTitle.textContent = "@" + data.handle;
    if (this.els.acctDetailBody) {
      const topics = (a.topics || []).slice(0, 5).map((t) => `<span class="ai-chain-step">${escapeHtml(t.topic)} · ${t.count}</span>`).join("");
      const hints = (a.keywords || []).slice(0, 20).map((k) => k.word).join(", ");
      this.els.acctDetailBody.innerHTML = `
        <div class="ai-chain-list" style="margin-bottom:12px;">${topics || '<span class="form-hint">Sin temas detectados.</span>'}</div>
        <p class="form-hint"><b>${f.total || 0}</b> publicaciones · <b>${f.originalPosts || 0}</b> propias · <b>${f.replies || 0}</b> respuestas</p>
        <p class="form-hint">Longitud media: <b>${f.avgLength || 0}</b> caracteres · Emojis: ${f.emojiRatio ?? 0} · Imagen en ${f.withImage || 0}</p>
        <p class="form-hint">Sentimiento: <b>${escapeHtml(a.sentiment?.label || "?")}</b> (${a.sentiment?.score ?? 0})</p>
        <p class="form-hint">Ritmo: <b>${a.rhythm?.postsPerDay ?? 0}</b> publicaciones/dia durante ${a.rhythm?.spanDays ?? 0} dias</p>
        <p class="form-hint" style="margin-top:8px;">Palabras clave: ${escapeHtml(hints)}</p>`;
    }
    if (this.els.acctManual) this.els.acctManual.textContent = data.manual || "Sin manual generado.";
    if (this.els.acctUseBtn) this.els.acctUseBtn.dataset.handle = data.handle;
  },

  async startAccountAnalysis() {
    const handle = (this.els.acctHandle?.value || "").trim();
    if (!handle) { this.setAcctProgress("Escribe un @ de X primero.", true); return; }
    if (!this.acctSession?.saved) {
      this.setAcctProgress("No puedes analizar todavia: primero inicia sesion en X (boton de arriba).", true);
      if (this.els.acctSessionWarning) this.els.acctSessionWarning.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    const maxPosts = Number(this.els.acctMaxPosts?.value) || 150;
    try {
      this.setAcctProgress("Iniciando analisis de " + handle + "...");
      await API.post("/api/account-analysis/start", { handle, maxPosts });
      this.startAcctPolling();
    } catch (error) { this.setAcctProgress("Error: " + error.message, true); }
  },

  startAcctPolling() {
    if (this.acctPoll) return;
    this.setAcctProgress("Preparando la extraccion...");
    this.acctPoll = setInterval(async () => {
      try {
        const job = await API.get("/api/account-analysis/status");
        if (job.running) {
          const phases = {
            "abriendo perfil": "Abriendo el perfil en X",
            "cargando perfil": "Cargando el perfil",
            "recogiendo publicaciones": "Recogiendo publicaciones",
            "analizando": "Analizando los datos",
            "generando manual": "Generando el manual de ADN",
          };
          const label = phases[job.phase] || job.phase;
          this.setAcctProgress(`@${job.handle} — ${label}: ${job.collected} de ${job.maxPosts} publicaciones. No cierres esta ventana.`);
        } else {
          clearInterval(this.acctPoll);
          this.acctPoll = null;
          if (job.error) this.setAcctProgress("Error: " + job.error, true);
          else {
            this.setAcctProgress(`Listo: ${job.collected} publicaciones analizadas. Ya aparece abajo.`);
            await this.loadAccountAnalysis();
            if (job.handle) await this.openAccountProfile(job.handle);
          }
        }
      } catch (error) {
        clearInterval(this.acctPoll);
        this.acctPoll = null;
        this.setAcctProgress("Error al consultar el progreso: " + error.message, true);
      }
    }, 3000);
  },

  setAcctProgress(message, isError) {
    const box = this.els.acctProgressBox;
    const text = this.els.acctProgress;
    if (!text) return;
    text.textContent = message;
    if (box) {
      box.style.display = "block";
      box.style.background = isError ? "#2a0f0f" : "#101c2e";
      box.style.borderColor = isError ? "#5c1a1a" : "#1e3a63";
      text.style.color = isError ? "#f87171" : "#9cc3ff";
    }
  },

  async useAccountForReference() {
    const handle = this.els.acctUseBtn?.dataset.handle;
    if (!handle) { alert("Selecciona una cuenta primero."); return; }
    try {
      await API.post("/api/x-autopilot/configure", { referenceHandle: handle });
      alert("Ahora X Autopilot usara @" + handle + " como referencia de estilo.");
    } catch (error) { alert(error.message); }
  },

  async deleteAccountAnalysis() {
    const handle = this.els.acctUseBtn?.dataset.handle;
    if (!handle) { alert("Selecciona una cuenta primero."); return; }
    if (!confirm("Borrar el analisis de @" + handle + "?")) return;
    try {
      await API.delete("/api/account-analysis/" + encodeURIComponent(handle));
      this.acctSelected = null;
      if (this.els.acctManual) this.els.acctManual.textContent = "Selecciona una cuenta para ver su manual.";
      if (this.els.acctDetailBody) this.els.acctDetailBody.innerHTML = '<p class="form-hint">Selecciona una cuenta de la lista.</p>';
      await this.loadAccountAnalysis();
    } catch (error) { alert(error.message); }
  },

  async refresh() {
    try {
      const [
        status,
        instagramStatus,
        youtubeStatus,
        uniquifier,
        accounts,
        tiktokLoginStatus,
        instagramLoginStatus,
        youtubeLoginStatus,
        flowStatus,
      ] = await Promise.all([
        API.get("/api/status"),
        API.get("/api/instagram/status"),
        API.get("/api/youtube/status"),
        API.get("/api/uniquifier/status"),
        API.get("/api/accounts"),
        API.get("/api/tiktok/login/status"),
        API.get("/api/instagram/login/status"),
        API.get("/api/youtube/login/status"),
        API.get("/api/google-flow/status"),
      ]);
      // Fetch autodownload status in parallel but don't block others
      API.get("/api/autodownload/status").then((ad) => this.renderAutoDownloadStatus(ad)).catch(() => { });
      API.get("/api/profile-download/status").then((pd) => this.renderProfileDownloadStatus(pd)).catch(() => { });
      API.get("/api/x-autopilot").then((data) => this.renderXAutopilot(data)).catch(() => { });
      API.get("/api/overview").then((ov) => this.renderOverview(ov)).catch(() => { });
      API.get("/api/account-manager").then((manager) => this.renderManagedAccounts(manager)).catch((error) => {
        if (this.els.accountVaultMessage) this.els.accountVaultMessage.textContent = error.message;
      });
      API.get("/api/jobs?limit=100").then((jobs) => this.renderAutonomousJobs(jobs)).catch(() => { });
      API.get("/api/google-flow/downloads").then((downloads) => this.renderFlowDownloads(downloads)).catch(() => { });

      this.renderStatus(status);
      this.renderInstagramStatus(instagramStatus);
      this.renderYouTubeStatus(youtubeStatus);
      this.renderUniquifierStatus(uniquifier);
      this.renderBrandSelector(accounts);
      this.accountState = {
        tiktok: {
          loginOpen: Boolean(tiktokLoginStatus?.open),
          sessionSaved: Boolean(tiktokLoginStatus?.saved),
          schedulerRunning: Boolean(status?.running),
        },
        instagram: {
          loginOpen: Boolean(instagramLoginStatus?.open),
          sessionSaved: Boolean(instagramLoginStatus?.saved),
          schedulerRunning: Boolean(instagramStatus?.running),
        },
        youtube: {
          loginOpen: Boolean(youtubeLoginStatus?.open),
          sessionSaved: Boolean(youtubeLoginStatus?.saved),
          schedulerRunning: Boolean(youtubeStatus?.running),
        },
        brands: accounts?.accounts || [],
        activeBrandId: accounts?.activeAccountId || null,
        activeBrandName: accounts?.activeAccount?.name || "",
      };
      this.renderAccounts();
      this.renderFlowStatus(flowStatus, accounts);
      this.loadFlowConfig();
    } catch (err) {
      console.warn("Polling error", err);
    }
  },

  updateLogContainer(container, html) {
    if (!container) return;
    const nextHtml = html || "";
    if (container.innerHTML === nextHtml) return;

    const topThreshold = 24;
    const wasNearTop = container.scrollTop <= topThreshold;
    const bottomOffset = Math.max(
      0,
      container.scrollHeight - container.clientHeight - container.scrollTop
    );

    container.innerHTML = nextHtml;

    if (wasNearTop) {
      container.scrollTop = 0;
      return;
    }

    container.scrollTop = Math.max(
      0,
      container.scrollHeight - container.clientHeight - bottomOffset
    );
  },

  renderBrandSelector(data) {
    if (!this.els.brandSelect || !data) return;
    const brands = Array.isArray(data.accounts) ? data.accounts : [];
    const activeAccountId = data.activeAccountId || brands[0]?.id || "";
    const currentValue = this.els.brandSelect.value;

    this.els.brandSelect.innerHTML = brands
      .map((brand) => `<option value="${escapeHtml(brand.id)}">${escapeHtml(brand.name)}</option>`)
      .join("");

    if (brands.some((brand) => brand.id === currentValue)) {
      this.els.brandSelect.value = currentValue;
    } else {
      this.els.brandSelect.value = activeAccountId;
    }
  },

  renderOverview(overviewData) {
    if (!overviewData || typeof overviewData !== "object") return;
    const container = this.els.overviewProfilesContainer;
    if (!container) return;

    const platformMeta = {
      tiktok: {
        label: "TikTok",
        icon: "ph-tiktok-logo",
        color: "#ff0050",
        bg: "linear-gradient(135deg,#00f2ea,#ff0050)",
      },
      instagram: {
        label: "Instagram",
        icon: "ph-instagram-logo",
        color: "#E1306C",
        bg: "linear-gradient(135deg,#833AB4,#E1306C,#F77737)",
      },
      youtube: {
        label: "YouTube",
        icon: "ph-youtube-logo",
        color: "#FF0000",
        bg: "#FF0000",
      },
    };

    const escapeHtml = (value) => String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

    const getProfileName = (profileId) => {
      const brands = this.accountState?.brands || [];
      const match = brands.find((brand) => brand.id === profileId);
      return match?.name || profileId;
    };

    const formatSchedule = (status) => {
      if (status?.schedulePlan?.type === "daily-times") {
        const times = Array.isArray(status.schedulePlan.times) && status.schedulePlan.times.length
          ? status.schedulePlan.times.join(", ")
          : "Not set";
        return `Daily: ${times}`;
      }
      if (status?.cronExpression) {
        return `Cron: ${status.cronExpression}`;
      }
      return "Not scheduled";
    };

    const formatLastRun = (status) => (
      status?.lastRunAt ? new Date(status.lastRunAt).toLocaleString() : "Never"
    );

    const getBadge = (status) => {
      if (status?.isPosting) {
        return { text: "Posting", color: "var(--status-warn)" };
      }
      if (status?.running) {
        return { text: "Running", color: "var(--status-good)" };
      }
      return { text: "Stopped", color: "var(--status-bad)" };
    };

    let totalPending = 0;
    let totalPosted = 0;
    let totalFailed = 0;
    let activeSchedulers = 0;
    const allLogs = [];
    const profileSections = [];

    for (const [profileId, statuses] of Object.entries(overviewData)) {
      const profileName = getProfileName(profileId);
      const cards = [];

      for (const [platformKey, meta] of Object.entries(platformMeta)) {
        const status = statuses?.[platformKey];
        if (!status) continue;

        const queueCounts = status.queue?.counts || {};
        const pending = Number(queueCounts.pending || 0);
        const posted = Number(queueCounts.posted || 0);
        const failed = Number(queueCounts.failed || 0);
        const badge = getBadge(status);

        totalPending += pending;
        totalPosted += posted;
        totalFailed += failed;
        if (status.running) {
          activeSchedulers += 1;
        }

        for (const log of status.logs || []) {
          allLogs.push({ ...log, platform: meta.label, profile: profileName });
        }

        cards.push(`
          <div class="card" style="border-left:3px solid ${meta.color};">
            <div style="display:flex; align-items:center; gap:12px; margin-bottom:14px;">
              <div class="brand-icon" style="background:${meta.bg}; width:34px; height:34px; font-size:18px;">
                <i class="ph ${meta.icon}"></i>
              </div>
              <div style="min-width:0;">
                <div style="font-weight:600; font-size:15px;">${escapeHtml(meta.label)}</div>
                <div class="status-badge" style="margin-top:4px; color:${badge.color}; border:1px solid ${badge.color}; background:rgba(255,255,255,0.03);">
                  ${escapeHtml(badge.text)}
                </div>
              </div>
            </div>
            <div style="display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:8px; text-align:center;">
              <div>
                <div style="font-size:22px; font-weight:700;">${pending}</div>
                <div style="font-size:11px; color:var(--text-muted);">Pending</div>
              </div>
              <div>
                <div style="font-size:22px; font-weight:700; color:var(--success);">${posted}</div>
                <div style="font-size:11px; color:var(--text-muted);">Posted</div>
              </div>
              <div>
                <div style="font-size:22px; font-weight:700; color:var(--danger);">${failed}</div>
                <div style="font-size:11px; color:var(--text-muted);">Failed</div>
              </div>
            </div>
            <div style="margin-top:12px; padding-top:10px; border-top:1px solid rgba(255,255,255,0.06); font-size:12px; color:var(--text-muted);">
              <div><i class="ph ph-clock"></i> ${escapeHtml(formatSchedule(status))}</div>
              <div style="margin-top:4px;"><i class="ph ph-calendar-blank"></i> Last: ${escapeHtml(formatLastRun(status))}</div>
            </div>
          </div>
        `);
      }

      if (cards.length > 0) {
        profileSections.push(`
          <div style="margin-bottom:22px;">
            <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px; font-size:14px; font-weight:600; color:var(--text-primary);">
              <i class="ph ph-user"></i>
              <span>${escapeHtml(profileName)}</span>
            </div>
            <div style="display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:12px;">
              ${cards.join("")}
            </div>
          </div>
        `);
      }
    }

    container.innerHTML = profileSections.join("") || `
      <div class="card full-width">
        <div style="text-align:center; padding:28px; color:var(--text-muted);">No profile overview data yet.</div>
      </div>
    `;

    const setValue = (el, value) => {
      if (el) el.textContent = value;
    };
    setValue(this.els.pendingCount, totalPending);
    setValue(this.els.successCount, totalPosted);
    setValue(this.els.failedCount, totalFailed);
    setValue(this.els.activeAccountsCount, activeSchedulers);

    allLogs.sort((a, b) => (b.at || "").localeCompare(a.at || ""));
    const recentLogs = allLogs.slice(0, 50);

    const logsHtml = recentLogs.length
      ? recentLogs.map((logEntry) => {
        const time = logEntry.at ? new Date(logEntry.at).toLocaleTimeString() : "";
        const color = logEntry.level === "error" ? "var(--danger)" : "var(--text-muted)";
        const platformColor = logEntry.platform === "TikTok"
          ? "#ff0050"
          : logEntry.platform === "Instagram"
            ? "#E1306C"
            : "#FF0000";
        return `<div class="log-entry" style="color:${color}">
          <span style="opacity:0.5;">${escapeHtml(time)}</span>
          <span style="color:${platformColor}; font-weight:600; font-size:11px;">[${escapeHtml(logEntry.platform)}]</span>
          <span style="opacity:0.4; font-size:10px;">${escapeHtml(logEntry.profile || "")}</span>
          ${escapeHtml(logEntry.message || "")}
        </div>`;
      }).join("")
      : '<div style="text-align:center; padding:20px; color:#666;">No logs yet</div>';
    this.updateLogContainer(this.els.logsContainer, logsHtml);
  },
  // Pending videos are grouped by profile so the queue stays short: videos
  // restored from a previous run ("name-restored-<timestamp>.mp4") are folded
  // into the group of the original video.
  queueGroupKey(name) {
    return String(name || "").replace(/-restored-\d+(?=\.\w+$)/i, "");
  },
  renderQueueGroups(items) {
    const groups = new Map();
    for (const item of items) {
      const key = this.queueGroupKey(item.name);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    const single = groups.size === 1;
    return [...groups.entries()].map(([key, groupItems]) => {
      const label = key.replace(/\.[a-z0-9]+$/i, "");
      const restored = groupItems.filter((item) => item.name !== key).length;
      const rows = groupItems.map((item) => `
        <div class="queue-item">
          <div class="queue-item-main">
            <span class="queue-item-icon"><i class="ph ph-file-video"></i></span>
            <span class="queue-item-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
            ${item.hasCaption ? '<span class="queue-caption-badge"><i class="ph ph-text-align-left"></i> Caption</span>' : ''}
          </div>
          <span class="status-badge active queue-item-status">Pending</span>
        </div>`).join("");
      if (single) return `<div class="queue-group open"><div class="queue-group-items">${rows}</div></div>`;
      return `
        <div class="queue-group">
          <button class="queue-group-header" type="button" aria-expanded="false">
            <span class="queue-item-icon"><i class="ph ph-file-video"></i></span>
            <span class="queue-group-title" title="${escapeHtml(key)}">${escapeHtml(label)}</span>
            <span class="queue-group-count">${groupItems.length}${restored ? ` · ${restored} copia${restored > 1 ? "s" : ""}` : ""}</span>
            <i class="ph ph-caret-down queue-group-chevron"></i>
          </button>
          <div class="queue-group-items">${rows}</div>
        </div>`;
    }).join("");
  },
  bindQueueGroups() {
    this.els.ttQueueList?.querySelectorAll(".queue-group-header").forEach((button) => {
      button.addEventListener("click", () => {
        const group = button.closest(".queue-group");
        const open = group.classList.toggle("open");
        button.setAttribute("aria-expanded", open ? "true" : "false");
      });
    });
  },
  renderStatus(data) {
    const pending = data.queue?.counts?.pending ?? 0;
    const posted = data.queue?.counts?.posted ?? 0;
    const failed = data.queue?.counts?.failed ?? 0;
    const pendingVideos = data.queue?.pendingVideos || [];
    const timezone = data.timezone || "UTC";
    const lastRunText = data.lastRunAt
      ? new Date(data.lastRunAt).toLocaleString()
      : "Never";


    if (this.els.ttPendingCount) this.els.ttPendingCount.textContent = pending;
    if (this.els.ttPostedCount) this.els.ttPostedCount.textContent = posted;
    if (this.els.ttFailedCount) this.els.ttFailedCount.textContent = failed;
    if (this.els.ttQueueCount) this.els.ttQueueCount.textContent = `${pending} pending`;
    if (this.els.ttSchedulerState) {
      this.els.ttSchedulerState.textContent = data.running ? "Running" : "Stopped";
      this.els.ttSchedulerState.classList.toggle("success", Boolean(data.running));
      this.els.ttSchedulerState.classList.toggle("error", !data.running);
    }

    // Sync instant-post toggle
    if (this.els.ttInstantPostToggle && document.activeElement !== this.els.ttInstantPostToggle) {
      this.els.ttInstantPostToggle.checked = Boolean(data.instantPost);
    }

    if (this.els.ttAutoAddSoundToggle && document.activeElement !== this.els.ttAutoAddSoundToggle) {
      this.els.ttAutoAddSoundToggle.checked = Boolean(data.autoAddSound);
    }

    if (this.els.ttSoundQueryInput && document.activeElement !== this.els.ttSoundQueryInput) {
      this.els.ttSoundQueryInput.value = data.defaultSoundQuery || "";
    }

    if (this.els.ttRandomQueueToggle && document.activeElement !== this.els.ttRandomQueueToggle) {
      this.els.ttRandomQueueToggle.checked = Boolean(data.randomQueueOrder);
    }

    const logHtml = (data.logs || [])
      .slice()
      .reverse()
      .map(
        (logEntry) => `
      <div class="log-entry">
        <span class="log-time">${logEntry.at.split("T")[1].split(".")[0]}</span>
        <span class="log-msg ${logEntry.level === "error" ? "log-error" : ""}">${escapeHtml(logEntry.message)}</span>
      </div>
    `
      )
      .join("");
    this.updateLogContainer(this.els.ttLogsContainer, logHtml);

    const queueItems = pendingVideos.map((video) => (typeof video === "string" ? { name: video, hasCaption: false } : video));
    if (this.els.ttQueueList) {
      this.els.ttQueueList.innerHTML = queueItems.length
        ? this.renderQueueGroups(queueItems)
        : '<div style="text-align:center; padding:20px; color:#666;">Queue is empty</div>';
      this.bindQueueGroups();
    }
    if (this.els.ttJobVideo && document.activeElement !== this.els.ttJobVideo) {
      const selected = this.els.ttJobVideo.value;
      this.els.ttJobVideo.innerHTML = '<option value="">Select a pending video</option>' + pendingVideos.map((video) => {
        const name = typeof video === "string" ? video : video.name;
        return `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`;
      }).join("");
      if (pendingVideos.some((video) => (typeof video === "string" ? video : video.name) === selected)) this.els.ttJobVideo.value = selected;
    }

    if (
      this.els.ttCronInput &&
      document.activeElement !== this.els.ttCronInput &&
      !this.isScheduleDraftDirty("tiktok")
    ) {
      this.els.ttCronInput.value = data.cronExpression || "";
    }
    this.applySchedulePlanFromStatus("tiktok", data);

    if (this.els.ttTimezoneLabel) this.els.ttTimezoneLabel.textContent = timezone;
    if (this.els.ttLastRunLabel) this.els.ttLastRunLabel.textContent = lastRunText;
    if (this.els.defaultCaptionInput && document.activeElement !== this.els.defaultCaptionInput) {
      this.els.defaultCaptionInput.value = data.defaultCaption || "";
    }

    if (this.els.statusBadge) {
      const textEl = this.els.statusBadge.querySelector("span");
      const dot = this.els.statusBadge.querySelector(".connection-dot");
      const isPosting = Boolean(data.isPosting);
      const running = Boolean(data.running);
      if (textEl) {
        textEl.textContent = isPosting
          ? "Posting in progress"
          : running
            ? "Scheduler running"
            : "Scheduler stopped";
      }
      if (dot) {
        const color = isPosting
          ? "var(--status-warn)"
          : running
            ? "var(--status-good)"
            : "var(--status-bad)";
        dot.style.backgroundColor = color;
        dot.style.boxShadow = `0 0 8px ${color}`;
      }
    }
  },

  renderInstagramStatus(data) {
    const pending = data.queue?.counts?.pending ?? 0;
    const posted = data.queue?.counts?.posted ?? 0;
    const failed = data.queue?.counts?.failed ?? 0;
    const pendingVideos = data.queue?.pendingVideos || [];
    const timezone = data.timezone || "UTC";
    const lastRunText = data.lastRunAt ? new Date(data.lastRunAt).toLocaleString() : "Never";

    if (this.els.igPendingCount) this.els.igPendingCount.textContent = pending;
    if (this.els.igPostedCount) this.els.igPostedCount.textContent = posted;
    if (this.els.igFailedCount) this.els.igFailedCount.textContent = failed;
    if (this.els.igSchedulerState) {
      this.els.igSchedulerState.textContent = data.running ? "Running" : "Stopped";
      this.els.igSchedulerState.classList.toggle("success", Boolean(data.running));
      this.els.igSchedulerState.classList.toggle("error", !data.running);
    }

    // Sync instant-post toggle
    if (this.els.igInstantPostToggle && document.activeElement !== this.els.igInstantPostToggle) {
      this.els.igInstantPostToggle.checked = Boolean(data.instantPost);
    }

    if (this.els.igRandomQueueToggle && document.activeElement !== this.els.igRandomQueueToggle) {
      this.els.igRandomQueueToggle.checked = Boolean(data.randomQueueOrder);
    }

    const logsHtml = (data.logs || [])
      .slice()
      .reverse()
      .map(
        (logEntry) => `
      <div class="log-entry">
        <span class="log-time">${logEntry.at.split("T")[1].split(".")[0]}</span>
        <span class="log-msg ${logEntry.level === "error" ? "log-error" : ""}">${escapeHtml(logEntry.message)}</span>
      </div>
    `
      )
      .join("");
    this.updateLogContainer(this.els.igLogsContainer, logsHtml);

    const queueHtml = pendingVideos.length
      ? pendingVideos
        .map((video) => {
          const videoName = typeof video === "string" ? video : video.name;
          const hasCaption = typeof video === "object" && video.hasCaption;
          return `
      <div class="queue-item">
        <div style="display:flex; align-items:center; gap:10px;">
          <i class="ph ph-file-video" style="font-size:20px;"></i>
          <span>${escapeHtml(videoName)}</span>
          ${hasCaption ? '<span class="status-badge" style="background:rgba(255,255,255,0.1); color:#ccc; border:1px solid #444; margin-left:8px;"><i class="ph ph-text-align-left"></i> Caption</span>' : ''}
        </div>
        <span class="status-badge active">Pending</span>
      </div>
    `;
        })
        .join("")
      : '<div style="text-align:center; padding:20px; color:#666;">Queue is empty</div>';
    if (this.els.igQueueList) this.els.igQueueList.innerHTML = queueHtml;

    if (
      this.els.igCronInput &&
      document.activeElement !== this.els.igCronInput &&
      !this.isScheduleDraftDirty("instagram")
    ) {
      this.els.igCronInput.value = data.cronExpression || "";
    }
    this.applySchedulePlanFromStatus("instagram", data);
    if (this.els.igTimezoneLabel) this.els.igTimezoneLabel.textContent = timezone;
    if (this.els.igLastRunLabel) this.els.igLastRunLabel.textContent = lastRunText;
  },

  renderYouTubeStatus(data) {
    const pending = data.queue?.counts?.pending ?? 0;
    const posted = data.queue?.counts?.posted ?? 0;
    const failed = data.queue?.counts?.failed ?? 0;
    const pendingVideos = data.queue?.pendingVideos || [];
    const timezone = data.timezone || "UTC";
    const lastRunText = data.lastRunAt ? new Date(data.lastRunAt).toLocaleString() : "Never";

    if (this.els.ytPendingCount) this.els.ytPendingCount.textContent = pending;
    if (this.els.ytPostedCount) this.els.ytPostedCount.textContent = posted;
    if (this.els.ytFailedCount) this.els.ytFailedCount.textContent = failed;
    if (this.els.ytSchedulerState) {
      this.els.ytSchedulerState.textContent = data.running ? "Running" : "Stopped";
      this.els.ytSchedulerState.classList.toggle("success", Boolean(data.running));
      this.els.ytSchedulerState.classList.toggle("error", !data.running);
    }

    // Sync instant-post toggle
    if (this.els.ytInstantPostToggle && document.activeElement !== this.els.ytInstantPostToggle) {
      this.els.ytInstantPostToggle.checked = Boolean(data.instantPost);
    }

    if (this.els.ytRandomQueueToggle && document.activeElement !== this.els.ytRandomQueueToggle) {
      this.els.ytRandomQueueToggle.checked = Boolean(data.randomQueueOrder);
    }

    const logsHtml = (data.logs || [])
      .slice()
      .reverse()
      .map(
        (logEntry) => `
      <div class="log-entry">
        <span class="log-time">${logEntry.at.split("T")[1].split(".")[0]}</span>
        <span class="log-msg ${logEntry.level === "error" ? "log-error" : ""}">${escapeHtml(logEntry.message)}</span>
      </div>
    `
      )
      .join("");
    this.updateLogContainer(this.els.ytLogsContainer, logsHtml);

    const queueHtml = pendingVideos.length
      ? pendingVideos
        .map((video) => {
          const videoName = typeof video === "string" ? video : video.name;
          const hasCaption = typeof video === "object" && video.hasCaption;
          return `
      <div class="queue-item">
        <div style="display:flex; align-items:center; gap:10px;">
          <i class="ph ph-file-video" style="font-size:20px;"></i>
          <span>${escapeHtml(videoName)}</span>
          ${hasCaption ? '<span class="status-badge" style="background:rgba(255,255,255,0.1); color:#ccc; border:1px solid #444; margin-left:8px;"><i class="ph ph-text-align-left"></i> Caption</span>' : ''}
        </div>
        <span class="status-badge active">Pending</span>
      </div>
    `;
        })
        .join("")
      : '<div style="text-align:center; padding:20px; color:#666;">Queue is empty</div>';
    if (this.els.ytQueueList) this.els.ytQueueList.innerHTML = queueHtml;

    if (
      this.els.ytCronInput &&
      document.activeElement !== this.els.ytCronInput &&
      !this.isScheduleDraftDirty("youtube")
    ) {
      this.els.ytCronInput.value = data.cronExpression || "";
    }
    this.applySchedulePlanFromStatus("youtube", data);
    if (this.els.ytTimezoneLabel) this.els.ytTimezoneLabel.textContent = timezone;
    if (this.els.ytLastRunLabel) this.els.ytLastRunLabel.textContent = lastRunText;
  },

  renderUniquifierStatus(data) {
    if (!data) return;

    if (this.els.uniqInputDir && document.activeElement !== this.els.uniqInputDir) {
      this.els.uniqInputDir.value = data.inputDir || "";
    }
    if (this.els.uniqOutputDir && document.activeElement !== this.els.uniqOutputDir) {
      this.els.uniqOutputDir.value = data.outputDir || "";
    }
    if (this.els.uniqLogoImage && document.activeElement !== this.els.uniqLogoImage) {
      this.els.uniqLogoImage.value = data.logoImage || "";
    }

    if (this.els.uniqState) {
      this.els.uniqState.textContent = data.running ? "Running" : "Idle";
      this.els.uniqState.classList.toggle("success", Boolean(data.running));
      this.els.uniqState.classList.toggle("error", !data.running);
    }

    const processed = data.progress?.processed ?? 0;
    const total = data.progress?.total ?? 0;
    const succeeded = data.progress?.succeeded ?? 0;
    const failed = data.progress?.failed ?? 0;
    if (this.els.uniqProgress) this.els.uniqProgress.textContent = `${processed} / ${total}`;
    if (this.els.uniqSucceeded) this.els.uniqSucceeded.textContent = String(succeeded);
    if (this.els.uniqFailed) this.els.uniqFailed.textContent = String(failed);

    if (this.els.uniqStartBtn) this.els.uniqStartBtn.disabled = Boolean(data.running);
    if (this.els.uniqStopBtn) this.els.uniqStopBtn.disabled = !data.running;

    const inputFiles = data.inputFiles || [];
    const outputFiles = data.outputFiles || [];

    if (this.els.uniqInputFiles) {
      this.els.uniqInputFiles.innerHTML = inputFiles.length
        ? inputFiles
          .map(
            (fileName) => `
        <div class="queue-item">
          <div style="display:flex; align-items:center; gap:10px;">
            <i class="ph ph-file-video" style="font-size:20px;"></i>
            <span>${escapeHtml(fileName)}</span>
          </div>
          <span class="status-badge active">Input</span>
        </div>
      `
          )
          .join("")
        : '<div style="text-align:center; padding:20px; color:#666;">No videos in input folder</div>';
    }

    if (this.els.uniqOutputFiles) {
      this.els.uniqOutputFiles.innerHTML = outputFiles.length
        ? outputFiles
          .map(
            (fileName) => `
        <div class="queue-item">
          <div style="display:flex; align-items:center; gap:10px;">
            <i class="ph ph-file-video" style="font-size:20px;"></i>
            <span>${escapeHtml(fileName)}</span>
          </div>
          <span class="status-badge active">Output</span>
        </div>
      `
          )
          .join("")
        : '<div style="text-align:center; padding:20px; color:#666;">No videos in output folder</div>';
    }

    const logs = data.logs || [];
    if (this.els.uniqLogs) {
      this.els.uniqLogs.innerHTML = logs
        .slice()
        .reverse()
        .map(
          (logEntry) => `
        <div class="log-entry">
          <span class="log-time">${logEntry.at.split("T")[1].split(".")[0]}</span>
          <span class="log-msg ${logEntry.level === "error" ? "log-error" : ""}">${escapeHtml(logEntry.message)}</span>
        </div>
      `
        )
        .join("");
    }
  },

  async copyAccountValue(value, label) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(String(value));
        alert(`${label} copied to the clipboard.`);
        return;
      }
    } catch {
      // Use the visible fallback below.
    }
    prompt(`${label} - copy this value:`, String(value));
  },

  async createTempMailAccount() {
    const button = this.els.createTempMailAccountBtn;
    if (button) {
      button.disabled = true;
      button.innerHTML = '<i class="ph ph-circle-notch"></i> Opening Chromium';
    }
    try {
      await API.post("/api/account-manager/create-temp-mail");
      await this.refresh();
    } catch (error) {
      alert(`Temporary email setup failed: ${error.message}`);
    } finally {
      if (button) {
        button.innerHTML = '<i class="ph ph-plus-circle"></i> Create new account';
      }
      try {
        this.renderManagedAccounts(await API.get("/api/account-manager"));
      } catch {
        if (button) button.disabled = false;
      }
    }
  },

  async retryTempMailCapture() {
    try {
      await API.post("/api/account-manager/retry-capture");
      await this.refresh();
    } catch (error) {
      alert(`Mailbox capture failed: ${error.message}`);
    }
  },

  async closeAccountBrowser() {
    try {
      await API.post("/api/account-manager/close");
      await this.refresh();
    } catch (error) {
      alert(`Could not close Chromium: ${error.message}`);
    }
  },

  async handleManagedAccountsClick(event) {
    const button = event.target.closest("button[data-account-action][data-account-id]");
    if (!button) return;
    const accountId = button.dataset.accountId;
    const action = button.dataset.accountAction;
    try {
      if (action === "select") {
        await API.post("/api/accounts/select", { accountId });
        await this.refresh();
        document.dispatchEvent(new CustomEvent("autosocial:accountchange", { detail: { accountId } }));
        return;
      }
      if (action === "copy-email") {
        await this.copyAccountValue(button.dataset.value || "", "Temporary email");
        return;
      }
      if (action === "copy-secret") {
        const result = await API.post("/api/account-manager/reveal", {
          accountId,
          field: button.dataset.field,
        });
        await this.copyAccountValue(result.value, button.dataset.label || "Credential");
        return;
      }
      if (action === "open") {
        await API.post("/api/account-manager/open", { accountId });
        await this.refresh();
      }
    } catch (error) {
      alert(`Account action failed: ${error.message}`);
    }
  },

  renderManagedAccounts(data) {
    if (!data || typeof data !== "object") return;
    const vaultAvailable = Boolean(data.vaultAvailable);
    const weekly = data.weeklyAvailability || { allowed: false };
    if (this.els.accountVaultMessage) {
      this.els.accountVaultMessage.textContent = vaultAvailable
        ? `All email addresses, recovery keys, and TikTok passwords are stored together in account-vault.json, encrypted for the current Windows user with DPAPI.`
        : "The encrypted credential vault is unavailable. Run AutoSocial on Windows 11 under your normal Windows user.";
    }
    if (this.els.accountWeeklyBadge) {
      const allowed = vaultAvailable && weekly.allowed;
      this.els.accountWeeklyBadge.classList.toggle("active", allowed);
      this.els.accountWeeklyBadge.textContent = allowed
        ? "One account may be prepared now"
        : weekly.nextAllowedAt
          ? `Next account: ${new Date(weekly.nextAllowedAt).toLocaleString()}`
          : "Windows credential vault required";
    }
    if (this.els.createTempMailAccountBtn) {
      this.els.createTempMailAccountBtn.disabled = !vaultAvailable || !weekly.allowed;
      this.els.createTempMailAccountBtn.title = this.els.createTempMailAccountBtn.disabled && weekly.nextAllowedAt
        ? `Weekly limit active until ${new Date(weekly.nextAllowedAt).toLocaleString()}`
        : "";
    }

    const onboarding = data.onboarding || {};
    if (this.els.accountOnboardingPanel) {
      const visible = onboarding.stage && onboarding.stage !== "idle";
      this.els.accountOnboardingPanel.classList.toggle("hidden", !visible);
    }
    if (this.els.accountOnboardingBadge) {
      this.els.accountOnboardingBadge.textContent = String(onboarding.stage || "idle").replace(/-/g, " ");
      this.els.accountOnboardingBadge.classList.toggle("active", onboarding.stage === "ready");
    }
    if (this.els.accountOnboardingMessage) {
      const emailSuffix = onboarding.email ? ` Email: ${onboarding.email}.` : "";
      this.els.accountOnboardingMessage.textContent = `${onboarding.message || ""}${emailSuffix}`;
    }
    if (this.els.accountRetryCaptureBtn) {
      this.els.accountRetryCaptureBtn.disabled = !onboarding.open || !["needs-attention", "closed"].includes(onboarding.stage);
    }
    if (this.els.accountCloseBrowserBtn) {
      this.els.accountCloseBrowserBtn.disabled = !onboarding.open;
    }

    if (!this.els.managedAccountsTableBody) return;
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    this.els.managedAccountsTableBody.innerHTML = accounts.length
      ? accounts.map((account) => {
        const credentials = account.credentials;
        const isActive = account.id === data.activeAccountId;
        const email = credentials?.tempMailEmail || "Not prepared";
        const status = credentials?.status || "No credentials";
        return `
          <tr class="${isActive ? "managed-account-active" : ""}">
            <td>
              <div class="managed-account-name">${escapeHtml(account.name)}</div>
              <small class="mono">${escapeHtml(account.id)}</small>
            </td>
            <td>
              <div class="managed-account-email">${escapeHtml(email)}</div>
              ${credentials?.tempMailEmail ? `<button class="credential-link" data-account-action="copy-email" data-account-id="${escapeHtml(account.id)}" data-value="${escapeHtml(credentials.tempMailEmail)}">Copy email</button>` : ""}
            </td>
            <td>${credentials?.hasRecoveryKey ? `<span class="credential-saved">Saved</span><button class="credential-link" data-account-action="copy-secret" data-account-id="${escapeHtml(account.id)}" data-field="tempMailRecoveryKey" data-label="Recovery key">Copy</button>` : "-"}</td>
            <td>${credentials?.hasTikTokPassword ? `<span class="credential-saved">Saved</span><button class="credential-link" data-account-action="copy-secret" data-account-id="${escapeHtml(account.id)}" data-field="tiktokPassword" data-label="TikTok password">Copy</button>` : "-"}</td>
            <td><span class="status-badge ${status === "email-ready" ? "active" : ""}">${escapeHtml(status.replace(/-/g, " "))}</span></td>
            <td><div class="account-action-row">
              <button class="control-btn-small" data-account-action="select" data-account-id="${escapeHtml(account.id)}" ${isActive ? "disabled" : ""}>${isActive ? "Selected" : "Select"}</button>
              ${credentials ? `<button class="control-btn-small" data-account-action="open" data-account-id="${escapeHtml(account.id)}"><i class="ph ph-browser"></i> Open tabs</button>` : ""}
            </div></td>
          </tr>`;
      }).join("")
      : '<tr><td colspan="6">No local accounts found.</td></tr>';
  },

  renderAccounts() {
    const rows = [
      {
        platformKey: "tiktok",
        platform: "TikTok",
        icon: "ph-tiktok-logo",
      },
      {
        platformKey: "instagram",
        platform: "Instagram",
        icon: "ph-instagram-logo",
      },
      {
        platformKey: "youtube",
        platform: "YouTube",
        icon: "ph-youtube-logo",
      },
    ];

    const activeCount = rows.filter(
      (row) =>
        this.accountState[row.platformKey]?.loginOpen ||
        this.accountState[row.platformKey]?.sessionSaved
    ).length;
    if (this.els.activeAccountsCount) {
      this.els.activeAccountsCount.textContent = String(activeCount);
    }
    if (this.els.activeBrandLabel) {
      const suffix = this.accountState.activeBrandName
        ? `- ${this.accountState.activeBrandName}`
        : "";
      this.els.activeBrandLabel.textContent = suffix;
    }
    if (!this.els.accountsTableBody) return;

    this.els.accountsTableBody.innerHTML = rows
      .map(
        (row) => {
          const platformState = this.accountState[row.platformKey] || {};
          const sessionText = platformState.loginOpen
            ? "Open"
            : platformState.sessionSaved
              ? "Saved"
              : "Not connected";
          return `
      <tr>
        <td><div class="platform-cell"><span class="platform-icon"><i class="ph ${row.icon}"></i></span> ${row.platform}</div></td>
        <td>${sessionText}</td>
        <td><span class="status-badge ${platformState.schedulerRunning ? "active" : ""}">${platformState.schedulerRunning ? "Scheduler Running" : "Scheduler Stopped"}</span></td>
        <td>
          <button class="control-btn-small" data-platform="${row.platformKey}" data-action="login"><i class="ph ph-sign-in"></i> Login Session</button>
          <button class="control-btn-small danger" data-platform="${row.platformKey}" data-action="close"><i class="ph ph-x-circle"></i> Close Session</button>
        </td>
      </tr>
    `;
        }
      )
      .join("");
  },

  async handleAutoDownloadAction(endpoint) {
    try {
      const result = await API.post(endpoint);
      if (result?.ok === false && result?.error) alert(result.error);
      this.refresh();
    } catch (err) {
      alert(`Auto-download action failed: ${err.message}`);
    }
  },

  async handleAutoDownloadSave() {
    const platforms = [];
    if (this.els.adPlatTiktok?.checked) platforms.push("tiktok");
    if (this.els.adPlatInstagram?.checked) platforms.push("instagram");
    if (this.els.adPlatYoutube?.checked) platforms.push("youtube");

    try {
      await API.post("/api/autodownload/configure", {
        channel: this.els.adChannel?.value || '',
        interval: parseInt(this.els.adInterval?.value, 10) || 10,
        maxVideos: parseInt(this.els.adMaxVideos?.value, 10) || 5,
        platforms
      });
      if (this.els.adSaveSettingsBtn) {
        this.els.adSaveSettingsBtn.innerHTML = '<i class="ph ph-check"></i> Saved!';
        setTimeout(() => {
          this.els.adSaveSettingsBtn.innerHTML = '<i class="ph ph-floppy-disk"></i> Save Settings';
        }, 2000);
      }
      this.refresh();
    } catch (err) {
      alert(`Save failed: ${err.message}`);
    }
  },

  renderAutoDownloadStatus(data) {
    if (!data) return;

    if (this.els.adWatcherState) {
      this.els.adWatcherState.textContent = data.running ? "Running" : "Stopped";
      this.els.adWatcherState.classList.toggle("success", Boolean(data.running));
      this.els.adWatcherState.classList.toggle("error", !data.running);
    }
    if (this.els.adTotalDownloaded) {
      this.els.adTotalDownloaded.textContent = data.totalDownloaded ?? 0;
    }
    if (this.els.adLastCheck) {
      this.els.adLastCheck.textContent = data.lastCheckAt
        ? new Date(data.lastCheckAt).toLocaleTimeString()
        : "Never";
    }

    // Sync form fields only when user isn't focused
    if (this.els.adChannel && document.activeElement !== this.els.adChannel) {
      this.els.adChannel.value = data.channel || '';
      this.els.adInterval.value = data.interval || 10;
      this.els.adMaxVideos.value = data.maxVideos || 5;
      const platforms = data.platforms || [];
      if (this.els.adPlatTiktok) this.els.adPlatTiktok.checked = platforms.includes("tiktok");
      if (this.els.adPlatInstagram) this.els.adPlatInstagram.checked = platforms.includes("instagram");
      if (this.els.adPlatYoutube) this.els.adPlatYoutube.checked = platforms.includes("youtube");

      // Logs
      const logsHtml = (data.logs || [])
        .slice()
        .reverse()
        .map(
          (logEntry) => `
      <div class="log-entry">
        <span class="log-time">${logEntry.at.split("T")[1].split(".")[0]}</span>
        <span class="log-msg ${logEntry.level === "error" ? "log-error" : ""}">${escapeHtml(logEntry.message)}</span>
      </div>
    `
        )
        .join("");
      this.updateLogContainer(this.els.adLogsContainer, logsHtml);
    }
  },


  async handleProfileDownloadStart(scanOnly = false) {
    try {
      const channel = this.els.pdChannel?.value?.trim();
      const maxVideos = parseInt(this.els.pdMaxVideos?.value, 10) || 0;
      const minViews = parseInt(this.els.pdMinViews?.value, 10) || 0;

      if (!channel) {
        alert("Please provide a valid TikTok channel URL or username.");
        return;
      }

      const result = await API.post("/api/profile-download/start", {
        channel,
        maxVideos,
        minViews,
        scanOnly
      });

      if (result?.ok === false && result?.error) alert(result.error);
      this.refresh();
    } catch (err) {
      alert(`Profile downloader failed to start: ${err.message}`);
    }
  },

  async handleProfileDownloadOpenFolder() {
    try {
      await API.post("/api/profile-download/open-folder");
    } catch (err) {
      alert(`Could not open profile downloads folder: ${err.message}`);
    }
  },

  renderProfileDownloadStatus(data) {
    if (!data) return;

    if (this.els.pdStatusBadge) {
      this.els.pdStatusBadge.textContent = data.running ? "Scraping" : "Idle";
      this.els.pdStatusBadge.classList.toggle("success", Boolean(data.running));
      this.els.pdStatusBadge.classList.toggle("error", !data.running);
    }
    if (this.els.pdStartBtn) {
      this.els.pdStartBtn.disabled = Boolean(data.running);
    }
    if (this.els.pdScanBtn) {
      this.els.pdScanBtn.disabled = Boolean(data.running);
    }

    const logsHtml = (data.logs || [])
      .slice()
      .reverse()
      .map(
        (logEntry) => `
    <div class="log-entry">
      <span class="log-time">${logEntry.at.split("T")[1].split(".")[0]}</span>
      <span class="log-msg ${logEntry.level === "error" ? "log-error" : ""}">${escapeHtml(logEntry.message)}</span>
    </div>
    `
      )
      .join("");
    this.updateLogContainer(this.els.pdLogsContainer, logsHtml);
  },

  async refreshFlowStatus() {
    try {
      const [status, accounts] = await Promise.all([
        API.get("/api/google-flow/status"),
        API.get("/api/accounts"),
      ]);
      this.renderFlowStatus(status, accounts);
    } catch (error) {
      alert(`Could not read Google Flow status: ${error.message}`);
    }
  },

  renderFlowStatus(status, accounts) {
    const active = accounts?.activeAccount || accounts?.accounts?.find((item) => item.id === status?.accountId);
    if (this.els.flowAccountName) this.els.flowAccountName.textContent = active?.name || status?.accountId || "-";
    if (this.els.flowAccountId) this.els.flowAccountId.textContent = status?.accountId || "-";
    if (this.els.flowSessionBadge) {
      const ready = Boolean(status?.saved);
      this.els.flowSessionBadge.textContent = ready ? "Session saved" : "Login required";
      this.els.flowSessionBadge.classList.toggle("success", ready);
      this.els.flowSessionBadge.classList.toggle("error", !ready);
    }
    if (this.els.flowSessionMessage) {
      this.els.flowSessionMessage.textContent = status?.saved
        ? "Saved Chromium session found. Flow can reuse this account without asking for credentials again."
        : "Open Chromium and complete the first Google Flow login manually. The session will be saved locally.";
    }
  },

  renderFlowDownloads(data) {
    if (!data?.ok) return;
    if (this.accountState.activeBrandId && data.accountId !== this.accountState.activeBrandId) return;
    if (this.els.flowDownloadsPath) this.els.flowDownloadsPath.textContent = data.folder || "-";
    const videos = Array.isArray(data.videos) ? data.videos : [];
    const signature = JSON.stringify([
      data.accountId,
      data.folder,
      ...videos.map((video) => [video.jobId, video.name, video.size, video.modifiedAt]),
    ]);
    if (signature === this.flowDownloadsSignature) return;
    this.flowDownloadsSignature = signature;
    if (!this.els.flowDownloadsList) return;
    if (!videos.length) {
      this.els.flowDownloadsList.innerHTML = '<div class="setup-empty">No saved Flow videos yet.</div>';
      return;
    }
    const formatBytes = (bytes) => {
      const value = Number(bytes) || 0;
      if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
      return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    };
    this.els.flowDownloadsList.innerHTML = videos.map((video) => `
      <article class="flow-download-item">
        <video controls preload="metadata" playsinline src="${escapeHtml(video.url)}"></video>
        <div class="flow-download-meta">
          <strong>${escapeHtml(video.name)}</strong>
          <small>${formatBytes(video.size)} - ${new Date(video.modifiedAt).toLocaleString()}</small>
          <small class="mono">${escapeHtml(video.relativePath)}</small>
          <div class="flow-actions">
            <a class="control-btn-small" href="${escapeHtml(video.url)}" target="_blank" rel="noopener"><i class="ph ph-play"></i> Open video</a>
            <a class="control-btn-small" href="${escapeHtml(video.url)}" download="${escapeHtml(video.name)}"><i class="ph ph-download-simple"></i> Download copy</a>
          </div>
        </div>
      </article>
    `).join("");
  },

  async openFlowDownloads() {
    if (!this.els.flowOpenDownloadsBtn) return;
    this.els.flowOpenDownloadsBtn.disabled = true;
    try {
      await API.post("/api/google-flow/downloads/open");
    } catch (error) {
      alert(`Could not open Flow downloads: ${error.message}`);
    } finally {
      this.els.flowOpenDownloadsBtn.disabled = false;
    }
  },

  async loadFlowConfig() {
    const sequence = ++this.flowConfigLoadSequence;
    const expectedAccountId = this.accountState.activeBrandId;
    try {
      const data = await API.get("/api/google-flow/config");
      if (sequence !== this.flowConfigLoadSequence) return;
      if (expectedAccountId && data.accountId !== expectedAccountId) return;
      if (this.accountState.activeBrandId && data.accountId !== this.accountState.activeBrandId) return;
      const setValue = (key, value) => {
        const element = this.els[key];
        if (element && !this.flowDirty.has(key) && document.activeElement !== element) element.value = value ?? "";
      };
      const setChecked = (key, value) => {
        const element = this.els[key];
        if (element && !this.flowDirty.has(key) && document.activeElement !== element) element.checked = Boolean(value);
      };
      setValue("flowFixedPromptTemplate", data.fixedPromptTemplate || "");
      setValue("flowDynamicInstructions", data.dynamicInstructions || "");
      setValue("flowCaption", data.caption || "");
      setValue("flowVideosPerDay", data.videosPerDay || 3);
      setValue("flowDailyTime", data.dailyTime || "06:00");
      setValue("flowTimezone", data.timezone || "UTC");
      setValue("flowPublicationTimes", (data.publicationTimes || []).join(", "));
      setChecked("flowEnabled", data.enabled);
      setChecked("flowAutoPublish", data.autoPublish);
      if (this.els.flowGeminiKeyStatus && !this.els.flowGeminiApiKey?.value && this.els.flowGeminiKeyRemoveBtn?.dataset.remove !== "true") {
        this.els.flowGeminiKeyStatus.textContent = data.geminiApiKeyConfigured ? "Key configured" : "Not configured";
        this.els.flowGeminiKeyStatus.classList.toggle("success", Boolean(data.geminiApiKeyConfigured));
      }
      if (!this.flowDirty.has("flowReference")) {
        if (this.els.flowReferenceName && data.referenceImage) this.els.flowReferenceName.textContent = data.referenceImage.name;
        if (this.els.flowReferenceName && !data.referenceImage) this.els.flowReferenceName.textContent = "No image selected";
        if (this.els.flowReferenceRemoveBtn) this.els.flowReferenceRemoveBtn.dataset.remove = "false";
      }
    } catch (error) {
      console.warn("Could not load Flow config", error);
    }
  },

  async saveFlowConfig() {
    try {
      const file = this.els.flowReferenceInput?.files?.[0];
      const payload = {
        fixedPromptTemplate: this.els.flowFixedPromptTemplate?.value || "",
        dynamicInstructions: this.els.flowDynamicInstructions?.value || "",
        caption: this.els.flowCaption?.value || "",
        enabled: Boolean(this.els.flowEnabled?.checked),
        videosPerDay: Number(this.els.flowVideosPerDay?.value) || 3,
        dailyTime: this.els.flowDailyTime?.value || "06:00",
        timezone: this.els.flowTimezone?.value || "UTC",
        publicationTimes: String(this.els.flowPublicationTimes?.value || "").split(",").map((value) => value.trim()).filter(Boolean),
        autoPublish: Boolean(this.els.flowAutoPublish?.checked),
        removeReference: this.els.flowReferenceRemoveBtn?.dataset.remove === "true",
        removeGeminiApiKey: this.els.flowGeminiKeyRemoveBtn?.dataset.remove === "true",
      };
      const geminiApiKey = this.els.flowGeminiApiKey?.value?.trim();
      if (geminiApiKey) payload.geminiApiKey = geminiApiKey;
      if (file) {
        if (file.size > 12 * 1024 * 1024) throw new Error("Reference image must be smaller than 12 MB.");
        payload.referenceImage = { type: file.type, data: await this.readFileAsDataUrl(file) };
      }
      const result = await API.post("/api/google-flow/config", payload);
      this.flowDirty.clear();
      if (this.els.flowGeminiApiKey) this.els.flowGeminiApiKey.value = "";
      if (this.els.flowReferenceInput) this.els.flowReferenceInput.value = "";
      if (this.els.flowGeminiKeyRemoveBtn) this.els.flowGeminiKeyRemoveBtn.dataset.remove = "false";
      this.els.flowConfigMessage.textContent = result.ok ? "Flow prompt and automation settings saved." : result.error;
      await this.loadFlowConfig();
      return result.config;
    } catch (error) {
      this.els.flowConfigMessage.textContent = error.message;
      throw error;
    }
  },

  async previewFlowPrompt() {
    try {
      this.els.flowPromptPreviewBtn.disabled = true;
      await this.saveFlowConfig();
      this.els.flowConfigMessage.textContent = "Gemini is creating a new unused phrase...";
      const result = await API.post("/api/google-flow/preview");
      if (this.els.flowPreviewPhrase) this.els.flowPreviewPhrase.textContent = result.phrase;
      if (this.els.flowPreviewFinalPrompt) this.els.flowPreviewFinalPrompt.textContent = result.prompt;
      if (this.els.flowPromptPreview) this.els.flowPromptPreview.classList.remove("hidden");
      this.els.flowConfigMessage.textContent = `Preview created with ${result.model}. This phrase is now in the no-repeat history.`;
    } catch (error) {
      this.els.flowConfigMessage.textContent = error.message;
    } finally {
      this.els.flowPromptPreviewBtn.disabled = false;
    }
  },

  async runFlowNow() {
    try {
      this.els.flowRunNowBtn.disabled = true;
      await this.saveFlowConfig();
      const result = await API.post("/api/google-flow/run-now");
      this.els.flowConfigMessage.textContent = `Generation job ${result.job.id.slice(0, 8)} queued.`;
      await this.refresh();
    } catch (error) {
      this.els.flowConfigMessage.textContent = error.message;
    } finally {
      this.els.flowRunNowBtn.disabled = false;
    }
  },

  async createAutonomousJob() {
    try {
      const videoName = this.els.ttJobVideo?.value;
      const localDate = this.els.ttJobDate?.value;
      if (!videoName || !localDate) throw new Error("Select a video and future date.");
      this.els.ttJobCreateBtn.disabled = true;
      const result = await API.post("/api/jobs", {
        videoName,
        scheduledAt: new Date(localDate).toISOString(),
        caption: this.els.ttJobCaption?.value || "",
      });
      this.els.ttJobMessage.textContent = `Scheduled ${videoName} for ${new Date(result.job.scheduledAt).toLocaleString()}.`;
      this.els.ttJobCaption.value = "";
      await this.refresh();
    } catch (error) {
      this.els.ttJobMessage.textContent = error.message;
    } finally {
      this.els.ttJobCreateBtn.disabled = false;
    }
  },

  async handleJobAction(event) {
    const button = event.target.closest("button[data-job-id][data-job-action]");
    if (!button) return;
    button.disabled = true;
    try {
      await API.post(`/api/jobs/${encodeURIComponent(button.dataset.jobId)}/${button.dataset.jobAction}`);
      await this.refresh();
    } catch (error) {
      alert(error.message);
    } finally {
      button.disabled = false;
    }
  },

  renderAutonomousJobs(data) {
    const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
    if (this.els.autonomousWorkerBadge) {
      const running = Boolean(data?.worker?.running);
      this.els.autonomousWorkerBadge.textContent = running ? (data.worker.busy ? "Working" : "Active") : "Stopped";
      this.els.autonomousWorkerBadge.classList.toggle("success", running);
      this.els.autonomousWorkerBadge.classList.toggle("error", !running);
    }
    const render = (items) => items.map((job) => {
      const pending = ["scheduled", "retry"].includes(job.status);
      const retryable = job.type === "flow-generate" && job.status === "failed";
      const title = job.type === "flow-generate" ? "Google Flow generation" : (job.payload?.videoName || "TikTok video");
      const progress = job.progress ? ` - ${job.progress.stage} ${job.progress.current || 0}/${job.progress.total || 0}` : "";
      return `<div class="autonomous-job">
        <div><strong>${escapeHtml(title)}</strong><small>${new Date(job.scheduledAt).toLocaleString()} - ${escapeHtml(job.status)}${escapeHtml(progress)}</small>${job.error ? `<small class="job-error">${escapeHtml(job.error)}</small>` : ""}</div>
        <div class="flow-actions">${pending ? `<button class="control-btn-small danger" data-job-id="${escapeHtml(job.id)}" data-job-action="cancel">Cancel</button>` : ""}${retryable ? `<button class="control-btn-small" data-job-id="${escapeHtml(job.id)}" data-job-action="retry">Retry</button>` : ""}</div>
      </div>`;
    }).join("") || '<div class="setup-empty">No autonomous jobs for this account.</div>';
    if (this.els.autonomousJobsList) this.els.autonomousJobsList.innerHTML = render(jobs);
    const flowJobs = jobs.filter((job) => job.type === "flow-generate");
    if (this.els.flowJobsList) this.els.flowJobsList.innerHTML = render(flowJobs);
    if (this.els.flowPipelineBadge) {
      const active = flowJobs.find((job) => ["running", "scheduled", "retry"].includes(job.status));
      this.els.flowPipelineBadge.textContent = active ? active.status : "Idle";
      this.els.flowPipelineBadge.classList.toggle("success", Boolean(active));
    }
  },

  readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Could not read reference image."));
      reader.readAsDataURL(file);
    });
  },

  async openFlowLogin() {
    try {
      await API.post("/api/google-flow/login");
      await this.refreshFlowStatus();
    } catch (error) {
      alert(`Could not open Google Flow: ${error.message}`);
    }
  },

  async closeFlowLogin() {
    try {
      await API.post("/api/google-flow/close");
      await this.refreshFlowStatus();
    } catch (error) {
      alert(`Could not close Google Flow: ${error.message}`);
    }
  },

  async saveXConfig() {
    try {
      const current = await API.get("/api/x-autopilot");
      const key = this.els.xAiKey?.value || (current.config?.ai?.apiKey === "configured" ? undefined : "");
      const token = this.els.xAccessToken?.value || (current.config?.x?.accessToken === "configured" ? undefined : "");
      const bearerToken = this.els.xBearerToken?.value || (current.config?.x?.bearerToken === "configured" ? undefined : "");
      const provider = this.els.xAiProvider?.value || "openai";
      const defaultModels = { openai: "gpt-4o-mini", gemini: "gemini-3.6-flash", deepseek: "deepseek-chat" };
      const defaultUrls = { openai: "https://api.openai.com/v1", gemini: "https://generativelanguage.googleapis.com/v1beta", deepseek: "https://api.deepseek.com/v1" };
      const payload = {
        enabled: Boolean(this.els.xEnabled?.checked), postsPerDay: Number(this.els.xPostsPerDay?.value) || 3,
        dailyTimes: String(this.els.xDailyTimes?.value || "09:00").split(",").map((v) => v.trim()).filter(Boolean),
        postingMode: this.els.xPostingMode?.value || "simulation", masterPrompt: this.els.xMasterPrompt?.value || "", // MARKER: XAP-LANG-PAYLOAD-v1 language: this.els.xLanguage?.value === "es" ? "es" : "en",
        accountTier: this.els.xAccountTier?.value || "free", contentMode: this.els.xContentMode?.value || "ai", searchTopic: this.els.xSearchTopic?.value || "",
        ai: { provider, baseUrl: defaultUrls[provider], model: this.els.xAiModel?.value || defaultModels[provider], ...(key !== undefined ? { apiKey: key } : {}) },
        x: { username: this.els.xUsername?.value || "", ...(token !== undefined ? { accessToken: token } : {}), ...(bearerToken !== undefined ? { bearerToken } : {}) },
      };
      await API.post("/api/x-autopilot/configure", payload); this.xDirty.clear(); this.refresh();
    } catch (error) { alert(`No se pudo guardar X Autopilot: ${error.message}`); }
  },
  async generateX() { try { await API.post("/api/x-autopilot/generate", { count: Number(this.els.xPostsPerDay?.value) || 3 }); this.refresh(); } catch (error) { alert(`No se pudo generar: ${error.message}`); } },
  async clearXQueue() { if (!confirm("Borrar todas las publicaciones pendientes?")) return; try { await API.post("/api/x-autopilot/clear-queue"); this.refresh(); } catch (error) { alert(`No se pudo borrar la cola: ${error.message}`); } },
  async addXReference() {
    try {
      await API.post("/api/x-autopilot/reference", { username: this.els.xReferenceUser?.value, text: this.els.xReferenceText?.value, url: this.els.xReferenceUrl?.value });
      this.els.xReferenceText.value = ""; this.refresh();
    } catch (error) { alert(`No se pudo anadir la referencia: ${error.message}`); }
  },
  renderXAutopilot(data) {
    if (!data?.config) return;
    const config = data.config;
    if (this.els.xWorkerBadge) { this.els.xWorkerBadge.textContent = data.worker ? "Worker activo" : "Worker detenido"; this.els.xWorkerBadge.classList.toggle("active", data.worker); }
    const setValue = (el, value, key) => { if (el && !this.xDirty.has(key) && document.activeElement !== el) el.value = value ?? ""; };
    setValue(this.els.xUsername, config.x?.username, "xUsername"); setValue(this.els.xPostsPerDay, config.postsPerDay, "xPostsPerDay"); setValue(this.els.xDailyTimes, (config.dailyTimes || []).join(", "), "xDailyTimes"); setValue(this.els.xPostingMode, config.postingMode, "xPostingMode"); setValue(this.els.xAccountTier, config.accountTier, "xAccountTier"); setValue(this.els.xContentMode, config.contentMode, "xContentMode"); setValue(this.els.xSearchTopic, config.searchTopic, "xSearchTopic"); setValue(this.els.xMasterPrompt, config.masterPrompt, "xMasterPrompt"); setValue(this.els.xLanguage, config.language === "es" ? "es" : "en", "xLanguage"); // MARKER: XAP-LANG-RENDER-v1 setValue(this.els.xAiProvider, config.ai?.provider, "xAiProvider"); setValue(this.els.xAiModel, config.ai?.model, "xAiModel");
    if (this.els.xLiveStatus) this.els.xLiveStatus.textContent = config.postingMode === "live" && config.x?.accessToken === "configured" ? "Modo live configurado: las publicaciones se enviaran a X cuando llegue su hora." : config.postingMode === "live" ? "Falta el User Access Token de X. Live no simulara publicaciones: mostrara un error." : "Modo simulacion: las publicaciones no se envian a X. Usa live y un User Access Token con permiso Write.";
    if (this.els.xEnabled && document.activeElement !== this.els.xEnabled) this.els.xEnabled.checked = Boolean(config.enabled);
    if (this.els.xQueueCount) this.els.xQueueCount.textContent = `${data.queue?.length || 0}`;
    if (this.els.xQueueList) this.els.xQueueList.innerHTML = (data.queue || []).slice().sort((a, b) => new Date(a.scheduledFor) - new Date(b.scheduledFor)).map((post) => `<div class="x-queue-item"><div><strong>${escapeHtml(post.text)}</strong><small>${new Date(post.scheduledFor).toLocaleString()}</small></div><span class="status-badge ${post.status === "failed" ? "error" : "active"}">${escapeHtml(post.status)}</span></div>`).join("") || '<div class="setup-empty">No hay publicaciones en cola.</div>';
    if (this.els.xReferencesList) this.els.xReferencesList.innerHTML = (data.references || []).slice(0, 8).map((ref) => `<div class="x-reference-item"><strong>@${escapeHtml(ref.username)}</strong><span>${escapeHtml(ref.text)}</span></div>`).join("") || '<div class="setup-empty">Sin referencias guardadas.</div>';
    if (this.els.xLogs) this.updateLogContainer(this.els.xLogs, (data.logs || []).map((entry) => `<div class="log-entry"><span class="log-time">${new Date(entry.at).toLocaleTimeString()}</span><span class="log-msg">${escapeHtml(entry.message)}</span></div>`).join(""));
  },

  initCompetitor() {
    if (!this.els.competitorAnalyzeBtn) return;
    this.competitorEventSource = null;
    this.els.competitorAnalyzeBtn.addEventListener("click", () => this.runCompetitorAnalyze());
    if (this.els.competitorKeyBtn) {
      this.els.competitorKeyBtn.addEventListener("click", () => {
        this.els.competitorKeyPanel.hidden = !this.els.competitorKeyPanel.hidden;
      });
    }
    if (this.els.competitorHistoryBtn) {
      this.els.competitorHistoryBtn.addEventListener("click", () => this.toggleCompetitorReports());
    }
    if (this.els.competitorSaveKeyBtn) {
      this.els.competitorSaveKeyBtn.addEventListener("click", () => this.saveCompetitorKey());
    }
    if (this.els.competitorRemoveKeyBtn) {
      this.els.competitorRemoveKeyBtn.addEventListener("click", () => this.removeCompetitorKey());
    }
    if (this.els.competitorSaveModelBtn) {
      this.els.competitorSaveModelBtn.addEventListener("click", () => this.saveCompetitorModel());
    }
    if (this.els.competitorModelsBtn) {
      this.els.competitorModelsBtn.addEventListener("click", () => this.listCompetitorModels());
    }
    if (this.els.competitorTarget) {
      this.els.competitorTarget.addEventListener("keydown", (e) => {
        if (e.key === "Enter") this.runCompetitorAnalyze();
      });
    }
    if (this.els.competitorReportsList) {
      this.els.competitorReportsList.addEventListener("click", (e) => this.handleCompetitorReportClick(e));
    }
    if (this.els.competitorResult) {
      this.els.competitorResult.addEventListener("click", (e) => this.handleCompetitorResultClick(e));
    }
    document.addEventListener("autosocial:viewchange", (event) => {
      if (event.detail?.viewName === "competitor") this.refreshCompetitorStatus();
    });
    this.refreshCompetitorStatus();
  },

  async refreshCompetitorStatus() {
    try {
      const data = await API.get("/api/competitor/settings");
      const s = data.settings || {};
      const hasKey = Boolean(s.hasGeminiKey);
      if (this.els.competitorKeyBadge) {
        this.els.competitorKeyBadge.textContent = hasKey ? `Gemini: ${s.geminiKeyMasked}` : "Sin API de Gemini";
        this.els.competitorKeyBadge.classList.toggle("active", hasKey);
        this.els.competitorKeyBadge.classList.toggle("error", !hasKey);
      }
      if (this.els.competitorKeyStatus) {
        this.els.competitorKeyStatus.textContent = hasKey
          ? `Configurada (${s.geminiKeyMasked}). Modelo ${s.model}.`
          : "Sin configurar. El analisis necesita una API key de Gemini.";
      }
      if (this.els.competitorModel && document.activeElement !== this.els.competitorModel) {
        this.els.competitorModel.value = s.model || "";
      }
      if (this.els.competitorBrand && document.activeElement !== this.els.competitorBrand) {
        this.els.competitorBrand.value = s.brand || "";
      }
      if (this.els.competitorLanguage && document.activeElement !== this.els.competitorLanguage) {
        this.els.competitorLanguage.value = s.language || "es";
      }
    } catch (error) {
      console.warn("competitor status", error.message);
    }
  },

  async saveCompetitorKey() {
    const key = (this.els.competitorApiKey?.value || "").trim();
    if (!key) { alert("Pega tu API key de Gemini."); return; }
    try {
      await API.post("/api/competitor/settings", {
        geminiApiKey: key,
        brand: this.els.competitorBrand?.value || "",
        language: this.els.competitorLanguage?.value || "es",
      });
      this.els.competitorApiKey.value = "";
      await this.refreshCompetitorStatus();
    } catch (error) { alert(`No se pudo guardar la API key: ${error.message}`); }
  },

  async removeCompetitorKey() {
    if (!confirm("¿Quitar la API key de Gemini guardada?")) return;
    try {
      await API.post("/api/competitor/settings", { geminiApiKey: "" });
      await this.refreshCompetitorStatus();
    } catch (error) { alert(`No se pudo quitar la API key: ${error.message}`); }
  },

  async saveCompetitorModel() {
    const model = (this.els.competitorModel?.value || "").trim();
    if (!model) { alert("Escribe un nombre de modelo (ej. gemini-3.6-flash)."); return; }
    try {
      const data = await API.post("/api/competitor/settings", { model });
      if (this.els.competitorModelStatus) this.els.competitorModelStatus.textContent = `Modelo guardado: ${data.settings.model}`;
      await this.refreshCompetitorStatus();
    } catch (error) { alert(`No se pudo guardar el modelo: ${error.message}`); }
  },

  async listCompetitorModels() {
    const status = this.els.competitorModelStatus;
    if (status) status.textContent = "Consultando modelos disponibles en tu cuenta…";
    try {
      const models = (await API.get("/api/competitor/models")).models || [];
      if (!models.length) { if (status) status.textContent = "No se encontraron modelos de texto."; return; }
      if (status) status.textContent = `Disponibles: ${models.slice(0, 25).join(", ")}`;
    } catch (error) {
      if (status) status.textContent = `Error al listar modelos: ${error.message}`;
    }
  },

  async toggleCompetitorReports() {
    const box = this.els.competitorReportsList;
    if (!box) return;
    if (!box.hidden) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = '<div class="setup-empty">Cargando informes…</div>';
    try {
      const data = await API.get("/api/competitor/reports");
      const reports = data.reports || [];
      box.innerHTML = reports.length
        ? reports.map((r) => `<div class="competitor-report-item" data-report-id="${escapeHtml(r.id)}">
            <div><strong>@${escapeHtml(r.handle)}</strong><small>${new Date(r.analyzedAt).toLocaleString()}${r.summary ? " · " + escapeHtml(r.summary).slice(0, 80) : ""}</small></div>
            <div class="competitor-report-actions">
              <button class="control-btn-small" data-action="open" data-report-id="${escapeHtml(r.id)}">Ver</button>
              <button class="control-btn-small danger" data-action="delete" data-report-id="${escapeHtml(r.id)}">Borrar</button>
            </div>
          </div>`).join("")
        : '<div class="setup-empty">Todavía no hay informes.</div>';
    } catch (error) {
      box.innerHTML = `<div class="setup-empty">Error: ${escapeHtml(error.message)}</div>`;
    }
  },

  async handleCompetitorReportClick(event) {
    const btn = event.target.closest("button[data-action]");
    if (!btn) return;
    const { action, reportId } = btn.dataset;
    if (action === "open") {
      try {
        const data = await API.get(`/api/competitor/reports/${encodeURIComponent(reportId)}`);
        this.renderCompetitorReport(data.report);
        this.els.competitorReportsList.hidden = true;
      } catch (error) { alert(`No se pudo abrir el informe: ${error.message}`); }
    } else if (action === "delete") {
      if (!confirm("¿Borrar este informe?")) return;
      try {
        await API.request(`/api/competitor/reports/${encodeURIComponent(reportId)}`, { method: "DELETE" });
        await this.toggleCompetitorReports();
        this.toggleCompetitorReports();
      } catch (error) { alert(`No se pudo borrar: ${error.message}`); }
    }
  },

  async handleCompetitorResultClick(event) {
    const btn = event.target.closest("button[data-action]");
    if (!btn) return;
    if (btn.dataset.action === "copy-prompt") {
      const prompt = this.competitorLastPrompt || "";
      if (!prompt) return;
      try { await navigator.clipboard.writeText(prompt); btn.textContent = "Copiado"; setTimeout(() => (btn.textContent = "Copiar prompt"), 1500); }
      catch { alert("No se pudo copiar automaticamente. Selecciona el texto y copia."); }
    } else if (btn.dataset.action === "rebuild-prompt") {
      const id = btn.dataset.reportId;
      if (!id) return;
      try {
        const data = await API.post(`/api/competitor/reports/${encodeURIComponent(id)}/master-prompt`, {
          brand: this.els.competitorBrand?.value || "",
          language: this.els.competitorLanguage?.value || "es",
        });
        this.renderCompetitorReport(data.report);
      } catch (error) { alert(`No se pudo regenerar el prompt: ${error.message}`); }
    } else if (btn.dataset.action === "apply-flow") {
      await this.applyCompetitorToFlow(btn.dataset.reportId);
    }
  },

  async applyCompetitorToFlow(reportId) {
    if (!reportId) { alert("Guarda primero el informe (ejecuta un análisis) para poder aplicarlo."); return; }
    let accounts = [];
    try {
      accounts = (await API.get("/api/competitor/flow-accounts")).accounts || [];
    } catch (error) { alert(`No se pudieron listar las cuentas de Flow: ${error.message}`); return; }
    if (!accounts.length) { alert("No hay cuentas de TikTok/Flow configuradas en el dashboard."); return; }
    const names = accounts.map((a, i) => `${i + 1}) ${a.name || a.id}`).join("\n");
    const answer = prompt(`¿En qué cuenta de Google Flow aplico el Prompt Maestro?\n\n${names}\n\nEscribe el número:`);
    if (answer === null) return;
    const index = Number(answer) - 1;
    const account = accounts[index];
    if (!account) { alert("Número no válido."); return; }
    try {
      const result = await API.post(`/api/competitor/reports/${encodeURIComponent(reportId)}/apply-to-flow`, { accountId: account.id });
      alert(`Prompt Maestro aplicado a "${account.name || account.id}".\nLongitud: ${result.length} caracteres.\n\nYa puedes generar vídeos en Flow con este estilo.`);
    } catch (error) { alert(`No se pudo aplicar a Flow: ${error.message}`); }
  },

  async runCompetitorAnalyze() {
    const target = (this.els.competitorTarget?.value || "").trim();
    if (!target) { alert("Escribe un @usuario o un enlace de TikTok."); return; }
    const btn = this.els.competitorAnalyzeBtn;
    btn.disabled = true;
    this.showCompetitorProgress({ stage: "starting", detail: "Preparando analisis…", at: Date.now() });
    this.openCompetitorEvents();
    try {
      const data = await API.post("/api/competitor/analyze", {
        target,
        depth: Number(this.els.competitorDepth?.value || 24),
        brand: this.els.competitorBrand?.value || "",
        language: this.els.competitorLanguage?.value || "es",
      });
      this.renderCompetitorReport(data.report);
    } catch (error) {
      this.showCompetitorProgress({ stage: "error", detail: error.message });
      alert(`No se pudo analizar: ${error.message}`);
    } finally {
      btn.disabled = false;
      this.closeCompetitorEvents();
    }
  },

  openCompetitorEvents() {
    this.closeCompetitorEvents();
    try {
      const es = new EventSource("/api/competitor/events");
      es.onmessage = (event) => {
        try { this.showCompetitorProgress(JSON.parse(event.data)); } catch {}
      };
      es.onerror = () => {};
      this.competitorEventSource = es;
    } catch {}
  },

  closeCompetitorEvents() {
    if (this.competitorEventSource) { this.competitorEventSource.close(); this.competitorEventSource = null; }
  },

  showCompetitorProgress(progress) {
    const el = this.els.competitorProgress;
    if (!el) return;
    if (!progress || progress.stage === "idle") { el.hidden = true; return; }
    el.hidden = false;
    const pct = typeof progress.percent === "number" ? progress.percent : null;
    el.innerHTML = `<div class="competitor-progress-head"><span class="competitor-spinner"></span><strong>${escapeHtml(progress.stage || "")}</strong><span>${escapeHtml(progress.detail || "")}</span></div>
      ${pct !== null ? `<div class="competitor-bar"><div style="width:${Math.max(0, Math.min(100, pct))}%"></div></div>` : ""}
      ${progress.handle ? `<small>@${escapeHtml(progress.handle)}</small>` : ""}`;
  },

  renderCompetitorReport(report) {
    if (!report) return;
    const box = this.els.competitorResult;
    if (!box) return;
    const m = report.metrics || {};
    const style = report.style || {};
    const narrative = report.narrative || {};
    const cats = report.categories || {};
    const earnings = m.estimatedMonthlyEarningsUsd || {};
    const videoCount = report.evidence?.videoCount || report.videosAnalyzed || 0;
    this.competitorLastPrompt = report.masterPrompt || "";
    const fmt = (v) => (v === null || v === undefined || v === "" ? null : Number(v).toLocaleString("es-ES"));
    const metricCards = [
      ["Seguidores", fmt(m.followers)],
      ["Vídeos analizados", videoCount],
      ["Vistas medias", fmt(m.avgViews)],
      ["Likes medios", fmt(m.avgLikes)],
      ["Comentarios medios", fmt(m.avgComments)],
      ["Engagement", m.engagementRate != null ? `${m.engagementRate}%` : null],
      ["Duración media", style.avgDurationSeconds ? `${style.avgDurationSeconds}s` : null],
      ["Cadencia", m.postingCadencePerWeek != null ? `${m.postingCadencePerWeek}/sem` : null],
      ["Ingresos est./mes", earnings.low != null ? `${earnings.low}–${earnings.high} $` : null],
    ].filter(([, v]) => v !== null && v !== undefined);
    box.hidden = false;
    box.innerHTML = `
      <div class="competitor-report-head">
        <div>
          <h3>@${escapeHtml(report.handle)}</h3>
          <small>${report.analyzedAt ? new Date(report.analyzedAt).toLocaleString() : ""} · ${videoCount} vídeos · ${report.framesAnalyzed || 0} frames</small>
        </div>
        ${report.id ? `<button class="control-btn-small" data-action="rebuild-prompt" data-report-id="${escapeHtml(report.id)}">Regenerar Prompt Maestro</button>` : ""}
      </div>
      <div class="competitor-metrics">${metricCards.map(([label, value]) => `<div class="competitor-metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></div>`).join("")}</div>
      ${report.summary ? `<div class="competitor-summary card"><div class="card-title">Resumen</div><p>${escapeHtml(report.summary)}</p></div>` : ""}
      ${narrative.hooksFirst3s ? `<div class="competitor-block card"><div class="card-title">Ganchos (primeros 3s)</div><p>${escapeHtml(narrative.hooksFirst3s)}</p></div>` : ""}
      ${narrative.structure ? `<div class="competitor-block card"><div class="card-title">Estructura</div><p>${escapeHtml(narrative.structure)}</p></div>` : ""}
      ${narrative.retention ? `<div class="competitor-block card"><div class="card-title">Retención</div><p>${escapeHtml(narrative.retention)}</p></div>` : ""}
      ${style.framing || style.paletteAndLighting || style.onScreenText ? `<div class="competitor-block card"><div class="card-title">Estilo visual</div>
        ${style.framing ? `<p><strong>Encuadre:</strong> ${escapeHtml(style.framing)}</p>` : ""}
        ${style.paletteAndLighting ? `<p><strong>Luz y color:</strong> ${escapeHtml(style.paletteAndLighting)}</p>` : ""}
        ${style.onScreenText ? `<p><strong>Texto en pantalla:</strong> ${escapeHtml(style.onScreenText)}</p>` : ""}
        ${style.musicAndSfx ? `<p><strong>Música/efectos:</strong> ${escapeHtml(style.musicAndSfx)}</p>` : ""}
      </div>` : ""}
      ${(cats.mainTopics || []).length ? `<div class="competitor-block card"><div class="card-title">Temas principales</div><div class="competitor-tags">${cats.mainTopics.map((t) => `<span>${escapeHtml(t)}</span>`).join("")}</div></div>` : ""}
      ${cats.viralPatterns ? `<div class="competitor-block card"><div class="card-title">Qué le da viralidad</div><p>${escapeHtml(cats.viralPatterns)}</p></div>` : ""}
      ${(report.opportunities || []).length ? `<div class="competitor-block card"><div class="card-title">Oportunidades</div><ul>${report.opportunities.map((o) => `<li>${escapeHtml(o)}</li>`).join("")}</ul></div>` : ""}
      <div class="competitor-block card" id="prompt-maestro">
        <div class="card-title">Prompt Maestro (para Google Flow)</div>
        ${report.dataQuality && report.dataQuality !== "metrics" ? `<div class="competitor-warning">yt-dlp no devolvió contadores de vistas/likes para este perfil, así que las métricas son parciales. El análisis se basa en títulos, duración, música y fotogramas.</div>` : ""}
        <textarea class="competitor-master-prompt" readonly>${escapeHtml(report.masterPrompt || "")}</textarea>
        <div class="competitor-prompt-actions">
          <button class="control-btn-small primary" data-action="copy-prompt">Copiar prompt</button>
          <button class="control-btn-small" data-action="apply-flow" data-report-id="${escapeHtml(report.id || "")}">Aplicar a Google Flow</button>
        </div>
      </div>`;
    if (this.els.competitorTarget && document.activeElement === this.els.competitorTarget) {
      box.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }
};

document.addEventListener("DOMContentLoaded", () => UI.init());
