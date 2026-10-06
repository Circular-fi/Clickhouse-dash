(() => {
  "use strict";

  const ns = window.ChDash;
  if (!ns) return;
  const { byId, $, $$ } = ns.dom;

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

  // /api/version: the version badge and the feature flags (ns.features; a
  // flag the server does not send keeps the defaults table's value).
  async function loadMeta() {
    if (!dom.versionBadge) return;
    let data;
    try {
      data = await api.getVersion();
    } catch (error) {
      dom.versionBadge.textContent = error?.code === "network_error" ? "meta: offline" : "meta: error";
      markFeaturesLoaded();
      return;
    }
    try {
      ns.features.set(data && data.features);
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
    ns.features.markLoaded();
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

  // The hosts stream answers every second with what is mostly the same: writing a text that is
  // already there still replaces its text node, which restyles and lays the page out again, once a
  // second on every page. Only a changed text is written.
  function setText(el, text) {
    if (el && el.textContent !== text) el.textContent = text;
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

    setText(dom.hostPickerText, apiOnline ? label : `${label} (API offline)`);
    setText(dom.hostPickerVersion, hostVersion || "");

    if (dom.hostPickerDot) {
      const good = apiOnline && healthy;
      dom.hostPickerDot.classList.toggle("hostDot--good", good);
      dom.hostPickerDot.classList.toggle("hostDot--bad", !good);
    }

    if (dom.hostPickerPing) {
      if (!apiOnline) {
        setText(dom.hostPickerPing, ns.format.EMPTY);
      } else if (healthy && pingMs != null && Number.isFinite(pingMs)) {
        setText(dom.hostPickerPing, formatPingMsLabel(pingMs));
      } else {
        setText(dom.hostPickerPing, healthy ? ns.format.EMPTY : "down");
      }
    }

    if (dom.hostPickerButton) {
      dom.hostPickerButton.disabled = !apiOnline;
      const title = hostVersion ? `${label}\nClickHouse ${hostVersion}` : label;
      if (dom.hostPickerButton.title !== title) dom.hostPickerButton.title = title;
      if (!apiOnline) closeHostMenu();
    }
  }


  // The header and Query menus are ns.menu menus (app_ui_menu.js): open /
  // close motion, keys, focus return and the one outside-click / Escape
  // layer. Bound in init(); these keep the names other modules call.
  const menus = { host: null, page: null, theme: null, runSettings: null, run: null, copy: null };

  function closeHostMenu() {
    menus.host?.close({ immediate: true, focus: false });
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

    dom.hostPickerMenu.replaceChildren();

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
        menus.host?.close({ focus: true });
        renderHostPicker(state.hostsSnapshot || snapshot);
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
        useSnapshot(await api.getHosts());
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

  // The page switcher (Query, Explorer, Observability, System) ships visible
  // in every page shell. Only a server with neither Explorer, System nor any
  // Observability view (Traces, Logs, Metrics) hides it; the head script of
  // each page applies the last known availability (chdash-page-select-hidden)
  // before first paint.
  function applyPageNavigation(nav) {
    const explorerEnabled = nav.explorer !== false;
    const systemEnabled = nav.system !== false;
    const observabilityEnabled = nav.traces === true || nav.logs === true || nav.metrics === true;
    const hidden = !explorerEnabled && !systemEnabled && !observabilityEnabled;
    dom.root?.classList.toggle("chdash-page-select-hidden", hidden);
    if (dom.pageSelect) dom.pageSelect.hidden = hidden;
    if (dom.navExplorerButton) dom.navExplorerButton.hidden = !explorerEnabled;
    if (dom.navObservabilityButton) dom.navObservabilityButton.hidden = !observabilityEnabled;
    if (dom.navSystemButton) dom.navSystemButton.hidden = !systemEnabled;
  }

  function applyProductFeatures() {
    const features = ns.features;
    const f = features.get("explorer");
    const explorerEnabled = f.enabled;
    const tracesEnabled = features.get("traces.enabled");
    const logsEnabled = features.get("logs.enabled");
    const metricsEnabled = features.get("metrics.enabled");
    const systemEnabled = features.get("system.enabled");
    applyPageNavigation({ explorer: explorerEnabled, system: systemEnabled, traces: tracesEnabled, logs: logsEnabled, metrics: metricsEnabled });
    storage?.savePageNav?.({ explorer: explorerEnabled, system: systemEnabled, traces: tracesEnabled, logs: logsEnabled, metrics: metricsEnabled });
    if (!explorerEnabled && /\/explorer(?:\/|$)/.test(window.location.pathname)) {
      ns.router.replace("", { path: "/query", view: "query" });
      if (ns.explorer && typeof ns.explorer.setWorkspace === "function") ns.explorer.setWorkspace("query", { history: "none" });
    }
    // A turned-off view falls back to another (app_observability.js); with no
    // view left the page itself is gone.
    if (!tracesEnabled && !logsEnabled && !metricsEnabled && document.body?.dataset?.page === "observability") {
      window.location.replace(api.resolveUrl("query"));
      return;
    }
    // A trace is Traces': the page is gone with it; Observability's first
    // remaining view, else Query.
    if (!tracesEnabled && document.body?.dataset?.page === "trace") {
      window.location.replace(api.resolveUrl(logsEnabled ? "observability/logs" : metricsEnabled ? "observability/metrics" : "query"));
      return;
    }
    // The System page turned off (system.enabled = false): its routes are gone,
    // a query shape's page (shape.html) with them.
    if (!systemEnabled && ["system", "shape"].includes(document.body?.dataset?.page)) {
      window.location.replace(api.resolveUrl("query"));
      return;
    }
    window.dispatchEvent(new CustomEvent("chdash:features-changed", { detail: { explorer: f, system: features.get("system"), traces: features.get("traces"), logs: features.get("logs"), metrics: features.get("metrics") } }));
  }

  function setPageSelectorValue(value) {
    const labels = { query: "Query", explorer: "Explorer", observability: "Observability", system: "System" };
    const page = Object.prototype.hasOwnProperty.call(labels, value) ? value : "query";
    if (dom.pageSelectButton) dom.pageSelectButton.textContent = labels[page];
    if (dom.pageSelectMenu) {
      for (const b of $$(".themeSelect__option[data-value]", dom.pageSelectMenu)) {
        b.setAttribute("aria-selected", String(b.getAttribute("data-value") === page));
      }
    }
  }

  function closePageMenu({ immediate = false } = {}) { menus.page?.close({ immediate }); }
  function closeRunSettings({ immediate = false } = {}) { menus.runSettings?.close({ immediate }); }

  function applyTheme(mode) {
    const resolved = getResolvedTheme(mode);
    if (mode === "system") delete dom.root.dataset.theme;
    else dom.root.dataset.theme = resolved;
    // Drives the theme button icon from CSS (css/20-features/shell.css), like the head
    // script does before the first paint.
    dom.root.dataset.themeMode = mode;

    if (dom.themeSelectButton) dom.themeSelectButton.setAttribute("aria-label", `Theme: ${mode}`);

    if (dom.themeSelectMenu) {
      const btns = $$(".themeSelect__option[data-value]", dom.themeSelectMenu);
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

  function closeThemeMenu({ immediate = false } = {}) { menus.theme?.close({ immediate }); }
  function closeRunMenu({ immediate = false } = {}) { menus.run?.close({ immediate }); }

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

  // --- Query library dialog ----------------------------------------------------
  // The toolbar book button opens the library in the shared modal dialog
  // (app_ui_dialog.js: the shell, size, backdrop and focus handling of the
  // profiling dialog), with two tabs: Saved (folders and saved queries) and
  // History. The dialog is built the first time it opens; app_query_library.js
  // renders both views and is loaded then (or when Ctrl+S is used): a page
  // that never opens it costs no module and no dialog.
  const queryLibraryPrefs = () => storage.pref(storage.KEYS.queryLibraryMenu, {});
  // modules.json pages.query.lazy.library.
  const QUERY_LIBRARY_GROUP = "library";
  let queryLibraryPromise = null;
  let queryLibraryTab = "saved";
  let queryLibraryDialog = null;
  let queryLibraryTabs = null;

  function readQueryLibraryPrefs() {
    const value = queryLibraryPrefs().get();
    return value && typeof value === "object" ? value : {};
  }

  function writeQueryLibraryPrefs(patch) {
    queryLibraryPrefs().set({ ...readQueryLibraryPrefs(), ...patch });
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
      queryLibraryPromise = ns.loader.loadGroup(QUERY_LIBRARY_GROUP).then(() => {
        if (!ns.queryLibrary) throw new Error("The query library did not register");
        return ns.queryLibrary;
      });
      queryLibraryPromise.catch(() => { queryLibraryPromise = null; });
    }
    return queryLibraryPromise;
  }

  function withQueryLibrary(fn) {
    return loadQueryLibrary().then(fn).catch((err) => {
      console.error(err);
      for (const view of [dom.queryLibraryViewSaved, dom.queryLibraryViewHistory]) {
        if (view && !view.dataset.rendered) ns.uiState.error(view, { body: "The query library could not be loaded.", compact: true, retry: () => withQueryLibrary(fn) });
      }
    });
  }

  function isQueryLibraryOpen() {
    return !!queryLibraryDialog?.isOpen();
  }

  function setQueryLibraryTab(tab, { focus = false } = {}) {
    const next = tab === "history" ? "history" : "saved";
    queryLibraryTab = next;
    queryLibraryTabs?.select(next);
    if (dom.queryLibraryViewSaved) dom.queryLibraryViewSaved.hidden = next !== "saved";
    if (dom.queryLibraryViewHistory) dom.queryLibraryViewHistory.hidden = next !== "history";
    writeQueryLibraryPrefs({ tab: next });
    if (!isQueryLibraryOpen()) return;
    withQueryLibrary((lib) => {
      lib.show(next);
      if (focus) lib.focus(next);
    });
  }

  // The dialog (the Saved / History tabs in its head, where a title would be,
  // in the profiling tab style, and the two views) is built the first time it
  // opens: an idle page carries none of it.
  function buildQueryLibraryDialog() {
    if (queryLibraryDialog || !ns.dialog || !dom.queryLibraryButton) return queryLibraryDialog;
    const parts = ns.dialog.shell({
      id: "queryLibraryMenu",
      label: "Query library",
      closeLabel: "Close the query library",
      size: "lg",
      className: "queryLibraryDialog",
      tabs: {
        label: "Saved queries or History",
        inHead: true,
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
      <div id="queryLibraryViewSaved" class="queryLibraryDialog__view" role="tabpanel" aria-labelledby="queryLibraryTabSaved">${ns.uiState.loadingHtml({ label: "Loading the library\u2026", compact: true })}</div>
      <div id="queryLibraryViewHistory" class="queryLibraryDialog__view" role="tabpanel" aria-labelledby="queryLibraryTabHistory" hidden>${ns.uiState.loadingHtml({ label: "Loading the history\u2026", compact: true })}</div>`;
    for (const id of ["queryLibraryMenu", "queryLibraryClose", "queryLibraryTabSaved", "queryLibraryTabHistory", "queryLibraryViewSaved", "queryLibraryViewHistory"]) {
      dom[id] = byId(id);
    }
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
    // Saved | History: the shared tab behaviour (app_ui_tabs.js: click,
    // arrows, Home / End, roving tabindex) in the dialog's tab style.
    queryLibraryTabs = ns.tabs?.bind(parts.tabs, { onSelect: (tab) => setQueryLibraryTab(tab) }) || null;
    return queryLibraryDialog;
  }

  function openQueryLibrary(tab = queryLibraryTab, { focus = true } = {}) {
    const libraryDialog = buildQueryLibraryDialog();
    if (!libraryDialog) return Promise.resolve(null);
    closeRunMenu({ immediate: true });
    closeRunSettings({ immediate: true });
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

  // The Query page's owner of the address (ns.router): it only writes these
  // two parameters, and always replaces.
  function syncQueryUrl(sqlText) {
    if (document.body?.dataset.page !== "query") return;
    const text = String(sqlText ?? dom.queryTextArea?.value ?? "").trim();
    const savedId = ns.queryLibrary?.openedId?.(text) || "";
    const sql = !savedId && text.length <= QUERY_URL_MAX_SQL ? text : "";
    ns.router.owner("query", { view: null }).replace({ saved: savedId, sql });
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
      for (const kbd of $$(".queryKbd--mod")) kbd.textContent = mod;
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

  // The editor's copy button: the shared ui.copyButton (icon, tooltip and
  // the one "Copied" feedback).
  function initEditorCopyButton() {
    if (!dom.editorCopyButton || !dom.queryTextArea) return;

    const sync = () => {
      dom.editorCopyButton.disabled = !String(dom.queryTextArea.value || "").trim();
    };

    ns.ui.copyButton(dom.editorCopyButton, () => {
      const text = String(dom.queryTextArea.value || "");
      return text.trim() ? text : "";
    }, { label: "Copy query" });

    sync();
    dom.queryTextArea.addEventListener("input", sync);
  }

  function initEditor() {
    if (!dom.queryTextArea) return;

    // The session draft, also written by the Explorer's "Open in Query".
    const draftPref = storage.pref(storage.KEYS.editorDraft, null, { session: true });
    const loadEditorDraft = () => draftPref.get();
    const saveEditorDraft = (text) => draftPref.set(String(text || ""));

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

    const saveDraftSoon = util.debounce(() => saveEditorDraft(dom.queryTextArea.value), 200);
    dom.queryTextArea.addEventListener("input", () => saveDraftSoon());

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

      const handle = $(".editorResizeHandle");
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

  // A phone (600 px and below, query.css): the run stats tiles fold into one
  // summary line ("7 ms \u00b7 120,064 rows \u00b7 1.9 MB read \u00b7 CPU 87.7%
  // \u00b7 1.8 MB memory"), a .foldSummary that unfolds them, so the results
  // start above the fold. The fold only bites at that width.
  function initRunStatsSummary() {
    const tiles = byId("runStatsTiles");
    const panel = tiles?.closest(".panel--metrics");
    if (!tiles || !panel) return;
    const { h } = ns;
    const text = h("span", { class: "foldSummary__text" });
    const icon = ns.icon.el("chevron-down", { className: "foldSummary__chevron" });
    const summary = h("button", { type: "button", id: "runStatsSummary", class: "foldSummary runStatsSummary", "aria-controls": tiles.id }, text, icon);
    panel.prepend(summary);
    const value = (el) => {
      const v = String(el?.textContent || "").replace(/\s+/g, " ").trim();
      return v && v !== ns.format.EMPTY ? v : "";
    };
    const shown = (el) => !!el && !el.closest(".metricCompact.is-hidden");
    const refresh = () => {
      // Before the first run the tiles say "No run yet": so does the summary.
      if (dom.runStatsTiles?.classList.contains("is-idle")) {
        ns.util.setMetaLine(text, "Run stats");
        return;
      }
      const parts = [];
      const add = (el, label) => {
        const v = shown(el) ? value(el) : "";
        if (v) parts.push(label.replace("#", v));
      };
      add(dom.elapsedSecondsText, "#");
      add(dom.readRowsTotalText, "# rows");
      add(dom.readBytesTotalText, "# read");
      add(dom.writtenRowsTotalText, "# rows written");
      add(dom.writtenBytesTotalText, "# written");
      add(dom.cpuMaxText, "CPU #");
      add(dom.memoryMaxText, "# memory");
      ns.util.setMetaLine(text, parts.length ? parts.join(" \u00b7 ") : "Run stats");
    };
    const fold = (folded) => {
      panel.classList.toggle("is-folded", folded);
      summary.setAttribute("aria-expanded", folded ? "false" : "true");
      summary.title = folded ? "Show the run stats" : "Hide the run stats";
    };
    summary.addEventListener("click", () => fold(!panel.classList.contains("is-folded")));
    new MutationObserver(ns.util.rafOnce(refresh)).observe(tiles, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["class"] });
    fold(true);
    refresh();
  }

  function init() {
    applyRunOptionsUi();
    initRunStatsSummary();

    // Menu entries follow the last known availability until /api/version answers.
    const cachedPageNav = storage?.loadPageNav?.();
    if (cachedPageNav) applyPageNavigation(cachedPageNav);
    loadMeta();
    initEditor();
    initEditorCopyButton();

    if (ns.meta && typeof ns.meta.prepareHost === "function" && state.selectedHostId) {
      ns.meta.prepareHost(state.selectedHostId);
    }

    const menu = ns.menu;
    menus.run = menu?.split(dom.runButton, dom.runMenuButton, dom.runMenu) || null;

    if (dom.runOptAutoFormat) dom.runOptAutoFormat.addEventListener("click", () => toggleRunOption("autoFormat"));
    if (dom.runOptMultiQuery) dom.runOptMultiQuery.addEventListener("click", () => toggleRunOption("multiQuery"));
    if (dom.runOptExecutionStats) dom.runOptExecutionStats.addEventListener("click", () => toggleRunOption("executionStats"));
    if (dom.runOptFlattenTuple) dom.runOptFlattenTuple.addEventListener("click", () => toggleRunOption("flattenTuple"));

    menus.host = menu?.bind(dom.hostPickerButton, dom.hostPickerMenu, {
      root: dom.hostPicker,
      openClass: "",
      canOpen: () => !dom.hostPicker?.classList.contains("is-static"),
    }) || null;

    initQueryLibrary();
    applyQueryUrl();

    menus.page = menu?.bind(dom.pageSelectButton, dom.pageSelectMenu, { canOpen: () => !dom.pageSelect?.hidden }) || null;
    // Observability (Traces, Logs, Metrics) is its own page: the other
    // shells navigate to it, on its first enabled view.
    dom.navObservabilityButton?.addEventListener("click", () => {
      if (document.body?.dataset?.page !== "observability") window.location.assign(api.resolveUrl("observability"));
    });
    // System is its own page too (system.html, app_system.js).
    dom.navSystemButton?.addEventListener("click", () => {
      if (document.body?.dataset?.page !== "system") window.location.assign(api.resolveUrl("system"));
      else closePageMenu();
    });
    menus.runSettings = menu?.bind(dom.runSettingsButton, dom.runSettingsMenu) || null;
    menus.theme = menu?.bind(dom.themeSelectButton, dom.themeSelectMenu) || null;
    if (dom.themeSelectMenu) {
      const buttons = $$(".themeSelect__option[data-value]", dom.themeSelectMenu);
      for (const b of buttons) {
        b.addEventListener("click", () => {
          const mode = b.getAttribute("data-value");
          if (mode !== "system" && mode !== "dark" && mode !== "light") return;
          storage.setSavedThemeMode(mode);
          applyTheme(mode);
        });
      }
    }


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

  // The component modules (app_ui_copy.js, app_ui_sql.js, ...) load first
  // and add their builders to ns.ui.
  ns.ui = Object.assign(ns.ui || {}, {
    init, setSelectedHostId, setApiOnline, closeRunMenu, closeHostMenu, closeThemeMenu, closePageMenu, closeRunSettings, setPageSelectorValue,
    applyProductFeatures, applyRunOptionsUi, setEditorError, clearEditorError,
    loadQueryLibrary, syncQueryUrl, openQueryLibrary, closeQueryLibrary, isQueryLibraryOpen, isPhoneLayout, modifierKeyLabel,
    serverTimeZone, serverTime,
  });
})();
