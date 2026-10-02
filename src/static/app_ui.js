(() => {
  "use strict";

  const ns = window.ChDash;
  if (!ns) return;

  const { dom, state, storage, util, api } = ns;

  (() => {
    const mode = storage && typeof storage.getSavedThemeMode === "function" ? storage.getSavedThemeMode() : null;
    if (mode === "dark" || mode === "light") dom.root.dataset.theme = mode;
    else if (mode === "system") delete dom.root.dataset.theme;
  })();

  function safelyParseJson(text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  async function loadMeta() {
    if (!dom.versionBadge) return;
    try {
      const resp = await fetch(api.resolveUrl("api/version"), { cache: "no-store" });
      if (!resp.ok) {
        dom.versionBadge.textContent = "meta: error";
        markFeaturesLoaded();
        return;
      }
      const data = await resp.json();
      const explorer = data && data.features && data.features.explorer ? data.features.explorer : {};
      const explorerGraph = explorer && explorer.graph && typeof explorer.graph === "object" ? explorer.graph : {};
      const lineage = explorerGraph.lineage !== false;
      const storageTopology = explorerGraph.storage_topology !== false;
      state.features.explorer = {
        enabled: explorer.enabled !== false,
        browse: explorer.browse !== false,
        graph: {
          enabled: explorerGraph.enabled !== false && (lineage || storageTopology),
          lineage,
          storage_topology: storageTopology,
        },
        // Server operations view (explorer.operations): the tab is hidden when off.
        operations: {
          enabled: explorer.operations?.enabled !== false,
          keeper: explorer.operations?.keeper === true,
        },
      };
      const traces = data && data.features && data.features.traces ? data.features.traces : {};
      state.features.traces = { enabled: traces.enabled === true };
      const logs = data && data.features && data.features.logs ? data.features.logs : {};
      state.features.logs = { enabled: logs.enabled === true, body_search: String(logs.body_search || "token") };
      const metrics = data && data.features && data.features.metrics ? data.features.metrics : {};
      state.features.metrics = { enabled: metrics.enabled === true };
      // Query library: off (or an older server) keeps the browser library.
      const library = data && data.features && data.features.query_library ? data.features.query_library : {};
      state.features.query_library = {
        enabled: library.enabled === true,
        writable: library.enabled === true && library.writable === true,
        history_store: library.enabled === true && library.history_store === "server" ? "server" : "browser",
      };
      markFeaturesLoaded();
      applyProductFeatures();
      const verObj = data && data.version ? data.version : null;
      const ver = verObj && typeof verObj === "object" ? String(verObj.semver || "dev") : String(data.version || "dev");
      const sha = verObj && typeof verObj === "object" ? String(verObj.git_sha || "") : String(data.git_sha || "");
      const build = verObj && typeof verObj === "object" ? String(verObj.build_time || "") : String(data.build_time || "");
      const text = sha && sha !== "unknown" ? `${ver} (${sha})` : ver;
      dom.versionBadge.textContent = text;
      if (build) dom.versionBadge.title = `Backend version\nBuild: ${build}`;
    } catch {
      dom.versionBadge.textContent = "meta: offline";
    }
    markFeaturesLoaded();
  }

  // The library waits for /api/version to pick its storage; without an answer
  // it stays in the browser.
  function markFeaturesLoaded() {
    if (state.featuresLoaded) return;
    state.featuresLoaded = true;
    window.dispatchEvent(new CustomEvent("chdash:features"));
  }

  // A host's ping in ns.format's duration ("12 ms"), whole milliseconds.
  function formatPingMsLabel(pingMs) {
    const ms = Number(pingMs);
    if (pingMs == null || !Number.isFinite(ms)) return ns.format.EMPTY;
    const rounded = Math.round(ms);
    return rounded < 1 ? "<1 ms" : ns.format.duration.fromMs(rounded);
  }

  // timeZone() of a host (default: the selected one), from the health
  // snapshot (api/hosts): the zone of the DateTime text its system tables
  // print, for ns.format.serverTime. "" until the first version check.
  function serverTimeZone(hostId = state.selectedHostId) {
    const hosts = state.hostsSnapshot && Array.isArray(state.hostsSnapshot.hosts) ? state.hostsSnapshot.hosts : [];
    const host = hostId ? hosts.find((h) => h && String(h.id) === String(hostId)) : null;
    return host && host.clickhouse_timezone ? String(host.clickhouse_timezone) : "";
  }

  // A DateTime text of a host's system tables, for display: browser-local
  // text, the tooltip with the server's zone, ISO for copies.
  function serverTime(value, { hostId, precision } = {}) {
    return ns.format.serverTime(value, { serverTz: serverTimeZone(hostId), precision });
  }

  function pickDefaultHostId(snapshot) {
    const hosts = snapshot && Array.isArray(snapshot.hosts) ? snapshot.hosts : [];
    const ids = hosts.map((h) => String(h.id));
    const stored = storage.getStoredHostId();
    if (stored && ids.includes(String(stored))) return String(stored);
    return ids.length ? ids[0] : null;
  }

  function setSelectedHostId(hostId) {
    state.selectedHostId = hostId ? String(hostId) : null;
    if (state.selectedHostId) storage.setStoredHostId(state.selectedHostId);
    applyHostPickerUi();

    if (ns.meta && state.selectedHostId) {
      if (typeof ns.meta.activateHost === "function") ns.meta.activateHost(state.selectedHostId);
      else if (typeof ns.meta.prepareHost === "function") ns.meta.prepareHost(state.selectedHostId);
      // Host selection is the authoritative point where editor diagnostics can
      // become meaningful. Hydrate the cached catalog immediately and refresh
      // stale catalog types in the background instead of briefly treating an
      // empty metadata object as proof that every reference is unknown.
      if (typeof ns.meta.maybeRefreshOnLoad === "function") ns.meta.maybeRefreshOnLoad();
    }
    if (state.highlightCtrl && typeof state.highlightCtrl.refresh === "function") {
      state.highlightCtrl.refresh();
    }
    if (state.editorSizeCtrl && typeof state.editorSizeCtrl.apply === "function") {
      state.editorSizeCtrl.apply(state.selectedHostId);
    }
    const run = ns.run;
    if (run && typeof run.updateActionButtons === "function") run.updateActionButtons();
    try {
      window.dispatchEvent(new CustomEvent("chdash:host-changed", { detail: { hostId: state.selectedHostId } }));
    } catch (_) {}
  }

  function applyHostPickerUi() {
    const snap = state.hostsSnapshot;
    const apiOnline = state.apiOnline !== false;

    const hosts = snap && Array.isArray(snap.hosts) ? snap.hosts : [];
    const selected = state.selectedHostId ? hosts.find((h) => h && String(h.id) === String(state.selectedHostId)) : null;

    const healthy = !!(selected && selected.healthy);
    const pingMs = selected && selected.ping_ms != null ? Number(selected.ping_ms) : null;
    const label = selected ? String(selected.label || selected.id) : (state.selectedHostId || "Host");
    const hostVersion = selected && selected.clickhouse_version != null ? String(selected.clickhouse_version) : "";

    if (dom.hostPickerText) dom.hostPickerText.textContent = apiOnline ? label : `${label} (API offline)`;
    if (dom.hostPickerVersion) dom.hostPickerVersion.textContent = hostVersion || "";

    if (dom.hostPickerDot) {
      const good = apiOnline && healthy;
      dom.hostPickerDot.classList.toggle("hostDot--good", good);
      dom.hostPickerDot.classList.toggle("hostDot--bad", !good);
    }

    if (dom.hostPickerPing) {
      if (!apiOnline) {
        dom.hostPickerPing.textContent = ns.format.EMPTY;
      } else if (healthy && pingMs != null && Number.isFinite(pingMs)) {
        dom.hostPickerPing.textContent = formatPingMsLabel(pingMs);
      } else {
        dom.hostPickerPing.textContent = healthy ? ns.format.EMPTY : "down";
      }
    }

    if (dom.hostPickerButton) {
      dom.hostPickerButton.disabled = !apiOnline;
      dom.hostPickerButton.title = hostVersion ? `${label}\nClickHouse ${hostVersion}` : label;
      if (!apiOnline) closeHostMenu();
    }
  }


  function closeHostMenu() {
    if (!dom.hostPickerMenu || !dom.hostPickerButton) return;
    dom.hostPickerMenu.hidden = true;
    dom.hostPickerButton.setAttribute("aria-expanded", "false");
  }

  function openHostMenu() {
    if (!dom.hostPickerMenu || !dom.hostPickerButton) return;
    dom.hostPickerMenu.hidden = false;
    dom.hostPickerButton.setAttribute("aria-expanded", "true");
    dom.hostPickerMenu.focus({ preventScroll: true });
  }

  function toggleHostMenu() {
    if (!dom.hostPickerMenu) return;
    if (dom.hostPicker?.classList.contains("is-static")) return;
    if (dom.hostPickerMenu.hidden) openHostMenu();
    else closeHostMenu();
  }

  function hostPickerSignature(snapshot) {
    const hosts = snapshot && Array.isArray(snapshot.hosts) ? snapshot.hosts : [];
    return JSON.stringify({
      selected: state.selectedHostId || "",
      apiOnline: state.apiOnline !== false,
      hosts: hosts
        .filter((h) => h && h.id)
        .map((h) => ({
          id: String(h.id),
          label: String(h.label || h.id),
          healthy: !!h.healthy,
          ping_ms: h.ping_ms == null ? null : Number(h.ping_ms),
          clickhouse_version: h.clickhouse_version == null ? "" : String(h.clickhouse_version),
        })),
    });
  }

  function renderHostPicker(snapshot) {
    if (!dom.hostPickerMenu) return;
    const hosts = snapshot && Array.isArray(snapshot.hosts) ? snapshot.hosts : [];

    if (!state.selectedHostId) {
      setSelectedHostId(pickDefaultHostId(snapshot));
    } else {
      const ids = hosts.map((x) => String(x.id));
      if (!ids.includes(String(state.selectedHostId))) setSelectedHostId(ids.length ? ids[0] : null);
    }

    const signature = hostPickerSignature(snapshot);
    if (state.hostPickerRenderSignature === signature) {
      applyHostPickerUi();
      return;
    }
    state.hostPickerRenderSignature = signature;

    const staticPicker = hosts.length <= 1;

    if (dom.hostPicker) dom.hostPicker.classList.toggle("is-static", staticPicker);

    if (dom.hostPickerButton) {
      dom.hostPickerButton.disabled = false;
      dom.hostPickerButton.setAttribute("aria-disabled", String(staticPicker));
      if (staticPicker) closeHostMenu();
    }

    dom.hostPickerMenu.innerHTML = "";

    for (const h of hosts) {
      if (!h || !h.id) continue;
      const id = String(h.id);
      const isSelected = state.selectedHostId && id === String(state.selectedHostId);
      if (isSelected) continue;

      const label = String(h.label || h.id);
      const healthy = !!h.healthy;
      const pingMs = h.ping_ms != null ? Number(h.ping_ms) : null;

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pickerOption";
      btn.setAttribute("role", "option");
      btn.setAttribute("data-id", id);
      btn.setAttribute("aria-selected", String(!!isSelected));

      const dot = document.createElement("span");
      dot.className = `hostDot ${healthy ? "hostDot--good" : "hostDot--bad"}`;
      dot.setAttribute("aria-hidden", "true");

      const text = document.createElement("span");
      text.className = "pickerOption__label";
      text.textContent = label;

      const version = document.createElement("span");
      version.className = "pickerOption__version";
      version.textContent = h.clickhouse_version != null ? String(h.clickhouse_version) : "";

      const meta = document.createElement("span");
      meta.className = "pickerOption__meta";
      meta.textContent = healthy && pingMs != null && Number.isFinite(pingMs) ? formatPingMsLabel(pingMs) : (healthy ? ns.format.EMPTY : "down");

      btn.appendChild(dot);
      btn.appendChild(text);
      btn.appendChild(version);
      btn.appendChild(meta);

      btn.addEventListener("click", () => {
        if (!isSelected) setSelectedHostId(id);
        renderHostPicker(state.hostsSnapshot || snapshot);
        closeHostMenu();
      });

      dom.hostPickerMenu.appendChild(btn);
    }

    applyHostPickerUi();
  }

  function setApiOnline(online) {
    const next = online !== false;
    if (state.apiOnline === next) return;
    state.apiOnline = next;
    applyHostPickerUi();
    const run = ns.run;
    if (run && typeof run.updateActionButtons === "function") run.updateActionButtons();
  }

  function startHostsSse() {
    if (!dom.hostPicker) return;

    const pollMs = 5000;
    let es = null;
    let pollTimer = 0;
    let reconnectTimer = 0;
    let hasSnapshot = false;
    let booting = false;

    const useSnapshot = (snap) => {
      if (!snap || !Array.isArray(snap.hosts)) return;
      hasSnapshot = true;
      state.hostsSnapshot = snap;
      renderHostPicker(snap);
      setApiOnline(true);
      const run = ns.run;
      if (run && typeof run.updateActionButtons === "function") run.updateActionButtons();
    };

    const closeStream = () => {
      if (!es) return;
      try {
        es.close();
      } catch {
        return;
      } finally {
        es = null;
      }
    };

    const stopPoll = () => {
      if (!pollTimer) return;
      clearTimeout(pollTimer);
      pollTimer = 0;
    };

    const stopReconnect = () => {
      if (!reconnectTimer) return;
      clearTimeout(reconnectTimer);
      reconnectTimer = 0;
    };

    const fetchHostsOnce = async () => {
      try {
        const r = await fetch(api.resolveUrl("api/hosts"), { cache: "no-store" });
        if (!r.ok) return false;
        const data = await r.json();
        useSnapshot(data);
        return true;
      } catch {
        return false;
      }
    };

    const schedulePoll = () => {
      if (document.hidden || pollTimer) return;
      pollTimer = setTimeout(async () => {
        pollTimer = 0;
        const ok = await fetchHostsOnce();
        if (!ok) setApiOnline(false);
        if (ok) ensureStream();
        if (!es) schedulePoll();
      }, pollMs);
    };

    const scheduleReconnect = () => {
      if (document.hidden || reconnectTimer || !hasSnapshot || es) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = 0;
        ensureStream();
      }, pollMs);
    };

    const ensureStream = () => {
      if (document.hidden || es || !hasSnapshot) return;
      stopReconnect();

      let next = null;
      try {
        next = new EventSource(api.resolveUrl("api/hosts/stream"));
      } catch {
        schedulePoll();
        scheduleReconnect();
        return;
      }

      es = next;

      es.addEventListener("hosts", (ev) => {
        const data = safelyParseJson(ev.data);
        if (!data) return;
        useSnapshot(data);
      });

      es.onopen = () => {
        setApiOnline(true);
        stopPoll();
      };

      es.onerror = () => {
        closeStream();
        schedulePoll();
        scheduleReconnect();
      };
    };

    const boot = async () => {
      if (document.hidden || booting) return;
      booting = true;
      try {
        const ok = await fetchHostsOnce();
        if (!ok) {
          setApiOnline(false);
          schedulePoll();
          return;
        }
        ensureStream();
      } finally {
        booting = false;
      }
    };

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        closeStream();
        stopPoll();
        stopReconnect();
        return;
      }
      boot();
    });

    boot();
  }


  function getResolvedTheme(mode) {
    if (mode === "dark" || mode === "light") return mode;
    try {
      const mql = window.matchMedia("(prefers-color-scheme: dark)");
      return mql && mql.matches ? "dark" : "light";
    } catch {
      return "dark";
    }
  }

  // The page switcher (Query, Explorer, Observability) ships visible in every
  // page shell. Only a server with neither Explorer nor any Observability view
  // (Traces, Logs, Metrics) hides it; the head script of each page applies the
  // last known availability (chdash-page-select-hidden) before first paint.
  function applyPageNavigation(nav) {
    const explorerEnabled = nav.explorer !== false;
    const observabilityEnabled = nav.traces === true || nav.logs === true || nav.metrics === true;
    const hidden = !explorerEnabled && !observabilityEnabled;
    dom.root?.classList.toggle("chdash-page-select-hidden", hidden);
    if (dom.pageSelect) dom.pageSelect.hidden = hidden;
    if (dom.navExplorerButton) dom.navExplorerButton.hidden = !explorerEnabled;
    if (dom.navObservabilityButton) dom.navObservabilityButton.hidden = !observabilityEnabled;
  }

  function applyProductFeatures() {
    const f = state.features?.explorer || {};
    const explorerEnabled = f.enabled !== false;
    const tracesEnabled = state.features?.traces?.enabled === true;
    const logsEnabled = state.features?.logs?.enabled === true;
    const metricsEnabled = state.features?.metrics?.enabled === true;
    applyPageNavigation({ explorer: explorerEnabled, traces: tracesEnabled, logs: logsEnabled, metrics: metricsEnabled });
    storage?.savePageNav?.({ explorer: explorerEnabled, traces: tracesEnabled, logs: logsEnabled, metrics: metricsEnabled });
    if (!explorerEnabled && /\/explorer(?:\/|$)/.test(window.location.pathname)) {
      const next = api.resolveUrl("query");
      window.history.replaceState({ workspace: "query" }, "", next);
      if (ns.explorer && typeof ns.explorer.setWorkspace === "function") ns.explorer.setWorkspace("query", { historyMode: "none" });
    }
    // A turned-off view falls back to another (app_observability.js); with no
    // view left the page itself is gone.
    if (!tracesEnabled && !logsEnabled && !metricsEnabled && document.body?.dataset?.page === "observability") {
      window.location.replace(api.resolveUrl("query"));
      return;
    }
    window.dispatchEvent(new CustomEvent("chdash:features-changed", { detail: { explorer: f, traces: state.features?.traces || {}, logs: state.features?.logs || {}, metrics: state.features?.metrics || {} } }));
  }

  function setPageSelectorValue(value) {
    const labels = { query: "Query", explorer: "Explorer", observability: "Observability" };
    const page = Object.prototype.hasOwnProperty.call(labels, value) ? value : "query";
    if (dom.pageSelectButton) dom.pageSelectButton.textContent = labels[page];
    if (dom.pageSelectMenu) {
      for (const b of dom.pageSelectMenu.querySelectorAll(".themeSelect__option[data-value]")) {
        b.setAttribute("aria-selected", String(b.getAttribute("data-value") === page));
      }
    }
  }

  function isPageMenuOpen() { return !!(dom.pageSelect && dom.pageSelect.classList.contains("themeSelect--open")); }
  function openPageMenu() {
    if (!dom.pageSelect || !dom.pageSelectMenu || !dom.pageSelectButton || dom.pageSelect.hidden) return;
    dom.pageSelectMenu.hidden = false;
    dom.pageSelectButton.setAttribute("aria-expanded", "true");
    dom.pageSelect.classList.remove("themeSelect--closing");
    requestAnimationFrame(() => dom.pageSelect.classList.add("themeSelect--open"));
    dom.pageSelectMenu.focus({ preventScroll: true });
  }
  function closePageMenu({ immediate = false } = {}) {
    if (!dom.pageSelect || !dom.pageSelectMenu || !dom.pageSelectButton) return;
    dom.pageSelectButton.setAttribute("aria-expanded", "false");
    dom.pageSelect.classList.remove("themeSelect--open");
    if (immediate) { dom.pageSelect.classList.remove("themeSelect--closing"); dom.pageSelectMenu.hidden = true; return; }
    dom.pageSelect.classList.add("themeSelect--closing");
    setTimeout(() => { if (!isPageMenuOpen()) dom.pageSelectMenu.hidden = true; dom.pageSelect.classList.remove("themeSelect--closing"); }, 160);
  }
  function togglePageMenu() { if (isPageMenuOpen()) closePageMenu(); else openPageMenu(); }

  function isRunSettingsOpen() { return !!(dom.runSettings && dom.runSettings.classList.contains("themeSelect--open")); }
  function openRunSettings() {
    closeRunMenu({ immediate: true });
    if (!dom.runSettings || !dom.runSettingsMenu || !dom.runSettingsButton) return;
    dom.runSettingsMenu.hidden = false;
    dom.runSettingsButton.setAttribute("aria-expanded", "true");
    dom.runSettings.classList.remove("themeSelect--closing");
    requestAnimationFrame(() => dom.runSettings.classList.add("themeSelect--open"));
    dom.runSettingsMenu.focus({ preventScroll: true });
  }
  function closeRunSettings({ immediate = false } = {}) {
    if (!dom.runSettings || !dom.runSettingsMenu || !dom.runSettingsButton) return;
    dom.runSettingsButton.setAttribute("aria-expanded", "false");
    dom.runSettings.classList.remove("themeSelect--open");
    if (immediate) { dom.runSettings.classList.remove("themeSelect--closing"); dom.runSettingsMenu.hidden = true; return; }
    dom.runSettings.classList.add("themeSelect--closing");
    setTimeout(() => { if (!isRunSettingsOpen()) dom.runSettingsMenu.hidden = true; dom.runSettings.classList.remove("themeSelect--closing"); }, 160);
  }
  function toggleRunSettings() { if (isRunSettingsOpen()) closeRunSettings(); else openRunSettings(); }

  function applyTheme(mode) {
    const resolved = getResolvedTheme(mode);
    if (mode === "system") delete dom.root.dataset.theme;
    else dom.root.dataset.theme = resolved;
    // Drives the theme button icon from CSS (see style.css), like the head
    // script does before the first paint.
    dom.root.dataset.themeMode = mode;

    if (dom.themeSelectText) dom.themeSelectText.className = `themeIcon themeIcon--${mode}`;
    if (dom.themeSelectButton) dom.themeSelectButton.setAttribute("aria-label", `Theme: ${mode}`);

    if (dom.themeSelectMenu) {
      const btns = dom.themeSelectMenu.querySelectorAll(".themeSelect__option[data-value]");
      for (const b of btns) {
        const m = b.getAttribute("data-value");
        b.setAttribute("aria-selected", String(m === mode));
      }
    }

    // Canvas pixels are not CSS-reactive. Keep Explorer's graph in the same
    // visual transaction as the DOM theme switch instead of waiting for its
    // next animation/activity frame.
    ns.explorerGraph?.redrawThemeNow?.();
  }

  function isThemeMenuOpen() {
    return !!(dom.themeSelect && dom.themeSelect.classList.contains("themeSelect--open"));
  }

  function openThemeMenu() {
    if (!dom.themeSelectMenu || !dom.themeSelect || !dom.themeSelectButton) return;
    dom.themeSelectMenu.hidden = false;
    dom.themeSelectButton.setAttribute("aria-expanded", "true");
    dom.themeSelect.classList.remove("themeSelect--closing");
    requestAnimationFrame(() => {
      dom.themeSelect.classList.add("themeSelect--open");
    });
    dom.themeSelectMenu.focus({ preventScroll: true });
  }

  function closeThemeMenu({ immediate = false } = {}) {
    if (!dom.themeSelectMenu || !dom.themeSelect || !dom.themeSelectButton) return;
    dom.themeSelectButton.setAttribute("aria-expanded", "false");
    dom.themeSelect.classList.remove("themeSelect--open");
    if (immediate) {
      dom.themeSelect.classList.remove("themeSelect--closing");
      dom.themeSelectMenu.hidden = true;
      return;
    }
    dom.themeSelect.classList.add("themeSelect--closing");
    setTimeout(() => {
      if (!isThemeMenuOpen()) dom.themeSelectMenu.hidden = true;
      dom.themeSelect.classList.remove("themeSelect--closing");
    }, 160);
  }

  function toggleThemeMenu() {
    if (!dom.themeSelectMenu) return;
    if (isThemeMenuOpen()) closeThemeMenu();
    else openThemeMenu();
  }

  function isCopyMenuOpen() {
    return !!(dom.copySplit && dom.copySplit.classList.contains("is-open"));
  }

  function openCopyMenu() {
    if (!dom.copyMenu || !dom.copyMenuButton || !dom.copySplit) return;
    dom.copyMenu.hidden = false;
    dom.copyMenuButton.setAttribute("aria-expanded", "true");
    requestAnimationFrame(() => {
      dom.copySplit.classList.add("is-open");
    });
    dom.copyMenu.focus({ preventScroll: true });
  }

  function closeCopyMenu({ immediate = false } = {}) {
    if (!dom.copyMenu || !dom.copyMenuButton || !dom.copySplit) return;
    dom.copyMenuButton.setAttribute("aria-expanded", "false");
    dom.copySplit.classList.remove("is-open");
    if (immediate) {
      dom.copyMenu.hidden = true;
      return;
    }
    setTimeout(() => {
      if (!isCopyMenuOpen()) dom.copyMenu.hidden = true;
    }, 160);
  }

  function toggleCopyMenu() {
    if (!dom.copyMenu) return;
    if (dom.copyMenu.hidden) openCopyMenu();
    else closeCopyMenu();
  }

  function openRunMenu() {
    closeRunSettings({ immediate: true });
    if (!dom.runMenu || !dom.runMenuButton || !dom.runSplit) return;
    dom.runMenu.hidden = false;
    dom.runMenuButton.setAttribute("aria-expanded", "true");
    requestAnimationFrame(() => {
      dom.runSplit.classList.add("is-open");
    });
    dom.runMenu.focus({ preventScroll: true });
  }

  function closeRunMenu({ immediate = false } = {}) {
    if (!dom.runMenu || !dom.runMenuButton || !dom.runSplit) return;
    dom.runMenuButton.setAttribute("aria-expanded", "false");
    dom.runSplit.classList.remove("is-open");
    if (immediate) {
      dom.runMenu.hidden = true;
      return;
    }
    setTimeout(() => {
      if (!dom.runSplit.classList.contains("is-open")) dom.runMenu.hidden = true;
    }, 160);
  }

  function toggleRunMenu() {
    if (!dom.runMenu) return;
    if (dom.runMenu.hidden) openRunMenu();
    else closeRunMenu();
  }

  function applyRunOptionsUi() {
    if (dom.runOptAutoFormat) {
      dom.runOptAutoFormat.setAttribute("aria-checked", String(!!state.runOptAutoFormat));
    }
    if (dom.runOptMultiQuery) {
      dom.runOptMultiQuery.setAttribute("aria-checked", String(!!state.runOptMultiQuery));
    }
    if (dom.runOptExecutionStats) {
      dom.runOptExecutionStats.setAttribute("aria-checked", String(!!state.runOptExecutionStats));
    }
    if (dom.runOptFlattenTuple) {
      dom.runOptFlattenTuple.setAttribute("aria-checked", String(state.runOptFlattenTuple !== false));
    }
  }

  function toggleRunOption(key) {
    if (key === "autoFormat") state.runOptAutoFormat = !state.runOptAutoFormat;
    if (key === "multiQuery") state.runOptMultiQuery = !state.runOptMultiQuery;
    if (key === "executionStats") {
      state.runOptExecutionStats = !state.runOptExecutionStats;
      if (!state.runOptExecutionStats && dom.clickhouseElapsedWrap) dom.clickhouseElapsedWrap.hidden = true;
    }
    if (key === "flattenTuple") {
      state.runOptFlattenTuple = !state.runOptFlattenTuple;
      window.dispatchEvent(new CustomEvent("chdash:flatten-tuple-change", { detail: { enabled: state.runOptFlattenTuple } }));
    }
    storage.saveRunOptions({
      autoFormat: state.runOptAutoFormat,
      multiQuery: state.runOptMultiQuery,
      executionStats: state.runOptExecutionStats,
      flattenTuple: state.runOptFlattenTuple,
    });
    applyRunOptionsUi();
  }

  // Sets one Run settings option (the Library "Add as a new statement" turns
  // multiquery on); a no-op when it already has that value.
  function setRunOption(key, enabled) {
    const current = {
      autoFormat: state.runOptAutoFormat,
      multiQuery: state.runOptMultiQuery,
      executionStats: state.runOptExecutionStats,
      flattenTuple: state.runOptFlattenTuple !== false,
    }[key];
    if (current === undefined || !!current === !!enabled) return;
    toggleRunOption(key);
  }

  // --- Query library dialog ----------------------------------------------------
  // The toolbar book button opens the library in the shared modal dialog
  // (app_ui_dialog.js: the shell, size, backdrop and focus handling of the
  // profiling dialog), with two tabs: Saved (folders and saved queries) and
  // History. The dialog is built the first time it opens; app_query_library.js
  // renders both views and is loaded then (or when Ctrl+S is used): a page
  // that never opens it costs no module and no dialog.
  const QUERY_LIBRARY_PREFS_KEY = "chdash.queryLibraryMenu.v1";
  const QUERY_LIBRARY_SCRIPT = "app_query_library.js";
  const scriptBase = (() => {
    const script = document.currentScript;
    if (script && script.src) return script.src.replace(/[^/]*$/, "");
    if (typeof window.__chdashUrl === "function") return new URL(window.__chdashUrl("static/"), window.location.href).toString();
    return new URL("./static/", window.location.href).toString();
  })();
  let queryLibraryPromise = null;
  let queryLibraryTab = "saved";
  let queryLibraryDialog = null;

  function readQueryLibraryPrefs() {
    try {
      const value = JSON.parse(localStorage.getItem(QUERY_LIBRARY_PREFS_KEY) || "null");
      return value && typeof value === "object" ? value : {};
    } catch {
      return {};
    }
  }

  function writeQueryLibraryPrefs(patch) {
    try {
      localStorage.setItem(QUERY_LIBRARY_PREFS_KEY, JSON.stringify({ ...readQueryLibraryPrefs(), ...patch }));
    } catch {
      return;
    }
  }

  function isPhoneLayout() {
    try {
      return window.matchMedia("(max-width: 760px)").matches;
    } catch {
      return false;
    }
  }

  function modifierKeyLabel() {
    const platform = String(navigator.userAgentData?.platform || navigator.platform || "");
    return /mac|iphone|ipad/i.test(platform) ? "\u2318" : "Ctrl";
  }

  function loadQueryLibrary() {
    if (ns.queryLibrary) return Promise.resolve(ns.queryLibrary);
    if (!queryLibraryPromise) {
      queryLibraryPromise = new Promise((resolve, reject) => {
        const el = document.createElement("script");
        el.src = new URL(QUERY_LIBRARY_SCRIPT, scriptBase).toString();
        el.onload = () => (ns.queryLibrary ? resolve(ns.queryLibrary) : reject(new Error(`${QUERY_LIBRARY_SCRIPT} did not register`)));
        el.onerror = () => {
          queryLibraryPromise = null;
          reject(new Error(`Failed to load ${QUERY_LIBRARY_SCRIPT}`));
        };
        document.head.appendChild(el);
      });
    }
    return queryLibraryPromise;
  }

  function withQueryLibrary(fn) {
    return loadQueryLibrary().then(fn).catch((err) => {
      console.error(err);
      for (const view of [dom.queryLibraryViewSaved, dom.queryLibraryViewHistory]) {
        if (view && !view.dataset.rendered) view.innerHTML = '<div class="qlEmpty qlEmpty--error">The query library could not be loaded.</div>';
      }
    });
  }

  function isQueryLibraryOpen() {
    return !!queryLibraryDialog?.isOpen();
  }

  function setQueryLibraryTab(tab, { focus = false } = {}) {
    const next = tab === "history" ? "history" : "saved";
    queryLibraryTab = next;
    const pairs = [["saved", dom.queryLibraryTabSaved, dom.queryLibraryViewSaved], ["history", dom.queryLibraryTabHistory, dom.queryLibraryViewHistory]];
    for (const [name, tabEl, viewEl] of pairs) {
      const on = name === next;
      tabEl?.setAttribute("aria-selected", String(on));
      if (tabEl) tabEl.tabIndex = on ? 0 : -1;
      if (viewEl) viewEl.hidden = !on;
    }
    writeQueryLibraryPrefs({ tab: next });
    if (!isQueryLibraryOpen()) return;
    withQueryLibrary((lib) => {
      lib.show(next);
      if (focus) lib.focus(next);
    });
  }

  // The dialog (title, Saved / History tabs in the profiling tab style and
  // the two views) is built the first time it opens: an idle page carries
  // none of it.
  function buildQueryLibraryDialog() {
    if (queryLibraryDialog || !ns.dialog || !dom.queryLibraryButton) return queryLibraryDialog;
    const parts = ns.dialog.shell({
      id: "queryLibraryMenu",
      title: "Query library",
      titleId: "queryLibraryTitle",
      subtitleId: "queryLibrarySummary",
      closeLabel: "Close the query library",
      size: "lg",
      className: "queryLibraryDialog",
      tabs: {
        label: "Query library",
        items: [
          { id: "queryLibraryTabSaved", label: "Saved", controls: "queryLibraryViewSaved", value: "saved" },
          { id: "queryLibraryTabHistory", label: "History", controls: "queryLibraryViewHistory", value: "history" },
        ],
      },
    });
    parts.close.id = "queryLibraryClose";
    // The two views; app_query_library.js adds the preview pane beside them.
    parts.body.classList.add("queryLibraryDialog__body");
    parts.body.innerHTML = `
      <div id="queryLibraryViewSaved" class="queryLibraryDialog__view" role="tabpanel" aria-labelledby="queryLibraryTabSaved"><div class="qlEmpty">Loading the library\u2026</div></div>
      <div id="queryLibraryViewHistory" class="queryLibraryDialog__view" role="tabpanel" aria-labelledby="queryLibraryTabHistory" hidden><div class="qlEmpty">Loading the history\u2026</div></div>`;
    for (const id of ["queryLibraryMenu", "queryLibraryClose", "queryLibraryTabSaved", "queryLibraryTabHistory", "queryLibraryViewSaved", "queryLibraryViewHistory"]) {
      dom[id] = document.getElementById(id);
    }
    dom.queryLibrarySummary = parts.subtitle;
    dom.queryLibraryButton.setAttribute("aria-controls", "queryLibraryMenu");
    queryLibraryDialog = ns.dialog.bind(parts.dialog, {
      closeButton: parts.close,
      fallbackFocus: () => dom.queryLibraryButton,
      onClose() {
        dom.queryLibrary?.classList.remove("is-open");
        dom.queryLibraryButton?.setAttribute("aria-expanded", "false");
        ns.queryLibrary?.hidden?.();
      },
    });
    const tabButtons = [dom.queryLibraryTabSaved, dom.queryLibraryTabHistory].filter(Boolean);
    for (const tab of tabButtons) {
      tab.addEventListener("click", () => setQueryLibraryTab(tab.dataset.tab));
      tab.addEventListener("keydown", (ev) => {
        const step = { ArrowRight: 1, ArrowLeft: -1 }[ev.key];
        if (!step && ev.key !== "Home" && ev.key !== "End") return;
        ev.preventDefault();
        const index = tabButtons.indexOf(tab);
        const next = ev.key === "Home" ? tabButtons[0] : ev.key === "End" ? tabButtons[tabButtons.length - 1] : tabButtons[(index + step + tabButtons.length) % tabButtons.length];
        setQueryLibraryTab(next.dataset.tab);
        next.focus();
      });
    }
    return queryLibraryDialog;
  }

  function openQueryLibrary(tab = queryLibraryTab, { focus = true } = {}) {
    const libraryDialog = buildQueryLibraryDialog();
    if (!libraryDialog) return Promise.resolve(null);
    closeRunMenu({ immediate: true });
    closeRunSettings({ immediate: true });
    closeCopyMenu({ immediate: true });
    // The focus moves into the dialog at once (the views render when the
    // module is in) and comes back to the book button when it closes.
    if (!libraryDialog.isOpen()) libraryDialog.open({ returnFocus: dom.queryLibraryButton });
    dom.queryLibrary?.classList.add("is-open");
    dom.queryLibraryButton.setAttribute("aria-expanded", "true");
    setQueryLibraryTab(tab);
    const panel = dom.queryLibraryMenu;
    return withQueryLibrary(async (lib) => {
      if (!isQueryLibraryOpen()) return lib;
      await lib.show(queryLibraryTab);
      if (focus && isQueryLibraryOpen() && document.activeElement === panel) await lib.focus(queryLibraryTab);
      return lib;
    });
  }

  // restoreFocus: false when the caller moves the focus (a query opened in
  // the editor).
  function closeQueryLibrary({ restoreFocus = true } = {}) {
    queryLibraryDialog?.close(null, { restoreFocus });
  }

  function toggleQueryLibrary() {
    if (isQueryLibraryOpen()) closeQueryLibrary();
    else openQueryLibrary();
  }

  function saveCurrentQuery() {
    withQueryLibrary((lib) => lib.saveCurrent());
  }

  // URL state of the Query page: ?saved=<id> while the editor holds a library
  // query as saved, else ?sql=<text> of the last run (up to 4,000 characters),
  // so the address bar is a link to the query. Read once at startup.
  const QUERY_URL_MAX_SQL = 4000;

  function syncQueryUrl(sqlText) {
    if (document.body?.dataset.page !== "query" || !window.history?.replaceState) return;
    const params = new URLSearchParams(window.location.search || "");
    params.delete("sql");
    params.delete("saved");
    const text = String(sqlText ?? dom.queryTextArea?.value ?? "").trim();
    const savedId = ns.queryLibrary?.openedId?.(text) || "";
    if (savedId) params.set("saved", savedId);
    else if (text && text.length <= QUERY_URL_MAX_SQL) params.set("sql", text);
    const qs = params.toString();
    const next = `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash || ""}`;
    if (next !== `${window.location.pathname}${window.location.search}${window.location.hash || ""}`) {
      window.history.replaceState(window.history.state, "", next);
    }
  }

  // A link fills an empty editor; a reload keeps the tab's own draft.
  function applyQueryUrl() {
    if (document.body?.dataset.page !== "query" || !dom.queryTextArea) return;
    if (String(dom.queryTextArea.value || "").trim()) return;
    const params = new URLSearchParams(window.location.search || "");
    const sqlText = params.get("sql");
    const savedId = params.get("saved");
    if (savedId) {
      withQueryLibrary((lib) => lib.openSaved(savedId));
    } else if (sqlText && sqlText.trim()) {
      util.replaceTextAreaValue(dom.queryTextArea, sqlText);
    }
  }

  function initQueryLibrary() {
    const mod = modifierKeyLabel();
    if (mod !== "Ctrl") {
      for (const kbd of document.querySelectorAll(".queryKbd--mod")) kbd.textContent = mod;
    }
    // The shortcut is told by the Run button's tooltip (no hint beside it).
    if (dom.runButton) dom.runButton.title = `Run (${mod}+Enter)`;
    if (!dom.queryLibraryButton) return;
    queryLibraryTab = readQueryLibraryPrefs().tab === "history" ? "history" : "saved";

    dom.queryLibraryButton.addEventListener("click", toggleQueryLibrary);

    // Escape and a click on the backdrop close the dialog (app_ui_dialog.js).
    document.addEventListener("keydown", (ev) => {
      if (ev.defaultPrevented || ev.isComposing) return;
      const key = String(ev.key || "").toLowerCase();
      if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && !ev.shiftKey && key === "s") {
        // Never the browser's "Save page". Over the library the save prompt
        // stacks on it; over another dialog (a prompt, profiling) it waits.
        ev.preventDefault();
        const top = ns.dialog?.host?.();
        if (top && top !== document.body && top !== dom.queryLibraryMenu) return;
        saveCurrentQuery();
      }
    });
    // A finished run is a new History entry.
    window.addEventListener("chdash:query-history", () => {
      if (ns.queryLibrary) ns.queryLibrary.historyChanged();
    });
  }

  function initEditorCopyButton() {
    if (!dom.editorCopyButton || !dom.queryTextArea) return;

    let copyTimer = 0;

    const sync = () => {
      dom.editorCopyButton.disabled = !String(dom.queryTextArea.value || "").trim();
    };

    dom.editorCopyButton.addEventListener("click", async () => {
      const text = String(dom.queryTextArea.value || "");
      if (!text.trim()) return;
      try {
        await util.copyTextToClipboard(text);
        dom.editorCopyButton.classList.add("is-copied");
        if (copyTimer) clearTimeout(copyTimer);
        copyTimer = window.setTimeout(() => {
          dom.editorCopyButton.classList.remove("is-copied");
          copyTimer = 0;
        }, 1200);
      } catch {
        null;
      }
    });

    sync();
    dom.queryTextArea.addEventListener("input", sync);
  }

  function initEditor() {
    if (!dom.queryTextArea) return;

    const editorDraftKey = "chdash.editor.draft.v2";

    const loadEditorDraft = () => {
      try {
        return sessionStorage.getItem(editorDraftKey);
      } catch {
        return null;
      }
    };

    const saveEditorDraft = (text) => {
      try {
        sessionStorage.setItem(editorDraftKey, String(text || ""));
      } catch {
        null;
      }
    };

    const dispatchInputEvent = (el) => {
      if (!el || typeof el.dispatchEvent !== "function") return;
      try {
        el.dispatchEvent(new Event("input", { bubbles: true }));
      } catch {
        try {
          el.dispatchEvent(new Event("input"));
        } catch {
          null;
        }
      }
    };

    const current = String(dom.queryTextArea.value || "");
    if (!current.trim()) {
      const saved = String(loadEditorDraft() || "");
      if (saved.trim()) {
        if (util && typeof util.replaceTextAreaValue === "function") {
          util.replaceTextAreaValue(dom.queryTextArea, saved);
        } else {
          dom.queryTextArea.value = saved;
        }
        requestAnimationFrame(() => {
          const ctrl = ns.state && ns.state.highlightCtrl;
          if (ctrl && typeof ctrl.refresh === "function") ctrl.refresh();
        });
      }
    }

    let draftSaveTimer = 0;
    dom.queryTextArea.addEventListener("input", () => {
      if (draftSaveTimer) clearTimeout(draftSaveTimer);
      draftSaveTimer = setTimeout(() => {
        draftSaveTimer = 0;
        saveEditorDraft(dom.queryTextArea.value);
      }, 200);
    });

    const replaceSelectionText = (ta, nextText) => {
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      try {
        const before = String(ta.value || "");
        ta.focus();
        ta.setSelectionRange(start, end);
        const ok = document.execCommand && document.execCommand("insertText", false, nextText);
        if (ok || String(ta.value || "") !== before) return { start, end };
      } catch {
        null;
      }
      try {
        ta.setRangeText(nextText, start, end, "end");
        dispatchInputEvent(ta);
        return { start, end };
      } catch {
        null;
      }
      const value = String(ta.value || "");
      ta.value = value.slice(0, start) + nextText + value.slice(end);
      const pos = start + nextText.length;
      ta.selectionStart = pos;
      ta.selectionEnd = pos;
      dispatchInputEvent(ta);
      return { start, end };
    };

    // Tab indents inside the editor; Escape then Tab leaves it (keyboard users
    // are never trapped). Escape that closed the autocomplete does not count.
    let tabReleased = false;
    dom.queryTextArea.addEventListener("keydown", (e) => {
      const key = e.key;
      if (e.isComposing) return;
      if (key === "Escape") {
        tabReleased = !e.defaultPrevented;
        return;
      }
      if (key === "Tab" && tabReleased && !e.defaultPrevented) {
        tabReleased = false;
        return;
      }
      if (key !== "Shift") tabReleased = false;
      if ((e.ctrlKey || e.metaKey) && key === "Enter") {
        e.preventDefault();
        const run = ns.run;
        if (run && typeof run.handleRun === "function") run.handleRun();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (key === "`" || key === "\"" || key === "'") {
        const ta = dom.queryTextArea;
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        if (start == null || end == null || start === end) return;
        e.preventDefault();
        const value = String(ta.value || "");
        const selected = value.slice(start, end);
        replaceSelectionText(ta, key + selected + key);
        ta.selectionStart = start + 1;
        ta.selectionEnd = end + 1;
        return;
      }

      if (key === "Enter") {
        const ta = dom.queryTextArea;
        const start = ta.selectionStart;
        if (start == null) return;
        const value = String(ta.value || "");
        const lineStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
        let i = lineStart;
        while (i < value.length) {
          const c = value[i];
          if (c !== " " && c !== "\t") break;
          i++;
        }
        const indent = value.slice(lineStart, i);
        e.preventDefault();
        const inserted = "\n" + indent;
        const prev = replaceSelectionText(ta, inserted);
        const pos = prev.start + inserted.length;
        ta.selectionStart = pos;
        ta.selectionEnd = pos;
        return;
      }

      if (key !== "Tab") return;

      const ta = dom.queryTextArea;
      const value = String(ta.value || "");
      const start = ta.selectionStart;
      const end = ta.selectionEnd;

      e.preventDefault();

      const lineStartIndex = (text, idx) => {
        const i = text.lastIndexOf("\n", idx - 1);
        return i === -1 ? 0 : i + 1;
      };

      const lineEndIndex = (text, idx) => {
        const i = text.indexOf("\n", idx);
        return i === -1 ? text.length : i;
      };

      const outdentLine = (line) => {
        if (line.startsWith("\t")) return { line: line.slice(1), removed: 1 };
        if (line.startsWith("    ")) return { line: line.slice(4), removed: 4 };
        if (line.startsWith("  ")) return { line: line.slice(2), removed: 2 };
        if (line.startsWith(" ")) return { line: line.slice(1), removed: 1 };
        return { line, removed: 0 };
      };

      if (start === end) {
        if (!e.shiftKey) {
          replaceSelectionText(ta, "\t");
          return;
        }

        const ls = lineStartIndex(value, start);
        const le = lineEndIndex(value, start);
        const line = value.slice(ls, le);
        const rel = start - ls;
        const prefix = line.slice(0, rel);
        if (!/^[\t ]*$/.test(prefix)) return;

        const od = outdentLine(line);
        if (od.removed === 0) return;
        ta.selectionStart = ls;
        ta.selectionEnd = le;
        replaceSelectionText(ta, od.line);
        const nextPos = Math.max(ls, start - od.removed);
        ta.selectionStart = nextPos;
        ta.selectionEnd = nextPos;
        return;
      }

      let endAdj = end;
      if (endAdj > start && value[endAdj - 1] === "\n") endAdj -= 1;

      const blockStart = lineStartIndex(value, start);
      const blockEnd = lineEndIndex(value, endAdj);
      const block = value.slice(blockStart, blockEnd);
      const oldLines = block.split("\n");

      const deltas = [];
      const newLines = [];

      for (const ln of oldLines) {
        if (e.shiftKey) {
          const od = outdentLine(ln);
          newLines.push(od.line);
          deltas.push(-od.removed);
        } else {
          newLines.push("\t" + ln);
          deltas.push(1);
        }
      }

      const newBlock = newLines.join("\n");

      const lineStarts = [];
      let acc = 0;
      for (let i = 0; i < oldLines.length; i++) {
        lineStarts.push(acc);
        acc += oldLines[i].length + 1;
      }

      const shiftFor = (posRel, includeEquals) => {
        let shift = 0;
        for (let i = 0; i < lineStarts.length; i++) {
          const ls = lineStarts[i];
          if (includeEquals ? posRel >= ls : posRel > ls) shift += deltas[i];
        }
        return shift;
      };

      const startRel = start - blockStart;
      const endRel = end - blockStart;
      const includeEquals = !e.shiftKey;
      const newStart = start + shiftFor(startRel, includeEquals);
      const newEnd = end + shiftFor(endRel, includeEquals);

      ta.selectionStart = blockStart;
      ta.selectionEnd = blockEnd;
      replaceSelectionText(ta, newBlock);
      ta.selectionStart = Math.max(blockStart, newStart);
      ta.selectionEnd = Math.max(blockStart, newEnd);
    });

    // Convert 4 leading spaces into a tab while typing (indentation only).
    dom.queryTextArea.addEventListener("beforeinput", (e) => {
      if (e.inputType !== "insertText" || e.data !== " ") return;

      const ta = dom.queryTextArea;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      if (start == null || end == null || start !== end) return;

      const value = String(ta.value || "");
      const lineStart = value.lastIndexOf("\n", start - 1) + 1; // 0 if not found
      const prefix = value.slice(lineStart, start);

      // Only within indentation region (tabs/spaces only before cursor)
      if (!/^[\t ]*$/.test(prefix)) return;

      // Count consecutive spaces immediately before cursor in indentation prefix
      let run = 0;
      for (let i = prefix.length - 1; i >= 0; i--) {
        if (prefix[i] === " ") run++;
        else break;
        if (run >= 4) break;
      }

      // If this keystroke would complete 4 spaces, replace them with a tab
      if (run === 3) {
        e.preventDefault();
        const deleteFrom = start - 3;
        try {
          ta.focus();
          ta.setSelectionRange(deleteFrom, start);
          const ok = document.execCommand && document.execCommand("insertText", false, "\t");
          if (ok) return;
        } catch {
          null;
        }
        // Fallback if execCommand isn't available
        ta.setRangeText("\t", deleteFrom, start, "end");
        dispatchInputEvent(ta);
      }
    });

    // Copy: convert tabs to 4 spaces in clipboard to keep alignment when pasting elsewhere.
    dom.queryTextArea.addEventListener("copy", (e) => {
      const ta = dom.queryTextArea;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      if (start == null || end == null || start === end) return;
      const selected = String(ta.value || "").slice(start, end);
      if (!selected.includes("\t")) return;

      const text = selected.replace(/\t/g, "    ");
      if (e.clipboardData) {
        e.preventDefault();
        e.clipboardData.setData("text/plain", text);
      }
    });

    if (ns.highlight && typeof ns.highlight.attach === "function") {
      const ctrl = ns.highlight.attach(dom.queryTextArea);
      if (ns.state) ns.state.highlightCtrl = ctrl || null;
    }

    if (ns.autocomplete && typeof ns.autocomplete.attach === "function") {
      const ctrl = ns.autocomplete.attach(dom.queryTextArea);
      if (ns.state) ns.state.autocompleteCtrl = ctrl || null;
    }

    if (storage && typeof storage.loadEditorHeight === "function" && typeof storage.saveEditorHeight === "function") {
      const getTarget = () => {
        const ta = dom.queryTextArea;
        if (!ta) return null;
        if (ta.closest) return ta.closest(".editorWrap") || ta;
        const p = ta.parentNode;
        if (p && p.classList && p.classList.contains("editorWrap")) return p;
        return ta;
      };

      let lastSaved = null;
      let scheduled = 0;

      const releasePrepaintHeight = () => {
        const root = document.documentElement;
        if (!root) return;
        root.classList.remove("chdash-has-initial-editor-height");
        root.style.removeProperty("--initialEditorHeight");
      };

      const apply = (hostId) => {
        const target = getTarget();
        if (!target) return;
        const h = storage.loadEditorHeight(hostId);
        if (h && Number.isFinite(h)) {
          const v = Math.round(h);
          target.style.height = `${v}px`;
          lastSaved = v;
        }
        // The page head script uses an !important pre-paint rule to avoid a startup jump.
        // Once the persisted height has been copied to the real element, release
        // that rule so the centered drag handle can change the used height.
        releasePrepaintHeight();
      };

      const save = () => {
        scheduled = 0;
        const target = getTarget();
        if (!target || !target.style || !target.style.height) return;
        const v = Math.round(target.getBoundingClientRect().height);
        if (!Number.isFinite(v) || v <= 0) return;
        if (lastSaved === v) return;
        lastSaved = v;
        storage.saveEditorHeight(state.selectedHostId, v);
      };

      apply(state.selectedHostId);

      if (typeof ResizeObserver === "function") {
        try {
          const ro = new ResizeObserver(() => {
            if (scheduled) return;
            scheduled = requestAnimationFrame(save);
          });
          const t = getTarget();
          if (t) ro.observe(t);
        } catch {
          null;
        }
      }

      const handle = document.querySelector(".editorResizeHandle");
      const target = getTarget();
      if (handle && target) {
        let drag = null;
        const finishDrag = (event) => {
          if (!drag) return;
          try { handle.releasePointerCapture(event.pointerId); } catch (_) {}
          drag = null;
          handle.classList.remove("is-dragging");
          save();
        };
        handle.addEventListener("pointerdown", (event) => {
          if (event.button !== 0) return;
          drag = { y: event.clientY, height: target.getBoundingClientRect().height };
          try { handle.setPointerCapture(event.pointerId); } catch (_) {}
          handle.classList.add("is-dragging");
          event.preventDefault();
        });
        handle.addEventListener("pointermove", (event) => {
          if (!drag) return;
          // Match the production resize semantics: only enforce the editor's
          // minimum usable height. The containing query panel grows/shrinks
          // naturally instead of forcing the whole workspace to viewport height.
          const next = Math.round(Math.max(180, drag.height + event.clientY - drag.y));
          target.style.height = `${next}px`;
          event.preventDefault();
        });
        handle.addEventListener("pointerup", finishDrag);
        handle.addEventListener("pointercancel", finishDrag);
      }

      state.editorSizeCtrl = { apply };
    }

    dom.queryTextArea.addEventListener("focus", () => {
      if (ns.meta && typeof ns.meta.maybeRefreshOnUserAction === "function") {
        ns.meta.maybeRefreshOnUserAction();
      }
    });
  }

  function init() {
    applyRunOptionsUi();

    // Menu entries follow the last known availability until /api/version answers.
    const cachedPageNav = storage?.loadPageNav?.();
    if (cachedPageNav) applyPageNavigation(cachedPageNav);
    loadMeta();
    initEditor();
    initEditorCopyButton();

    if (ns.meta && typeof ns.meta.prepareHost === "function" && state.selectedHostId) {
      ns.meta.prepareHost(state.selectedHostId);
    }

    if (dom.runMenuButton) dom.runMenuButton.addEventListener("click", toggleRunMenu);

    if (dom.runOptAutoFormat) dom.runOptAutoFormat.addEventListener("click", () => toggleRunOption("autoFormat"));
    if (dom.runOptMultiQuery) dom.runOptMultiQuery.addEventListener("click", () => toggleRunOption("multiQuery"));
    if (dom.runOptExecutionStats) dom.runOptExecutionStats.addEventListener("click", () => toggleRunOption("executionStats"));
    if (dom.runOptFlattenTuple) dom.runOptFlattenTuple.addEventListener("click", () => toggleRunOption("flattenTuple"));

    if (dom.hostPickerButton) dom.hostPickerButton.addEventListener("click", toggleHostMenu);

    document.addEventListener("click", (ev) => {
      const t = ev.target;
      if (dom.runSplit && dom.runMenu && !dom.runMenu.hidden) {
        if (t instanceof Node && !dom.runSplit.contains(t)) closeRunMenu();
      }
      if (dom.hostPicker && dom.hostPickerMenu && !dom.hostPickerMenu.hidden) {
        if (t instanceof Node && !dom.hostPicker.contains(t)) closeHostMenu();
      }
      if (dom.themeSelect && dom.themeSelectMenu && isThemeMenuOpen()) {
        if (t instanceof Node && !dom.themeSelect.contains(t)) closeThemeMenu();
      }
      if (dom.pageSelect && dom.pageSelectMenu && isPageMenuOpen()) {
        if (t instanceof Node && !dom.pageSelect.contains(t)) closePageMenu();
      }
      if (dom.runSettings && dom.runSettingsMenu && isRunSettingsOpen()) {
        if (t instanceof Node && !dom.runSettings.contains(t)) closeRunSettings();
      }
      if (dom.copySplit && dom.copyMenu && !dom.copyMenu.hidden) {
        if (t instanceof Node && !dom.copySplit.contains(t)) closeCopyMenu();
      }
    });

    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        closeRunMenu({ immediate: true });
        closeHostMenu();
        closeThemeMenu({ immediate: true });
        closePageMenu({ immediate: true });
        closeRunSettings({ immediate: true });
        closeCopyMenu({ immediate: true });
      }
    });

    initQueryLibrary();
    applyQueryUrl();

    if (dom.pageSelectButton) dom.pageSelectButton.addEventListener("click", togglePageMenu);
    // Observability (Traces, Logs, Metrics) is its own page: the Query and
    // Explorer shells navigate to it, on its first enabled view.
    dom.navObservabilityButton?.addEventListener("click", () => {
      if (document.body?.dataset?.page !== "observability") window.location.assign(api.resolveUrl("observability"));
    });
    if (dom.pageSelectMenu) {
      for (const b of dom.pageSelectMenu.querySelectorAll(".themeSelect__option[data-value]")) b.addEventListener("click", () => closePageMenu());
    }
    if (dom.runSettingsButton) dom.runSettingsButton.addEventListener("click", toggleRunSettings);

    if (dom.themeSelectButton) dom.themeSelectButton.addEventListener("click", toggleThemeMenu);
    if (dom.themeSelectMenu) {
      const buttons = dom.themeSelectMenu.querySelectorAll(".themeSelect__option[data-value]");
      for (const b of buttons) {
        b.addEventListener("click", () => {
          const mode = b.getAttribute("data-value");
          if (mode !== "system" && mode !== "dark" && mode !== "light") return;
          storage.setSavedThemeMode(mode);
          applyTheme(mode);
          closeThemeMenu();
        });
      }
    }

    if (dom.copyMenuButton) dom.copyMenuButton.addEventListener("click", toggleCopyMenu);
    if (dom.copyCsvButton) dom.copyCsvButton.addEventListener("click", () => closeCopyMenu({ immediate: true }));

    const themeMode = storage.getSavedThemeMode();
    applyTheme(themeMode);

    try {
      const mql = window.matchMedia("(prefers-color-scheme: dark)");
      if (mql && mql.addEventListener) {
        mql.addEventListener("change", () => {
          if (storage.getSavedThemeMode() === "system") applyTheme("system");
        });
      }
    } catch {
      // No OS theme change events: System keeps the theme resolved above.
      // Startup still has to finish (ready class, hosts stream).
    }

    if (dom.root && dom.root.classList) dom.root.classList.add("is-ready");

    startHostsSse();
  }

  function setEditorError(loc) {
    const ctrl = state && state.highlightCtrl;
    if (!ctrl || typeof ctrl.setError !== "function") return;
    ctrl.setError(loc);
  }

  function clearEditorError() {
    const ctrl = state && state.highlightCtrl;
    if (!ctrl || typeof ctrl.clearError !== "function") return;
    ctrl.clearError();
  }

  ns.ui = {
    init, setSelectedHostId, setApiOnline, closeRunMenu, closeHostMenu, closeThemeMenu, closePageMenu, closeRunSettings, setPageSelectorValue,
    applyProductFeatures, applyRunOptionsUi, setRunOption, setEditorError, clearEditorError,
    loadQueryLibrary, syncQueryUrl, openQueryLibrary, closeQueryLibrary, isQueryLibraryOpen, isPhoneLayout, modifierKeyLabel,
    serverTimeZone, serverTime,
  };
})();
