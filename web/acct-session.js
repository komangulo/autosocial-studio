// Controlador de la pestana "Analisis de cuenta".
// MARKER: ACCTAN-SESSION-v1
//
// La CSP del dashboard bloquea <script> inline, asi que esta logica vive en
// un archivo externo servido desde web/. Gestiona la sesion de X, lanza el
// analisis y muestra el progreso, de forma independiente al resto del panel.
(function () {
  var poll = null;
  function $(id) { return document.getElementById(id); }
  function setBadge(text, ok) {
    var b = $("acctSessionBadge");
    if (!b) return;
    b.textContent = text;
    b.className = "status-badge" + (ok ? " success" : "");
  }
  function setMessage(text) { var m = $("acctSessionMessage"); if (m) m.textContent = text; }
  function showBox(html, isError) {
    var w = $("acctSessionWarning");
    if (!w) return;
    w.style.display = "block";
    w.style.borderColor = isError ? "#5c1a1a" : "";
    w.style.background = isError ? "#2a0f0f" : "";
    var p = w.querySelector("p");
    if (p) { p.innerHTML = html; p.style.color = isError ? "#f87171" : ""; }
  }
  function hideBox() { var w = $("acctSessionWarning"); if (w) w.style.display = "none"; }
  function progress(text, isError) {
    var box = $("acctProgressBox");
    var el = $("acctProgress");
    if (!el) return;
    el.textContent = text;
    if (box) {
      box.style.display = "block";
      box.style.background = isError ? "#2a0f0f" : "#101c2e";
      box.style.borderColor = isError ? "#5c1a1a" : "#1e3a63";
      el.style.color = isError ? "#f87171" : "#9cc3ff";
    }
  }
  function jsonp(r) {
    return r.text().then(function (t) {
      var d = null;
      try { d = JSON.parse(t); } catch (e) {}
      return { status: r.status, data: d, raw: t };
    });
  }
  function fail(res) {
    var msg = (res.data && res.data.error) || res.raw || ("HTTP " + res.status);
    return String(msg).slice(0, 300);
  }

  var isSaved = false;

  function refresh() {
    return fetch("/api/x-autopilot/session", { credentials: "same-origin", headers: { "Accept": "application/json" } })
      .then(jsonp)
      .then(function (res) {
        if (res.status !== 200 || !res.data) {
          isSaved = false; setBadge("Sin sesion", false);
          showBox("<b>No se pudo comprobar la sesion de X.</b> El servidor respondio " + res.status + ". " + fail(res), true);
          return;
        }
        var s = res.data.session || {};
        isSaved = !!s.saved;
        setBadge(isSaved ? "Sesion guardada" : (s.open ? "Ventana abierta" : "Sin sesion"), isSaved);
        setMessage(isSaved
          ? "Sesion de X lista. Escribe un @, elige cuantas publicaciones y pulsa Analizar."
          : "Necesitas iniciar sesion en X aqui mismo para poder leer los posts de una cuenta.");
        if (isSaved) hideBox();
        var btn = $("acctStartBtn");
        if (btn) {
          btn.disabled = !isSaved;
          btn.style.opacity = isSaved ? "1" : "0.5";
          btn.style.cursor = isSaved ? "pointer" : "not-allowed";
        }
      })
      .catch(function (e) {
        isSaved = false; setBadge("Sin sesion", false);
        showBox("<b>No se pudo conectar con el servidor.</b> " + String(e && e.message ? e.message : e), true);
      });
  }

  function post(url, body) {
    return fetch(url, {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    }).then(jsonp).then(function (res) {
      if (res.status !== 200 || (res.data && res.data.ok === false)) throw new Error(fail(res));
      return res.data || {};
    });
  }

  function startPolling() {
    if (poll) return;
    progress("Analisis en marcha. No cierres esta pestana.");
    poll = setInterval(function () {
      fetch("/api/account-analysis/status", { credentials: "same-origin", headers: { "Accept": "application/json" } })
        .then(jsonp)
        .then(function (res) {
          if (res.status !== 200 || !res.data) return;
          var job = res.data;
          if (job.running) {
            var labels = {
              "abriendo perfil": "Abriendo el perfil en X",
              "cargando perfil": "Cargando el perfil",
              "recogiendo publicaciones": "Recogiendo publicaciones",
              "analizando": "Analizando los datos",
              "generando manual": "Generando el manual de ADN",
            };
            progress("@" + job.handle + " — " + (labels[job.phase] || job.phase) + ": " + job.collected + " de " + job.maxPosts + " publicaciones...");
            return;
          }
          clearInterval(poll); poll = null;
          if (job.error) {
            progress("No se pudo completar el analisis: " + job.error, true);
          } else {
            progress("Listo: " + job.collected + " publicaciones analizadas de @" + job.handle + ". Aparecen abajo.");
            loadList().then(function () { if (job.handle) openProfile(job.handle); });
          }
        })
        .catch(function () {});
    }, 2500);
  }

  function analyze() {
    var input = $("acctHandle");
    var handle = (input && input.value ? input.value : "").replace(/^\s+|\s+$/g, "");
    if (!handle) { progress("Escribe primero un @ de X (por ejemplo levelsio).", true); input && input.focus(); return; }
    if (!isSaved) {
      progress("Primero inicia sesion en X con el boton de arriba.", true);
      var w = $("acctSessionWarning"); if (w) w.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    var sel = $("acctMaxPosts");
    var maxPosts = sel ? Number(sel.value) || 150 : 150;
    progress("Iniciando el analisis de @" + handle.replace(/^@+/, "") + "...");
    post("/api/account-analysis/start", { handle: handle, maxPosts: maxPosts })
      .then(function () { startPolling(); })
      .catch(function (e) { progress("Error al iniciar: " + String(e && e.message ? e.message : e), true); });
  }

  function boot() {
    if (!$("view-account-analysis") && !$("acctSessionBadge")) return;
    bind(); refresh(); loadList();
    setInterval(function () {
      var view = $("view-account-analysis");
      var visible = view ? view.offsetParent !== null || (view.className || "").indexOf("active") !== -1 : true;
      fetch("/api/account-analysis/status", { credentials: "same-origin" }).then(jsonp).then(function (res) {
        if (res.status === 200 && res.data && res.data.running) { startPolling(); return; }
        if (visible) loadList();
      }).catch(function () {});
    }, 5000);
    // Al pulsar la pestana, refrescar inmediatamente.
    var nav = document.querySelector('[data-view="account-analysis"]');
    if (nav) nav.addEventListener("click", function () { setTimeout(function () { refresh(); loadList(); }, 150); });
  }

  // ---- Lista, detalle y manual (independientes del panel general) ----
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function loadList() {
    return fetch("/api/account-analysis", { credentials: "same-origin", headers: { "Accept": "application/json" } })
      .then(jsonp)
      .then(function (res) {
        if (res.status !== 200 || !res.data) return;
        renderList(res.data.profiles || []);
      })
      .catch(function () {});
  }
  function renderList(profiles) {
    var list = $("acctProfileList");
    var badge = $("acctAnalysisBadge");
    if (badge) {
      badge.textContent = profiles.length ? profiles.length + " cuenta(s)" : "Sin analisis";
      badge.className = "status-badge" + (profiles.length ? " success" : "");
    }
    if (!list) return;
    if (!profiles.length) {
      list.innerHTML = '<div class="setup-empty">Todavia no has analizado ninguna cuenta.</div>';
      return;
    }
    list.innerHTML = profiles.map(function (p) {
      return '<div class="x-reference-item" style="cursor:pointer;" data-acct="' + esc(p.handle) + '">' +
        '<strong>@' + esc(p.handle) + '</strong>' +
        '<span>' + p.posts + ' publicaciones · ' + p.originals + ' propias · ' + p.replies + ' respuestas</span>' +
        '<span class="form-hint">' + esc((p.topTopics || []).join(" · ")) + '</span></div>';
    }).join("");
    Array.prototype.forEach.call(list.querySelectorAll("[data-acct]"), function (node) {
      node.addEventListener("click", function () { openProfile(node.getAttribute("data-acct")); });
    });
  }
  function openProfile(handle) {
    fetch("/api/account-analysis/" + encodeURIComponent(handle), { credentials: "same-origin", headers: { "Accept": "application/json" } })
      .then(jsonp)
      .then(function (res) {
        if (res.status !== 200 || !res.data || !res.data.data) return;
        renderDetail(res.data.data);
      })
      .catch(function () {});
  }
  function renderDetail(data) {
    var a = data.analysis || {};
    var f = a.format || {};
    var title = $("acctDetailTitle");
    if (title) title.textContent = "@" + data.handle;
    var body = $("acctDetailBody");
    if (body) {
      var topics = (a.topics || []).slice(0, 5).map(function (t) {
        return '<span class="ai-chain-step">' + esc(t.topic) + ' · ' + t.count + '</span>';
      }).join("");
      var hints = (a.keywords || []).slice(0, 20).map(function (k) { return k.word; }).join(", ");
      body.innerHTML =
        '<div class="ai-chain-list" style="margin-bottom:12px;">' + (topics || '<span class="form-hint">Sin temas detectados.</span>') + '</div>' +
        '<p class="form-hint"><b>' + (f.total || 0) + '</b> publicaciones · <b>' + (f.originalPosts || 0) + '</b> propias · <b>' + (f.replies || 0) + '</b> respuestas</p>' +
        '<p class="form-hint">Longitud media: <b>' + (f.avgLength || 0) + '</b> caracteres · Emojis: ' + (f.emojiRatio || 0) + ' · Imagen en ' + (f.withImage || 0) + '</p>' +
        '<p class="form-hint">Sentimiento: <b>' + esc(a.sentiment && a.sentiment.label || "?") + '</b> (' + (a.sentiment && a.sentiment.score || 0) + ')</p>' +
        '<p class="form-hint">Ritmo: <b>' + (a.rhythm && a.rhythm.postsPerDay || 0) + '</b> publicaciones/dia durante ' + (a.rhythm && a.rhythm.spanDays || 0) + ' dias</p>' +
        '<p class="form-hint" style="margin-top:8px;">Palabras clave: ' + esc(hints) + '</p>';
    }
    var manual = $("acctManual");
    if (manual) manual.textContent = data.manual || "Sin manual generado.";
    var ub = $("acctUseBtn");
    if (ub) ub.setAttribute("data-handle", data.handle);
    loadPublisher(data.handle);
    loadReports(data.handle);
  }

  // ---- Historial de informes guardados (elegir uno anterior) ----
  function setReportsEnabled(on) {
    var sel = $("acctReportSelect"), rl = $("acctReportLoad"), rd = $("acctReportDelete");
    [sel, rl, rd].forEach(function (el) {
      if (!el) return;
      el.disabled = !on;
      el.style.opacity = on ? "1" : "0.5";
      el.style.cursor = on ? "pointer" : "not-allowed";
    });
  }
  function loadReports(handle) {
    var sel = $("acctReportSelect");
    if (!sel) return;
    sel.setAttribute("data-handle", handle || "");
    if (!handle) {
      sel.innerHTML = '<option value="">— Selecciona una cuenta de la lista —</option>';
      setReportsEnabled(false);
      return;
    }
    setReportsEnabled(true);
    fetch("/api/account-analysis/" + encodeURIComponent(handle) + "/reports", { credentials: "same-origin", headers: { "Accept": "application/json" } })
      .then(jsonp)
      .then(function (res) {
        var reports = (res.data && res.data.reports) || [];
        var hint = $("acctReportsHint");
        if (!reports.length) {
          sel.innerHTML = '<option value="">— Aun no hay informes guardados —</option>';
          if (hint) hint.textContent = "Este es el primer analisis de @" + handle + ". Se guardara con fecha y hora para reutilizarlo.";
          return;
        }
        sel.innerHTML = '<option value="">— Usar el analisis mas reciente —</option>' + reports.map(function (r, i) {
          return '<option value="' + esc(r.stamp) + '">' + esc(r.label) + ' · ' + r.posts + ' posts' + (i === 0 ? ' (mas reciente)' : '') + '</option>';
        }).join("");
        if (hint) hint.textContent = reports.length + " informe(s) guardado(s) de @" + handle + ". Elige uno y pulsa Cargar informe.";
      })
      .catch(function () {});
  }
  function loadSelectedReport() {
    var sel = $("acctReportSelect");
    var handle = sel && sel.getAttribute("data-handle");
    var stamp = sel && sel.value;
    if (!handle) { alert("Selecciona una cuenta de la lista de arriba primero."); return; }
    if (!stamp) {
      // Volver al mas reciente: simplemente recargar el detalle vigente.
      openProfile(handle);
      return;
    }
    post("/api/account-analysis/" + encodeURIComponent(handle) + "/reports/" + encodeURIComponent(stamp) + "/use", {})
      .then(function () { openProfile(handle); loadList(); })
      .catch(function (e) { alert(String(e && e.message ? e.message : e)); });
  }
  function deleteSelectedReport() {
    var sel = $("acctReportSelect");
    var handle = sel && sel.getAttribute("data-handle");
    var stamp = sel && sel.value;
    if (!handle || !stamp) { alert("Elige un informe concreto del desplegable para borrarlo."); return; }
    if (!window.confirm("Borrar este informe guardado?")) return;
    fetch("/api/account-analysis/" + encodeURIComponent(handle) + "/reports/" + encodeURIComponent(stamp), { method: "DELETE", credentials: "same-origin" })
      .then(jsonp).then(function () { loadReports(handle); }).catch(function (e) { alert(String(e && e.message ? e.message : e)); });
  }

  // ---- Publicacion diaria (usa el ADN de esta cuenta) ----
  var pubHandle = "";
  function pubMsg(text, isError) {
    var box = $("acctPubBox"), el = $("acctPubMsg");
    if (!el) return;
    box.style.display = "block";
    box.style.background = isError ? "#2a0f0f" : "#101c2e";
    box.style.borderColor = isError ? "#5c1a1a" : "#1e3a63";
    el.style.color = isError ? "#f87171" : "#9cc3ff";
    el.textContent = text;
  }
  function loadPublisher(handle) {
    pubHandle = handle || "";
    if (!pubHandle || !$("acctPubCard")) return;
    fetch("/api/acct-publisher/" + encodeURIComponent(pubHandle), { credentials: "same-origin", headers: { "Accept": "application/json" } })
      .then(jsonp)
      .then(function (res) {
        if (res.status !== 200 || !res.data || !res.data.profile) return;
        renderPublisher(res.data.profile);
      })
      .catch(function () {});
  }
  function renderPublisher(profile) {
    var c = profile.config || {};
    if ($("acctPubCount")) $("acctPubCount").value = c.postsPerDay || 3;
    if ($("acctPubStart")) $("acctPubStart").value = c.startTime || "09:00";
    if ($("acctPubSpread")) $("acctPubSpread").value = c.spreadMinutes || 240;
    if ($("acctPubJitter")) $("acctPubJitter").value = (c.jitterMinutes == null ? 30 : c.jitterMinutes);
    if ($("acctPubMax")) $("acctPubMax").value = c.maxChars || 280;
    if ($("acctPubLang")) $("acctPubLang").value = c.language === "en" ? "en" : "es";
    if ($("acctPubTopics")) $("acctPubTopics").value = (c.topics || []).join("\n");
    var badge = $("acctPubBadge");
    if (badge) {
      badge.textContent = c.enabled ? "Activo" : "Pausado";
      badge.className = "status-badge" + (c.enabled ? " success" : "");
    }
    var tb = $("acctPubToggle");
    if (tb) tb.innerHTML = c.enabled
      ? '<i class="ph ph-pause"></i> Desactivar publicacion diaria'
      : '<i class="ph ph-power"></i> Activar publicacion diaria';
    var sb = $("acctPubStop");
    if (sb) {
      sb.disabled = !c.enabled;
      sb.style.opacity = c.enabled ? "1" : "0.5";
      sb.style.cursor = c.enabled ? "pointer" : "not-allowed";
    }
    var hist = $("acctPubHistory");
    if (hist) {
      if (c.enabled) {
        var slots = profile.todaySlots || [];
        var times = slots.map(function (iso) {
          var d = new Date(iso);
          return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
        });
        var line = times.length
          ? 'Hoy publica a las: <b>' + times.join(" · ") + '</b> (hora local, con variacion aleatoria).'
          : 'Se calcularan las horas al activar.';
        hist.innerHTML = '<p class="form-hint">' + line + ' Han salido <b>' + ((profile.firedSlots || []).length) + '</b> de ' + (Number(c.postsPerDay) || 3) + ' hoy.</p>';
      } else {
        var last = profile.lastResult;
        hist.innerHTML = last
          ? '<p class="form-hint">Ultimo lote: <b>' + (last.published || 0) + '</b> publicados, <b>' + ((last.failed || []).length) + '</b> fallos.</p>'
          : "";
      }
    }
    var feed = $("acctPubFeed");
    if (feed) {
      var items = profile.history || [];
      feed.innerHTML = items.length ? items.map(function (h) {
        var when = h.at ? new Date(h.at).toLocaleString() : "";
        var ok = h.status === "published";
        return '<div class="x-reference-item"><strong>' + (ok ? "Publicado" : (h.status === "generated" ? "Generado" : "Fallo")) + '</strong>' +
          '<span class="form-hint">' + esc(h.topic ? "Tema: " + h.topic + " · " : "") + when + (h.model ? " · " + esc(h.model) : "") + '</span>' +
          '<span style="white-space:pre-wrap;">' + esc(h.text) + '</span>' +
          (h.error ? '<span class="form-hint" style="color:#f87171;">' + esc(h.error) + '</span>' : '') + '</div>';
      }).join("") : '<p class="form-hint">Aun no ha publicado nada.</p>';
    }
  }
  function savePublisher(extra) {
    if (!pubHandle) { pubMsg("Selecciona una cuenta analizada primero.", true); return Promise.reject(new Error("sin cuenta")); }
    var body = {
      postsPerDay: Number($("acctPubCount") && $("acctPubCount").value) || 3,
      startTime: ($("acctPubStart") && $("acctPubStart").value) || "09:00",
      spreadMinutes: Number($("acctPubSpread") && $("acctPubSpread").value) || 240,
      jitterMinutes: Number($("acctPubJitter") && $("acctPubJitter").value) || 0,
      maxChars: Number($("acctPubMax") && $("acctPubMax").value) || 280,
      language: ($("acctPubLang") && $("acctPubLang").value) || "es",
      topics: ($("acctPubTopics") && $("acctPubTopics").value) || "",
    };
    if (extra) for (var k in extra) body[k] = extra[k];
    return post("/api/acct-publisher/" + encodeURIComponent(pubHandle), body)
      .then(function (d) { if (d.profile) renderPublisher(d.profile); return d; });
  }
  function pubNow(dryRun) {
    savePublisher().then(function () {
      pubMsg(dryRun ? "Generando un post de prueba (sin publicar)..." : "Generando y publicando un post...", false);
      return post("/api/acct-publisher/" + encodeURIComponent(pubHandle) + "/now", { count: 1, dryRun: dryRun });
    }).then(function (d) {
      if (d.profile) renderPublisher(d.profile);
      var r = d.result || {};
      var last = (d.profile && d.profile.history && d.profile.history[0]) || {};
      if (r.failed && r.failed.length) pubMsg("Fallo: " + r.failed[0].error, true);
      else if (dryRun) pubMsg("Generado sin publicar: " + (last.text || ""), false);
      else pubMsg("Publicado en tu cuenta de X: " + (last.text || ""), false);
    }).catch(function (e) { pubMsg(String(e && e.message ? e.message : e), true); });
  }
  function togglePublisher() {
    var active = $("acctPubBadge") && $("acctPubBadge").textContent === "Activo";
    savePublisher({ enabled: !active })
      .then(function (d) {
        var on = d.profile && d.profile.config && d.profile.config.enabled;
        pubMsg(on
          ? "Publicacion diaria ACTIVADA. La IA escribira y publicara sola cada dia a las horas indicadas."
          : "Publicacion diaria en pausa.", false);
      })
      .catch(function (e) { pubMsg(String(e && e.message ? e.message : e), true); });
  }
  function stopPublisher() {
    if (!pubHandle) { pubMsg("Selecciona una cuenta analizada primero.", true); return; }
    if (!window.confirm("Parar la publicacion diaria de @" + pubHandle + "? No se publicara nada mas hoy (podras reactivarla cuando quieras).")) return;
    post("/api/acct-publisher/" + encodeURIComponent(pubHandle) + "/stop", {})
      .then(function (d) {
        if (d.profile) renderPublisher(d.profile);
        pubMsg("Publicacion diaria PARADA. No se publicara nada mas hoy. Pulsa «Activar publicacion diaria» para reanudarla manana.", false);
      })
      .catch(function (e) { pubMsg(String(e && e.message ? e.message : e), true); });
  }
  function useRef() {
    var ub = $("acctUseBtn");
    var handle = ub && ub.getAttribute("data-handle");
    if (!handle) { alert("Selecciona una cuenta de la lista primero."); return; }
    post("/api/x-autopilot/configure", { referenceHandle: handle })
      .then(function () { alert("Ahora X Autopilot usara @" + handle + " como referencia de estilo."); })
      .catch(function (e) { alert(String(e && e.message ? e.message : e)); });
  }
  function delProfile() {
    var ub = $("acctUseBtn");
    var handle = ub && ub.getAttribute("data-handle");
    if (!handle) { alert("Selecciona una cuenta de la lista primero."); return; }
    if (!window.confirm("Borrar el analisis de @" + handle + "?")) return;
    fetch("/api/account-analysis/" + encodeURIComponent(handle), { method: "DELETE", credentials: "same-origin" })
      .then(jsonp).then(function () {
        var manual = $("acctManual"); if (manual) manual.textContent = "Selecciona una cuenta para ver su manual.";
        var body = $("acctDetailBody"); if (body) body.innerHTML = '<p class="form-hint">Selecciona una cuenta de la lista.</p>';
        loadList();
      }).catch(function (e) { alert(String(e && e.message ? e.message : e)); });
  }

  function bind() {
    var lb = $("acctLoginBtn"), sb = $("acctLoginSaveBtn"), cb = $("acctLoginCloseBtn"), ab = $("acctStartBtn"), rb = $("acctRefreshBtn");
    if (lb) lb.addEventListener("click", function () {
      setMessage("Abriendo la ventana de X... (puede tardar unos segundos)");
      post("/api/x-autopilot/login", {})
        .then(function () { setMessage("Ventana abierta. Inicia sesion en ella y pulsa Guardar sesion."); hideBox(); })
        .catch(function (e) { showBox("<b>Error al abrir X:</b> " + String(e && e.message ? e.message : e), true); })
        .then(refresh);
    });
    if (sb) sb.addEventListener("click", function () {
      post("/api/x-autopilot/login/save", {})
        .then(function (d) { setMessage("Sesion guardada" + (d && d.handle ? " (" + d.handle + ")" : "") + ". Ya puedes analizar: la ventana de X se reutilizara."); hideBox(); })
        .catch(function (e) { showBox("<b>Error al guardar la sesion:</b> " + String(e && e.message ? e.message : e), true); })
        .then(refresh);
    });
    if (cb) cb.addEventListener("click", function () { post("/api/x-autopilot/login/close", {}).catch(function () {}).then(refresh); });
    if (ab) ab.addEventListener("click", analyze);
    if (rb) rb.addEventListener("click", function () { loadList(); refresh(); });
    var ub = $("acctUseBtn"), db = $("acctDeleteBtn");
    if (ub) ub.addEventListener("click", useRef);
    if (db) db.addEventListener("click", delProfile);
    var ps = $("acctPubSave"), pt = $("acctPubToggle"), pn = $("acctPubNow"), pp = $("acctPubPreview");
    if (ps) ps.addEventListener("click", function () { savePublisher().then(function () { pubMsg("Ajustes guardados.", false); }).catch(function (e) { pubMsg(String(e && e.message ? e.message : e), true); }); });
    if (pt) pt.addEventListener("click", togglePublisher);
    var st = $("acctPubStop");
    if (st) st.addEventListener("click", stopPublisher);
    if (pn) pn.addEventListener("click", function () { pubNow(false); });
    if (pp) pp.addEventListener("click", function () { pubNow(true); });
    var rl = $("acctReportLoad"), rd = $("acctReportDelete");
    if (rl) rl.addEventListener("click", loadSelectedReport);
    if (rd) rd.addEventListener("click", deleteSelectedReport);
    window.__acctSessionOwned = true;
    window.__acctSessionRefresh = refresh;
    window.__acctSessionLoadList = loadList;
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
