(() => {
  "use strict";

  const ns = window.ChDash;
  if (!ns) return;

  const { dom, state, api, util, ui, storage } = ns;
  const graph = ns.explorerGraph;
  const treemap = ns.explorerTreemap;

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
    detailCache: new Map(),
    detailPromises: new Map(),
    routeIntent: null,
    includeSystem: false,
    includeNonStoring: true,
    // Storage section (app_explorer_storage.js): breadcrumb scope of the
    // server / database / table storage view.
    storageScope: { database: "", table: "" },
    databaseStorage: null,
  };

  // Route slug of the Storage section. "/explorer/system" already addresses
  // the ClickHouse `system` database (and /explorer/system/<table>/... its
  // tables), so the section uses a reserved, underscore-prefixed segment.
  const SYSTEM_ROUTE_SEGMENT = "_system";
  // Route slug of the Server operations section (app_explorer_ops.js).
  const OPERATIONS_ROUTE_SEGMENT = "_operations";

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
    if (parts[0] === SYSTEM_ROUTE_SEGMENT) {
      const storageDatabase = params.get("database") || "";
      return { workspace: "explorer", section: "system", storageScope: { database: storageDatabase, table: storageDatabase ? params.get("table") || "" : "" } };
    }
    if (parts[0] === OPERATIONS_ROUTE_SEGMENT) {
      return { workspace: "explorer", section: "operations" };
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
    if (model.section === "system") return `/explorer/${SYSTEM_ROUTE_SEGMENT}`;
    if (model.section === "operations") return `/explorer/${OPERATIONS_ROUTE_SEGMENT}`;
    const table = selectedTable();
    if (table) return `/explorer/${encodeRouteSegment(table.database)}/${encodeRouteSegment(table.name)}/${model.tab.toLowerCase()}`;
    if (model.selectedDatabase) return `/explorer/${encodeRouteSegment(model.selectedDatabase)}`;
    return "/explorer";
  }

  function currentExplorerUrl() {
    const path = appRoute(currentExplorerPath());
    if (model.section === "system") {
      const scope = new URLSearchParams();
      if (model.storageScope.database) scope.set("database", model.storageScope.database);
      if (model.storageScope.database && model.storageScope.table) scope.set("table", model.storageScope.table);
      const query = scope.toString();
      return query ? `${path}?${query}` : path;
    }
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
    if (value == null) return "\u2014";
    return util.formatInt(value);
  }

  function fmtBytes(value) {
    if (value == null) return "\u2014";
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
    if (!Number.isFinite(n)) return "\u2014";
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
    if (!Number.isFinite(n)) return "\u2014";
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

  function detailCacheKey(hostId, database, table) {
    return `${String(hostId || "")}\0${String(database || "")}\0${String(table || "")}`;
  }

  function currentCatalogTable(database, table) {
    return (model.catalog?.tables || []).find((item) => String(item.database || "") === String(database || "") && String(item.name || "") === String(table || "")) || null;
  }

  function metadataRevision(table) {
    return String(table?.metadata_modification_time || "");
  }

  function detailMatchesCatalog(detail, database, table) {
    const current = currentCatalogTable(database, table);
    const navRevision = metadataRevision(current);
    const detailRevision = metadataRevision(detail?.summary);
    // Older ClickHouse versions / restricted accounts may not expose a revision.
    // In that case fall back to the bounded detail TTL instead of invalidating
    // every time the lightweight navigation catalog refreshes.
    return !navRevision || !detailRevision || navRevision === detailRevision;
  }

  function applyFreshSidebarSummary(detail, database, table) {
    const current = currentCatalogTable(database, table);
    if (!detail?.summary || !current) return detail;
    detail.summary.engine = current.engine || detail.summary.engine;
    detail.summary.metadata_modification_time = current.metadata_modification_time || detail.summary.metadata_modification_time || "";
    if (current.rows != null) detail.summary.rows = current.rows;
    if (current.bytes != null) {
      if (detail.summary.resident_bytes != null) detail.summary.resident_bytes = current.bytes;
      else {
        detail.summary.logical_bytes = current.bytes;
        detail.summary.compressed_bytes = current.bytes;
        if (detail.summary.physical_bytes != null) detail.summary.physical_bytes = current.bytes;
      }
    }
    return detail;
  }

  const DETAIL_CACHE_MAX_ENTRIES = 64;

  async function fetchTableDetail(hostId, database, table, force = false) {
    const key = detailCacheKey(hostId, database, table);
    if (force) model.detailCache.delete(key);
    const cached = model.detailCache.get(key);
    const ttl = Math.max(0, Number(cached?.detail?.cache_ttl_ms ?? 30000));
    const freshByAge = !!cached && (Date.now() - Number(cached.cachedAtMs || 0) < ttl);
    if (!force && cached?.detail && freshByAge && detailMatchesCatalog(cached.detail, database, table)) {
      return applyFreshSidebarSummary(cached.detail, database, table);
    }
    const existing = model.detailPromises.get(key);
    if (existing) return existing;

    const promise = (async () => {
      let detail = await api.getExplorerTable(hostId, database, table, !!force);
      // A 30s rich-detail cache keeps clicks responsive, while the 5s navigation
      // catalog carries ClickHouse's metadata_modification_time. If the schema
      // changed since the cached detail was produced, bypass the server cache
      // exactly once; row/byte-only changes are overlaid from the sidebar.
      if (!force && !detailMatchesCatalog(detail, database, table)) {
        detail = await api.getExplorerTable(hostId, database, table, true);
      }
      applyFreshSidebarSummary(detail, database, table);
      // Map preserves insertion order: re-inserting keeps LRU order and the
      // oldest entries are evicted. Rich details (columns, parts, DDL) were
      // otherwise retained for every object visited during the session.
      model.detailCache.delete(key);
      model.detailCache.set(key, { detail, cachedAtMs: Date.now() });
      while (model.detailCache.size > DETAIL_CACHE_MAX_ENTRIES) {
        model.detailCache.delete(model.detailCache.keys().next().value);
      }
      return detail;
    })().finally(() => model.detailPromises.delete(key));
    model.detailPromises.set(key, promise);
    return promise;
  }


  function setSection(section) {
    const operationsEnabled = !!ns.explorerOps && explorerFeatures().operations?.enabled !== false;
    const next = section === "functions" || section === "system" || (section === "operations" && operationsEnabled) ? section : "tables";
    model.section = next;
    const functions = next === "functions";
    const system = next === "system";
    const operations = next === "operations";
    const tables = next === "tables";

    dom.explorerTablesSectionButton?.setAttribute("aria-selected", String(tables));
    dom.explorerFunctionsSectionButton?.setAttribute("aria-selected", String(functions));
    dom.explorerSystemSectionButton?.setAttribute("aria-selected", String(system));
    dom.explorerOpsSectionButton?.setAttribute("aria-selected", String(operations));
    if (dom.explorerSectionSelectButton) dom.explorerSectionSelectButton.textContent = functions ? "Functions" : (system ? "Storage" : (operations ? "Operations" : "Tables"));
    closeDropdown(dom.explorerSectionSelect, dom.explorerSectionSelectButton, dom.explorerSectionSelectMenu, { immediate: true });
    if (dom.explorerTableModeTabs) dom.explorerTableModeTabs.hidden = !tables;
    if (dom.explorerFunctionsPane) dom.explorerFunctionsPane.hidden = !functions;
    if (dom.explorerSystemPane) dom.explorerSystemPane.hidden = !system;
    if (dom.explorerOpsPane) dom.explorerOpsPane.hidden = !operations;
    if (!operations) ns.explorerOps?.hide?.();

    if (system || operations) {
      if (dom.explorerListView) dom.explorerListView.hidden = true;
      if (dom.explorerGraphPane) dom.explorerGraphPane.hidden = true;
      graph?.deactivate();
      if (system) renderSystemView();
      else if (model.active) ns.explorerOps?.show(dom.explorerOpsPane, { onOpenTable: (database, table) => openStorageRoute(database, table) });
      return;
    }

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
    if (dom.explorerTableModeTabs) dom.explorerTableModeTabs.hidden = !(browseEnabled && graphEnabled) || model.section !== "tables";
    const operationsEnabled = !!ns.explorerOps && f.enabled !== false && f.operations?.enabled !== false;
    if (dom.explorerOpsSectionButton) dom.explorerOpsSectionButton.hidden = !operationsEnabled;
    if (!operationsEnabled && model.section === "operations") setSection("tables");
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
      else if (model.section === "system") renderSystemView();
      else if (model.section === "operations") ns.explorerOps?.show(dom.explorerOpsPane, { onOpenTable: (database, table) => openStorageRoute(database, table) });
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

  // Category names come from system.functions.categories, with the kind
  // ("Function", "Aggregate Function", "Table Function") as the backend
  // fallback when a function has none. Fold the spelling variants into one
  // group: "Aggregate Functions" + "Aggregate Function" -> "Aggregate",
  // uncategorized plain functions -> "Other" (ClickHouse's own catch-all).
  const FUNCTION_CATEGORY_LABELS = new Map([
    ["aggregate", "Aggregate"],
    ["table", "Table functions"],
    ["", "Other"],
    ["other", "Other"],
  ]);

  function functionCategory(item) {
    let value = String(item?.category || "").trim();
    // system.functions.categories is represented as text by the native client
    // on some versions. Keep the first meaningful category for navigation.
    value = value.replace(/^\[|\]$/g, "").trim();
    const first = value.split(",").map((part) => part.trim().replace(/^['\"]|['\"]$/g, "")).find(Boolean) || "";
    const kind = String(item?.kind || "");
    const raw = first === kind ? "" : first;
    if (!raw && kind === "Aggregate Function") return "Aggregate";
    if (!raw && kind === "Table Function") return "Table functions";
    const key = raw.toLowerCase().replace(/\bfunctions?\b/g, "").replace(/\s+/g, " ").trim();
    return FUNCTION_CATEGORY_LABELS.get(key) || raw;
  }

  // Kind badge shown only where the group does not already say it.
  function functionKindBadge(item, category) {
    if (item?.user_defined) return "UDF";
    if (item?.kind === "Aggregate Function" && category !== "Aggregate") return "aggregate";
    if (item?.kind === "Table Function" && category !== "Table functions") return "table";
    return "";
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

  // Functions most queries use, offered as shortcuts while nothing is
  // selected (only those the server actually exposes are listed).
  const POPULAR_FUNCTIONS = [
    "count", "sum", "avg", "uniq", "quantile", "argMax", "groupArray", "countIf",
    "if", "multiIf", "toDate", "toStartOfInterval", "formatDateTime", "dateDiff",
    "arrayJoin", "arrayMap", "has", "JSONExtract", "splitByChar", "replaceRegexpAll",
  ];

  function revealSelectedFunction(block = "nearest") {
    dom.explorerFunctionList?.querySelector(".explorerFunctionObject.is-selected")?.scrollIntoView?.({ block });
  }

  function selectFunction(item, category) {
    model.selectedFunctionKey = functionKey(item);
    model.expandedFunctionCategories.add(category);
    renderFunctionList();
    syncExplorerUrl("push");
    revealSelectedFunction();
  }

  // Empty state: what the catalog contains (categories with counts, popular
  // functions) instead of a bare "Select a function".
  function renderFunctionOverview() {
    const empty = dom.explorerFunctionEmpty;
    if (!empty) return;
    const functions = model.functionsCatalog?.functions || [];
    empty.classList.toggle("explorerFunctionOverview", functions.length > 0);
    if (!functions.length) {
      empty.replaceChildren(
        node("strong", "", model.loadingFunctions ? "Loading functions\u2026" : "Select a function"),
        node("span", "", "Documentation is loaded from the selected ClickHouse server when available."),
      );
      return;
    }
    const counts = new Map();
    for (const item of functions) {
      const category = functionCategory(item);
      counts.set(category, (counts.get(category) || 0) + 1);
    }
    const header = node("div", "explorerFunctionOverview__header");
    header.append(
      node("strong", "explorerFunctionOverview__title", `${fmtInt(functions.length)} functions in ${fmtInt(counts.size)} categories`),
      node("span", "explorerFunctionOverview__sub", model.functionsCatalog?.documentation_available === false
        ? "This server does not expose system.documentation: names and categories only."
        : "Pick a function on the left, search by name, or start from a category."),
    );
    const popular = POPULAR_FUNCTIONS
      .map((name) => functions.find((item) => item.name === name && !item.user_defined))
      .filter(Boolean);
    const sections = [header];
    if (popular.length) {
      const block = node("section", "explorerFunctionOverview__section");
      block.appendChild(node("h3", "explorerFunctionOverview__heading", "Popular"));
      const list = node("div", "explorerFunctionOverview__chips");
      list.id = "explorerFunctionPopular";
      for (const item of popular) {
        const button = node("button", "explorerFunctionOverview__chip", item.name);
        button.type = "button";
        button.title = `${item.name} · ${functionCategory(item)}`;
        button.addEventListener("click", () => selectFunction(item, functionCategory(item)));
        list.appendChild(button);
      }
      block.appendChild(list);
      sections.push(block);
    }
    const block = node("section", "explorerFunctionOverview__section");
    block.appendChild(node("h3", "explorerFunctionOverview__heading", "Categories"));
    const grid = node("div", "explorerFunctionOverview__categories");
    grid.id = "explorerFunctionCategories";
    for (const [category, count] of [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
      const button = node("button", "explorerFunctionOverview__category");
      button.type = "button";
      button.dataset.category = category;
      button.append(node("span", "explorerFunctionOverview__categoryName", category), node("span", "explorerFunctionOverview__categoryCount", fmtInt(count)));
      button.addEventListener("click", () => {
        model.expandedFunctionCategories.add(category);
        renderFunctionList();
        const group = [...(dom.explorerFunctionList?.querySelectorAll(".explorerFunctionGroup") || [])].find((el) => el.dataset.category === category);
        group?.scrollIntoView?.({ block: "start" });
        group?.querySelector(".explorerTreeDatabase")?.focus({ preventScroll: true });
      });
      grid.appendChild(button);
    }
    block.appendChild(grid);
    sections.push(block);
    empty.replaceChildren(...sections);
  }

  function renderFunctionDetail() {
    const item = (model.functionsCatalog?.functions || []).find((candidate) => functionKey(candidate) === model.selectedFunctionKey) || null;
    if (dom.explorerFunctionEmpty) dom.explorerFunctionEmpty.hidden = !!item;
    if (!item) renderFunctionOverview();
    if (dom.explorerFunctionDetail) dom.explorerFunctionDetail.hidden = !item;
    if (!item) return;
    if (dom.explorerFunctionDetailName) dom.explorerFunctionDetailName.textContent = item.name || "Function";
    if (dom.explorerFunctionDetailMeta) {
      const category = functionCategory(item);
      const kind = item.kind === "Aggregate Function" && category !== "Aggregate"
        ? "Aggregate function"
        : (item.kind === "Table Function" && category !== "Table functions" ? "Table function" : "");
      const bits = uniqueMetaBits([category, kind, item.user_defined ? functionOrigin(item) : "", item.introduced_in ? `since ${item.introduced_in}` : ""]);
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
      dom.explorerFunctionList.appendChild(node("div", "explorerListEmpty", model.loadingFunctions ? "Loading\u2026" : "No functions found"));
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
      section.dataset.category = category;
      const selectedInGroup = groupItems.some((item) => functionKey(item) === model.selectedFunctionKey);
      const expanded = searching || selectedInGroup || model.expandedFunctionCategories.has(category);
      const row = node("div", "explorerTreeDatabaseRow");
      const toggle = node("button", "explorerTreeDatabaseToggle", expanded ? "\u2304" : "\u203a");
      toggle.type = "button";
      toggle.setAttribute("aria-label", `${expanded ? "Collapse" : "Expand"} ${category}`);
      toggle.setAttribute("aria-expanded", String(expanded));
      const header = node("button", "explorerTreeDatabase");
      header.type = "button";
      header.append(node("span", "explorerTreeDatabase__name", category), node("span", "explorerTreeDatabase__count explorerFunctionGroup__count", fmtInt(groupItems.length)));
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
          // One line per function: the group already names the category,
          // so only a kind badge that adds information is kept.
          button.appendChild(node("span", "explorerTreeObject__name explorerFunctionObject__name", item.name || "\u2014"));
          const badge = functionKindBadge(item, category);
          if (badge) button.appendChild(node("span", "explorerFunctionObject__badge", badge));
          button.title = item.name || "";
          button.addEventListener("click", () => selectFunction(item, category));
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
      if (route?.functionName) revealSelectedFunction("center");
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

  // ---------------------------------------------------------------------------
  // Storage (database page + Storage section), drawn by app_explorer_storage.js
  //
  // Areas are local on-disk bytes, the same accounting as the database header
  // and sidebar summaries (system.parts bytes_on_disk for MergeTree, total_bytes
  // for Log-family and other disk engines). Memory/Buffer/Dictionary objects
  // report resident RAM (isResidentMemorySummary); mixing RAM into an on-disk
  // area would make the storage view disagree with the header total, so
  // resident bytes are excluded from the areas and reported separately.

  function destroyDatabaseTreemap() {
    model.databaseStorage?.destroy?.();
    model.databaseStorage = null;
  }

  function databaseStorageTree(database) {
    const tables = (model.catalog?.tables || []).filter((item) => String(item.database || "") === database);
    let residentBytes = 0;
    const children = [];
    for (const table of tables) {
      const footprint = summaryFootprintBytes(table);
      if (footprint == null || footprint <= 0) continue;
      if (isResidentMemorySummary(table)) {
        residentBytes += footprint;
        continue;
      }
      children.push({
        kind: "table",
        name: table.name,
        path: `${database}.${table.name}`,
        database,
        table: table.name,
        engine: humanEngine(table.engine),
        rows: table.rows == null ? null : Number(table.rows),
        bytes: footprint,
        count: 1,
      });
    }
    const bytes = children.reduce((sum, child) => sum + child.bytes, 0);
    const root = { kind: "database", name: database, path: database, database, bytes, count: children.length, children };
    return { root, residentBytes };
  }

  // Compact storage of the database page: a short treemap band when at least
  // three tables hold >= 1% of the database, otherwise a single share strip,
  // so the object list stays in view.
  function renderDatabaseStorage(container, database) {
    destroyDatabaseTreemap();
    const storageView = ns.explorerStorage;
    if (!storageView) return;
    const { root, residentBytes } = databaseStorageTree(database);
    model.databaseStorage = storageView.renderCompact(container, {
      root,
      residentBytes,
      name: database,
      onOpen: (db, table) => void selectTable(db, table),
      onShowStorage: () => openStorageSection({ database }),
    });
  }

  function openStorageSection(scope = {}) {
    model.storageScope = { database: String(scope.database || ""), table: scope.database ? String(scope.table || "") : "" };
    setSection("system");
    syncExplorerUrl("push");
  }

  // Treemap clicks leave the System section for the normal Tables routes, so
  // the address bar, history and lazy catalog loading behave exactly like a
  // deep link (the catalog may not even be loaded yet when System was opened
  // directly).
  function openStorageRoute(database, table = "") {
    if (!database) return;
    const path = table
      ? `/explorer/${encodeRouteSegment(database)}/${encodeRouteSegment(table)}/overview`
      : `/explorer/${encodeRouteSegment(database)}`;
    window.history.pushState({ workspace: "explorer" }, "", `${appRoute(path)}?view=browse`);
    void applyRouteFromLocation();
  }

  function renderSystemView() {
    const storageView = ns.explorerStorage;
    if (!storageView || !dom.explorerSystemPane || !model.active) return;
    storageView.show(dom.explorerSystemPane, {
      scope: model.storageScope,
      includeSystem: model.includeSystem,
      onIncludeSystemChange: (value) => {
        if (dom.explorerIncludeSystem?.disabled && !value) return;
        model.includeSystem = !!value;
        persistVisibilityOptions();
        syncVisibilityOptionLocks({ propagate: true });
        renderTableList();
      },
      onScopeChange: (scope) => {
        model.storageScope = { database: scope.database || "", table: scope.table || "" };
        syncExplorerUrl("push");
      },
      onOpenTable: (database, table) => openStorageRoute(database, table),
    });
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
          node("strong", "", error ? "Unable to load database" : "Loading tables\u2026"),
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
    renderDatabaseStorage(dom.explorerDetailContent, name);
    dom.explorerDetailContent.appendChild(sectionTitle("Objects"));
    renderDatabaseObjects(dom.explorerDetailContent, name, tables);
  }

  // Database detail object table: every visible object of the database in the
  // shared Query result table (sortable headers, numeric gauges). Data comes
  // only from the per-database catalog payload already loaded for the sidebar
  // and the treemap (system.tables + one system.parts GROUP BY), never from
  // per-table requests. Missing values sort last in both directions.
  const DATABASE_OBJECT_COLUMNS = ["Name", "Engine", "Rows", "Size", "Compressed", "Uncompressed", "Ratio", "% database", "Parts", "Modified"];
  const DATABASE_OBJECT_TYPES = ["String", "String", "UInt64", "UInt64", "UInt64", "UInt64", "Float64", "Float64", "UInt64", "DateTime"];
  const DATABASE_OBJECT_BYTE_COLUMNS = new Set([3, 4, 5]);

  function validCatalogTime(value) {
    const text = String(value || "").trim();
    return text && !text.startsWith("1970-01-01") ? text : null;
  }

  function databaseObjectRow(table, onDiskTotal) {
    const optional = (value) => {
      if (value == null || value === "") return null;
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    };
    const resident = isResidentMemorySummary(table);
    const footprint = summaryFootprintBytes(table);
    const compressed = resident ? null : optional(table.compressed_bytes);
    const uncompressed = resident ? null : optional(table.uncompressed_bytes);
    const ratio = compressed > 0 && uncompressed > 0 ? uncompressed / compressed : null;
    const share = !resident && footprint != null && onDiskTotal > 0 ? footprint / onDiskTotal * 100 : null;
    const parts = isMergeTreeSummary(table) && table.active_parts != null ? optional(table.active_parts) : null;
    const times = [validCatalogTime(table.last_part_time), validCatalogTime(table.metadata_modification_time)].filter(Boolean).sort();
    const row = [
      String(table.name || ""),
      humanEngine(table.engine) || String(table.engine || "") || null,
      optional(table.rows),
      footprint,
      compressed,
      uncompressed,
      ratio,
      share,
      parts,
      times.length ? times[times.length - 1] : null,
    ];
    row.__explorerObject = { database: String(table.database || ""), name: String(table.name || ""), resident };
    return row;
  }

  function renderDatabaseObjects(container, database, tables) {
    if (!tables.length) {
      container.appendChild(node("div", "explorerEmptySection", "No objects in this database."));
      return;
    }
    const onDiskTotal = databaseStorageTree(database).root.bytes;
    const rows = tables.map((table) => databaseObjectRow(table, onDiskTotal));
    const maxima = DATABASE_OBJECT_COLUMNS.map((_, index) => Math.max(0, ...rows.map((row) => Number(row[index]) || 0)));
    maxima[7] = 100;
    const gauges = rows.length > 1;
    const setGauge = (td, value, max, text) => {
      td.classList.add("resultTable__numeric");
      if (gauges) {
        td.classList.add("resultTable__gaugeCell", "explorerStorageGaugeCell");
        const fill = value == null || max <= 0 ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
        td.style.setProperty("--gaugeFill", `${fill}%`);
      }
      td.textContent = text;
    };
    const objectTable = ns.results?.createStaticResultTable?.({
      columns: DATABASE_OBJECT_COLUMNS,
      types: DATABASE_OBJECT_TYPES,
      rows,
      className: "explorerResultTable explorerDatabaseObjectsTable",
      nullsLast: true,
      decorateHeader: (th, ctx) => {
        th.title = {
          3: "On-disk bytes of active parts (resident memory for Memory / Buffer / Dictionary)",
          4: "Compressed data bytes of active parts",
          5: "Uncompressed data bytes of active parts",
          6: "Uncompressed / compressed",
          7: "Share of the database on-disk bytes (the treemap area)",
          8: "Active parts",
          9: "Latest of the newest part and the metadata modification time",
        }[ctx.columnIndex] || "";
      },
      decorateRow: (tr, ctx) => {
        const item = ctx.row?.__explorerObject;
        if (item) tr.dataset.table = item.name;
      },
      renderCell: (td, ctx) => {
        const item = ctx.row?.__explorerObject || null;
        const value = ctx.value;
        if (ctx.columnIndex >= 2 && ctx.columnIndex <= 8) td.dataset.value = value == null ? "" : String(value);
        if (ctx.columnIndex === 0) {
          const button = node("button", "explorerDatabaseObjectsTable__open", String(value || ""));
          button.type = "button";
          button.title = `Open ${database}.${value}`;
          const table = item || { database, name: String(value || "") };
          button.addEventListener("click", () => void selectTable(table.database, table.name));
          td.appendChild(button);
          return true;
        }
        if (value == null) {
          if (ctx.columnIndex >= 2 && ctx.columnIndex <= 8) td.classList.add("resultTable__numeric");
          td.textContent = "\u2014";
          td.classList.add("explorerDatabaseObjectsTable__missing");
          return true;
        }
        if (DATABASE_OBJECT_BYTE_COLUMNS.has(ctx.columnIndex)) {
          const text = util.formatBytes(value);
          setGauge(td, value, maxima[ctx.columnIndex], ctx.columnIndex === 3 && item?.resident ? `${text} RAM` : text);
          if (ctx.columnIndex === 3 && item?.resident) td.title = "RAM held by the object, not on disk";
          return true;
        }
        if (ctx.columnIndex === 6) { setGauge(td, value, maxima[6], `${value.toFixed(2)}×`); return true; }
        if (ctx.columnIndex === 7) { setGauge(td, value, 100, fmtPercent(value)); return true; }
        return false;
      },
    });
    if (!objectTable) throw new Error("Shared result table component is unavailable.");
    objectTable.id = "explorerDatabaseObjects";
    container.appendChild(objectTable);
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

  // Catalog payloads are replaced, never mutated in place, so their arrays are
  // stable cache keys. renderTableList() runs on every search keystroke and
  // previously re-filtered all tables and re-searched all summaries once per
  // database (O(databases x tables)).
  const catalogTablesByDatabase = new WeakMap();
  const catalogSummaryByDatabase = new WeakMap();
  function tablesByDatabase(tables) {
    let grouped = catalogTablesByDatabase.get(tables);
    if (grouped) return grouped;
    grouped = new Map();
    for (const table of tables) {
      if (!grouped.has(table.database)) grouped.set(table.database, []);
      grouped.get(table.database).push(table);
    }
    catalogTablesByDatabase.set(tables, grouped);
    return grouped;
  }
  function summaryByDatabase(summaries) {
    let byName = catalogSummaryByDatabase.get(summaries);
    if (byName) return byName;
    byName = new Map();
    for (const item of summaries) {
      // Keep the first match, as the former .find() did.
      const name = String(item?.name || "");
      if (!byName.has(name)) byName.set(name, item);
    }
    catalogSummaryByDatabase.set(summaries, byName);
    return byName;
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
      dom.explorerTableList.appendChild(node("div", "explorerListEmpty", model.loadingCatalog ? "Loading\u2026" : "No accessible databases"));
      return;
    }

    const query = String(dom.explorerSearchInput?.value || "").trim().toLowerCase();
    const groupedTables = tablesByDatabase(catalog?.tables || []);
    const summaries = summaryByDatabase(catalog?.database_summaries || []);
    for (const database of databases) {
      const allItems = (groupedTables.get(database) || []).filter((table) => sidebarObjectVisible(table));
      const items = allItems.filter((table) => !query || `${table.database}.${table.name} ${table.engine || ""}`.toLowerCase().includes(query));
      const loaded = model.databaseTablesLoaded.has(database);
      const loading = model.databaseTablesLoading.has(database);
      const expanded = model.expandedDatabases.has(database);
      const section = node("section", "explorerTreeGroup");
      const header = node("div", `explorerTreeDatabaseRow${model.selectedDatabase === database ? " is-selected" : ""}`);
      const toggle = node("button", "explorerTreeDatabaseToggle", expanded ? "\u2304" : "\u203a");
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
      const databaseSummary = summaries.get(database) || null;
      const databaseMeta = [];
      if (loading) databaseMeta.push("Loading\u2026");
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
          children.appendChild(node("div", "explorerListEmpty", "Loading tables\u2026"));
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
            const icon = node("span", `explorerTreeObject__icon explorerTreeObject__icon--${objectKind(table).toLowerCase().replace(/[^a-z]+/g, "-")}`, objectKind(table) === "Table" ? "\u25a6" : objectKind(table) === "View" ? "\u25c7" : objectKind(table) === "Materialized View" ? "\u25c6" : "\u25c8");
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

  // Table detail (header, tabs and tab bodies) lives in app_explorer_detail.js.
  // The shell hands it the model and the helpers it shares with the tree.
  const detailView = ns.explorerDetail?.create?.({
    model, node, clear, appRoute, setError, fmtInt,
    fmtBytes, fmtStorageBytes, fmtRate, fmtPercent, quoteIdent, humanEngine,
    healthLabel, summaryFootprintBytes, summaryRowsLabel, isViewLikeSummary, isMergeTreeSummary, isDictionarySummary,
    isDistributedSummary, isLogFamilySummary, isResidentMemorySummary, renderHighlightedCode, destroyDatabaseTreemap, selectTable,
    setMode, setWorkspace, syncExplorerUrl,
  }) || null;

  function renderDetailHeader() { detailView?.renderDetailHeader(); }
  function renderTabs() { detailView?.renderTabs(); }
  function renderTabContent() { detailView?.renderTabContent(); }
  function sectionTitle(text) { return node("h3", "explorerSectionTitle", text); }

  function fmtPercent(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "\u2014";
    if (n > 0 && n < 0.1) return "<0.1%";
    return `${n.toFixed(n < 10 ? 1 : 0)}%`;
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
    model.preview = null;
    model.detailLoading = true;
    renderTableList();
    setError(null);

    // The sidebar already owns a fresh table summary. Paint it immediately
    // instead of replacing the whole detail pane with a 1-2s loading screen
    // while the richer physical metadata is collected.
    const sidebarSummary = selectedTable();
    model.detail = sidebarSummary ? {
      summary: { ...sidebarSummary },
      metric_scope: "local-replica",
      footprint_scope: {},
      dependencies: [],
      columns: [],
      storage: [],
      parts: [],
      partitions: [],
      indexes_and_projections: [],
      mutations: [],
      merges: [],
      unavailable_sections: [],
      _loading: true,
    } : null;
    if (model.detail) {
      renderDetailHeader();
      renderTabs();
      renderTabContent();
      syncExplorerUrl(historyMode);
    } else {
      if (dom.explorerEmptyState) {
        dom.explorerEmptyState.hidden = false;
        dom.explorerEmptyState.replaceChildren(node("strong", "", "Loading table\u2026"), node("span", "", `${database}.${table}`));
      }
      if (dom.explorerDetail) dom.explorerDetail.hidden = true;
    }

    const hostId = String(state.selectedHostId || "");
    // Browse detail delegates to fetchTableDetail(), whose network path calls
    // api.getExplorerTable only after the graph-mode early return above.
    try {
      const detail = await fetchTableDetail(hostId, database, table, !!force);
      if (!detail || typeof detail !== "object" || !detail.summary || detail.summary.database !== database || detail.summary.name !== table) {
        throw new Error(`Invalid Explorer detail response for ${database}.${table}.`);
      }
      if (serial !== model.detailSerial || String(state.selectedHostId || "") !== hostId || model.selectedKey !== key) return;
      model.detail = detail;
      if (dom.explorerDetailTabs) dom.explorerDetailTabs.hidden = false;
      renderDetailHeader();
      renderTabs();
      renderTabContent();
      syncExplorerUrl(historyMode);

      // SQL formatting is cosmetic and must never delay the first usable table
      // view. Format after the raw DDL/detail has already been rendered.
      if (detail.ddl) {
        void api.formatSqls(hostId, [String(detail.ddl)]).then((formatted) => {
          if (!Array.isArray(formatted) || !formatted[0]) return;
          if (serial !== model.detailSerial || String(state.selectedHostId || "") !== hostId || model.selectedKey !== key || model.detail !== detail) return;
          detail.formatted_ddl = formatted[0];
          if (model.tab === "Overview") renderTabContent();
        }).catch((formatError) => {
          detail.ddl_format_error = formatError instanceof Error ? formatError.message : String(formatError || "format failed");
        });
      }
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
          revealSelectedFunction("center");
        }
        model.routeIntent = null;
      }
      return;
    }
    if (route.section === "system") {
      model.storageScope = route.storageScope || { database: "", table: "" };
      model.routeIntent = null;
      setSection("system");
      return;
    }
    if (route.section === "operations") {
      model.routeIntent = null;
      setSection("operations");
      if (model.section !== "operations") syncExplorerUrl("replace");
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
    model.detailCache.clear();
    model.detailPromises.clear();
    model.expandedDatabases.clear();
    model.selectedKey = null;
    model.selectedDatabase = null;
    model.detailSerial += 1;
    model.detail = null;
    model.detailLoading = false;
    model.preview = null;
    model.tab = "Overview";
    model.storageScope = { database: "", table: "" };
    destroyDatabaseTreemap();
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
      else if (model.section === "system") renderSystemView();
      else if (model.section !== "operations") refreshCatalog(false);
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
    dom.navTracesButton?.addEventListener("click", () => window.location.assign(appRoute("/traces")));
    window.addEventListener("popstate", () => { void applyRouteFromLocation(); });
    dom.explorerSectionSelectButton?.addEventListener("click", () => toggleDropdown(dom.explorerSectionSelect, dom.explorerSectionSelectButton, dom.explorerSectionSelectMenu));
    dom.explorerModeSelectButton?.addEventListener("click", () => toggleDropdown(dom.explorerTableModeTabs, dom.explorerModeSelectButton, dom.explorerModeSelectMenu));
    dom.explorerTablesSectionButton?.addEventListener("click", () => { setSection("tables"); syncExplorerUrl("push"); });
    dom.explorerFunctionsSectionButton?.addEventListener("click", () => { setSection("functions"); syncExplorerUrl("push"); });
    dom.explorerSystemSectionButton?.addEventListener("click", () => { setSection("system"); syncExplorerUrl("push"); });
    dom.explorerOpsSectionButton?.addEventListener("click", () => { setSection("operations"); syncExplorerUrl("push"); });
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
    // The list filter is cheap and stays per keystroke. Graph focus re-runs the
    // layout, the fit and a scoped graph fetch, so it only follows the query
    // once typing pauses instead of once per intermediate prefix.
    let graphSearchTimer = 0;
    dom.explorerSearchInput?.addEventListener("input", () => {
      renderTableList();
      clearTimeout(graphSearchTimer);
      graphSearchTimer = setTimeout(() => graph?.searchFocus(), 200);
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
