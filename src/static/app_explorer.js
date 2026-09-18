(() => {
  "use strict";

  const ns = window.ChDash;
  if (!ns) return;

  const { dom, state, api, util, ui, storage } = ns;
  const graph = ns.explorerGraph;

  const model = {
    active: false,
    section: "tables",
    mode: "list",
    loadingCatalog: false,
    catalog: null,
    selectedKey: null,
    selectedDatabase: null,
    detail: null,
    detailLoading: false,
    detailSerial: 0,
    tab: "Overview",
    preview: null,
    previewLoading: false,
    loadingFunctions: false,
    functionsCatalog: null,
    selectedFunctionKey: null,
    expandedFunctionCategories: new Set(),
    expandedDatabases: new Set(),
    databaseTablesLoaded: new Set(),
    databaseTablesLoading: new Set(),
    databaseLoadPromises: new Map(),
    databaseLoadErrors: new Map(),
    routeIntent: null,
    includeSystem: false,
    includeNonStoring: true,
  };

  const TABS = ["Overview", "Schema", "Data", "Lineage", "Storage", "Operations"];

  const TAB_BY_SLUG = new Map(TABS.map((label) => [label.toLowerCase(), label]));

  function decodeRouteSegment(value) {
    try { return decodeURIComponent(String(value || "")); } catch { return String(value || ""); }
  }

  function encodeRouteSegment(value) {
    return encodeURIComponent(String(value || ""));
  }

  function appBasePath() {
    const base = String(window.__CHDASH_BASE_PATH__ || "/");
    return base === "/" ? "" : base.replace(/\/+$/, "");
  }

  function appRoute(path) {
    const raw = String(path || "/");
    return `${appBasePath()}${raw.startsWith("/") ? raw : `/${raw}`}` || "/";
  }

  function parseExplorerRoute(pathname = window.location.pathname) {
    let path = String(pathname || "/");
    const base = appBasePath();
    if (base && path.startsWith(base)) path = path.slice(base.length) || "/";
    path = path.replace(/\/+$/, "") || "/";
    const params = new URLSearchParams(window.location.search || "");
    const viewMode = params.get("view") === "graph" ? "graph" : "list";
    const graphType = params.get("graph") === "storage" ? "physical" : "logical";
    const hasDepth = params.has("depth");
    const parsedDepth = hasDepth ? Number(params.get("depth")) : Number.NaN;
    const graphDepth = Number.isFinite(parsedDepth) ? Math.max(0, Math.min(8, Math.trunc(parsedDepth))) : 1;
    if (path === "/explorer") return { workspace: "explorer", section: "tables", viewMode, graphType, graphDepth };
    if (!path.startsWith("/explorer/")) return { workspace: "query" };
    const parts = path.slice("/explorer/".length).split("/").filter(Boolean).map(decodeRouteSegment);
    if (parts[0] === "functions") {
      return { workspace: "explorer", section: "functions", functionName: parts[1] || "" };
    }
    if (parts[0] === "databases") {
      return { workspace: "explorer", section: "tables" };
    }
    const database = parts[0] || "";
    const table = parts[1] || "";
    const requestedTab = String(parts[2] || "overview").toLowerCase();
    const legacySchema = requestedTab === "schema";
    const tab = legacySchema ? "Overview" : (TAB_BY_SLUG.get(requestedTab) || "Overview");
    return { workspace: "explorer", section: "tables", database, table, tab, legacySchema, viewMode, graphType, graphDepth };
  }

  function currentExplorerPath() {
    if (model.section === "functions") {
      const selected = (model.functionsCatalog?.functions || []).find((candidate) => functionKey(candidate) === model.selectedFunctionKey) || null;
      return selected?.name ? `/explorer/functions/${encodeRouteSegment(selected.name)}` : "/explorer/functions";
    }
    const table = selectedTable();
    if (table) return `/explorer/${encodeRouteSegment(table.database)}/${encodeRouteSegment(table.name)}/${model.tab.toLowerCase()}`;
    if (model.selectedDatabase) return `/explorer/${encodeRouteSegment(model.selectedDatabase)}`;
    return "/explorer";
  }

  function currentExplorerUrl() {
    const path = appRoute(currentExplorerPath());
    if (model.section !== "tables") return path;
    const params = new URLSearchParams();
    params.set("view", model.mode === "graph" ? "graph" : "browse");
    if (model.mode === "graph") {
      const route = graph?.getRouteState?.() || { mode: "logical", depth: 1 };
      params.set("graph", route.mode === "physical" ? "storage" : "lineage");
      if (route.mode !== "physical") params.set("depth", String(route.depth ?? 1));
    }
    const query = params.toString();
    return query ? `${path}?${query}` : path;
  }

  function syncExplorerUrl(mode = "push") {
    if (!model.active || mode === "none") return;
    const url = currentExplorerUrl();
    const current = `${window.location.pathname}${window.location.search || ""}`;
    if (current === url) return;
    const method = mode === "replace" ? "replaceState" : "pushState";
    window.history[method]({ workspace: "explorer" }, "", url);
  }

  function node(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = String(text);
    return el;
  }

  function clear(el) {
    if (el) el.replaceChildren();
  }

  function isDropdownOpen(root) {
    return !!(root && root.classList.contains("themeSelect--open"));
  }

  function openDropdown(root, button, menu) {
    if (!root || !button || !menu || root.hidden) return;
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    root.classList.remove("themeSelect--closing");
    requestAnimationFrame(() => root.classList.add("themeSelect--open"));
    menu.focus({ preventScroll: true });
  }

  function closeDropdown(root, button, menu, { immediate = false } = {}) {
    if (!root || !button || !menu) return;
    button.setAttribute("aria-expanded", "false");
    root.classList.remove("themeSelect--open");
    if (immediate) {
      root.classList.remove("themeSelect--closing");
      menu.hidden = true;
      return;
    }
    root.classList.add("themeSelect--closing");
    setTimeout(() => {
      if (!isDropdownOpen(root)) menu.hidden = true;
      root.classList.remove("themeSelect--closing");
    }, 160);
  }

  function toggleDropdown(root, button, menu) {
    if (isDropdownOpen(root)) closeDropdown(root, button, menu);
    else openDropdown(root, button, menu);
  }

  function setError(error) {
    if (!dom.explorerError) return;
    if (!error) {
      dom.explorerError.hidden = true;
      dom.explorerError.textContent = "";
      return;
    }
    const code = error && error.code ? String(error.code) : "explorer_error";
    let message = error instanceof Error ? String(error.message || "Explorer request failed.") : String(error || "Explorer request failed.");
    dom.explorerError.textContent = message;
    dom.explorerError.hidden = false;
  }

  function fmtInt(value) {
    if (value == null) return "—";
    return util.formatInt(value);
  }

  function fmtBytes(value) {
    if (value == null) return "—";
    return util.formatBytes(value);
  }

  function fmtStorageBytes(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "unknown";
    const sign = n < 0 ? "-" : "";
    let v = Math.abs(n);
    const units = ["B", "KB", "MB", "GB", "TB", "PB"];
    let unit = 0;
    while (v >= 1024 && unit < units.length - 1) {
      v /= 1024;
      unit += 1;
    }
    return `${sign}${v.toFixed(2)}${units[unit]}`;
  }

  function fmtCompactInt(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    try {
      return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
    } catch {
      if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
      if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
      if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
      return String(Math.trunc(n));
    }
  }

  function fmtRate(value, suffix) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    if (suffix === "rows/s") {
      if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(2)}B rows/s`;
      if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M rows/s`;
      if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}k rows/s`;
      return `${n.toFixed(n < 10 ? 2 : 0)} rows/s`;
    }
    return `${util.formatBytes(n)}/s`;
  }

  function quoteIdent(value) {
    return `\`${String(value).replace(/`/g, "``")}\``;
  }

  function selectedTable() {
    if (!model.catalog || !model.selectedKey) return null;
    return (model.catalog.tables || []).find((t) => `${t.database}\0${t.name}` === model.selectedKey) || null;
  }

  function setSection(section) {
    const next = section === "functions" ? "functions" : "tables";
    model.section = next;
    const functions = next === "functions";
    const tables = next === "tables";

    dom.explorerTablesSectionButton?.setAttribute("aria-selected", String(tables));
    dom.explorerFunctionsSectionButton?.setAttribute("aria-selected", String(functions));
    if (dom.explorerSectionSelectButton) dom.explorerSectionSelectButton.textContent = functions ? "Functions" : "Tables";
    closeDropdown(dom.explorerSectionSelect, dom.explorerSectionSelectButton, dom.explorerSectionSelectMenu, { immediate: true });
    if (dom.explorerTableModeTabs) dom.explorerTableModeTabs.hidden = !tables;
    if (dom.explorerFunctionsPane) dom.explorerFunctionsPane.hidden = !functions;

    if (functions) {
      if (dom.explorerListView) dom.explorerListView.hidden = true;
      if (dom.explorerGraphPane) dom.explorerGraphPane.hidden = true;
      graph?.deactivate();
      renderFunctionList();
      if (model.active) refreshFunctions(false);
      return;
    }

    setMode(model.mode);
    renderTableList();
    if (model.active) refreshCatalog(false);
  }

  function explorerFeatures() {
    return state.features?.explorer || { enabled: true, browse: true, graph: { enabled: true, lineage: true, storage_topology: true } };
  }

  function applyExplorerFeatures() {
    const f = explorerFeatures();
    const browseEnabled = f.enabled !== false && f.browse !== false;
    const gf = f.graph || {};
    const graphEnabled = f.enabled !== false && gf.enabled !== false && (gf.lineage !== false || gf.storage_topology !== false);
    if (dom.explorerTableModeTabs) dom.explorerTableModeTabs.hidden = !(browseEnabled && graphEnabled);
    if (!browseEnabled && graphEnabled && model.mode !== "graph") setMode("graph");
    else if (!graphEnabled && model.mode === "graph") setMode("list");

    const modes = [];
    if (graphEnabled && gf.lineage !== false) modes.push("logical");
    if (graphEnabled && gf.storage_topology !== false) modes.push("physical");
    const explicitTypeChoice = modes.length > 1;
    if (dom.explorerGraphTypeSelect) dom.explorerGraphTypeSelect.hidden = !explicitTypeChoice;
    if (dom.explorerGraphLogicalButton) dom.explorerGraphLogicalButton.hidden = gf.lineage === false;
    if (dom.explorerGraphPhysicalButton) dom.explorerGraphPhysicalButton.hidden = gf.storage_topology === false;
    if (modes.length === 1) graph?.setDetailMode?.(modes[0]);
  }

  function setMode(mode) {
    const f = explorerFeatures();
    const browseEnabled = f.enabled !== false && f.browse !== false;
    const gf = f.graph || {};
    const graphEnabled = f.enabled !== false && gf.enabled !== false && (gf.lineage !== false || gf.storage_topology !== false);
    const next = graphEnabled && (!browseEnabled || mode === "graph") ? "graph" : "list";
    model.mode = next;
    const graphMode = next === "graph";
    const tables = model.section === "tables";
    // Browse stays mounted on the left in both Browse and Graph modes.
    if (dom.explorerListView) dom.explorerListView.hidden = !tables;
    if (dom.explorerDetailPane) dom.explorerDetailPane.hidden = !tables || graphMode;
    if (dom.explorerGraphPane) dom.explorerGraphPane.hidden = !tables || !graphMode;
    dom.explorerListModeButton?.setAttribute("aria-selected", String(!graphMode));
    dom.explorerGraphModeButton?.setAttribute("aria-selected", String(graphMode));
    if (dom.explorerModeSelectButton) {
      const label = graphMode ? "Graph" : "Browse";
      const icon = dom.explorerModeSelectButton.querySelector(".explorerModeIcon");
      if (icon) icon.className = `explorerModeIcon explorerModeIcon--${graphMode ? "graph" : "browse"}`;
      dom.explorerModeSelectButton.setAttribute("aria-label", `Table view: ${label}`);
      dom.explorerModeSelectButton.title = label;
    }
    closeDropdown(dom.explorerTableModeTabs, dom.explorerModeSelectButton, dom.explorerModeSelectMenu, { immediate: true });
    if (!model.active || !tables) return;
    if (graphMode) {
      const table = selectedTable();
      if (table && graph?.isStorageMode?.() && graph?.canUseStorageForTable?.(table.database, table.name) === false) {
        graph?.setDetailMode?.("logical");
      }
      if (table) graph?.focusTable?.(table.database, table.name);
      graph?.activate(false);
    } else {
      graph?.deactivate();
      // Graph focus intentionally does not fetch Browse metadata. Load the
      // selected table only when Browse becomes visible and actually needs it.
      const table = selectedTable();
      if (table && !model.detailLoading && !model.detail) {
        void selectTable(table.database, table.name, false, { historyMode: "replace" });
      }
    }
  }

  function setWorkspace(name, { historyMode = "push" } = {}) {
    if (name === "explorer" && explorerFeatures().enabled === false) name = "query";
    const explorer = name === "explorer";
    // Query and Explorer are separate HTML documents. Crossing that boundary
    // must load the other document rather than leaving the current DOM mounted
    // and emulating a page transition with pushState.
    if (explorer && !dom.explorerWorkspace) {
      if (historyMode !== "none") window.location.assign(appRoute("/explorer"));
      return;
    }
    if (!explorer && !dom.queryWorkspace) {
      if (historyMode !== "none") window.location.assign(appRoute("/query"));
      return;
    }
    model.active = explorer;
    if (dom.queryWorkspace) dom.queryWorkspace.hidden = explorer;
    if (dom.explorerWorkspace) dom.explorerWorkspace.hidden = !explorer;
    dom.navQueryButton?.classList.toggle("is-active", !explorer);
    dom.navExplorerButton?.classList.toggle("is-active", explorer);
    dom.navQueryButton?.toggleAttribute("aria-current", !explorer);
    dom.navExplorerButton?.toggleAttribute("aria-current", explorer);
    ui?.setPageSelectorValue?.(explorer ? "explorer" : "query");

    const route = explorer ? (parseExplorerRoute().workspace === "explorer" ? window.location.pathname : appRoute("/explorer")) : appRoute("/query");
    if (window.location.pathname !== route) {
      if (historyMode === "replace") window.history.replaceState({ workspace: explorer ? "explorer" : "query" }, "", route);
      else if (historyMode !== "none") window.history.pushState({ workspace: explorer ? "explorer" : "query" }, "", route);
    }

    if (explorer) {
      if (model.section === "functions") refreshFunctions(false);
      else {
        refreshCatalog(false);
        if (model.mode === "graph") graph?.activate(false);
      }
    } else {
      graph?.deactivate();
    }
  }


  function nonStoringSummary(table) {
    const key = engineKey(table);
    return key === "view" || key === "parameterizedview" || key === "materializedview" || key === "buffer";
  }

  function sidebarObjectVisible(table) {
    if (!table) return false;
    if (!model.includeSystem && isSystemDatabaseName(table.database)) return false;
    if (!model.includeNonStoring && nonStoringSummary(table)) return false;
    return true;
  }

  function isSystemDatabaseName(database) {
    return ["system", "information_schema", "INFORMATION_SCHEMA"].includes(String(database || ""));
  }

  function visibilityRequirementsForCurrentObject() {
    const table = selectedTable();
    const graphRequirements = model.mode === "graph" ? (graph?.visibilityRequirements?.() || {}) : {};
    return {
      includeSystem: !!graphRequirements.includeSystem || !!table && isSystemDatabaseName(table.database),
      // A non-storing object cannot remain selected while being excluded from
      // the current Explorer scope. Keep the option checked/locked until the
      // user moves to a storing object.
      includeNonStoring: !!table && nonStoringSummary(table),
    };
  }

  function persistVisibilityOptions() {
    try {
      localStorage.setItem("chdash.explorer.includeSystem", model.includeSystem ? "1" : "0");
      localStorage.setItem("chdash.explorer.includeNonStoring", model.includeNonStoring ? "1" : "0");
    } catch {}
  }

  function syncVisibilityOptionLocks({ propagate = false } = {}) {
    const required = visibilityRequirementsForCurrentObject();
    let changed = false;
    if (required.includeSystem && !model.includeSystem) { model.includeSystem = true; changed = true; }
    if (required.includeNonStoring && !model.includeNonStoring) { model.includeNonStoring = true; changed = true; }

    if (dom.explorerIncludeSystem) {
      dom.explorerIncludeSystem.checked = model.includeSystem;
      dom.explorerIncludeSystem.disabled = required.includeSystem;
      dom.explorerIncludeSystem.title = required.includeSystem ? "Required while the selected object belongs to a system database." : "";
    }
    if (dom.explorerIncludeNonStoring) {
      dom.explorerIncludeNonStoring.checked = model.includeNonStoring;
      dom.explorerIncludeNonStoring.disabled = required.includeNonStoring;
      dom.explorerIncludeNonStoring.title = required.includeNonStoring ? "Required while the selected object does not store data itself." : "";
    }
    if (changed) persistVisibilityOptions();
    if ((changed || propagate) && model.mode === "graph") {
      const effective = graph?.setVisibilityOptions?.({ includeSystem: model.includeSystem, includeNonStoring: model.includeNonStoring });
      if (effective) {
        model.includeSystem = !!effective.includeSystem;
        model.includeNonStoring = !!effective.includeNonStoring;
        if (dom.explorerIncludeSystem) dom.explorerIncludeSystem.checked = model.includeSystem;
        if (dom.explorerIncludeNonStoring) dom.explorerIncludeNonStoring.checked = model.includeNonStoring;
      }
    }
  }

  function visibleTables() {
    const q = String(dom.explorerSearchInput?.value || "").trim().toLowerCase();
    const storageMode = model.mode === "graph" && graph?.isStorageMode?.();
    return (model.catalog?.tables || []).filter((table) => {
      if (!model.includeSystem && ["system", "information_schema", "INFORMATION_SCHEMA"].includes(String(table.database || ""))) return false;
      // Buffer is a special case in Storage: although it owns no persistent
      // parts, it is a real write-routing object and is shown together with the
      // table it flushes into. Other non-storing objects still obey the toggle.
      const storageBuffer = storageMode && engineKey(table) === "buffer";
      if (!model.includeNonStoring && nonStoringSummary(table) && !storageBuffer) return false;
      if (!q) return true;
      return `${table.database}.${table.name} ${table.engine || ""} ${objectKind(table)}`.toLowerCase().includes(q);
    });
  }

  function objectKind(table) {
    const engine = String(table?.engine || "").toLowerCase();
    if (engine === "view") return "View";
    if (engine === "materializedview" || engine === "materialized view") return "Materialized View";
    if (engine === "dictionary") return "Dictionary";
    return "Table";
  }

  function engineKey(summaryOrEngine) {
    const raw = typeof summaryOrEngine === "string" ? summaryOrEngine : summaryOrEngine?.engine;
    return String(raw || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function isMergeTreeSummary(summary) { return engineKey(summary).includes("mergetree"); }
  function isDictionarySummary(summary) { return engineKey(summary) === "dictionary"; }
  function isMemorySummary(summary) { return engineKey(summary) === "memory"; }
  function isBufferSummary(summary) { return engineKey(summary) === "buffer"; }
  function isResidentMemorySummary(summary) {
    return isBufferSummary(summary) || isMemorySummary(summary) || isDictionarySummary(summary);
  }
  function isLogFamilySummary(summary) { return ["tinylog", "stripelog", "log"].includes(engineKey(summary)); }
  function isDistributedSummary(summary) { return engineKey(summary) === "distributed"; }

  function storageCatalogEligible(summary) {
    // Keep sidebar eligibility independent from the currently loaded graph so
    // changing databases cannot transiently grey valid tables. The catalog has
    // enough durable signals to classify every engine supported by the Storage
    // graph: MergeTree families, Log families, explicit disk/policy placement,
    // and Buffer as the one non-persistent routing exception. System* virtual
    // engines (for example system.columns / system.data_type_families) expose
    // none of these signals and are therefore visibly disabled in Storage.
    if (!summary) return false;
    if (isBufferSummary(summary)) return true;
    if (isMergeTreeSummary(summary) || isLogFamilySummary(summary)) return true;
    if (String(summary.storage_policy || "").trim()) return true;
    if (Array.isArray(summary.disks) && summary.disks.length > 0) return true;
    return false;
  }


  function summaryFootprintBytes(summary) {
    if (!summary) return null;
    const raw = summary?.bytes != null
      ? summary.bytes
      : (isResidentMemorySummary(summary)
        ? summary.resident_bytes
        : (summary.logical_bytes ?? summary.compressed_bytes));
    if (raw == null) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : null;
  }

  function summaryRowsLabel(summary, { compact = false } = {}) {
    if (!summary || summary.rows == null) return null;
    const value = compact ? fmtCompactInt(summary.rows) : fmtInt(summary.rows);
    return isBufferSummary(summary) ? `${value} buffered rows` : `${value} rows`;
  }

  function sizeLabelForSummary(summary) {
    return isMergeTreeSummary(summary) ? "Compressed" : "Size";
  }

  function humanEngine(engine) {
    const value = String(engine || "");
    const compact = value.toLowerCase().replace(/[^a-z0-9]/g, "");
    const labels = {
      mergetree: "Merge Tree",
      replacingmergetree: "Replacing Merge Tree",
      summingmergetree: "Summing Merge Tree",
      aggregatingmergetree: "Aggregating Merge Tree",
      collapsingmergetree: "Collapsing Merge Tree",
      versionedcollapsingmergetree: "Versioned Collapsing Merge Tree",
      replicatedmergetree: "Replicated Merge Tree",
      replicatedreplacingmergetree: "Replicated Replacing Merge Tree",
      replicatedsummingmergetree: "Replicated Summing Merge Tree",
      replicatedaggregatingmergetree: "Replicated Aggregating Merge Tree",
      materializedview: "Materialized View",
      parameterizedview: "Parameterized View",
      view: "View",
      distributed: "Distributed",
      dictionary: "Dictionary",
      memory: "Memory",
      buffer: "Buffer",
      tinylog: "Tiny Log",
      stripelog: "Stripe Log",
      log: "Log",
    };
    return labels[compact] || value.replace(/([a-z0-9])([A-Z])/g, "$1 $2") || "metadata pending";
  }

  function isViewLikeSummary(summary) {
    const engine = String(summary?.engine || "").toLowerCase().replace(/[^a-z]/g, "");
    return engine === "view" || engine === "parameterizedview" || engine === "materializedview";
  }

  function visibleDependencies(detail) {
    return (detail?.dependencies || []).filter((d) => !/^_?row$/i.test(String(d.table || "")));
  }

  function isEmptyRowSummary(summary) {
    return optionalNumber(summary?.rows) === 0;
  }

  function availableTabs(detail) {
    if (isViewLikeSummary(detail?.summary)) return ["Overview"];
    const summary = detail?.summary || {};
    // An empty table has nothing useful to preview or inspect physically. Keep
    // Overview for identity/lineage/DDL, but do not expose empty Data/Storage
    // surfaces or their zero-value breakdowns.
    if (isEmptyRowSummary(summary)) return ["Overview"];
    const tabs = ["Overview", "Data"];
    const hasStorage = isMergeTreeSummary(summary) || isDistributedSummary(summary) || isLogFamilySummary(summary);
    if (hasStorage) tabs.push("Storage");
    else if (!isDictionarySummary(summary)) tabs.push("Operations");
    return tabs;
  }

  function visibleFunctions() {
    const q = String(dom.explorerFunctionSearchInput?.value || "").trim().toLowerCase();
    const kind = String(dom.explorerFunctionCategorySelect?.value || "");
    const items = (model.functionsCatalog?.functions || []).filter((item) => {
      if (kind === "user-defined" && !item.user_defined) return false;
      if (kind && kind !== "user-defined" && item.kind !== kind) return false;
      if (!q) return true;
      return String(item.name || "").toLowerCase().includes(q);
    });
    if (!q) return items;
    const rank = (item) => {
      const name = String(item.name || "").toLowerCase();
      if (name === q) return 0;
      if (name.startsWith(q)) return 1;
      if (name.split(/[^a-z0-9_]+/).some((part) => part.startsWith(q))) return 2;
      if (name.includes(q)) return 3;
      return 4;
    };
    return items.sort((a, b) => rank(a) - rank(b) || String(a.name || "").localeCompare(String(b.name || "")));
  }

  function functionKey(item) {
    return `${item.kind || "Function"}\0${item.name || ""}`;
  }

  function functionCategory(item) {
    let value = String(item?.category || "").trim();
    // system.functions.categories is represented as text by the native client
    // on some versions. Keep the first meaningful category for navigation.
    value = value.replace(/^\[|\]$/g, "").trim();
    const first = value.split(",").map((part) => part.trim().replace(/^['\"]|['\"]$/g, "")).find(Boolean);
    return first || String(item?.kind || "Functions");
  }

  function functionOrigin(item) {
    if (item?.user_defined) return "User-defined";
    const origin = String(item?.origin || "System").trim();
    return origin || "System";
  }

  function uniqueMetaBits(values) {
    const seen = new Set();
    const out = [];
    for (const raw of values) {
      const value = String(raw || "").trim();
      if (!value) continue;
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(value);
    }
    return out;
  }

  function safeDocHref(raw) {
    if (model.functionsCatalog?.markdown_links_enabled !== true) return null;
    const value = String(raw || "").trim();
    if (value.startsWith("/") && !value.startsWith("//")) return `https://clickhouse.com/docs${value}`;
    if (value.startsWith("./")) return `https://clickhouse.com/docs/${value.slice(2)}`;
    return null;
  }

  function renderHighlightedCode(codeEl, source) {
    const text = String(source || "");
    // Reuse the exact SQL lexer/highlighter used by the Query editor. This is
    // important for CREATE statements: identifiers stay identifiers, while
    // functions are highlighted only when they are known functions followed
    // by `(`, using the selected host's function metadata.
    if (ns.highlight && typeof ns.highlight.renderInto === "function") {
      ns.highlight.renderInto(codeEl, text);
      return;
    }
    codeEl.textContent = text;
  }

  function appendMarkdownInline(parent, text) {
    const source = String(text || "");
    const re = /\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*/g;
    let cursor = 0;
    for (const match of source.matchAll(re)) {
      if (match.index > cursor) parent.appendChild(document.createTextNode(source.slice(cursor, match.index)));
      if (match[1] != null) {
        const href = safeDocHref(match[2]);
        if (href) {
          const a = node("a", "functionDoc__link", match[1]);
          a.href = href;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          parent.appendChild(a);
        } else {
          parent.appendChild(document.createTextNode(match[1]));
        }
      } else if (match[3] != null) {
        parent.appendChild(node("code", "functionDoc__inlineCode", match[3]));
      } else if (match[4] != null) {
        parent.appendChild(node("strong", "", match[4]));
      }
      cursor = match.index + match[0].length;
    }
    if (cursor < source.length) parent.appendChild(document.createTextNode(source.slice(cursor)));
  }

  function renderSafeMarkdown(container, markdown) {
    clear(container);
    const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
    let paragraph = [];
    let list = null;
    let code = null;
    const flushParagraph = () => {
      if (!paragraph.length) return;
      const p = node("p", "functionDoc__paragraph");
      appendMarkdownInline(p, paragraph.join(" ").trim());
      container.appendChild(p);
      paragraph = [];
    };
    const closeList = () => { list = null; };
    for (const rawLine of lines) {
      const line = rawLine.replace(/\s+$/, "");
      if (code) {
        if (/^\s*```/.test(line)) {
          const source = code.lines.join("\n");
          renderHighlightedCode(code.code, source);
          container.appendChild(code.wrap);
          code = null;
        } else {
          code.lines.push(rawLine);
        }
        continue;
      }
      const fence = line.match(/^\s*```\s*([\w+-]*)/);
      if (fence) {
        flushParagraph(); closeList();
        const wrap = node("pre", "functionDoc__code");
        const codeEl = node("code", fence[1] ? `language-${fence[1]}` : "");
        wrap.appendChild(codeEl);
        code = { wrap, code: codeEl, lines: [] };
        continue;
      }
      const heading = line.match(/^\s*(#{1,4})\s+(.+)$/);
      if (heading) {
        flushParagraph(); closeList();
        const h = document.createElement(heading[1].length <= 2 ? "h3" : "h4");
        h.className = "functionDoc__heading";
        appendMarkdownInline(h, heading[2]);
        container.appendChild(h);
        continue;
      }
      const bullet = line.match(/^\s*[-*]\s+(.+)$/);
      if (bullet) {
        flushParagraph();
        if (!list) { list = node("ul", "functionDoc__list"); container.appendChild(list); }
        const li = document.createElement("li"); appendMarkdownInline(li, bullet[1]); list.appendChild(li);
        continue;
      }
      if (!line.trim()) { flushParagraph(); closeList(); continue; }
      closeList(); paragraph.push(line.trim());
    }
    if (code) {
      const source = code.lines.join("\n");
      renderHighlightedCode(code.code, source);
      container.appendChild(code.wrap);
    }
    flushParagraph();
  }

  function splitFunctionDocumentation(markdown) {
    const buckets = { description: [], syntax: [], arguments: [], returns: [], examples: [], seeAlso: [] };
    let current = "description";
    const matchSection = (line) => {
      const cleaned = String(line || "")
        .replace(/^\s*#{1,6}\s*/, "")
        .replace(/^\s*\*\*/, "").replace(/\*\*\s*:?\s*$/, "")
        .replace(/:\s*$/, "").trim().toLowerCase();
      if (/^syntax$/.test(cleaned)) return "syntax";
      if (/^arguments?$|^parameters?$/.test(cleaned)) return "arguments";
      if (/^returns?$|^returned value$|^return value$/.test(cleaned)) return "returns";
      if (/^examples?$|^usage$/.test(cleaned)) return "examples";
      if (/^see also$|^related$|^references?$/.test(cleaned)) return "seeAlso";
      return null;
    };
    for (const line of String(markdown || "").replace(/\r\n?/g, "\n").split("\n")) {
      const next = matchSection(line);
      if (next) { current = next; continue; }
      buckets[current].push(line);
    }
    return Object.fromEntries(Object.entries(buckets).map(([key, value]) => [key, value.join("\n").trim()]));
  }

  function appendFunctionDocSection(root, title, content, { code = false } = {}) {
    if (!String(content || "").trim()) return;
    const section = node("section", "functionDoc__section");
    section.appendChild(node("h3", "functionDoc__sectionTitle", title));
    if (code) {
      const pre = node("pre", "functionDoc__code");
      const codeEl = node("code", "language-sql");
      renderHighlightedCode(codeEl, String(content || ""));
      pre.appendChild(codeEl);
      section.appendChild(pre);
    } else {
      const body = node("div", "functionDoc__markdown");
      renderSafeMarkdown(body, content);
      section.appendChild(body);
    }
    root.appendChild(section);
  }

  function renderFunctionDetail() {
    const item = (model.functionsCatalog?.functions || []).find((candidate) => functionKey(candidate) === model.selectedFunctionKey) || null;
    if (dom.explorerFunctionEmpty) dom.explorerFunctionEmpty.hidden = !!item;
    if (dom.explorerFunctionDetail) dom.explorerFunctionDetail.hidden = !item;
    if (!item) return;
    if (dom.explorerFunctionDetailName) dom.explorerFunctionDetailName.textContent = item.name || "Function";
    if (dom.explorerFunctionDetailMeta) {
      const bits = uniqueMetaBits([functionOrigin(item), functionCategory(item), item.kind || "Function"]);
      dom.explorerFunctionDetailMeta.textContent = bits.join(" · ");
    }
    if (!dom.explorerFunctionDescription) return;

    clear(dom.explorerFunctionDescription);
    const sections = splitFunctionDocumentation(item.description || "");
    const description = sections.description || (item.description || "");
    if (description) appendFunctionDocSection(dom.explorerFunctionDescription, "Description", description);
    appendFunctionDocSection(dom.explorerFunctionDescription, "Syntax", item.syntax || sections.syntax, { code: true });
    const argumentsDoc = [item.arguments, item.parameters].filter((value) => String(value || "").trim()).join("\n\n");
    appendFunctionDocSection(dom.explorerFunctionDescription, "Arguments", argumentsDoc || sections.arguments);
    appendFunctionDocSection(dom.explorerFunctionDescription, "Returns", item.returned_value || sections.returns);
    appendFunctionDocSection(dom.explorerFunctionDescription, "Examples", item.examples || sections.examples);
    appendFunctionDocSection(dom.explorerFunctionDescription, "See also", sections.seeAlso);
    if (item.introduced_in) appendFunctionDocSection(dom.explorerFunctionDescription, "Introduced", `ClickHouse ${item.introduced_in}`);

    const aliases = Array.isArray(item.alias_documents) ? item.alias_documents : [];
    for (const aliased of aliases) {
      if (!aliased || !aliased.name) continue;
      const aliasSection = node("section", "functionDoc__section functionDoc__alias");
      aliasSection.appendChild(node("h3", "functionDoc__sectionTitle", `Alias documentation · ${aliased.name}`));
      const aliasSections = splitFunctionDocumentation(aliased.description || "");
      const aliasDescription = aliasSections.description || (aliased.description || "");
      if (aliasDescription) appendFunctionDocSection(aliasSection, "Description", aliasDescription);
      appendFunctionDocSection(aliasSection, "Syntax", aliased.syntax || aliasSections.syntax, { code: true });
      const aliasArguments = [aliased.arguments, aliased.parameters].filter((value) => String(value || "").trim()).join("\n\n");
      appendFunctionDocSection(aliasSection, "Arguments", aliasArguments || aliasSections.arguments);
      appendFunctionDocSection(aliasSection, "Returns", aliased.returned_value || aliasSections.returns);
      appendFunctionDocSection(aliasSection, "Examples", aliased.examples || aliasSections.examples);
      if (aliased.introduced_in) appendFunctionDocSection(aliasSection, "Introduced", `ClickHouse ${aliased.introduced_in}`);
      dom.explorerFunctionDescription.appendChild(aliasSection);
    }
    if (!dom.explorerFunctionDescription.childElementCount) {
      dom.explorerFunctionDescription.appendChild(node("div", "explorerEmptySection", "Documentation unavailable on this server."));
    }
  }

  function renderFunctionList() {
    if (!dom.explorerFunctionList) return;
    const items = visibleFunctions();
    clear(dom.explorerFunctionList);
    if (!items.length) {
      dom.explorerFunctionList.appendChild(node("div", "explorerListEmpty", model.loadingFunctions ? "Loading…" : "No functions found"));
      renderFunctionDetail();
      return;
    }
    const searching = !!String(dom.explorerFunctionSearchInput?.value || "").trim();
    const groups = new Map();
    for (const item of items) {
      const category = functionCategory(item);
      if (!groups.has(category)) groups.set(category, []);
      groups.get(category).push(item);
    }
    for (const [category, groupItems] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const section = node("section", "explorerTreeGroup explorerFunctionGroup");
      const selectedInGroup = groupItems.some((item) => functionKey(item) === model.selectedFunctionKey);
      const expanded = searching || selectedInGroup || model.expandedFunctionCategories.has(category);
      const row = node("div", "explorerTreeDatabaseRow");
      const toggle = node("button", "explorerTreeDatabaseToggle", expanded ? "⌄" : "›");
      toggle.type = "button";
      toggle.setAttribute("aria-label", `${expanded ? "Collapse" : "Expand"} ${category}`);
      toggle.setAttribute("aria-expanded", String(expanded));
      const header = node("button", "explorerTreeDatabase");
      header.type = "button";
      header.appendChild(node("span", "explorerTreeDatabase__name", category));
      const toggleGroup = () => {
        if (model.expandedFunctionCategories.has(category)) model.expandedFunctionCategories.delete(category);
        else model.expandedFunctionCategories.add(category);
        renderFunctionList();
      };
      toggle.addEventListener("click", toggleGroup);
      header.addEventListener("click", toggleGroup);
      row.append(toggle, header);
      section.appendChild(row);
      if (expanded) {
        const children = node("div", "explorerTreeChildren");
        for (const item of groupItems.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")))) {
          const key = functionKey(item);
          const button = node("button", "explorerTreeObject explorerFunctionObject");
          button.type = "button";
          button.classList.toggle("is-selected", key === model.selectedFunctionKey);
          const labels = node("span", "explorerTreeObject__labels");
          labels.append(node("span", "explorerTreeObject__name", item.name || "—"), node("span", "explorerTreeObject__meta", uniqueMetaBits([functionOrigin(item), item.kind || "Function"]).join(" · ")));
          button.append(node("span", "explorerTreeObject__icon explorerTreeObject__icon--function", "ƒ"), labels);
          button.addEventListener("click", () => {
            model.selectedFunctionKey = key;
            model.expandedFunctionCategories.add(category);
            renderFunctionList();
            renderFunctionDetail();
            syncExplorerUrl("push");
          });
          children.appendChild(button);
        }
        section.appendChild(children);
      }
      dom.explorerFunctionList.appendChild(section);
    }
    renderFunctionDetail();
  }

  async function refreshFunctions(force) {
    if (!model.active || model.loadingFunctions) return;
    const hostId = String(state.selectedHostId || "");
    if (!hostId) return;
    if (!force && model.functionsCatalog) {
      renderFunctionList();
      renderFunctionDetail();
      return;
    }
    model.loadingFunctions = true;
    setError(null);
    if (dom.explorerFunctionRefreshButton) dom.explorerFunctionRefreshButton.disabled = true;
    renderFunctionList();
    try {
      const payload = await api.getExplorerFunctions(hostId, !!force);
      if (String(state.selectedHostId || "") !== hostId || !model.active || model.section !== "functions") return;
      model.functionsCatalog = payload;
      const keys = new Set((payload?.functions || []).map(functionKey));
      if (!keys.has(model.selectedFunctionKey)) model.selectedFunctionKey = null;
      const route = model.routeIntent;
      if (route?.workspace === "explorer" && route.section === "functions") model.routeIntent = null;
      if (route?.workspace === "explorer" && route.section === "functions" && route.functionName) {
        const item = (payload?.functions || []).find((candidate) => candidate.name === route.functionName) || null;
        if (!item) throw new Error(`Explorer function route is not visible: ${route.functionName}`);
        model.selectedFunctionKey = functionKey(item);
      }
      renderFunctionList();
    } catch (e) {
      setError(e);
      model.functionsCatalog = null;
      model.selectedFunctionKey = null;
      renderFunctionList();
    } finally {
      model.loadingFunctions = false;
      if (dom.explorerFunctionRefreshButton) dom.explorerFunctionRefreshButton.disabled = false;
    }
  }

  function mergeDatabaseCatalog(database, payload) {
    if (!model.catalog) model.catalog = { databases: [], tables: [] };
    const name = String(database || "");
    const databases = new Set([...(model.catalog.databases || []), ...(payload?.databases || []), name].filter(Boolean));
    const retained = (model.catalog.tables || []).filter((table) => String(table.database || "") !== name);
    model.catalog = {
      ...model.catalog,
      databases: [...databases].sort((a, b) => a.localeCompare(b)),
      tables: retained.concat(Array.isArray(payload?.tables) ? payload.tables : []),
    };
  }

  async function loadDatabaseTables(database, force = false) {
    const name = String(database || "");
    if (!name || !model.active) return;
    if (!force && model.databaseTablesLoaded.has(name)) return;
    const existing = model.databaseLoadPromises.get(name);
    if (existing) return existing;
    const hostId = String(state.selectedHostId || "");
    if (!hostId) return;

    const promise = (async () => {
      model.databaseTablesLoading.add(name);
      model.databaseLoadErrors.delete(name);
      renderTableList();
      try {
        const payload = await api.getExplorerCatalog(hostId, name, !!force);
        if (!model.active || String(state.selectedHostId || "") !== hostId) return;
        mergeDatabaseCatalog(name, payload);
        model.databaseTablesLoaded.add(name);
        renderTableList();
        if (model.selectedDatabase === name && model.mode !== "graph") renderDatabaseDetail(name);
      } catch (error) {
        if (!model.active || String(state.selectedHostId || "") !== hostId) return;
        model.databaseLoadErrors.set(name, error);
        renderTableList();
        if (model.selectedDatabase === name && model.mode !== "graph") renderDatabaseDetail(name);
      } finally {
        model.databaseTablesLoading.delete(name);
        model.databaseLoadPromises.delete(name);
        renderTableList();
      }
    })();
    model.databaseLoadPromises.set(name, promise);
    return promise;
  }

  function catalogHasDatabase(name) {
    const target = String(name || "");
    return (model.catalog?.databases || []).some((item) => String(item || "") === target)
      || (model.catalog?.tables || []).some((item) => String(item.database || "") === target);
  }

  function renderDatabaseDetail(database) {
    const name = String(database || "");
    const tables = (model.catalog?.tables || [])
      .filter((item) => item.database === name && sidebarObjectVisible(item))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!name || !catalogHasDatabase(name)) {
      if (dom.explorerEmptyState) {
        dom.explorerEmptyState.hidden = false;
        dom.explorerEmptyState.replaceChildren(node("strong", "", "Database unavailable"), node("span", "", name || "Unknown database"));
      }
      if (dom.explorerDetail) dom.explorerDetail.hidden = true;
      return;
    }

    if (!model.databaseTablesLoaded.has(name)) {
      if (dom.explorerEmptyState) {
        dom.explorerEmptyState.hidden = false;
        const error = model.databaseLoadErrors.get(name);
        dom.explorerEmptyState.replaceChildren(
          node("strong", "", error ? "Unable to load database" : "Loading tables…"),
          node("span", "", error?.message || name),
        );
      }
      if (dom.explorerDetail) dom.explorerDetail.hidden = true;
      if (!model.databaseTablesLoading.has(name)) void loadDatabaseTables(name);
      return;
    }

    if (dom.explorerEmptyState) dom.explorerEmptyState.hidden = true;
    if (dom.explorerDetail) dom.explorerDetail.hidden = false;
    if (dom.explorerDetailName) dom.explorerDetailName.textContent = name;
    if (dom.explorerDetailMeta) {
      const databaseSummary = (model.catalog?.database_summaries || []).find((item) => String(item?.name || "") === name) || null;
      const meta = [`${fmtInt(tables.length)} tables`];
      if (databaseSummary && Number.isFinite(Number(databaseSummary.bytes))) meta.push(fmtStorageBytes(databaseSummary.bytes));
      dom.explorerDetailMeta.textContent = meta.join(" · ");
    }
    if (dom.explorerHealthBadge) { dom.explorerHealthBadge.hidden = true; dom.explorerHealthBadge.textContent = ""; }
    if (dom.explorerWarnings) { dom.explorerWarnings.hidden = true; dom.explorerWarnings.replaceChildren(); }
    if (dom.explorerSummaryCards) { dom.explorerSummaryCards.hidden = true; dom.explorerSummaryCards.replaceChildren(); }
    if (dom.explorerDetailTabs) { dom.explorerDetailTabs.hidden = true; dom.explorerDetailTabs.replaceChildren(); }
    if (!dom.explorerDetailContent) return;
    clear(dom.explorerDetailContent);

    const list = node("div", "explorerDatabaseDetailTables");
    for (const table of tables) {
      const button = node("button", "explorerDatabaseDetailTable");
      button.type = "button";
      const labels = node("span", "explorerDatabaseDetailTable__labels");
      const footprint = summaryFootprintBytes(table);
      const stats = [summaryRowsLabel(table, { compact: true }), footprint == null ? null : util.formatBytes(footprint)].filter(Boolean).join(" · ");
      labels.append(node("strong", "", table.name), node("span", "", humanEngine(table.engine)));
      button.append(labels, node("span", "explorerDatabaseDetailTable__stats", stats || "—"));
      button.addEventListener("click", () => void selectTable(table.database, table.name));
      list.appendChild(button);
    }
    dom.explorerDetailContent.appendChild(list);
  }

  function selectDatabase(database, { historyMode = "push", expand = true } = {}) {
    const name = String(database || "");
    if (!name || !catalogHasDatabase(name)) {
      setError(new Error(`Explorer database is not visible: ${name || "unknown"}`));
      return;
    }
    model.selectedDatabase = name;
    model.detailSerial += 1;
    model.detailLoading = false;
    model.selectedKey = null;
    model.detail = null;
    model.preview = null;
    if (expand) model.expandedDatabases.add(name);
    else model.expandedDatabases.delete(name);
    setError(null);
    syncVisibilityOptionLocks({ propagate: true });
    renderTableList();
    if (model.mode === "graph") graph?.focusDatabase?.(name);
    else renderDatabaseDetail(name);
    if (!model.databaseTablesLoaded.has(name)) void loadDatabaseTables(name);
    syncExplorerUrl(historyMode);
  }

  function healthLabel(table) {
    const health = String(table?.health || "healthy");
    return health === "error" ? "Error" : health === "warning" ? "Warning" : "Healthy";
  }

  function renderTableList() {
    if (!dom.explorerTableList) return;
    clear(dom.explorerTableList);
    const catalog = model.catalog;
    const databases = [...new Set([
      ...(catalog?.databases || []),
      ...(catalog?.tables || []).map((table) => String(table.database || "")),
    ].filter(Boolean))]
      .filter((database) => model.includeSystem || !["system", "information_schema", "INFORMATION_SCHEMA"].includes(database))
      .sort((a, b) => a.localeCompare(b));

    if (!databases.length) {
      dom.explorerTableList.appendChild(node("div", "explorerListEmpty", model.loadingCatalog ? "Loading…" : "No accessible databases"));
      return;
    }

    const query = String(dom.explorerSearchInput?.value || "").trim().toLowerCase();
    for (const database of databases) {
      const allItems = (catalog?.tables || []).filter((table) => table.database === database && sidebarObjectVisible(table));
      const items = allItems.filter((table) => !query || `${table.database}.${table.name} ${table.engine || ""}`.toLowerCase().includes(query));
      const loaded = model.databaseTablesLoaded.has(database);
      const loading = model.databaseTablesLoading.has(database);
      const expanded = model.expandedDatabases.has(database);
      const section = node("section", "explorerTreeGroup");
      const header = node("div", `explorerTreeDatabaseRow${model.selectedDatabase === database ? " is-selected" : ""}`);
      const toggle = node("button", "explorerTreeDatabaseToggle", expanded ? "⌄" : "›");
      toggle.type = "button";
      toggle.setAttribute("aria-label", `${expanded ? "Collapse" : "Expand"} ${database}`);
      toggle.setAttribute("aria-expanded", String(expanded));
      toggle.addEventListener("click", (event) => {
        event.stopPropagation();
        if (expanded) {
          const selectedTableInDatabase = typeof model.selectedKey === "string" && model.selectedKey.startsWith(`${database}\0`);
          const selectedDatabase = model.selectedDatabase === database;
          if (selectedTableInDatabase || selectedDatabase) {
            // Collapsing the branch that currently owns the detail view should
            // never leave a hidden table selected. Switch to the database view
            // while keeping the branch collapsed.
            selectDatabase(database, { expand: false });
            return;
          }
          model.expandedDatabases.delete(database);
        } else {
          model.expandedDatabases.add(database);
          if (!loaded) void loadDatabaseTables(database);
        }
        renderTableList();
      });
      const headerMain = node("button", "explorerTreeDatabase");
      headerMain.type = "button";
      const databaseSummary = (catalog?.database_summaries || []).find((item) => String(item?.name || "") === database) || null;
      const databaseMeta = [];
      if (loading) databaseMeta.push("Loading…");
      else if (loaded) databaseMeta.push(`${fmtInt(allItems.length)} tables`);
      else if (databaseSummary && Number.isFinite(Number(databaseSummary.tables))) databaseMeta.push(`${fmtInt(databaseSummary.tables)} tables`);
      else databaseMeta.push("Tables");
      if (databaseSummary && Number.isFinite(Number(databaseSummary.bytes))) databaseMeta.push(fmtStorageBytes(databaseSummary.bytes));
      headerMain.append(
        node("span", "explorerTreeDatabase__name", database),
        node("span", "explorerTreeDatabase__count", databaseMeta.join(" · ")),
      );
      headerMain.addEventListener("click", () => selectDatabase(database));
      header.append(toggle, headerMain);
      section.appendChild(header);

      if (expanded) {
        const children = node("div", "explorerTreeChildren");
        if (loading && !loaded) {
          children.appendChild(node("div", "explorerListEmpty", "Loading tables…"));
        } else if (model.databaseLoadErrors.has(database) && !loaded) {
          children.appendChild(node("div", "explorerListEmpty", "Unable to load tables"));
        } else if (loaded && !items.length) {
          children.appendChild(node("div", "explorerListEmpty", query ? "No matching tables" : "No accessible tables or views"));
        } else {
          for (const table of items.sort((a, b) => a.name.localeCompare(b.name))) {
            const key = `${table.database}\0${table.name}`;
            const button = node("button", "explorerTreeObject");
            button.type = "button";
            button.classList.toggle("is-selected", key === model.selectedKey);
            button.dataset.database = table.database;
            button.dataset.table = table.name;
            const icon = node("span", `explorerTreeObject__icon explorerTreeObject__icon--${objectKind(table).toLowerCase().replace(/[^a-z]+/g, "-")}`, objectKind(table) === "Table" ? "▦" : objectKind(table) === "View" ? "◇" : objectKind(table) === "Materialized View" ? "◆" : "◈");
            const labels = node("span", "explorerTreeObject__labels");
            const footprint = summaryFootprintBytes(table);
            const stats = [
              summaryRowsLabel(table, { compact: true }),
              footprint == null ? null : util.formatBytes(footprint),
            ].filter(Boolean).join(" · ");
            labels.append(
              node("span", "explorerTreeObject__name", table.name),
              node("span", "explorerTreeObject__meta", [humanEngine(table.engine), stats].filter(Boolean).join(" · ")),
            );
            button.append(icon, labels);
            const storageBlocked = model.mode === "graph" && graph?.isStorageMode?.() && !storageCatalogEligible(table);
            button.disabled = !!storageBlocked;
            button.classList.toggle("is-storage-blocked", !!storageBlocked);
            if (storageBlocked) button.title = "This object does not store data and has no storage topology.";
            button.addEventListener("click", () => { if (!button.disabled) void selectTable(table.database, table.name); });
            children.appendChild(button);
          }
        }
        section.appendChild(children);
        if (!loaded && !loading) queueMicrotask(() => void loadDatabaseTables(database));
      }
      dom.explorerTableList.appendChild(section);
    }
  }

  function catalogContainsTable(payload, database, table) {
    return (payload?.tables || []).some((item) => item.database === database && item.name === table);
  }

  async function refreshCatalog(force) {
    if (!model.active || model.loadingCatalog) return;
    const hostId = String(state.selectedHostId || "");
    if (!hostId) return;
    model.loadingCatalog = true;
    setError(null);
    if (dom.explorerRefreshButton) dom.explorerRefreshButton.disabled = true;
    renderTableList();
    try {
      const payload = await api.getExplorerCatalog(hostId, "", !!force);
      if (String(state.selectedHostId || "") !== hostId || !model.active) return;

      const previousTables = force ? [] : (model.catalog?.tables || []);
      model.catalog = { ...payload, tables: previousTables };
      if (force) {
        model.databaseTablesLoaded.clear();
        model.databaseLoadErrors.clear();
      }
      renderTableList();
      if (model.mode === "graph") graph?.onScopeChanged();

      const route = model.routeIntent;
      if (route?.workspace === "explorer" && route.section === "tables") {
        model.routeIntent = null;
        if (route.database) {
          model.expandedDatabases.add(route.database);
          await loadDatabaseTables(route.database, !!force);
        }
        if (route.database && route.table) {
          if (!catalogContainsTable(model.catalog, route.database, route.table) && !force) {
            await loadDatabaseTables(route.database, true);
          }
          if (!catalogContainsTable(model.catalog, route.database, route.table)) {
            throw new Error(`Explorer route object is not visible: ${route.database}.${route.table}`);
          }
          model.tab = route.tab || "Overview";
          await selectTable(route.database, route.table, false, { historyMode: "none" });
        } else if (route.database) {
          selectDatabase(route.database, { historyMode: "none" });
        }
      }

      if (force) {
        const expanded = [...model.expandedDatabases];
        for (const database of expanded) await loadDatabaseTables(database, true);
        if (model.selectedKey) {
          const [database, table] = model.selectedKey.split("\0");
          if (database && table) await selectTable(database, table, true);
        }
      }
    } catch (e) {
      setError(e);
      if (!model.catalog) model.catalog = null;
      renderTableList();
    } finally {
      model.loadingCatalog = false;
      if (dom.explorerRefreshButton) dom.explorerRefreshButton.disabled = false;
    }
  }

  function summaryCard(label, value, sub) {
    const card = node("div", "explorerSummaryCard");
    card.append(node("div", "explorerSummaryCard__label", label), node("div", "explorerSummaryCard__value", value));
    if (sub) card.appendChild(node("div", "explorerSummaryCard__sub", sub));
    return card;
  }

  function renderDetailHeader() {
    const detail = model.detail;
    if (!detail) return;
    const s = detail.summary || {};
    if (dom.explorerEmptyState) dom.explorerEmptyState.hidden = true;
    if (dom.explorerDetail) dom.explorerDetail.hidden = false;
    if (dom.explorerDetailName) dom.explorerDetailName.textContent = `${s.database || ""}.${s.name || ""}`;
    if (dom.explorerDetailMeta) {
      const viewLike = isViewLikeSummary(s);
      const partCount = Number(s.active_parts || 0);
      const partitionCount = Number(s.partitions || 0);
      const footprint = summaryFootprintBytes(s);
      const stats = [
        humanEngine(s.engine),
        detail.metric_scope || "local-replica",
        s.health ? healthLabel(s).toLowerCase() : null,
        !viewLike ? summaryRowsLabel(s) : null,
        !viewLike && footprint != null ? (isResidentMemorySummary(s) ? `${fmtBytes(footprint)} RAM` : `${fmtBytes(footprint)} on disk`) : null,
        !viewLike && partCount > 0 ? `${fmtInt(partCount)} part${partCount === 1 ? "" : "s"}` : null,
        !viewLike && partitionCount > 0 ? `${fmtInt(partitionCount)} partition${partitionCount === 1 ? "" : "s"}` : null,
        !viewLike && s.client_ingress?.rows_per_second_1m != null ? `${fmtRate(s.client_ingress.rows_per_second_1m, "rows/s")} in` : null,
      ].filter(Boolean);
      dom.explorerDetailMeta.textContent = stats.join(" · ");
    }
    if (dom.explorerHealthBadge) {
      dom.explorerHealthBadge.hidden = true;
      dom.explorerHealthBadge.textContent = "";
    }
    if (dom.explorerWarnings) {
      const warnings = Array.isArray(s.warnings) ? s.warnings : [];
      dom.explorerWarnings.hidden = !warnings.length;
      dom.explorerWarnings.replaceChildren(...warnings.map((warning) => node("div", "explorerWarning", warning)));
    }
    if (dom.explorerSummaryCards) {
      dom.explorerSummaryCards.hidden = true;
      dom.explorerSummaryCards.replaceChildren();
    }
  }

  function renderTabs() {
    if (!dom.explorerDetailTabs) return;
    const tabs = availableTabs(model.detail);
    if (!tabs.includes(model.tab)) model.tab = "Overview";
    if (tabs.length <= 1) {
      dom.explorerDetailTabs.hidden = true;
      dom.explorerDetailTabs.replaceChildren();
      return;
    }
    dom.explorerDetailTabs.hidden = false;
    const buttons = [];
    for (const label of tabs) {
      const button = node("button", `explorerDetailTab${model.tab === label ? " is-active" : ""}`, label);
      button.type = "button";
      button.role = "tab";
      button.setAttribute("aria-selected", String(model.tab === label));
      button.addEventListener("click", () => {
        model.tab = label;
        renderTabs();
        renderTabContent();
        syncExplorerUrl("push");
      });
      buttons.push(button);
    }
    dom.explorerDetailTabs.replaceChildren(...buttons);
  }

  function dataTable(headers, rows, classes = "") {
    const wrap = node("div", `explorerDataTableWrap ${classes}`.trim());
    const table = node("table", "explorerDataTable");
    const thead = document.createElement("thead");
    const trh = document.createElement("tr");
    for (const header of headers) trh.appendChild(node("th", "", header));
    thead.appendChild(trh);
    const tbody = document.createElement("tbody");
    for (const values of rows) {
      const tr = document.createElement("tr");
      for (const value of values) tr.appendChild(node("td", "", value == null ? "—" : value));
      tbody.appendChild(tr);
    }
    table.append(thead, tbody);
    wrap.appendChild(table);
    return wrap;
  }

  function sectionUnavailable(name) {
    const unavailable = new Set(model.detail?.unavailable_sections || []);
    return unavailable.has(name);
  }

  function unavailableMessage(label) {
    return node("div", "explorerUnavailable", `${label} is unavailable on this server or is not enabled.`);
  }

  function extractTableTtl(detail) {
    const ddl = String(detail?.formatted_ddl || detail?.ddl || "");
    if (!ddl) return "";
    const match = ddl.match(/(?:^|\n)TTL\s+([\s\S]*?)(?=\n(?:SETTINGS|COMMENT|AS\s+SELECT|POPULATE|EMPTY\s+AS)\b|;?\s*$)/i);
    return match ? String(match[1] || "").trim().replace(/\s+/g, " ") : "";
  }

  function formatStructuredType(type) {
    const text = String(type || "").trim();
    if (!text) return "—";
    if (!/\n/.test(text) && !/(Tuple\(|Array\(Tuple\(|Map\(|Enum(?:8|16)\()/.test(text)) return text;
    let depth = 0;
    let out = "";
    const indent = () => "    ".repeat(Math.max(0, depth));
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      out += ch;
      if (ch === "(") {
        depth += 1;
        const ahead = text.slice(i + 1);
        if (/^\s*(?:[A-Za-z_`]|Tuple\(|Map\(|Array\()/u.test(ahead)) out += `\n${indent()}`;
      } else if (ch === ",") {
        out += `\n${indent()}`;
      } else if (ch === ")") {
        depth = Math.max(0, depth - 1);
        out = out.replace(/\n\s*\)$/, `\n${indent()})`);
      }
    }
    return out.replace(/\n{3,}/g, "\n\n");
  }

  function percentValue(value, total) {
    const v = Number(value);
    const t = Number(total);
    if (!Number.isFinite(v) || !Number.isFinite(t) || t <= 0) return null;
    return Math.max(0, Math.min(100, (v / t) * 100));
  }

  function fmtPercent(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    if (n > 0 && n < 0.1) return "<0.1%";
    return `${n.toFixed(n < 10 ? 1 : 0)}%`;
  }

  function percentBar(value, { title = "", variant = "default", unknownText = "unknown" } = {}) {
    const pct = value == null ? Number.NaN : Number(value);
    const wrap = node("div", `explorerPercentBar explorerPercentBar--${variant}`);
    if (title) wrap.title = title;
    if (!Number.isFinite(pct)) {
      wrap.classList.add("is-unknown");
      wrap.appendChild(node("span", "explorerPercentBar__text", unknownText));
      return wrap;
    }
    const bounded = Math.max(0, Math.min(100, pct));
    const fill = node("div", "explorerPercentBar__fill");
    fill.style.width = `${bounded}%`;
    wrap.append(fill, node("span", "explorerPercentBar__text", fmtPercent(pct)));
    return wrap;
  }

  function simpleRows(items) {
    const list = node("div", "explorerSimpleList");
    for (const [label, value] of items) {
      if (value == null || value === "" || value === "—" || value === "unknown engine") continue;
      const row = node("div", "explorerSimpleRow");
      row.append(node("span", "explorerSimpleRow__label", label), node("code", "explorerSimpleRow__value", value));
      list.appendChild(row);
    }
    return list;
  }

  function optionalNumber(value) {
    if (value == null || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function renderTableFootprint(container, detail) {
    const s = detail.summary || {};
    const tableBytes = summaryFootprintBytes(s);
    const dbBytes = optionalNumber(detail?.footprint_scope?.database_bytes);
    const allBytes = optionalNumber(detail?.footprint_scope?.clickhouse_bytes);
    const list = node("div", "explorerShareList explorerShareList--footprint");

    const scopeMeter = (label, part, total, variant) => {
      const pct = part == null ? null : percentValue(part, total);
      const row = node("div", `explorerScopeMeter explorerScopeMeter--${variant}`);
      const head = node("div", "explorerScopeMeter__head");
      head.append(
        node("span", "explorerScopeMeter__label", label),
        node("code", "explorerScopeMeter__percent", pct == null ? "unknown" : fmtPercent(pct)),
        node("code", "explorerScopeMeter__bytes", part == null || total == null
          ? "unknown"
          : `${fmtStorageBytes(part)} / ${fmtStorageBytes(total)}`),
      );
      const track = node("div", "explorerScopeMeter__track");
      if (pct == null) {
        track.classList.add("is-unknown");
      } else {
        const fill = node("div", "explorerScopeMeter__fill");
        fill.style.width = `${Math.max(0, Math.min(100, Number(pct) || 0))}%`;
        track.appendChild(fill);
      }
      row.append(head, track);
      return row;
    };

    const scopeCard = node("div", "explorerScopeMeters");
    scopeCard.append(
      scopeMeter("Table / Database", tableBytes, dbBytes, "database"),
      scopeMeter("Table / ClickHouse", tableBytes, allBytes, "clickhouse"),
    );
    list.appendChild(scopeCard);

    if (isMergeTreeSummary(s)) {
      const composition = node("div", "explorerStorageCompositionCard");
      const head = node("div", "explorerStorageCompositionCard__head");
      head.append(
        node("span", "explorerStorageCompositionCard__label", "Table storage"),
        node("code", "explorerStorageCompositionCard__bytes", tableBytes == null ? "unknown" : fmtStorageBytes(tableBytes)),
      );
      composition.append(head, buildStorageComposition(detail, { embedded: true }));
      list.appendChild(composition);
    }

    container.appendChild(list);
  }

  function structureCompressedBytes(detail, prefix, summaryValue) {
    const fromSummary = optionalNumber(summaryValue);
    if (fromSummary != null) return fromSummary;
    const matching = (detail.indexes_and_projections || []).filter((item) => String(item.kind || "").startsWith(prefix));
    if (!matching.length) return 0;
    let total = 0;
    for (const item of matching) {
      const value = optionalNumber(item.compressed_bytes);
      if (value == null) return null;
      total += value;
    }
    return total;
  }

  function structureOnDiskBytes(detail, prefix) {
    const matching = (detail.indexes_and_projections || []).filter((item) => String(item.kind || "").startsWith(prefix));
    if (!matching.length) return 0;
    let total = 0;
    for (const item of matching) {
      const value = optionalNumber(item.on_disk_bytes);
      if (value == null) return null;
      total += value;
    }
    return total;
  }

  function storageComposition(detail) {
    const storage = detail.column_storage || {};
    const footprint = summaryFootprintBytes(detail.summary || {});
    const wideParts = Number(storage.wide_parts || 0);
    const compactParts = Number(storage.compact_parts || 0);
    const rawWide = wideParts > 0 ? optionalNumber(storage.wide_on_disk_bytes) : (compactParts > 0 ? 0 : null);
    const rawCompact = compactParts > 0 ? optionalNumber(storage.compact_on_disk_bytes) : (wideParts > 0 ? 0 : null);
    const projectionBytes = structureOnDiskBytes(detail, "projection:");
    // ClickHouse exposes skipping-index compressed bytes, but not a standalone
    // bytes_on_disk counter. Account those known index files explicitly; all
    // remaining parent-part overhead stays in the Wide/Compact base footprint.
    const indexBytes = structureCompressedBytes(detail, "index:", detail.summary?.secondary_indices_bytes);

    const known = [footprint, rawWide, rawCompact, projectionBytes, indexBytes].every((value) => value != null);
    if (!known || footprint <= 0) return { known: false, footprint, items: [] };

    const structureBytes = projectionBytes + indexBytes;
    if (structureBytes < 0 || structureBytes > footprint) return { known: false, footprint, items: [] };
    const baseBytes = footprint - structureBytes;
    const rawBase = rawWide + rawCompact;
    if (baseBytes > 0 && rawBase <= 0) return { known: false, footprint, items: [] };

    let wideBytes = 0;
    let compactBytes = 0;
    if (baseBytes > 0) {
      if (wideParts > 0 && compactParts <= 0) {
        wideBytes = baseBytes;
      } else if (compactParts > 0 && wideParts <= 0) {
        compactBytes = baseBytes;
      } else {
        // Allocate the reconciled parent-part residual using the exact
        // bytes_on_disk ratio of Wide vs Compact active parts. Keep one side as
        // the arithmetic remainder so the four categories sum exactly to the
        // table's bytes_on_disk footprint rather than merely approximately.
        wideBytes = baseBytes * (rawWide / rawBase);
        compactBytes = baseBytes - wideBytes;
      }
    }

    const rawItems = [
      ["Wide", wideBytes, "wide"],
      ["Compact", compactBytes, "compact"],
      ["Projections", projectionBytes, "projection"],
      ["Indexes", indexBytes, "index"],
    ];
    return {
      known: true,
      footprint,
      items: rawItems.map(([label, bytes, variant]) => ({
        label,
        bytes,
        variant,
        percent: (bytes / footprint) * 100,
      })),
    };
  }

  function buildStorageComposition(detail, { embedded = false } = {}) {
    const composition = storageComposition(detail);
    const wrap = node("div", `explorerStorageComposition explorerStorageComposition--stacked${embedded ? " is-embedded" : ""}`);
    const bar = node("div", `explorerStorageStackedBar${composition.known ? "" : " is-unknown"}`);

    if (composition.known) {
      let consumed = 0;
      const visible = composition.items.filter((item) => item.percent > 0);
      visible.forEach((item, index) => {
        const width = index === visible.length - 1
          ? Math.max(0, 100 - consumed)
          : Math.max(0, Math.min(item.percent, 100 - consumed));
        const segment = node("div", `explorerStorageStackedBar__segment explorerStorageStackedBar__segment--${item.variant}`);
        segment.style.width = `${width}%`;
        segment.title = `${item.label}: ${fmtPercent(item.percent)} · ${fmtStorageBytes(item.bytes)}`;
        bar.appendChild(segment);
        consumed += width;
      });
    } else {
      bar.appendChild(node("span", "explorerStorageStackedBar__unknown", "unknown"));
    }
    wrap.appendChild(bar);

    const legend = node("div", "explorerStorageCompositionLegend");
    const legendItems = composition.known
      ? composition.items.filter((item) => Number(item.bytes) > 0)
      : [];
    for (const item of legendItems) {
      const entry = node("div", "explorerStorageCompositionLegend__item");
      entry.append(
        node("i", `explorerStorageCompositionLegend__swatch explorerStorageCompositionLegend__swatch--${item.variant}`),
        node("span", "explorerStorageCompositionLegend__label", item.label),
        node("code", "explorerStorageCompositionLegend__percent",
          item.percent == null || item.bytes == null
            ? "unknown"
            : `${fmtPercent(item.percent)} · ${fmtStorageBytes(item.bytes)}`),
      );
      if (item.bytes != null) entry.title = `${item.label}: ${fmtPercent(item.percent)} · ${fmtStorageBytes(item.bytes)}`;
      legend.appendChild(entry);
    }
    if (legendItems.length) wrap.appendChild(legend);
    return wrap;
  }

  function renderStorageComposition(container, detail) {
    container.appendChild(buildStorageComposition(detail));
  }

  function renderOverview(container, detail) {
    const s = detail.summary || {};
    const viewLike = isViewLikeSummary(s);
    const resident = isResidentMemorySummary(s);
    const empty = isEmptyRowSummary(s);
    if (!empty && !resident && !viewLike) {
      renderTableFootprint(container, detail);
    }

    const deps = visibleDependencies(detail);
    if (deps.length) renderDependencies(container, detail);
    if (viewLike || resident || empty) {
      if (detail.ddl) renderDdl(container, detail);
      return;
    }

    if (detail.ddl) renderDdl(container, detail);
  }

  function isImplementationSubcolumn(column) {
    if (!column?.is_subcolumn) return false;
    return /(?:^|\.)(?:size|size\d+)$/i.test(String(column.name || ""));
  }

  function renderStorageMetricTable(container, title, group, rows, firstLabel, options = {}) {
    if (!rows.length) {
      container.appendChild(node("div", "explorerEmptySection", `No ${title.toLowerCase()} metadata.`));
      return;
    }

    const compressedMax = Math.max(0, ...rows.map((item) => optionalNumber(item.compressed) || 0));
    const uncompressedMax = Math.max(0, ...rows.map((item) => optionalNumber(item.uncompressed) || 0));
    const applyGauge = (td, value, max, text) => {
      td.classList.add("resultTable__gaugeCell", "resultTable__numeric", "explorerStorageGaugeCell");
      const n = optionalNumber(value);
      const fill = n == null || max <= 0 ? 0 : Math.max(0, Math.min(100, (Math.abs(n) / max) * 100));
      td.style.setProperty("--gaugeFill", `${fill}%`);
      td.textContent = text;
    };

    // Reuse the exact Query results table component. Explorer contributes only
    // display adapters for byte values and the percentage bar; sorting,
    // headers, row indexes, typography and table geometry remain shared.
    const tableRows = rows.map((item) => {
      const displayName = String(item.name || "—");
      const row = [
        displayName,
        item.codec && item.codec !== "unknown" ? item.codec : "-",
        item.compressed,
        item.uncompressed,
        item.percent,
      ];
      row.__explorerStorageItem = item;
      return row;
    });
    const tupleExpanded = options.tupleExpanded instanceof Set ? options.tupleExpanded : null;
    let table = null;
    table = ns.results?.createStaticResultTable?.({
      columns: [firstLabel, group === "columns" ? "Codec" : "Type", "Compressed", "Uncompressed", "% table"],
      types: ["String", "String", "Float64", "Float64", "Float64"],
      rows: tableRows,
      className: `explorerResultTable explorerStorageResultTable explorerStorageResultTable--${group}`,
      indexSortable: false,
      rowIndexValue: (row) => row?.__explorerStorageItem?.position ?? "",
      decorateRow: (tr, ctx) => {
        const item = ctx.row?.__explorerStorageItem || null;
        if (item?.tuple_parent) {
          tr.dataset.tupleParent = item.tuple_parent;
          tr.classList.add("explorerStorageTupleChild");
          tr.hidden = !(tupleExpanded?.has(item.tuple_parent));
          const indexCell = tr.querySelector(".resultTable__rowIndex");
          if (indexCell) {
            indexCell.textContent = "";
            indexCell.setAttribute("aria-hidden", "true");
          }
        }
      },
      renderCell: (td, ctx) => {
        const item = ctx.row?.__explorerStorageItem || null;
        if (ctx.columnIndex === 0) {
          td.textContent = "";
          if (item?.tuple_root && tupleExpanded) {
            const toggle = node("button", "explorerTreeDatabaseToggle explorerStorageTupleToggle", tupleExpanded.has(item.tuple_root) ? "⌄" : "›");
            toggle.type = "button";
            toggle.setAttribute("aria-expanded", String(tupleExpanded.has(item.tuple_root)));
            toggle.setAttribute("aria-label", `${tupleExpanded.has(item.tuple_root) ? "Collapse" : "Expand"} ${item.tuple_root}`);
            toggle.addEventListener("click", (event) => {
              event.stopPropagation();
              const opening = !tupleExpanded.has(item.tuple_root);
              if (opening) tupleExpanded.add(item.tuple_root);
              else tupleExpanded.delete(item.tuple_root);
              toggle.textContent = opening ? "⌄" : "›";
              toggle.setAttribute("aria-expanded", String(opening));
              toggle.setAttribute("aria-label", `${opening ? "Collapse" : "Expand"} ${item.tuple_root}`);
              for (const row of table?.querySelectorAll?.("tbody tr[data-tuple-parent]") || []) {
                if (row.dataset.tupleParent === item.tuple_root) row.hidden = !opening;
              }
            });
            td.append(toggle, node("span", "explorerStorageTupleName", String(ctx.value ?? "—")));
          } else {
            const label = node("span", item?.tuple_parent ? "explorerStorageTupleName explorerStorageTupleName--child" : "explorerStorageTupleName", String(ctx.value ?? "—"));
            td.appendChild(label);
          }
          if (item?.title) td.title = item.title;
          return true;
        }
        if (ctx.columnIndex === 2) {
          applyGauge(td, ctx.value, compressedMax, ctx.value == null ? "-" : fmtStorageBytes(ctx.value));
          return true;
        }
        if (ctx.columnIndex === 3) {
          applyGauge(td, ctx.value, uncompressedMax, ctx.value == null ? "-" : fmtStorageBytes(ctx.value));
          return true;
        }
        if (ctx.columnIndex === 4) {
          td.classList.add("explorerStoragePercentCell");
          applyGauge(td, ctx.value, 100, ctx.value == null ? "-" : fmtPercent(ctx.value));
          return true;
        }
        return false;
      },
    });
    if (!table) throw new Error("Shared result table component is unavailable.");
    container.appendChild(table);
  }

  function renderColumns(container, detail) {
    if (sectionUnavailable("columns")) container.appendChild(unavailableMessage("Column metadata"));

    const tableFootprint = summaryFootprintBytes(detail.summary || {});
    const observedDefaults = (detail.default_compression_codecs || []).map((value) => String(value || "").trim()).filter(Boolean);
    const defaultCodec = !isMergeTreeSummary(detail.summary)
      ? "-"
      : observedDefaults.length === 1
        ? `${observedDefaults[0]} (default)`
        : observedDefaults.length > 1
          ? `${observedDefaults.join(" / ")} (part defaults)`
          : "DEFAULT";
    const visibleColumns = (detail.columns || []).filter((column) => !isImplementationSubcolumn(column));
    const tupleRoots = visibleColumns
      .filter((column) => !column?.is_subcolumn && /^Tuple\s*\(/i.test(String(column?.type || "")))
      .map((column) => String(column.name || ""))
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    const tupleExpanded = new Set();
    let topLevelColumnPosition = 0;
    const columnRows = visibleColumns.map((c) => {
      const compressed = optionalNumber(c.compressed_bytes);
      const uncompressed = optionalNumber(c.uncompressed_bytes);
      const name = String(c.name || "—");
      const tupleParent = c.is_subcolumn
        ? (tupleRoots.find((root) => name.startsWith(`${root}.`)) || null)
        : null;
      const displayPosition = c.is_subcolumn ? null : ++topLevelColumnPosition;
      return {
        position: displayPosition,
        name,
        title: c.type || "",
        codec: c.codec || defaultCodec,
        compressed,
        uncompressed,
        percent: compressed == null ? null : percentValue(compressed, tableFootprint),
        is_subcolumn: !!c.is_subcolumn,
        tuple_root: tupleRoots.includes(name) ? name : null,
        tuple_parent: tupleParent,
      };
    });
    renderStorageMetricTable(container, "Columns", "columns", columnRows, "Column", { tupleExpanded });

    const structures = (detail.indexes_and_projections || []).map((item, position) => {
      const compressed = optionalNumber(item.compressed_bytes);
      const uncompressed = optionalNumber(item.uncompressed_bytes);
      const kind = String(item.kind || "");
      return {
        position,
        name: item.name || "—",
        title: item.expression || "",
        kind,
        codec: kind.startsWith("index:") ? kind.slice(6) : kind.startsWith("projection:") ? kind.slice(11) : (kind || "unknown"),
        compressed,
        uncompressed,
        percent: compressed == null ? null : percentValue(compressed, tableFootprint),
      };
    });
    const indexes = structures.filter((item) => String(item.kind || "").startsWith("index:"));
    const projections = structures.filter((item) => String(item.kind || "").startsWith("projection:"));
    renderStorageMetricTable(container, "Indexes", "indexes", indexes, "Index", { structure: true });
    renderStorageMetricTable(container, "Projections", "projections", projections, "Projection", { structure: true });

    const storage = detail.column_storage || {};
    const compactParts = Number(storage.compact_parts || 0);
    if (sectionUnavailable("wide_column_sizes")) {
      container.appendChild(node("div", "explorerFootnote", "Wide per-column storage counters are unavailable on this server; unknown is shown instead of fabricating 0%."));
    } else if (sectionUnavailable("wide_subcolumn_sizes")) {
      container.appendChild(node("div", "explorerFootnote", "Tuple subcolumn names are available, but this server does not expose per-subcolumn Wide byte counters."));
    }
  }

  function metricBars(items, { valueFormatter = (value) => String(value), variant = "default" } = {}) {
    const wrap = node("div", `explorerMetricBars explorerMetricBars--${variant}`);
    const known = items.map((item) => optionalNumber(item.value)).filter((value) => value != null && value >= 0);
    const max = known.length ? Math.max(...known) : 0;
    for (const item of items) {
      const value = optionalNumber(item.value);
      const row = node("div", "explorerMetricBars__row");
      const label = node("div", "explorerMetricBars__label", item.label || "—");
      if (item.title) label.title = item.title;
      const track = node("div", "explorerMetricBars__track");
      if (value == null) {
        track.classList.add("is-unknown");
      } else {
        const fill = node("div", "explorerMetricBars__fill");
        fill.style.width = `${max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0}%`;
        track.appendChild(fill);
      }
      const formatted = value == null ? "unknown" : valueFormatter(value);
      const valueEl = node("code", "explorerMetricBars__value", formatted);
      const meta = item.meta ? node("span", "explorerMetricBars__meta", item.meta) : null;
      row.append(label, track, valueEl);
      if (meta) row.appendChild(meta);
      wrap.appendChild(row);
    }
    return wrap;
  }

  function renderStorage(container, detail) {
    const s = detail.summary || {};
    const meta = node("div", "explorerStorageMetaLine");
    const values = [
      [isLogFamilySummary(s) ? "Storage medium" : "Storage policy", isLogFamilySummary(s) ? "Disk" : (s.storage_policy || "default")],
      ["On disk", summaryFootprintBytes(s) == null ? "unknown" : fmtBytes(summaryFootprintBytes(s))],
      ["Data compressed", s.compressed_bytes == null ? "unknown" : fmtBytes(s.compressed_bytes)],
      ["Data uncompressed", s.uncompressed_bytes == null ? "unknown" : fmtBytes(s.uncompressed_bytes)],
    ];
    for (const [label, value] of values) {
      const cell = node("div", "explorerStorageMetaLine__item");
      cell.append(node("span", "explorerStorageMetaLine__label", label), node("code", "explorerStorageMetaLine__value", value));
      meta.appendChild(cell);
    }
    container.appendChild(meta);

    container.appendChild(node("h3", "explorerSectionTitle", "Disk distribution"));
    const storageRows = detail.storage || [];
    if (!storageRows.length && sectionUnavailable("storage")) {
      container.appendChild(unavailableMessage("Storage metadata"));
    } else if (!storageRows.length) {
      container.appendChild(node("div", "explorerEmptySection", "No local disk-backed storage was resolved."));
    } else {
      container.appendChild(metricBars(storageRows.map((disk) => ({
        label: disk.disk || "unknown disk",
        value: disk.bytes,
        title: disk.path || "",
        meta: [
          disk.rows == null ? null : `${fmtInt(disk.rows)} rows`,
          `${fmtInt(disk.parts)} part${Number(disk.parts) === 1 ? "" : "s"}`,
          disk.free_space == null ? null : `${fmtBytes(disk.free_space)} free`,
          disk.total_space == null ? null : `${fmtBytes(disk.total_space)} capacity`,
        ].filter(Boolean).join(" · "),
      })), { valueFormatter: fmtBytes, variant: "storage" }));
    }
  }

  function renderIngestionCharts(container, detail) {
    const s = detail.summary || {};
    const client = s.client_ingress || {};
    const physical = s.physical_ingress || {};
    const windows = [
      ["1m", "rows_per_second_1m", "bytes_per_second_1m"],
      ["5m", "rows_per_second_5m", "bytes_per_second_5m"],
      ["1h", "rows_per_second_1h", "bytes_per_second_1h"],
    ];
    const grid = node("div", "explorerActivityCharts");
    const rowsCard = node("section", "explorerActivityChart");
    rowsCard.appendChild(node("h4", "explorerActivityChart__title", "Rows / second"));
    rowsCard.appendChild(metricBars(windows.flatMap(([window, rowKey]) => [
      { label: `Client · ${window}`, value: client[rowKey] },
      { label: `Persisted · ${window}`, value: physical[rowKey] },
    ]), { valueFormatter: (value) => `${value.toFixed(value < 10 ? 2 : 1)}`, variant: "ingestion" }));
    const bytesCard = node("section", "explorerActivityChart");
    bytesCard.appendChild(node("h4", "explorerActivityChart__title", "Bytes / second"));
    bytesCard.appendChild(metricBars(windows.flatMap(([window, , bytesKey]) => [
      { label: `Client · ${window}`, value: client[bytesKey] },
      { label: `Persisted · ${window}`, value: physical[bytesKey] },
    ]), { valueFormatter: (value) => fmtBytes(value), variant: "ingestion" }));
    grid.append(rowsCard, bytesCard);
    container.appendChild(grid);
    container.appendChild(node("div", "explorerFootnote", "Client ingress comes from query_log; persisted writes come from part_log. Buffer forwarding and Materialized View output are not folded into client ingress."));
  }

  function renderMergeProgress(container, detail) {
    const merges = detail.merges || [];
    if (!merges.length) {
      container.appendChild(node("div", "explorerEmptySection", sectionUnavailable("merges") ? "Merge metadata unavailable." : "No active merges."));
      return;
    }
    const rows = merges.map((merge) => [
      merge.result_part_name || merge.partition || "merge",
      merge.partition || "—",
      Number(merge.elapsed_seconds || 0),
      Math.max(0, Math.min(100, Number(merge.progress || 0) * 100)),
      Number(merge.num_parts || 0),
      Number(merge.rows_read || 0),
      Number(merge.bytes_read || 0),
      Number(merge.memory_usage || 0),
    ]);
    const table = ns.results?.createStaticResultTable?.({
      columns: ["Result part", "Partition", "Elapsed", "Progress", "Parts", "Rows read", "Bytes read", "Memory"],
      types: ["String", "String", "Float64", "Float64", "UInt64", "UInt64", "UInt64", "UInt64"],
      rows,
      className: "explorerResultTable explorerStorageResultTable explorerStorageResultTable--merges",
      renderCell: (td, ctx) => {
        if (ctx.columnIndex === 2) { td.textContent = util.formatSeconds(Number(ctx.value || 0)); return true; }
        if (ctx.columnIndex === 3) {
          td.classList.add("resultTable__gaugeCell", "resultTable__numeric", "explorerStorageGaugeCell");
          td.style.setProperty("--gaugeFill", `${Math.max(0, Math.min(100, Number(ctx.value || 0)))}%`);
          td.textContent = `${Number(ctx.value || 0).toFixed(2)}%`;
          return true;
        }
        if (ctx.columnIndex === 6 || ctx.columnIndex === 7) { td.textContent = fmtStorageBytes(ctx.value); return true; }
        return false;
      },
    });
    if (!table) throw new Error("Shared result table component is unavailable.");
    container.appendChild(table);
  }

  function renderTopology(container, detail) {
    const s = detail.summary || {};
    const r = s.replication || {};
    container.appendChild(simpleRows([
      ["Engine", s.engine],
      ["Engine definition", s.engine_full],
      ["Replica", r.available ? r.replica_name : "—"],
      ["Active replicas", r.available ? `${r.active_replicas}/${r.total_replicas}` : "—"],
      ["Replication queue", r.available ? fmtInt(r.queue_size) : "—"],
      ["Absolute delay", r.available ? `${fmtInt(r.absolute_delay_seconds)}s` : "—"],
      ["Coordination path", r.available ? r.zookeeper_path : "—"],
    ]));
    const topology = detail.topology || [];
    if (topology.length) {
      container.appendChild(dataTable(
        ["Cluster", "Shard", "Replica", "Host", "Address", "Port", "Local", "Errors", "Slowdowns", "Recovery"],
        topology.map((n) => [
          n.cluster, fmtInt(n.shard_num), fmtInt(n.replica_num), n.host_name || "—", n.host_address || "—",
          fmtInt(n.port), n.is_local ? "yes" : "no", fmtInt(n.errors_count), fmtInt(n.slowdowns_count),
          `${fmtInt(n.estimated_recovery_time)}s`,
        ]),
        "explorerDataTableWrap--wide",
      ));
    } else if (s.engine === "Distributed" && sectionUnavailable("topology")) {
      container.appendChild(unavailableMessage("Distributed cluster topology"));
    }
    const distributionQueue = detail.distribution_queue || [];
    if (s.engine === "Distributed") {
      container.appendChild(node("h3", "explorerSectionTitle", "Distribution queue"));
      if (distributionQueue.length) {
        container.appendChild(dataTable(
          ["Data path", "Blocked", "Errors", "Files", "Compressed", "Broken files", "Broken bytes", "Last error time", "Last exception"],
          distributionQueue.map((q) => [q.data_path || "—", q.blocked ? "yes" : "no", fmtInt(q.error_count), fmtInt(q.data_files), fmtBytes(q.data_compressed_bytes), fmtInt(q.broken_data_files), fmtBytes(q.broken_data_compressed_bytes), q.last_exception_time || "—", q.last_exception || "—"]),
          "explorerDataTableWrap--wide",
        ));
      } else if (sectionUnavailable("distribution_queue")) {
        container.appendChild(unavailableMessage("Distribution queue"));
      } else {
        container.appendChild(node("div", "explorerEmptySection", "Distribution queue is empty."));
      }
    }
    container.appendChild(node("div", "explorerFootnote", topology.length
      ? "Distributed topology is resolved from the cluster named by the engine and system.clusters. Physical per-table bytes remain explicitly scoped instead of being inferred from replica counts."
      : "For replicated local tables the List view shows only topology that can be established from local system metadata; it does not invent a shard mapping."));
  }

  function renderIngestion(container, detail) {
    const s = detail.summary || {};
    const client = s.client_ingress || {};
    const physical = s.physical_ingress || {};
    container.appendChild(simpleRows([
      ["Client ingress · rows/s · 1m", fmtRate(client.rows_per_second_1m, "rows/s")],
      ["Client ingress · rows/s · 5m", fmtRate(client.rows_per_second_5m, "rows/s")],
      ["Client ingress · rows/s · 1h", fmtRate(client.rows_per_second_1h, "rows/s")],
      ["Client ingress · bytes/s · 1m", fmtRate(client.bytes_per_second_1m, "bytes/s")],
      ["Client ingress · total · 1h", client.rows_total_1h == null && client.bytes_total_1h == null ? "—" : `${fmtInt(client.rows_total_1h)} rows · ${fmtBytes(client.bytes_total_1h)}`],
      ["Physical writes · rows/s · 1m", fmtRate(physical.rows_per_second_1m, "rows/s")],
      ["Physical writes · rows/s · 5m", fmtRate(physical.rows_per_second_5m, "rows/s")],
      ["Physical writes · bytes/s · 1m", fmtRate(physical.bytes_per_second_1m, "bytes/s")],
      ["Physical writes · total · 1h", physical.rows_total_1h == null && physical.bytes_total_1h == null ? "—" : `${fmtInt(physical.rows_total_1h)} rows · ${fmtBytes(physical.bytes_total_1h)}`],
      ["New parts / minute", fmtInt(physical.new_parts_per_minute)],
      ["Last client write", client.last_event_time || "—"],
      ["Last physical write", physical.last_event_time || "—"],
    ]));
    container.appendChild(node("div", "explorerFootnote", "Client ingress and physical persisted writes are intentionally separate. MV output and Buffer forwarding are not merged into either label."));
  }

  function renderDependencies(container, detail) {
    const deps = visibleDependencies(detail);
    if (!deps.length) {
      container.appendChild(node("div", "explorerEmptySection", sectionUnavailable("dependencies") ? "Dependency metadata unavailable." : "No visible dependencies."));
      return;
    }

    // Ordinary Views, Materialized Views and tables use the exact same lineage
    // presentation. Always render both directions so the layout does not change
    // shape merely because one object currently has only upstream or downstream
    // relations.
    const matrix = node("div", "explorerDependencyMatrix");
    for (const relation of ["upstream", "downstream"]) {
      const items = deps
        .filter((dep) => String(dep.relation || "").toLowerCase() === relation)
        .slice()
        .sort((a, b) => `${a.database}.${a.table}`.localeCompare(`${b.database}.${b.table}`, undefined, { numeric: true, sensitivity: "base" }));
      const group = node("section", "explorerDependencyGroup");
      group.appendChild(node("h4", "explorerDependencyGroup__title", relation === "upstream" ? "Upstream" : "Downstream"));
      const list = node("div", "explorerDependencyList");
      if (!items.length) {
        list.appendChild(node("div", "explorerDependencyEmpty", "—"));
      } else {
        for (const dep of items) {
          const button = node("button", "explorerDependencyItem");
          button.type = "button";
          const qualified = `${dep.database || "—"}.${dep.table || "—"}`;
          const label = node("code", "explorerDependencyItem__qualified", qualified);
          label.title = `${dep.database || ""}.${dep.table || ""}`;
          button.appendChild(label);
          button.addEventListener("click", () => void selectTable(dep.database, dep.table));
          list.appendChild(button);
        }
      }
      group.appendChild(list);
      matrix.appendChild(group);
    }
    container.appendChild(matrix);
  }

  function renderParts(container, detail) {
    const rows = (detail.parts || []).map((p) => [
      p.name, p.partition, p.disk, Number(p.rows || 0), Number(p.bytes || 0), Number(p.marks || 0), Number(p.files || 0), Number(p.level || 0),
      Number(p.age_seconds || 0), p.active ? "active" : "inactive",
    ]);
    if (!rows.length && sectionUnavailable("parts")) return container.appendChild(unavailableMessage("Parts metadata"));
    if (!rows.length) return container.appendChild(node("div", "explorerEmptySection", "No parts."));
    const table = ns.results?.createStaticResultTable?.({
      columns: ["Part", "Partition", "Disk", "Rows", "Bytes", "Marks", "Files", "Level", "Age", "State"],
      types: ["String", "String", "String", "UInt64", "UInt64", "UInt64", "UInt64", "UInt64", "Float64", "String"],
      rows,
      className: "explorerResultTable explorerStorageResultTable explorerStorageResultTable--parts",
      renderCell: (td, ctx) => {
        if (ctx.columnIndex === 4) { td.textContent = fmtStorageBytes(ctx.value); return true; }
        if (ctx.columnIndex === 8) { td.textContent = util.formatSeconds(Number(ctx.value || 0)); return true; }
        return false;
      },
    });
    if (!table) throw new Error("Shared result table component is unavailable.");
    container.appendChild(table);
  }

  function renderPartitions(container, detail) {
    const rows = (detail.partitions || []).map((p) => [p.partition, Number(p.rows || 0), Number(p.bytes || 0), Number(p.parts || 0)]);
    if (!rows.length && sectionUnavailable("partitions")) return container.appendChild(unavailableMessage("Partition metadata"));
    if (!rows.length) return container.appendChild(node("div", "explorerEmptySection", "No partitions."));
    const table = ns.results?.createStaticResultTable?.({
      columns: ["Partition", "Rows", "Bytes", "Parts"],
      types: ["String", "UInt64", "UInt64", "UInt64"],
      rows,
      className: "explorerResultTable explorerStorageResultTable explorerStorageResultTable--partitions",
      renderCell: (td, ctx) => {
        if (ctx.columnIndex === 2) { td.textContent = fmtStorageBytes(ctx.value); return true; }
        return false;
      },
    });
    if (!table) throw new Error("Shared result table component is unavailable.");
    container.appendChild(table);
  }

  function renderIndexes(container, detail) {
    const rows = (detail.indexes_and_projections || []).map((p) => [p.name, p.kind, p.expression || "—", p.compressed_bytes == null ? "—" : fmtBytes(p.compressed_bytes)]);
    if (!rows.length) container.appendChild(node("div", "explorerEmptySection", "No visible data-skipping indexes or projections were returned."));
    else container.appendChild(dataTable(["Name", "Kind", "Expression", "Compressed"], rows));
  }

  function renderReplication(container, detail) {
    const r = detail.summary?.replication || {};
    if (!r.available) {
      container.appendChild(node("div", "explorerEmptySection", "This object does not expose replicated-table state on the selected server."));
      return;
    }
    container.appendChild(simpleRows([
      ["Replica", r.replica_name || "—"],
      ["Active replicas", `${fmtInt(r.active_replicas)}/${fmtInt(r.total_replicas)}`],
      ["Queue size", fmtInt(r.queue_size)],
      ["Absolute delay", `${fmtInt(r.absolute_delay_seconds)}s`],
      ["Read-only", r.readonly ? "yes" : "no"],
      ["Session expired", r.session_expired ? "yes" : "no"],
      ["Coordination path", r.zookeeper_path || "—"],
    ]));
    const queue = detail.replication_queue || [];
    if (queue.length) {
      container.appendChild(dataTable(
        ["Type", "Created", "Source replica", "Part", "Tries", "Last attempt", "Last exception"],
        queue.map((q) => [q.type, q.create_time, q.source_replica || "—", q.new_part_name || "—", fmtInt(q.num_tries), q.last_attempt_time || "—", q.last_exception || "—"]),
        "explorerDataTableWrap--wide",
      ));
    } else if (sectionUnavailable("replication_queue")) {
      container.appendChild(unavailableMessage("Replication queue"));
    } else {
      container.appendChild(node("div", "explorerEmptySection", "Replication queue is empty."));
    }
  }

  function renderMergesMutations(container, detail) {
    const merges = detail.merges || [];
    const mutations = detail.mutations || [];
    container.appendChild(node("h3", "explorerSectionTitle", "Active merges"));
    if (merges.length) {
      container.appendChild(dataTable(["Partition", "Result part", "Elapsed", "Progress", "Parts", "Rows read", "Bytes read", "Memory"], merges.map((m) => [
        m.partition, m.result_part_name, util.formatSeconds(m.elapsed_seconds), `${(Number(m.progress || 0) * 100).toFixed(1)}%`,
        fmtInt(m.num_parts), fmtInt(m.rows_read), fmtBytes(m.bytes_read), fmtBytes(m.memory_usage),
      ]), "explorerDataTableWrap--wide"));
    } else container.appendChild(node("div", "explorerEmptySection", sectionUnavailable("merges") ? "Merge metadata unavailable." : "No active merges."));

    container.appendChild(node("h3", "explorerSectionTitle", "Mutations"));
    if (mutations.length) {
      container.appendChild(dataTable(["Mutation", "Created", "State", "Parts to do", "Command", "Last failure"], mutations.map((m) => [
        m.mutation_id, m.create_time, m.done ? "done" : "pending", fmtInt(m.parts_to_do), m.command, m.latest_fail_reason || "—",
      ]), "explorerDataTableWrap--wide"));
    } else container.appendChild(node("div", "explorerEmptySection", sectionUnavailable("mutations") ? "Mutation metadata unavailable." : "No mutations."));
  }

  function sectionTitle(text) { return node("h3", "explorerSectionTitle", text); }

  function renderSchema(container, detail) {
    // Kept as a compatibility target for old /schema URLs. The current UI
    // intentionally merges Overview + Schema so CREATE is always visible.
    renderOverview(container, detail);
  }

  function renderLineage(container, detail) {
    const toolbar = node("div", "explorerSectionToolbar");
    const text = node("div", "explorerFootnote", "Only dependencies visible through the runner ACL are exposed.");
    const open = node("button", "button button--small", "Open lineage graph");
    open.type = "button";
    open.addEventListener("click", () => {
      setMode("graph");
      graph?.focusTable?.(detail.summary?.database, detail.summary?.name);
    });
    toolbar.append(text, open);
    container.appendChild(toolbar);
    renderDependencies(container, detail);
  }

  function renderStorageCombined(container, detail) {
    renderStorage(container, detail);

    if (isMergeTreeSummary(detail.summary)) {
      renderColumns(container, detail);
    }

    container.appendChild(sectionTitle("Ingestion activity"));
    renderIngestionCharts(container, detail);

    // Log-family tables are disk-backed but do not own MergeTree parts, merges,
    // mutations or partitions. Stop after their real storage + ingestion
    // surfaces instead of showing empty MergeTree-only sections.
    if (isLogFamilySummary(detail.summary)) return;

    container.appendChild(sectionTitle("Merge activity"));
    renderMergeProgress(container, detail);
    const mutations = detail.mutations || [];
    if (mutations.length) {
      container.appendChild(sectionTitle("Mutations"));
      container.appendChild(dataTable(["Mutation", "Created", "State", "Parts to do", "Command", "Last failure"], mutations.map((m) => [
        m.mutation_id, m.create_time, m.done ? "done" : "pending", fmtInt(m.parts_to_do), m.command, m.latest_fail_reason || "—",
      ]), "explorerDataTableWrap--wide"));
    } else if (sectionUnavailable("mutations")) {
      container.appendChild(unavailableMessage("Mutation metadata"));
    }

    if (detail.summary?.engine === "Distributed" || (detail.topology || []).length) {
      container.appendChild(sectionTitle("Topology"));
      renderTopology(container, detail);
    }
    if (detail.summary?.replication?.available || (detail.replication_queue || []).length) {
      container.appendChild(sectionTitle("Replication"));
      renderReplication(container, detail);
    }
    const hasParts = (detail.parts || []).length || !sectionUnavailable("parts");
    if (hasParts) { container.appendChild(sectionTitle("Parts")); renderParts(container, detail); }
    const hasPartitions = (detail.partitions || []).length || !sectionUnavailable("partitions");
    if (hasPartitions) { container.appendChild(sectionTitle("Partitions")); renderPartitions(container, detail); }
  }

  function renderOperations(container, detail) {
    container.appendChild(sectionTitle("Ingestion activity"));
    renderIngestionCharts(container, detail);
    if (detail.summary?.replication?.available || (detail.replication_queue || []).length) {
      container.appendChild(sectionTitle("Replication"));
      renderReplication(container, detail);
    }
    container.appendChild(sectionTitle("Merge activity"));
    renderMergeProgress(container, detail);
    const mutations = detail.mutations || [];
    if (mutations.length) {
      container.appendChild(sectionTitle("Mutations"));
      container.appendChild(dataTable(["Mutation", "Created", "State", "Parts to do", "Command", "Last failure"], mutations.map((m) => [
        m.mutation_id, m.create_time, m.done ? "done" : "pending", fmtInt(m.parts_to_do), m.command, m.latest_fail_reason || "—",
      ]), "explorerDataTableWrap--wide"));
    }
  }

  async function loadPreview() {
    if (model.previewLoading || model.preview) return;
    const detail = model.detail;
    if (!detail) return;
    const s = detail.summary || {};
    model.previewLoading = true;
    renderTabContent();
    try {
      model.preview = await api.getExplorerTableData(state.selectedHostId, s.database, s.name, 100);
    } catch (e) {
      model.preview = { error: e };
    } finally {
      model.previewLoading = false;
      if (model.tab === "Data") renderTabContent();
    }
  }

  function openSqlInQuery(sql) {
    const text = String(sql || "");
    // Explorer and Query are separate HTML documents. Persist the requested SQL
    // in the same session draft consumed by Query before crossing documents,
    // otherwise the textarea does not exist yet and the statement is lost.
    try {
      sessionStorage.setItem("chdash.editor.draft.v2", text);
    } catch {
      null;
    }
    if (dom.queryTextArea) {
      util.replaceTextAreaValue(dom.queryTextArea, text);
      setWorkspace("query");
      return;
    }
    window.location.assign(appRoute("/query"));
  }

  function aggregatePreviewColumn(column) {
    if (!column) return false;
    if (column.finalized_for_preview === true) return true;
    return /^AggregateFunction\s*\(/i.test(String(column.type || "").trim());
  }

  function buildPreviewSelectSql(detail) {
    const s = detail?.summary || {};
    const previewByName = new Map(
      (model.preview?.columns || []).map((column) => [String(column?.name || ""), column]),
    );
    const columns = (detail?.columns || []).filter((column) => column?.is_subcolumn !== true);
    const projection = columns.map((column) => {
      const name = String(column?.name || "");
      const quoted = quoteIdent(name);
      const previewColumn = previewByName.get(name);
      return aggregatePreviewColumn(previewColumn || column)
        ? `finalizeAggregation(${quoted}) AS ${quoted}`
        : quoted;
    });
    return `SELECT ${projection.length ? projection.join(", ") : "*"}\nFROM ${quoteIdent(s.database)}.${quoteIdent(s.name)}\nLIMIT 100`;
  }

  async function openFormattedSqlInQuery(sql) {
    const formatted = await api.formatSqls(state.selectedHostId, [String(sql || "")]);
    if (!Array.isArray(formatted) || !formatted.length || !String(formatted[0] || "").trim()) {
      throw new Error("Formatter returned an empty query.");
    }
    openSqlInQuery(formatted[0]);
  }

  function appendFinalizePreviewInfo(th) {
    const text = "finalizeAggregation() used so Explorer can display the value of a single row";
    th.classList.add("has-finalize-info");
    const info = node("span", "explorerFinalizeInfo");
    info.tabIndex = 0;
    info.setAttribute("aria-label", text);
    info.addEventListener("click", (event) => event.stopPropagation());
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 416.979 416.979");
    icon.setAttribute("aria-hidden", "true");
    icon.classList.add("explorerFinalizeInfo__icon");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M356.004 61.156C274.634-20.314 142.627-20.395 61.156 60.974c-81.47 81.371-81.552 213.379-.181 294.85 81.369 81.47 213.378 81.551 294.849.181 81.469-81.369 81.551-213.379.18-294.849zM237.6 340.786c0 3.217-2.607 5.822-5.822 5.822h-46.576c-3.215 0-5.822-2.605-5.822-5.822V167.885c0-3.217 2.607-5.822 5.822-5.822h46.576c3.215 0 5.822 2.604 5.822 5.822v172.901zM208.49 137.901c-18.618 0-33.766-15.146-33.766-33.765 0-18.617 15.147-33.766 33.766-33.766 18.619 0 33.766 15.148 33.766 33.766 0 18.619-15.149 33.765-33.766 33.765z");
    icon.appendChild(path);
    info.append(icon, node("div", "explorerFinalizeInfo__tooltip", text));
    th.appendChild(info);
  }

  function persistFlattenTuple(enabled) {
    state.runOptFlattenTuple = enabled !== false;
    storage?.saveRunOptions?.({
      autoFormat: state.runOptAutoFormat,
      multiQuery: state.runOptMultiQuery,
      executionStats: state.runOptExecutionStats,
      flattenTuple: state.runOptFlattenTuple,
    });
    ui?.applyRunOptionsUi?.();
    window.dispatchEvent(new CustomEvent("chdash:flatten-tuple-change", { detail: { enabled: state.runOptFlattenTuple } }));
  }

  function createDataSettingsControl() {
    const root = node("div", "themeSelect explorerDataSettings");
    const button = node("button", "themeSelect__button editorAutocompleteControl__button explorerDataSettings__button");
    button.type = "button";
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-label", "Data display settings");
    button.title = "Data display settings";
    button.appendChild(node("span", "editorAutocompleteControl__gear"));

    const menu = node("div", "themeSelect__menu explorerDataSettings__menu");
    menu.setAttribute("role", "menu");
    menu.tabIndex = -1;
    menu.hidden = true;
    const option = node("button", "runMenu__opt");
    option.type = "button";
    option.setAttribute("role", "menuitemcheckbox");
    const check = node("span", "runMenu__optCheck");
    check.setAttribute("aria-hidden", "true");
    option.append(check, node("span", "runMenu__optText", "Flatten tuple"));
    const sync = () => option.setAttribute("aria-checked", String(state.runOptFlattenTuple !== false));
    sync();
    menu.appendChild(option);
    root.append(button, menu);

    let open = false;
    const positionMenu = () => {
      if (!open) return;
      const rect = button.getBoundingClientRect();
      menu.style.position = "fixed";
      menu.style.left = "auto";
      menu.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
      menu.style.top = `${Math.min(window.innerHeight - menu.offsetHeight - 8, rect.bottom + 4)}px`;
    };
    const onOutsideClick = (event) => {
      const target = event.target;
      if (target instanceof Node && (root.contains(target) || menu.contains(target))) return;
      close();
    };
    const onEscape = (event) => {
      if (event.key === "Escape") close();
    };
    const close = () => {
      if (!open) return;
      open = false;
      root.classList.remove("themeSelect--open");
      menu.classList.remove("is-open");
      button.setAttribute("aria-expanded", "false");
      document.removeEventListener("click", onOutsideClick);
      document.removeEventListener("keydown", onEscape);
      window.removeEventListener("resize", positionMenu);
      window.removeEventListener("scroll", positionMenu, true);
      menu.hidden = true;
      menu.style.removeProperty("position");
      menu.style.removeProperty("left");
      menu.style.removeProperty("right");
      menu.style.removeProperty("top");
      if (menu.parentNode !== root) root.appendChild(menu);
    };
    const openMenu = () => {
      if (open) return;
      open = true;
      document.body.appendChild(menu);
      menu.hidden = false;
      button.setAttribute("aria-expanded", "true");
      positionMenu();
      requestAnimationFrame(() => {
        if (!open) return;
        root.classList.add("themeSelect--open");
        menu.classList.add("is-open");
      });
      document.addEventListener("click", onOutsideClick);
      document.addEventListener("keydown", onEscape);
      window.addEventListener("resize", positionMenu, { passive: true });
      window.addEventListener("scroll", positionMenu, { passive: true, capture: true });
    };

    option.addEventListener("click", (event) => {
      event.stopPropagation();
      persistFlattenTuple(!(state.runOptFlattenTuple !== false));
      sync();
      close();
      renderTabContent();
    });
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      if (open) close();
      else openMenu();
    });
    return root;
  }

  function renderData(container, detail) {
    const toolbar = node("div", "explorerDataToolbar");
    const open = node("button", "button button--small", "Open in Query");
    open.type = "button";
    open.addEventListener("click", async () => {
      if (open.disabled) return;
      open.disabled = true;
      try {
        await openFormattedSqlInQuery(buildPreviewSelectSql(detail));
      } catch (error) {
        setError(error);
        open.disabled = false;
      }
    });
    const actions = node("div", "explorerDataToolbar__actions");
    actions.append(open, createDataSettingsControl());
    toolbar.append(actions);
    container.appendChild(toolbar);

    if (model.previewLoading) return container.appendChild(node("div", "explorerEmptySection", "Loading preview…"));
    if (!model.preview) {
      container.appendChild(node("div", "explorerEmptySection", "Preview not loaded."));
      setTimeout(loadPreview, 0);
      return;
    }
    if (model.preview.error) return container.appendChild(node("div", "explorerUnavailable", model.preview.error.message || "Preview failed."));
    const previewColumns = Array.isArray(model.preview.columns) ? model.preview.columns : [];
    const sourceColumns = previewColumns.map((c) => c.name);
    const sourceRows = Array.isArray(model.preview.rows) ? model.preview.rows : [];
    // AggregateFunction preview values are finalized/stringified server-side so
    // clickhouse-cpp never has to decode aggregate states. If every returned
    // finalized value is numeric, expose a numeric presentation type to the
    // shared result table so Explorer gets the same background gauges as Query.
    const sourceTypes = previewColumns.map((c, columnIndex) => {
      if (!aggregatePreviewColumn(c)) return c.type;
      const values = sourceRows.map((row) => Array.isArray(row) ? row[columnIndex] : null).filter((value) => value != null && String(value).trim() !== "");
      return values.length && values.every((value) => Number.isFinite(Number(value))) ? "Float64" : c.type;
    });
    const projected = ns.results?.flattenTupleTableData?.(sourceColumns, sourceTypes, sourceRows, state.runOptFlattenTuple !== false)
      || { columns: sourceColumns, types: sourceTypes, rows: sourceRows, sourceColumnIndexes: sourceColumns.map((_, index) => index) };
    const table = ns.results?.createStaticResultTable?.({
      columns: projected.columns,
      types: projected.types,
      rows: projected.rows,
      className: "explorerResultTable explorerResultTable--preview",
      decorateHeader: (th, ctx) => {
        const sourceIndex = projected.sourceColumnIndexes?.[ctx.columnIndex] ?? ctx.columnIndex;
        if (aggregatePreviewColumn(previewColumns[sourceIndex])) appendFinalizePreviewInfo(th);
      },
    });
    if (!table) throw new Error("Shared result table component is unavailable.");
    container.appendChild(table);
  }

  function renderDdl(container, detail) {
    if (!detail.ddl) return container.appendChild(unavailableMessage("DDL"));
    const ddl = String(detail.formatted_ddl || detail.ddl);
    if (detail.ddl_format_error) container.appendChild(node("div", "explorerFootnote", `Formatter unavailable: ${detail.ddl_format_error}`));

    // Render CREATE with the same editor primitives as Query: identical gutter,
    // syntax overlay, token colors and copy control. Explorer only overrides
    // sizing because this surface is read-only and must grow with the DDL.
    const wrap = node("div", "editorWrap explorerDdlWrap");
    const gutter = node("pre", "editorGutter explorerDdlGutter");
    const lineCount = Math.max(1, ddl.split("\n").length);
    gutter.textContent = Array.from({ length: lineCount }, (_, index) => String(index + 1)).join("\n");

    const copy = node("button", "editorCopyButton explorerDdlCopy");
    copy.type = "button";
    copy.setAttribute("aria-label", "Copy CREATE statement");
    copy.title = "Copy CREATE statement";
    copy.appendChild(node("span", "editorCopyButton__icon"));
    copy.addEventListener("click", async () => {
      await util.copyTextToClipboard(ddl);
      copy.classList.add("is-copied");
      setTimeout(() => copy.classList.remove("is-copied"), 1000);
    });
    const pre = node("pre", "editorHighlight explorerDdl");
    renderHighlightedCode(pre, ddl);
    wrap.append(gutter, pre, copy);
    container.appendChild(wrap);
  }

  function renderTabContent() {
    const container = dom.explorerDetailContent;
    if (!container) return;
    clear(container);
    const detail = model.detail;
    if (!detail) return;

    switch (model.tab) {
      case "Overview": renderOverview(container, detail); break;
      case "Schema": renderSchema(container, detail); break;
      case "Data": renderData(container, detail); break;
      case "Lineage": renderLineage(container, detail); break;
      case "Storage": renderStorageCombined(container, detail); break;
      case "Operations": renderOperations(container, detail); break;
      default: renderOverview(container, detail); break;
    }
  }

  async function selectTable(database, table, force = false, { historyMode = "push", graphOrigin = false } = {}) {
    if (model.mode === "graph" && graph?.isStorageMode?.() && graph?.canUseStorageForTable?.(database, table) === false) return;
    // The top-level catalog intentionally contains only database names. Load
    // exactly the branch the user is navigating to before resolving selection.
    if (model.catalog && !model.databaseTablesLoaded.has(database)) await loadDatabaseTables(database, false);
    if (model.catalog && !catalogContainsTable(model.catalog, database, table)) {
      await loadDatabaseTables(database, true);
      if (!catalogContainsTable(model.catalog, database, table)) {
        setError(new Error(`Explorer table is not visible: ${database}.${table}`));
        return;
      }
    }
    const serial = ++model.detailSerial;
    const key = `${database}\0${table}`;
    if (model.mode === "graph") graph?.focusTable?.(database, table, { ensureVisible: !graphOrigin });
    model.selectedKey = key;
    model.selectedDatabase = null;
    model.expandedDatabases.add(database);
    // A selected object must never be hidden by the visibility switch that is
    // required to render it. Lock the corresponding option until selection
    // moves away from a system/non-storing object.
    syncVisibilityOptionLocks({ propagate: true });
    if (model.mode === "graph") {
      // Nothing from /api/explorer/table is rendered in Graph mode. Keep only
      // the lightweight catalog selection + graph focus and avoid the detail
      // request entirely until the user switches to Browse.
      model.detail = null;
      model.preview = null;
      model.detailLoading = false;
      renderTableList();
      syncExplorerUrl(historyMode);
      return;
    }
    model.detail = null;
    model.preview = null;
    model.detailLoading = true;
    renderTableList();
    setError(null);
    if (dom.explorerEmptyState) {
      dom.explorerEmptyState.hidden = false;
      dom.explorerEmptyState.replaceChildren(node("strong", "", "Loading table…"), node("span", "", `${database}.${table}`));
    }
    if (dom.explorerDetail) dom.explorerDetail.hidden = true;

    const hostId = String(state.selectedHostId || "");
    try {
      const detail = await api.getExplorerTable(hostId, database, table, !!force);
      if (!detail || typeof detail !== "object" || !detail.summary || detail.summary.database !== database || detail.summary.name !== table) {
        throw new Error(`Invalid Explorer detail response for ${database}.${table}.`);
      }
      if (detail.ddl) {
        try {
          const formatted = await api.formatSqls(hostId, [String(detail.ddl)]);
          if (Array.isArray(formatted) && formatted[0]) detail.formatted_ddl = formatted[0];
        } catch (formatError) {
          detail.ddl_format_error = formatError instanceof Error ? formatError.message : String(formatError || "format failed");
        }
      }
      if (serial !== model.detailSerial || String(state.selectedHostId || "") !== hostId || model.selectedKey !== key) return;
      model.detail = detail;
      if (dom.explorerDetailTabs) dom.explorerDetailTabs.hidden = false;
      renderDetailHeader();
      renderTabs();
      renderTabContent();
      syncExplorerUrl(historyMode);
    } catch (e) {
      if (serial !== model.detailSerial || model.selectedKey !== key) return;
      setError(e);
      if (dom.explorerEmptyState) {
        dom.explorerEmptyState.hidden = false;
        dom.explorerEmptyState.replaceChildren(node("strong", "", "Unable to load table"), node("span", "", "The object may no longer be readable."));
      }
    } finally {
      if (serial === model.detailSerial) model.detailLoading = false;
    }
  }

  async function applyRouteFromLocation() {
    const route = parseExplorerRoute();
    if (route.workspace === "explorer" && route.legacySchema && route.database && route.table) {
      const canonicalPath = appRoute(`/explorer/${encodeRouteSegment(route.database)}/${encodeRouteSegment(route.table)}/overview`);
      const canonicalParams = new URLSearchParams(window.location.search || "");
      if (!canonicalParams.has("view")) canonicalParams.set("view", route.viewMode === "graph" ? "graph" : "browse");
      if (route.viewMode === "graph") {
        if (!canonicalParams.has("graph")) canonicalParams.set("graph", route.graphType === "physical" ? "storage" : "lineage");
        if (route.graphType !== "physical" && !canonicalParams.has("depth")) canonicalParams.set("depth", String(route.graphDepth ?? 1));
      } else {
        canonicalParams.delete("graph");
        canonicalParams.delete("depth");
      }
      const canonicalQuery = canonicalParams.toString();
      window.history.replaceState(
        { workspace: "explorer" },
        "",
        canonicalQuery ? `${canonicalPath}?${canonicalQuery}` : canonicalPath,
      );
    }
    model.routeIntent = route;
    if (route.workspace !== "explorer") {
      setWorkspace("query", { historyMode: "none" });
      if (window.location.pathname === appRoute("/")) window.history.replaceState({ workspace: "query" }, "", appRoute("/query"));
      return;
    }

    setWorkspace("explorer", { historyMode: "none" });
    if (route.section === "functions") {
      setSection("functions");
      if (model.functionsCatalog) {
        if (route.functionName) {
          const item = (model.functionsCatalog.functions || []).find((candidate) => candidate.name === route.functionName) || null;
          model.selectedFunctionKey = item ? functionKey(item) : null;
          renderFunctionList();
          renderFunctionDetail();
        }
        model.routeIntent = null;
      }
      return;
    }
    setSection("tables");
    graph?.applyRouteState?.({ mode: route.graphType || "logical", depth: route.graphDepth ?? 1 });
    setMode(route.viewMode === "graph" ? "graph" : "list");
    if (route.database) {
      model.expandedDatabases.add(route.database);
    }
    model.tab = route.tab || "Overview";
    if (route.database && route.table && model.catalog) {
      // A route only needs the addressed database branch. Never refresh/enumerate
      // every database just because the selected table is not in the lightweight
      // top-level catalog yet.
      await loadDatabaseTables(route.database, false);
      if (!catalogContainsTable(model.catalog, route.database, route.table)) {
        await loadDatabaseTables(route.database, true);
      }
      if (!catalogContainsTable(model.catalog, route.database, route.table)) {
        setError(new Error(`Explorer table route is not visible: ${route.database}.${route.table}`));
        model.routeIntent = null;
        return;
      }
      const key = `${route.database}\0${route.table}`;
      if (model.selectedKey === key && model.detail) {
        if (dom.explorerDetailTabs) dom.explorerDetailTabs.hidden = false;
        renderTabs();
        renderTabContent();
        renderTableList();
      } else {
        await selectTable(route.database, route.table, false, { historyMode: "none" });
      }
      model.routeIntent = null;
    } else if (route.database && model.catalog) {
      selectDatabase(route.database, { historyMode: "none" });
      model.routeIntent = null;
    } else {
      model.selectedDatabase = null;
      renderTableList();
      if (model.catalog) model.routeIntent = null;
    }
  }

  function resetForHost() {
    model.catalog = null;
    model.databaseTablesLoaded.clear();
    model.databaseTablesLoading.clear();
    model.databaseLoadPromises.clear();
    model.databaseLoadErrors.clear();
    model.expandedDatabases.clear();
    model.selectedKey = null;
    model.selectedDatabase = null;
    model.detailSerial += 1;
    model.detail = null;
    model.detailLoading = false;
    model.preview = null;
    model.tab = "Overview";
    if (dom.explorerEmptyState) {
      dom.explorerEmptyState.hidden = false;
      dom.explorerEmptyState.replaceChildren(node("strong", "", "Select a table"), node("span", "", "Metadata is scoped to the currently selected host and user."));
    }
    if (dom.explorerDetail) dom.explorerDetail.hidden = true;
    renderTableList();
    renderFunctionList();
    graph?.onHostChanged();
    syncVisibilityOptionLocks();
    if (model.active) {
      if (model.section === "functions") refreshFunctions(false);
      else refreshCatalog(false);
    }
  }

  function openTableFromGraph(database, table) {
    // Canvas clicks must never restart the catalog loader: doing so can replay
    // a stale route intent and snap focus back to the table that originally
    // opened Explorer. Only switch section when we are actually leaving
    // Functions.
    if (model.section !== "tables") setSection("tables");
    selectTable(database, table, false, { graphOrigin: true });
  }

  function init() {
    graph?.init({ openTable: openTableFromGraph, onStateChange: () => { syncVisibilityOptionLocks(); renderTableList(); syncExplorerUrl("replace"); } });
    dom.navQueryButton?.addEventListener("click", () => setWorkspace("query"));
    dom.navExplorerButton?.addEventListener("click", () => setWorkspace("explorer"));
    window.addEventListener("popstate", () => { void applyRouteFromLocation(); });
    dom.explorerSectionSelectButton?.addEventListener("click", () => toggleDropdown(dom.explorerSectionSelect, dom.explorerSectionSelectButton, dom.explorerSectionSelectMenu));
    dom.explorerModeSelectButton?.addEventListener("click", () => toggleDropdown(dom.explorerTableModeTabs, dom.explorerModeSelectButton, dom.explorerModeSelectMenu));
    dom.explorerTablesSectionButton?.addEventListener("click", () => { setSection("tables"); syncExplorerUrl("push"); });
    dom.explorerFunctionsSectionButton?.addEventListener("click", () => { setSection("functions"); syncExplorerUrl("push"); });
    dom.explorerListModeButton?.addEventListener("click", () => { setMode("list"); syncExplorerUrl("push"); });
    dom.explorerGraphModeButton?.addEventListener("click", () => { setMode("graph"); syncExplorerUrl("push"); });
    dom.explorerRefreshButton?.addEventListener("click", () => refreshCatalog(true));
    dom.explorerTableSettingsButton?.addEventListener("click", () => toggleDropdown(dom.explorerTableSettings, dom.explorerTableSettingsButton, dom.explorerTableSettingsMenu));
    dom.explorerIncludeSystem?.addEventListener("change", () => {
      if (dom.explorerIncludeSystem.disabled) return syncVisibilityOptionLocks();
      model.includeSystem = !!dom.explorerIncludeSystem.checked;
      persistVisibilityOptions();
      syncVisibilityOptionLocks({ propagate: true });
      renderTableList();
    });
    dom.explorerIncludeNonStoring?.addEventListener("change", () => {
      if (dom.explorerIncludeNonStoring.disabled) return syncVisibilityOptionLocks();
      model.includeNonStoring = !!dom.explorerIncludeNonStoring.checked;
      persistVisibilityOptions();
      syncVisibilityOptionLocks({ propagate: true });
      renderTableList();
    });
    dom.explorerFunctionRefreshButton?.addEventListener("click", () => refreshFunctions(true));
    dom.explorerSearchInput?.addEventListener("input", () => {
      renderTableList();
      graph?.searchFocus();
    });
    dom.explorerFunctionSearchInput?.addEventListener("input", renderFunctionList);
    dom.explorerFunctionCategorySelect?.addEventListener("change", renderFunctionList);
    dom.explorerFunctionSettingsButton?.addEventListener("click", () => toggleDropdown(dom.explorerFunctionSettings, dom.explorerFunctionSettingsButton, dom.explorerFunctionSettingsMenu));
    for (const option of dom.explorerFunctionSettingsMenu?.querySelectorAll?.("[data-function-kind]") || []) {
      option.addEventListener("click", () => {
        const value = String(option.dataset.functionKind || "");
        if (dom.explorerFunctionCategorySelect) dom.explorerFunctionCategorySelect.value = value;
        for (const candidate of dom.explorerFunctionSettingsMenu.querySelectorAll("[data-function-kind]")) {
          const selected = String(candidate.dataset.functionKind || "") === value;
          candidate.setAttribute("aria-checked", String(selected));
          candidate.classList.toggle("is-checked", selected);
        }
        renderFunctionList();
        closeDropdown(dom.explorerFunctionSettings, dom.explorerFunctionSettingsButton, dom.explorerFunctionSettingsMenu);
      });
    }
    window.addEventListener("chdash:host-changed", resetForHost);
    window.addEventListener("chdash:features-changed", applyExplorerFeatures);
    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (isDropdownOpen(dom.explorerSectionSelect) && !dom.explorerSectionSelect.contains(target)) {
        closeDropdown(dom.explorerSectionSelect, dom.explorerSectionSelectButton, dom.explorerSectionSelectMenu);
      }
      if (isDropdownOpen(dom.explorerTableModeTabs) && !dom.explorerTableModeTabs.contains(target)) {
        closeDropdown(dom.explorerTableModeTabs, dom.explorerModeSelectButton, dom.explorerModeSelectMenu);
      }
      if (isDropdownOpen(dom.explorerTableSettings) && !dom.explorerTableSettings.contains(target)) {
        closeDropdown(dom.explorerTableSettings, dom.explorerTableSettingsButton, dom.explorerTableSettingsMenu);
      }
      if (isDropdownOpen(dom.explorerFunctionSettings) && !dom.explorerFunctionSettings.contains(target)) {
        closeDropdown(dom.explorerFunctionSettings, dom.explorerFunctionSettingsButton, dom.explorerFunctionSettingsMenu);
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      closeDropdown(dom.explorerSectionSelect, dom.explorerSectionSelectButton, dom.explorerSectionSelectMenu, { immediate: true });
      closeDropdown(dom.explorerTableModeTabs, dom.explorerModeSelectButton, dom.explorerModeSelectMenu, { immediate: true });
      closeDropdown(dom.explorerTableSettings, dom.explorerTableSettingsButton, dom.explorerTableSettingsMenu, { immediate: true });
      closeDropdown(dom.explorerFunctionSettings, dom.explorerFunctionSettingsButton, dom.explorerFunctionSettingsMenu, { immediate: true });
    });
    try {
      model.includeSystem = localStorage.getItem("chdash.explorer.includeSystem") === "1";
      const nonStoring = localStorage.getItem("chdash.explorer.includeNonStoring");
      model.includeNonStoring = nonStoring == null ? true : nonStoring !== "0";
    } catch {}
    if (dom.explorerIncludeSystem) dom.explorerIncludeSystem.checked = model.includeSystem;
    if (dom.explorerIncludeNonStoring) dom.explorerIncludeNonStoring.checked = model.includeNonStoring;
    syncVisibilityOptionLocks({ propagate: true });
    applyExplorerFeatures();
    setSection("tables");
    setMode("list");
    void applyRouteFromLocation();
  }

  ns.explorer = { init, setWorkspace, setSection, setMode, refreshCatalog, refreshFunctions, selectTable, selectDatabase };
})();
