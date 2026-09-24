/* Keep Auto Clone and AutoPost settings separate for each selected account. */
(function initAccountSettings() {
  const STORAGE_KEY = "autosocial.accountSettings.v1";
  const LEGACY_FOLDER_KEY = "autoclone.destination";
  const LEGACY_POST_OPTIONS_KEY = "autoclone.postOptions";
  let activeAccountId = "";
  let switching = false;
  let initialized = false;

  const $ = (id) => document.getElementById(id);
  const fields = {
    sourceUsername: $("autocloneUsername"),
    markerUrl: $("autocloneLastPublishedUrl"),
    destination: $("autocloneDestination"),
    folder: $("apFolder"),
    hashtags: $("apHashtags"),
    caption: $("apCaption"),
    times: $("apTimes"),
    max: $("apMax"),
    timezone: $("apTimezone"),
    locationMadrid: $("apLocationMadrid"),
    locationCustom: $("apLocationCustom"),
    aiGenerated: $("apAiGenerated"),
    days: $("apDays"),
    chooseFolder: $("apChooseBtn"),
    loadFolder: $("apLoadBtn"),
    useDestination: $("apUseDestBtn"),
  };

  function readStore() {
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      return value && typeof value === "object" ? value : {};
    } catch {
      return {};
    }
  }

  function writeStore(store) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); } catch { /* best effort */ }
  }

  function legacyValues() {
    let postOptions = {};
    try { postOptions = JSON.parse(localStorage.getItem(LEGACY_POST_OPTIONS_KEY) || "{}"); } catch { /* ignore */ }
    return {
      sourceUsername: fields.sourceUsername?.value || "",
      markerUrl: fields.markerUrl?.value || "",
      destination: localStorage.getItem(LEGACY_FOLDER_KEY) || fields.destination?.value || "",
      folder: localStorage.getItem(LEGACY_FOLDER_KEY) || fields.folder?.value || "",
      hashtags: postOptions.hashtags || fields.hashtags?.value || "",
      caption: fields.caption?.value || "",
      times: fields.times?.value || "",
      max: fields.max?.value || "0",
      timezone: fields.timezone?.value || "",
      locationMadrid: Boolean(postOptions.locationMadrid || fields.locationMadrid?.checked),
      locationCustom: postOptions.locationCustom || fields.locationCustom?.value || "",
      aiGenerated: Boolean(postOptions.aiGenerated || fields.aiGenerated?.checked),
      days: fields.days ? [...fields.days.querySelectorAll("input:checked")].map((input) => input.value) : [],
    };
  }

  function snapshot() {
    return {
      sourceUsername: fields.sourceUsername?.value || "",
      markerUrl: fields.markerUrl?.value || "",
      destination: fields.destination?.value || fields.folder?.value || "",
      folder: fields.folder?.value || fields.destination?.value || "",
      hashtags: fields.hashtags?.value || "",
      caption: fields.caption?.value || "",
      times: fields.times?.value || "",
      max: fields.max?.value || "0",
      timezone: fields.timezone?.value || "",
      locationMadrid: Boolean(fields.locationMadrid?.checked),
      locationCustom: fields.locationCustom?.value || "",
      aiGenerated: Boolean(fields.aiGenerated?.checked),
      days: fields.days ? [...fields.days.querySelectorAll("input:checked")].map((input) => input.value) : [],
    };
  }

  function syncLegacyFolder(folder) {
    try { localStorage.setItem(LEGACY_FOLDER_KEY, folder || ""); } catch { /* ignore */ }
  }

  function applyValues(values) {
    const data = values || {};
    if (fields.sourceUsername) fields.sourceUsername.value = data.sourceUsername || "";
    if (fields.markerUrl) fields.markerUrl.value = data.markerUrl || "";
    if (fields.destination) fields.destination.value = data.destination || data.folder || "";
    if (fields.folder) fields.folder.value = data.folder || data.destination || "";
    if (fields.hashtags) fields.hashtags.value = data.hashtags || "";
    if (fields.caption) fields.caption.value = data.caption || "";
    if (fields.times && data.times) fields.times.value = data.times;
    if (fields.max && data.max !== undefined) fields.max.value = data.max;
    if (fields.timezone && data.timezone) fields.timezone.value = data.timezone;
    if (fields.locationMadrid) fields.locationMadrid.checked = Boolean(data.locationMadrid);
    if (fields.locationCustom) fields.locationCustom.value = data.locationCustom || "";
    if (fields.aiGenerated) fields.aiGenerated.checked = Boolean(data.aiGenerated);
    if (fields.days && Array.isArray(data.days) && data.days.length) {
      for (const input of fields.days.querySelectorAll("input")) input.checked = data.days.includes(input.value);
    }
    syncLegacyFolder(data.destination || data.folder || "");
    fields.destination?.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function saveCurrent() {
    if (!activeAccountId || switching) return;
    const store = readStore();
    store[activeAccountId] = snapshot();
    writeStore(store);
    syncLegacyFolder(store[activeAccountId].destination);
  }

  async function switchAccount(accountId) {
    const nextId = String(accountId || "").trim();
    if (!nextId || nextId === activeAccountId) return;
    if (activeAccountId) saveCurrent();
    switching = true;
    activeAccountId = nextId;
    const store = readStore();
    const values = store[nextId] || (!initialized ? legacyValues() : null);
    if (!store[nextId] && values) {
      store[nextId] = values;
      writeStore(store);
    }
    applyValues(values || {});
    switching = false;
    initialized = true;
  }

  function bindPersistence() {
    const save = () => saveCurrent();
    for (const field of Object.values(fields)) {
      field?.addEventListener("input", save);
      field?.addEventListener("change", save);
      field?.addEventListener("blur", save);
    }
    fields.days?.addEventListener("change", save);
    document.addEventListener("autosocial:destinationchange", save);

    // Folder pickers assign .value in code, so no input/change event is emitted.
    fields.chooseFolder?.addEventListener("click", () => {
      const before = fields.folder?.value || "";
      let attempts = 0;
      const timer = setInterval(() => {
        attempts += 1;
        if ((fields.folder?.value || "") !== before || attempts >= 120) {
          clearInterval(timer);
          save();
        }
      }, 250);
    });
    fields.loadFolder?.addEventListener("click", () => setTimeout(save, 0));
    fields.useDestination?.addEventListener("click", () => setTimeout(save, 0));
    window.addEventListener("beforeunload", save);
  }

  document.addEventListener("autosocial:accountchange", (event) => {
    setTimeout(() => switchAccount(event.detail?.accountId).catch(() => {}), 0);
  });

  (async () => {
    bindPersistence();
    try {
      const data = await API.get("/api/accounts");
      await switchAccount(data.activeAccountId || data.activeAccount?.id || "default");
    } catch {
      await switchAccount("default");
    }
  })();
})();
