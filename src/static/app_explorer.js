(() => {
  "use strict";

  const ns = window.ChDash;
  if (!ns) return;
  const { byId, $, $$ } = ns.dom;

  const { dom, state, api, util, ui, storage, h } = ns;
  const graph = ns.explorerGraph;
  const treemap = ns.explorerTreemap;

  const model = {
    active: false,
    section: "tables",
    // Catalog mode: "browse" (the card) or "graph". The tree selection
    // (selectedKey / selectedDatabase) is the scope of both.
    mode: "browse",
    loadingCatalog: false,
    catalog: null,
    selectedKey: null,
    selectedDatabase: null,
    detail: null,
    detailLoading: false,
    detailSerial: 0,
    tab: "Columns",
    // The database page shows its storage below its objects; "storage"
    // scrolls it into view once (a former ?tab=storage address).
    databaseFocus: "",
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
    // Derived from the Views / MV chips (plus the selected object): the graph
    // projection hides or contracts non-storing objects when it is false.
    includeNonStoring: true,
    // Tree object-type chips (Tables / Views / MV / Dict); System is includeSystem.
    filters: { tables: true, views: true, mv: true, dict: true },
    treeOpen: false,
    // Side panel the mobile drawer toggle controls (drawerPane()).
    drawerPaneId: "",
    // The treemap of the database page or of the databases overview
    // (destroyed on re-render).
    databaseStorage: null,
    // The local disks of each loaded database branch (catalog "disks").
    databaseDisks: new Map(),
  };

  // Former route of the Storage section (later the Catalog's Storage mode):
  // /explorer/_system[?database=&table=] stays an alias of the storage of
  // the database page (/explorer/<db>, scrolled to it) or of the table
  // card's Storage tab (/explorer/<db>/<table>?tab=storage), or of the
  // databases overview. "/explorer/system" addresses the ClickHouse
  // `system` database, hence the underscore.
  const SYSTEM_ROUTE_SEGMENT = "_system";
  // The former Monitoring tab (/explorer/_monitoring[/<section>]) and Server
  // operations (/explorer/_operations) are the System page now: the server
  // redirects them (server.cpp redirect_to_system); an address that still
  // reaches this page (System off) opens the Catalog.
  const MOVED_ROUTE_SEGMENTS = ["_monitoring", "_operations"];
  // Route slug of the Functions section. The former "/explorer/functions"
  // route stays an alias, but only while no database is named "functions":
  // a real database always wins (resolveLegacyAlias below).
  const FUNCTIONS_ROUTE_SEGMENT = "_functions";

  // Catalog modes; Browse is the default and has no ?mode= parameter. The
  // former Storage mode is the storage of the database page and the Storage
  // tab of the table card.
  const MODES = ["browse", "graph"];

  // Table detail tabs (app_explorer_detail.js hides the ones without content).
  const TABS = ["Columns", "Preview", "Storage", "Operations", "Lineage", "DDL"];
  const DEFAULT_TAB = TABS[0];

  // Former tab slugs open the tab that took their content over.
  const TAB_BY_SLUG = new Map([
    ...TABS.map((label) => [label.toLowerCase(), label]),
    ["overview", "Columns"], ["schema", "Columns"], ["data", "Preview"],
  ]);

  // The database page has no tabs: its objects, then its storage. A former
  // ?tab=storage (or ?tab=objects) address opens it, the storage scrolled
  // into view.
  function databaseFocusOf(slug) {
    return String(slug || "").toLowerCase() === "storage" ? "storage" : "";
  }

  function decodeRouteSegment(value) {
    try { return decodeURIComponent(String(value || "")); } catch { return String(value || ""); }
  }

  function encodeRouteSegment(value) {
    return encodeURIComponent(String(value || ""));
  }

  // The address bar is ns.router's (app_router.js); the Explorer writes it
  // while its workspace shows.
  const router = ns.router;
  const appRoute = (path) => router.url(path);
  const address = router.owner("explorer", { view: () => model.active });

  // One URL scheme for the Catalog:
  //   /explorer[/<db>[/<table>]][?tab=<table card tab>|?mode=graph]
  // Browse (no mode) names the table card's tab in ?tab= (Columns, the
  // default, has none; a database page has no tabs); Graph adds
  // &graph=lineage|storage&depth=N. Aliases, rewritten to that form by
  // applyRouteFromLocation:
  //   ?view=browse|graph (former Browse / Graph views),
  //   ?mode=storage and /explorer/_system[?database=&table=] (the former
  //   Storage mode and view): the table card's Storage tab, the database
  //   page scrolled to its storage, or the databases overview at the root,
  //   /explorer/<db>?tab=storage|objects (the former database card tabs):
  //   the database page, scrolled to its storage for the first,
  //   /explorer/<db>/<table>/<tab> (the card tab as a path segment) and the
  //   former card tab slugs (overview, schema, data).
  function parseExplorerRoute(pathname = window.location.pathname) {
    const path = router.path(pathname).replace(/\/+$/, "") || "/";
    const params = router.current().params;
    const modeParam = String(params.get("mode") || "");
    const mode = MODES.includes(modeParam) ? modeParam : (params.get("view") === "graph" ? "graph" : "browse");
    // The former Storage mode: the Storage tab of the card, in Browse.
    const storageAlias = modeParam === "storage";
    const graphType = params.get("graph") === "storage" ? "physical" : "logical";
    const hasDepth = params.has("depth");
    const parsedDepth = hasDepth ? Number(params.get("depth")) : Number.NaN;
    const graphDepth = Number.isFinite(parsedDepth) ? Math.max(0, Math.min(8, Math.trunc(parsedDepth))) : 1;
    const catalog = { workspace: "explorer", section: "tables", database: "", table: "", tab: DEFAULT_TAB, databaseFocus: "", mode, graphType, graphDepth };
    if (path === "/explorer") return catalog;
    if (!path.startsWith("/explorer/")) return { workspace: "query" };
    const parts = path.slice("/explorer/".length).split("/").filter(Boolean).map(decodeRouteSegment);
    if (parts[0] === FUNCTIONS_ROUTE_SEGMENT) {
      return { workspace: "explorer", section: "functions", functionName: parts[1] || "" };
    }
    if (MOVED_ROUTE_SEGMENTS.includes(parts[0])) return { ...catalog, movedAlias: true };
    if (parts[0] === SYSTEM_ROUTE_SEGMENT) {
      const database = params.get("database") || "";
      const table = database ? params.get("table") || "" : "";
      return { ...catalog, mode: "browse", database, table, tab: "Storage", databaseFocus: table ? "" : "storage" };
    }
    const database = parts[0] || "";
    const table = parts[1] || "";
    const slug = storageAlias ? "storage" : String(params.get("tab") || parts[2] || "");
    const tab = TAB_BY_SLUG.get((slug || DEFAULT_TAB).toLowerCase()) || DEFAULT_TAB;
    const route = { ...catalog, database, table, tab, databaseFocus: table ? "" : databaseFocusOf(slug) };
    // Former reserved routes, now plain database routes that keep an alias:
    // /explorer/functions[/<name>] opened Functions, /explorer/databases the
    // catalog root. They only stand for the section when no database of that
    // name exists, which needs the catalog (resolveLegacyAlias).
    if (database === "functions" && parts.length <= 2) {
      route.legacyAlias = { section: "functions", functionName: table };
    } else if (database === "databases" && parts.length === 1) {
      route.legacyAlias = { section: "tables" };
    }
    return route;
  }

  // The Catalog URL of a scope in a mode (the scheme of parseExplorerRoute).
  function catalogPath({ database = "", table = "", tab = DEFAULT_TAB, mode = "browse", graphRoute = null } = {}) {
    let path = "/explorer";
    if (database) path += `/${encodeRouteSegment(database)}`;
    if (database && table) path += `/${encodeRouteSegment(table)}`;
    const params = new URLSearchParams();
    if (mode === "browse" && database && table && tab && tab !== DEFAULT_TAB) params.set("tab", String(tab).toLowerCase());
    if (mode !== "browse") params.set("mode", mode);
    if (mode === "graph") {
      const route = graphRoute || { mode: "logical", depth: 1 };
      params.set("graph", route.mode === "physical" ? "storage" : "lineage");
      if (route.mode !== "physical") params.set("depth", String(route.depth ?? 1));
    }
    const query = params.toString();
    return query ? `${path}?${query}` : path;
  }

  function currentExplorerPath() {
    if (model.section === "functions") {
      const selected = (model.functionsCatalog?.functions || []).find((candidate) => functionKey(candidate) === model.selectedFunctionKey) || null;
      return selected?.name ? `/explorer/${FUNCTIONS_ROUTE_SEGMENT}/${encodeRouteSegment(selected.name)}` : `/explorer/${FUNCTIONS_ROUTE_SEGMENT}`;
    }
    return catalogPath({
      ...selectionScope(),
      tab: model.tab,
      mode: model.mode,
      graphRoute: model.mode === "graph" ? (graph?.getRouteState?.() || null) : null,
    });
  }

  function currentExplorerUrl() {
    return appRoute(currentExplorerPath());
  }

  // history: "push" | "replace" | "none" (the option of every Explorer
  // navigation function).
  function syncExplorerUrl(history = "push") {
    address.write(history, null, { href: currentExplorerUrl() });
  }

  function clear(el) {
    if (el) el.replaceChildren();
  }

  // The error strip above the Explorer (ns.uiState.banner).
  function setError(error) {
    const message = !error ? "" : ns.util.errorText(error, "The Explorer request failed.");
    ns.uiState.banner(dom.explorerError, { message });
  }

  // The detail pane's state when no object is shown: empty, loading or
  // error (ns.uiState), in #explorerEmptyState.
  function showDetailState(kind, options) {
    const box = dom.explorerEmptyState;
    if (!box) return;
    box.hidden = false;
    ns.uiState[kind](box, options);
  }

  // Numbers, sizes, percentages and instants come from ns.format
  // (docs/ui-foundations.md), shared with the whole app: "120,064",
  // "120.1K", "1.7 KB", "12.3%", EMPTY (\u2014) for an absent value.
  const format = ns.format;

  function finiteOrNull(value) {
    if (value == null || value === "") return null;
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? n : null;
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


  // ---------------------------------------------------------------------------
  // Explorer shell: top-level view tabs, Catalog modes, mobile tree drawer.
  //
  // Views (top tabs) and their containers (other Explorer modules render into
  // these):
  //   catalog    #explorerListView: the object tree + #explorerCatalogMain,
  //              whose mode bar switches between two modes of one scope,
  //              the tree selection (nothing, a database or an object):
  //                browse   #explorerCatalogView (#explorerDetailPane): the
  //                         databases overview, the database page or the
  //                         table card (their storage draws through
  //                         ns.explorerStorage)
  //                graph    #explorerGraphPane, focused on the selection
  //   functions  #explorerFunctionsPane
  // Routes: the Catalog is /explorer[/<db>[/<table>[/<tab>]]][?tab=<tab>|?mode=graph]
  // (parseExplorerRoute), functions /explorer/_functions[/<name>]. Reserved
  // segments start with "_" so they never shadow a database. The server
  // itself is the System page (/system, app_system.js).
  const VIEWS = ["catalog", "functions"];

  function shellEl(id) {
    return dom[id] || byId(id);
  }

  function currentView() {
    if (model.section === "functions") return "functions";
    return "catalog";
  }

  // The scope every Catalog mode shows: the tree selection, or the route
  // still being resolved while the catalog loads.
  function selectionScope() {
    if (model.selectedKey) {
      const [database, table] = String(model.selectedKey).split("\0");
      return { database: database || "", table: table || "" };
    }
    if (model.selectedDatabase) return { database: String(model.selectedDatabase), table: "" };
    const intent = model.routeIntent;
    if (intent?.workspace === "explorer" && intent.section === "tables" && intent.database) {
      return { database: String(intent.database), table: String(intent.table || "") };
    }
    return { database: "", table: "" };
  }

  function modeAvailability() {
    // ns.features: graph.enabled already requires lineage or storage_topology.
    const f = explorerFeatures();
    return {
      browse: f.enabled && f.browse,
      graph: f.enabled && f.graph.enabled,
    };
  }

  // The Explorer view or Catalog mode on screen is an ns.lifecycle scope
  // ("explorer:browse", "explorer:graph", "explorer:functions"): what a mode
  // binds while it
  // shows (ns.lifecycle.bind) goes when another one shows.
  let lifecycleName = "";
  function syncLifecycle() {
    const next = model.section === "functions" ? "explorer:functions" : `explorer:${model.mode}`;
    if (next === lifecycleName) return;
    if (lifecycleName) ns.lifecycle?.leave(lifecycleName);
    lifecycleName = next;
    ns.lifecycle?.enter(next);
  }

  function syncViewTabs() {
    syncLifecycle();
    const view = currentView();
    const viewTabs = shellEl("explorerViewTabs");
    ns.tabs?.select(viewTabs, view, "view");
    // The Catalog modes belong to the Catalog view only.
    const modeBar = shellEl("explorerModeBar");
    if (modeBar) modeBar.hidden = view !== "catalog";
    const shell = shellEl("explorerTopBar")?.closest?.(".explorerShell");
    if (shell) {
      shell.dataset.explorerView = view;
      shell.dataset.explorerMode = model.mode;
    }
    // Every view with a side panel gets the drawer toggle on a phone.
    const pane = drawerPane(view);
    const toggle = shellEl("explorerTreeToggle");
    if (toggle) {
      toggle.hidden = !pane;
      if (pane) {
        toggle.setAttribute("aria-controls", pane.id);
        toggle.title = pane.label;
        const text = $(".explorerTreeToggle__text", toggle);
        if (text) text.textContent = pane.label;
      }
    }
    // Every Catalog mode shares the one tree; another panel starts closed.
    const paneId = pane?.id || "";
    if (paneId !== model.drawerPaneId) setTreeDrawerOpen(false);
    model.drawerPaneId = paneId;
  }

  // The Catalog modes on the right of the nav row: Browse | Graph (a
  // segmented control: modes present the same scope; the card's underlined
  // tabs are its sections). The way up to the parent scope is an icon tool
  // of the graph toolbar (Browse has the tree and the card header).
  function syncModeTabs() {
    const available = modeAvailability();
    const tabs = shellEl("explorerModeTabs");
    let shown = 0;
    for (const button of $$("[data-mode]", tabs) || []) {
      button.hidden = !available[String(button.dataset.mode || "")];
      if (!button.hidden) shown += 1;
    }
    ns.segmented?.set(tabs, model.mode, "mode");
    if (tabs) tabs.hidden = shown < 2;
    syncScopeUp();
  }

  function syncScopeUp() {
    const button = shellEl("explorerScopeUp");
    if (!button) return;
    const scope = selectionScope();
    const shown = model.section === "tables" && model.mode !== "browse" && !!scope.database;
    button.hidden = !shown;
    if (!shown) return;
    const label = scope.table ? `Up to ${scope.database}` : "Up to all databases";
    button.title = label;
    button.setAttribute("aria-label", label);
  }

  function scopeUp() {
    const scope = selectionScope();
    if (scope.table) selectDatabase(scope.database);
    else if (scope.database) openCatalogRoot();
  }

  // The side panel a view slides in as a drawer on a phone (null: none).
  function drawerPane(view = currentView()) {
    if (view === "catalog") return { id: "explorerListPane", label: "Objects" };
    if (view === "functions") return { id: "explorerFunctionListPane", label: "Functions" };
    return null;
  }

  // ns.explorer.setView(): a top view, or a Catalog mode by name ("browse",
  // "graph": the former Graph view). "storage" (the former Storage view)
  // opens Browse on the storage of the selection (the table card's Storage
  // tab, the database page scrolled to its storage).
  function setView(view, { history = "push" } = {}) {
    if (view === "storage") {
      model.tab = "Storage";
      model.databaseFocus = model.selectedKey ? "" : "storage";
      view = "browse";
    }
    if (MODES.includes(view)) {
      if (model.section !== "tables") {
        model.mode = view;
        setSection("tables");
      } else {
        setMode(view);
      }
    } else if (view === "functions") {
      setSection("functions");
    } else {
      setSection("tables");
    }
    syncExplorerUrl(history);
  }

  function clearSelection() {
    model.selectedKey = null;
    model.selectedDatabase = null;
    model.detailSerial += 1;
    model.detail = null;
    model.detailLoading = false;
    model.preview = null;
  }

  // The Catalog root in Browse ("All databases", the tree's first row): a
  // treemap of the visible databases by on-disk bytes (app_explorer_treemap.js,
  // as on the System Overview; a database opens its page), then the
  // databases overview (objects, rows, size and share of the server for
  // each, from the catalog's database summaries). The header carries the
  // count and the total; the section repeats neither.
  function renderBrowseRoot() {
    destroyDatabaseTreemap();
    const databases = visibleDatabases();
    if (!databases.length) {
      if (dom.explorerDetail) dom.explorerDetail.hidden = true;
      if (model.loadingCatalog || !model.catalog) showDetailState("loading", { label: "Loading databases\u2026" });
      else showDetailState("empty", { title: "No databases", body: "This host shows no database you can read." });
      return;
    }
    if (dom.explorerEmptyState) dom.explorerEmptyState.hidden = true;
    if (!dom.explorerDetail || !dom.explorerDetailContent) return;
    dom.explorerDetail.hidden = false;
    const summaries = summaryByDatabase(model.catalog?.database_summaries || []);
    const rows = databases.map((name) => {
      const summary = summaries.get(name) || null;
      const number = (value) => (value == null || !Number.isFinite(Number(value)) ? null : Number(value));
      const row = [name, number(summary?.tables), number(summary?.rows), number(summary?.bytes), null];
      row.__database = name;
      return row;
    });
    const total = rows.reduce((sum, row) => sum + (row[3] || 0), 0);
    for (const row of rows) row[4] = total > 0 && row[3] != null ? row[3] / total * 100 : null;
    if (dom.explorerDetailName) dom.explorerDetailName.textContent = "All databases";
    if (dom.explorerDetailMeta) dom.explorerDetailMeta.textContent = [format.countLabel(databases.length, "database"), total > 0 ? `${format.bytes(total)} on disk` : ""].filter(Boolean).join(" \u00b7 ");
    if (dom.explorerHealthBadge) { dom.explorerHealthBadge.hidden = true; dom.explorerHealthBadge.textContent = ""; }
    if (dom.explorerWarnings) { dom.explorerWarnings.hidden = true; dom.explorerWarnings.replaceChildren(); }
    if (dom.explorerSummaryCards) { dom.explorerSummaryCards.hidden = true; dom.explorerSummaryCards.replaceChildren(); }
    if (dom.explorerDetailTabs) { dom.explorerDetailTabs.hidden = true; dom.explorerDetailTabs.replaceChildren(); }
    clear(dom.explorerDetailContent);
    const section = h("section", { class: "explorerSection explorerDatabasesOverview" });
    section.appendChild(h("div", { class: "explorerSectionHead" }, h("h3", { class: "explorerSectionTitle" }, "Databases")));
    dom.explorerDetailContent.appendChild(section);
    renderDatabasesTreemap(section, rows);
    const maxima = [0, 1, 2, 3, 4].map((index) => Math.max(0, ...rows.map((row) => Number(row[index]) || 0)));
    const overview = ns.results?.createStaticResultTable?.({
      columns: ["Database", "Objects", "Rows", "Size", "% server"],
      types: ["String", "UInt64", "UInt64", "UInt64", "Float64"],
      rows,
      className: "explorerResultTable explorerDatabasesTable",
      compact: true,
      nullsLast: true,
      decorateHeader: (th, ctx) => {
        th.title = { 1: "Tables, views, dictionaries and other objects", 2: "Rows of the tables that report them", 3: "On-disk bytes of active parts", 4: "Share of the on-disk bytes of the databases listed" }[ctx.columnIndex] || "";
      },
      decorateRow: (tr, ctx) => { if (ctx.row?.__database) tr.dataset.database = ctx.row.__database; },
      renderCell: (td, ctx) => {
        const value = ctx.value;
        if (ctx.columnIndex === 0) {
          const button = h("button", { class: "explorerDatabaseObjectsTable__open explorerDatabaseObjectsTable__clip", type: "button", title: `Open ${value}` }, String(value || ""));
          button.addEventListener("click", () => selectDatabase(String(value || "")));
          td.appendChild(button);
          return true;
        }
        td.classList.add("num");
        if (value == null) { td.textContent = format.EMPTY; return true; }
        const text = ctx.columnIndex === 3 ? format.bytes(value) : ctx.columnIndex === 4 ? format.percent(value / 100) : format.count(value);
        if (rows.length > 1 && ctx.columnIndex >= 2) ns.table.cellBar(td, barPercent(value, maxima[ctx.columnIndex]));
        td.textContent = text;
        return true;
      },
    });
    if (overview) {
      overview.id = "explorerDatabasesOverview";
      section.appendChild(overview);
    }
  }

  // The databases overview's size band: one rectangle per visible database
  // with on-disk bytes, the ones under 1% of the total grouped into Others
  // (drawn as soon as one database holds data, as on the System Overview);
  // always a treemap (strip: "never"), even when one database holds most of
  // the bytes, at the size band's height.
  function renderDatabasesTreemap(container, rows) {
    const storageView = ns.explorerStorage;
    if (!storageView) return;
    const children = rows.filter((row) => Number(row[3]) > 0).map((row) => ({
      kind: "database",
      name: row.__database,
      path: row.__database,
      database: row.__database,
      bytes: Number(row[3]),
      count: 0,
      countLabel: row[1] == null ? "" : format.countLabel(row[1], "object"),
    }));
    const bytes = children.reduce((sum, child) => sum + child.bytes, 0);
    model.databaseStorage = storageView.renderTreemap(container, {
      tree: { kind: "server", name: "", bytes, children },
      name: "the databases",
      id: "explorerDatabasesTreemap",
      ariaLabel: "Database size treemap",
      scopeLabel: "the databases listed",
      unit: "databases",
      minItems: 1,
      fallback: "strip",
      strip: "never",
      onOpen: (target) => {
        if (target.kind === "database" && target.database) selectDatabase(target.database);
      },
    });
  }

  // Is the Browse pane showing the Catalog root (the databases overview)?
  function browseRootShown() {
    return model.active && model.section === "tables" && model.mode === "browse" && !model.selectedKey && !model.selectedDatabase && !selectionScope().database;
  }

  // Nothing selected: the Catalog root (the databases overview in Browse,
  // all databases in Graph).
  function openCatalogRoot({ history = "push" } = {}) {
    clearSelection();
    syncVisibilityOptionLocks({ propagate: true });
    renderTableList();
    showMode();
    syncExplorerUrl(history);
  }

  // The tree becomes a drawer at --bp-md (ns.shell, app_dom.js).
  function isMobileShell() {
    return !!ns.shell?.isAtMost("md");
  }

  // The tree and the Functions list: ns.sidePanel shells (a 32 px rail when
  // folded on wide windows; a drawer over the content on phones, which
  // #explorerTreeToggle opens for the view's pane: an ns.layers layer, so
  // Escape and a press outside close it).
  const sidePanels = {};
  function sidePanel(id) {
    if (sidePanels[id] || !byId(id)) return sidePanels[id] || null;
    const pane = byId(id);
    const tree = id === "explorerListPane";
    sidePanels[id] = ns.sidePanel.mount(pane, {
      label: tree ? "Objects" : "Functions",
      collapse: { button: byId(tree ? "explorerTreeCollapse" : "explorerFunctionCollapse"), storeKey: tree ? ns.storage.KEYS.explorerTreeCollapsed : ns.storage.KEYS.explorerFunctionsCollapsed },
      drawer: {
        toggle: shellEl("explorerTreeToggle"),
        backdrop: pane.nextElementSibling?.classList.contains("explorerTreeBackdrop") ? pane.nextElementSibling : null,
        // The toggle is shared by both panes: the Explorer names it (syncViewTabs).
        bind: false,
        manageToggle: false,
        onChange: (open) => { if (!open && model.treeOpen && drawerPane()?.id === id) setTreeDrawerOpen(false); },
      },
    });
    return sidePanels[id];
  }

  // Mobile: the tree is an off-canvas drawer over the content.
  function setTreeDrawerOpen(open) {
    const shell = shellEl("explorerTopBar")?.closest?.(".explorerShell");
    const value = !!open && isMobileShell();
    model.treeOpen = value;
    shell?.classList.toggle("is-tree-open", value);
    const current = drawerPane()?.id || "";
    for (const id of ["explorerListPane", "explorerFunctionListPane"]) sidePanel(id)?.setDrawerOpen(value && id === current);
    const toggle = shellEl("explorerTreeToggle");
    if (toggle) {
      const label = (drawerPane()?.label || "Objects").toLowerCase();
      toggle.setAttribute("aria-expanded", String(value));
      toggle.setAttribute("aria-label", value ? `Hide ${label}` : `Show ${label}`);
    }
  }

  // show: false only switches the panes; the caller applies the selection
  // (applyRouteFromLocation, openCard).
  function setSection(section, { show = true } = {}) {
    const next = section === "functions" ? "functions" : "tables";
    model.section = next;
    const functions = next === "functions";

    if (dom.explorerFunctionsPane) dom.explorerFunctionsPane.hidden = !functions;
    syncViewTabs();

    if (functions) {
      if (dom.explorerListView) dom.explorerListView.hidden = true;
      graph?.deactivate();
      renderFunctionList();
      if (model.active) refreshFunctions(false);
      return;
    }

    setMode(model.mode, { show });
    renderTableList();
    if (model.active) refreshCatalog(false);
  }

  function explorerFeatures() {
    return ns.features.get("explorer");
  }

  function applyExplorerFeatures() {
    const gf = explorerFeatures().graph || {};
    const available = modeAvailability();
    // A mode the server disables falls back to the first available one.
    if (!available[model.mode]) setMode(model.mode);

    const modes = [];
    if (available.graph && gf.lineage !== false) modes.push("logical");
    if (available.graph && gf.storage_topology !== false) modes.push("physical");
    const explicitTypeChoice = modes.length > 1;
    if (dom.explorerGraphTypeSelect) dom.explorerGraphTypeSelect.hidden = !explicitTypeChoice;
    if (dom.explorerGraphLogicalButton) dom.explorerGraphLogicalButton.hidden = gf.lineage === false;
    if (dom.explorerGraphPhysicalButton) dom.explorerGraphPhysicalButton.hidden = gf.storage_topology === false;
    if (modes.length === 1) graph?.setDetailMode?.(modes[0]);
    syncModeTabs();
    syncViewTabs();
  }

  // Switches the Catalog mode; the selection stays. show: false only
  // switches the panes (see setSection).
  function setMode(mode, { show = true } = {}) {
    const available = modeAvailability();
    const requested = mode === "list" ? "browse" : String(mode || "");
    const next = MODES.includes(requested) && available[requested] ? requested : (MODES.find((name) => available[name]) || "browse");
    const previous = model.mode;
    model.mode = next;
    const tables = model.section === "tables";
    const browse = tables && next === "browse";
    if (dom.explorerListView) dom.explorerListView.hidden = !tables;
    const catalogView = shellEl("explorerCatalogView");
    if (catalogView) catalogView.hidden = !browse;
    if (dom.explorerDetailPane) dom.explorerDetailPane.hidden = !browse;
    if (dom.explorerGraphPane) dom.explorerGraphPane.hidden = !tables || next !== "graph";
    syncModeTabs();
    syncViewTabs();
    if (!model.active || !tables) return;
    if (next !== "graph") graph?.deactivate();
    // The tree greys storage-less objects in the graph's Storage topology only.
    if (previous !== next) {
      syncVisibilityOptionLocks({ propagate: next === "graph" });
      renderTableList();
    }
    if (show) showMode();
  }

  // Shows the selection in the current mode: the card (Browse) or the graph
  // focused on it (Graph).
  function showMode() {
    if (!model.active || model.section !== "tables") return;
    const scope = selectionScope();
    if (model.mode === "graph") {
      if (scope.table) {
        if (graph?.isStorageMode?.() && graph?.canUseStorageForTable?.(scope.database, scope.table) === false) {
          graph?.setDetailMode?.("logical");
        }
        graph?.focusTable?.(scope.database, scope.table, { ensureVisible: true });
      } else {
        graph?.focusDatabase?.(scope.database);
      }
      graph?.activate(false);
      return;
    }
    // Graph never fetches the card: Browse loads it when shown. The caller
    // owns the history entry (a mode switch pushes the Browse URL).
    if (model.selectedKey) {
      if (!model.detailLoading && !model.detail) void selectTable(scope.database, scope.table, false, { history: "none" });
    } else if (model.selectedDatabase) {
      renderDatabaseDetail(model.selectedDatabase);
    } else if (!scope.database) {
      renderBrowseRoot();
    }
  }

  // "Open card" (Graph side panel): the object's card in Browse, as its
  // deep link opens it.
  function openCard(database, table) {
    if (!database || !table) return;
    model.tab = DEFAULT_TAB;
    if (model.section !== "tables") {
      model.mode = "browse";
      setSection("tables", { show: false });
    } else {
      setMode("browse", { show: false });
    }
    void selectTable(database, table, false, { history: "push" });
  }

  function setWorkspace(name, { history = "push" } = {}) {
    if (name === "explorer" && explorerFeatures().enabled === false) name = "query";
    const explorer = name === "explorer";
    // Query and Explorer are separate HTML documents. Crossing that boundary
    // must load the other document rather than leaving the current DOM mounted
    // and emulating a page transition with pushState.
    if (explorer && !dom.explorerWorkspace) {
      if (history !== "none") window.location.assign(appRoute("/explorer"));
      return;
    }
    if (!explorer && !dom.queryWorkspace) {
      if (history !== "none") window.location.assign(appRoute("/query"));
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
    if (window.location.pathname !== route) router.write(history, null, { href: route, view: explorer ? "explorer" : "query" });

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

  const TYPE_FILTERS = ["tables", "views", "mv", "dict"];
  const KEYS = ns.storage.KEYS;

  function filterKindOf(table) {
    const key = engineKey(table);
    if (key === "dictionary") return "dict";
    if (key === "materializedview") return "mv";
    if (key === "view" || key === "parameterizedview") return "views";
    return "tables";
  }

  function sidebarObjectVisible(table) {
    if (!table) return false;
    if (!model.includeSystem && isSystemDatabaseName(table.database)) return false;
    return model.filters[filterKindOf(table)] !== false;
  }

  function isSystemDatabaseName(database) {
    return ["system", "information_schema", "INFORMATION_SCHEMA"].includes(String(database || ""));
  }

  function visibilityRequirementsForCurrentObject() {
    const table = selectedTable();
    const graphRequirements = model.mode === "graph" ? (graph?.visibilityRequirements?.() || {}) : {};
    return {
      includeSystem: !!graphRequirements.includeSystem || !!table && isSystemDatabaseName(table.database)
        || !!model.selectedDatabase && isSystemDatabaseName(model.selectedDatabase),
      // A selected object cannot be hidden by the filter that would exclude
      // it: its type chip stays pressed and locked until the selection moves.
      kind: table ? filterKindOf(table) : null,
      includeNonStoring: !!table && nonStoringSummary(table) || !!graphRequirements.includeNonStoring,
    };
  }

  function persistVisibilityOptions() {
    ns.storage.pref(KEYS.explorerIncludeSystem, false).set(model.includeSystem);
    ns.storage.pref(KEYS.explorerTypeFilters, "").set(TYPE_FILTERS.filter((key) => model.filters[key] !== false).join(","));
  }

  function loadVisibilityOptions() {
    model.includeSystem = ns.storage.pref(KEYS.explorerIncludeSystem, false).get();
    const stored = ns.storage.pref(KEYS.explorerTypeFilters, null).get();
    if (stored != null) {
      const enabled = new Set(String(stored).split(",").filter(Boolean));
      for (const key of TYPE_FILTERS) model.filters[key] = enabled.has(key);
    } else if (ns.storage.pref(KEYS.explorerIncludeNonStoring, true).get() === false) {
      // Former "Include non-storing objects" switch.
      model.filters.views = false;
      model.filters.mv = false;
    }
  }

  function syncFilterChips(required) {
    const root = shellEl("explorerTreeFilters");
    if (!root) return;
    for (const chip of $$(".explorerFilterChip[data-filter]", root)) {
      const key = String(chip.dataset.filter || "");
      const system = key === "system";
      const pressed = system ? model.includeSystem : model.filters[key] !== false;
      const locked = system ? !!required.includeSystem : required.kind === key;
      chip.setAttribute("aria-pressed", String(pressed));
      chip.classList.toggle("is-on", pressed);
      chip.disabled = locked;
      chip.classList.toggle("is-locked", locked);
      if (!chip.dataset.baseTitle) chip.dataset.baseTitle = chip.title || "";
      chip.title = locked
        ? (system ? "Required while the selected object belongs to a system database." : "Required while the selected object is of this type.")
        : chip.dataset.baseTitle;
    }
  }

  function syncVisibilityOptionLocks({ propagate = false } = {}) {
    const required = visibilityRequirementsForCurrentObject();
    let changed = false;
    if (required.includeSystem && !model.includeSystem) { model.includeSystem = true; changed = true; }
    if (required.kind && model.filters[required.kind] === false) { model.filters[required.kind] = true; changed = true; }
    const includeNonStoring = model.filters.views !== false || model.filters.mv !== false || required.includeNonStoring;
    if (includeNonStoring !== model.includeNonStoring) { model.includeNonStoring = includeNonStoring; changed = true; }
    syncFilterChips(required);
    if (changed) persistVisibilityOptions();
    if ((changed || propagate) && model.mode === "graph") {
      const effective = graph?.setVisibilityOptions?.({ includeSystem: model.includeSystem, includeNonStoring: model.includeNonStoring });
      if (effective) {
        model.includeSystem = !!effective.includeSystem;
        model.includeNonStoring = !!effective.includeNonStoring;
        syncFilterChips(required);
      }
    }
  }

  function toggleTypeFilter(key) {
    if (key === "system") model.includeSystem = !model.includeSystem;
    else if (TYPE_FILTERS.includes(key)) model.filters[key] = model.filters[key] === false;
    else return;
    persistVisibilityOptions();
    syncVisibilityOptionLocks({ propagate: true });
    renderTableList();
    if (model.section === "tables" && model.mode === "browse" && model.selectedDatabase && !model.selectedKey) renderDatabaseDetail(model.selectedDatabase);
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
    const value = compact ? format.compact(summary.rows) : format.count(summary.rows);
    return isBufferSummary(summary) ? `${value} buffered rows` : `${value} rows`;
  }

  function sizeLabelForSummary(summary) {
    return isMergeTreeSummary(summary) ? "Compressed" : "Size";
  }

  function humanEngine(engine) {
    const value = String(engine || "");
    const compact = value.toLowerCase().replace(/[^a-z0-9]/g, "");
    // ClickHouse's own engine names, as system.tables spells them: an engine
    // given in another spelling (lower case, spaced) is written back that way,
    // any other name is shown as sent.
    const labels = {
      mergetree: "MergeTree",
      replacingmergetree: "ReplacingMergeTree",
      summingmergetree: "SummingMergeTree",
      aggregatingmergetree: "AggregatingMergeTree",
      collapsingmergetree: "CollapsingMergeTree",
      versionedcollapsingmergetree: "VersionedCollapsingMergeTree",
      replicatedmergetree: "ReplicatedMergeTree",
      replicatedreplacingmergetree: "ReplicatedReplacingMergeTree",
      replicatedsummingmergetree: "ReplicatedSummingMergeTree",
      replicatedaggregatingmergetree: "ReplicatedAggregatingMergeTree",
      materializedview: "MaterializedView",
      view: "View",
      distributed: "Distributed",
      dictionary: "Dictionary",
      memory: "Memory",
      buffer: "Buffer",
      tinylog: "TinyLog",
      stripelog: "StripeLog",
      log: "Log",
    };
    return labels[compact] || value || "metadata pending";
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

  // Inline markdown: [label](href), `code` and **bold**. A link's label is
  // inline markdown too ("[`Array(T)`](/sql-reference/data-types/array)"
  // reads as code, with or without the link).
  function appendMarkdownInline(parent, text) {
    const source = String(text || "");
    const re = /\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*/g;
    let cursor = 0;
    for (const match of source.matchAll(re)) {
      if (match.index > cursor) parent.appendChild(document.createTextNode(source.slice(cursor, match.index)));
      if (match[1] != null) {
        const href = safeDocHref(match[2]);
        if (href) {
          const a = h("a", { class: "functionDoc__link" });
          appendMarkdownInline(a, match[1]);
          a.href = href;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          parent.appendChild(a);
        } else {
          appendMarkdownInline(parent, match[1]);
        }
      } else if (match[3] != null) {
        parent.appendChild(h("code", { class: "functionDoc__inlineCode" }, match[3]));
      } else if (match[4] != null) {
        parent.appendChild(h("strong", null, match[4]));
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
      const p = h("p", { class: "functionDoc__paragraph" });
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
        const wrap = h("pre", { class: "functionDoc__code" });
        const codeEl = h("code", { class: fence[1] ? `language-${fence[1]}` : "" });
        wrap.appendChild(codeEl);
        code = { wrap, code: codeEl, lines: [] };
        continue;
      }
      const heading = line.match(/^\s*(#{1,4})\s+(.+)$/);
      if (heading) {
        flushParagraph(); closeList();
        const title = h(heading[1].length <= 2 ? "h3" : "h4", { class: "functionDoc__heading" });
        appendMarkdownInline(title, heading[2]);
        container.appendChild(title);
        continue;
      }
      const bullet = line.match(/^\s*[-*]\s+(.+)$/);
      if (bullet) {
        flushParagraph();
        if (!list) { list = h("ul", { class: "functionDoc__list" }); container.appendChild(list); }
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
    const section = h("section", { class: "functionDoc__section" });
    section.appendChild(h("h3", { class: "functionDoc__sectionTitle" }, title));
    if (code) {
      const pre = h("pre", { class: "functionDoc__code" });
      const codeEl = h("code", { class: "language-sql" });
      renderHighlightedCode(codeEl, String(content || ""));
      pre.appendChild(codeEl);
      section.appendChild(pre);
    } else {
      const body = h("div", { class: "functionDoc__markdown" });
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
    $(".explorerFunctionObject.is-selected", dom.explorerFunctionList)?.scrollIntoView?.({ block });
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
      if (model.loadingFunctions) ns.uiState.loading(empty, { label: "Loading functions\u2026" });
      else ns.uiState.empty(empty, { title: "Select a function", body: "Its documentation comes from the selected ClickHouse server, when it has some." });
      return;
    }
    empty.removeAttribute("aria-busy");
    const counts = new Map();
    for (const item of functions) {
      const category = functionCategory(item);
      counts.set(category, (counts.get(category) || 0) + 1);
    }
    const header = h("div", { class: "explorerFunctionOverview__header" });
    header.append(
      h("strong", { class: "explorerFunctionOverview__title" }, `${format.countLabel(functions.length, "function")} in ${format.countLabel(counts.size, "category", "categories")}`),
      h("span", { class: "explorerFunctionOverview__sub" }, model.functionsCatalog?.documentation_available === false
        ? "This server does not expose system.documentation: names and categories only."
        : "Pick a function or a category on the left, or search by name."),
    );
    const popular = POPULAR_FUNCTIONS
      .map((name) => functions.find((item) => item.name === name && !item.user_defined))
      .filter(Boolean);
    const sections = [header];
    if (popular.length) {
      const block = h("section", { class: "explorerFunctionOverview__section" });
      block.appendChild(h("h3", { class: "explorerFunctionOverview__heading" }, "Popular"));
      const list = h("div", { class: "explorerFunctionOverview__chips" });
      list.id = "explorerFunctionPopular";
      for (const item of popular) {
        const button = h("button", { class: "explorerFunctionOverview__chip" }, item.name);
        button.type = "button";
        button.title = `${item.name} · ${functionCategory(item)}`;
        button.addEventListener("click", () => selectFunction(item, functionCategory(item)));
        list.appendChild(button);
      }
      block.appendChild(list);
      sections.push(block);
    }
    // The categories are the list on the left (with their counts): the
    // overview does not repeat them.
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
      const aliasSection = h("section", { class: "functionDoc__section functionDoc__alias" });
      aliasSection.appendChild(h("h3", { class: "functionDoc__sectionTitle" }, `Alias documentation · ${aliased.name}`));
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
      dom.explorerFunctionDescription.appendChild(ns.uiState.block("empty", { body: "This server has no documentation for this function.", compact: true }));
    }
  }

  // The loading, empty or failed state of a tree or list (ns.uiState, compact).
  // `clear`: the search field whose search found nothing (a "Clear the search" way out).
  function listState(kind, text, retry, clear) {
    const action = clear?.handle && clear.input?.value ? { label: "Clear the search", onClick: () => { clear.handle.clear(); clear.input.focus(); } } : null;
    return ns.uiState.block(kind, kind === "loading" ? { label: text, compact: true } : { body: text, compact: true, retry, action });
  }
  const searches = { tree: null, functions: null };

  function renderFunctionList() {
    if (!dom.explorerFunctionList) return;
    const items = visibleFunctions();
    clear(dom.explorerFunctionList);
    setSideMeta("explorerFunctionMeta", items.length ? format.countLabel(items.length, "function") : "");
    if (!items.length) {
      dom.explorerFunctionList.appendChild(listState(model.loadingFunctions ? "loading" : "empty", model.loadingFunctions ? "Loading functions\u2026" : "No functions found", null, { handle: searches.functions, input: dom.explorerFunctionSearchInput }));
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
      const section = h("section", { class: "explorerTreeGroup explorerFunctionGroup" });
      section.dataset.category = category;
      const selectedInGroup = groupItems.some((item) => functionKey(item) === model.selectedFunctionKey);
      const expanded = searching || selectedInGroup || model.expandedFunctionCategories.has(category);
      const row = h("div", { class: "explorerTreeDatabaseRow" });
      const toggle = h("button", { class: "explorerTreeDatabaseToggle" }, ns.icon.el("chevron-right", { size: "sm", className: "icon--disclosure" }));
      toggle.type = "button";
      toggle.setAttribute("aria-label", `${expanded ? "Collapse" : "Expand"} ${category}`);
      toggle.title = toggle.getAttribute("aria-label");
      toggle.setAttribute("aria-expanded", String(expanded));
      const header = h("button", { class: "explorerTreeDatabase" });
      header.type = "button";
      header.append(h("span", { class: "explorerTreeDatabase__name" }, category), h("span", { class: "explorerTreeDatabase__count explorerFunctionGroup__count" }, format.count(groupItems.length)));
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
        const children = h("div", { class: "explorerTreeChildren" });
        for (const item of groupItems.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")))) {
          const key = functionKey(item);
          const button = h("button", { class: "explorerTreeObject explorerFunctionObject" });
          button.type = "button";
          button.classList.toggle("is-selected", key === model.selectedFunctionKey);
          // One line per function: the group already names the category,
          // so only a kind badge that adds information is kept.
          button.appendChild(h("span", { class: "explorerTreeObject__name explorerFunctionObject__name" }, item.name || "\u2014"));
          const badge = functionKindBadge(item, category);
          if (badge) button.appendChild(ns.badge.el(badge, { shape: "pill", className: "explorerFunctionObject__badge" }));
          button.title = item.name || "";
          button.addEventListener("click", () => { selectFunction(item, category); setTreeDrawerOpen(false); });
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
    ns.uiState.busy(dom.explorerFunctionRefreshButton, true);
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
      ns.uiState.busy(dom.explorerFunctionRefreshButton, false);
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
    model.databaseDisks.set(name, Array.isArray(payload?.disks) ? payload.disks : []);
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
        if (model.selectedDatabase === name && model.mode === "browse") renderDatabaseDetail(name);
      } catch (error) {
        if (!model.active || String(state.selectedHostId || "") !== hostId) return;
        model.databaseLoadErrors.set(name, error);
        renderTableList();
        if (model.selectedDatabase === name && model.mode === "browse") renderDatabaseDetail(name);
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
  // Database page: the header, then one page without tabs: its objects,
  // then its storage (tables by size and the disks it uses, drawn by
  // app_explorer_storage.js) when something of it is stored.
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

  function databaseSummary(name) {
    return summaryByDatabase(model.catalog?.database_summaries || []).get(String(name || "")) || null;
  }

  // The storage of a database page, under its objects: a treemap of its
  // tables (or one share strip when fewer than three hold >= 1%) and the
  // disks it uses; nothing when nothing of it is stored (on disk or in RAM).
  // A table opens on its own Storage tab.
  function renderDatabaseStorage(container, database) {
    destroyDatabaseTreemap();
    const storageView = ns.explorerStorage;
    if (!storageView) return null;
    const { root, residentBytes } = databaseStorageTree(database);
    if (!(root.bytes > 0) && !(residentBytes > 0)) return null;
    model.databaseStorage = storageView.renderDatabase(container, {
      root,
      residentBytes,
      name: database,
      disks: model.databaseDisks.get(database) || [],
      onOpen: (db, table) => {
        model.tab = "Storage";
        void selectTable(db, table);
      },
    });
    return model.databaseStorage?.element || null;
  }

  function renderDatabaseDetail(database) {
    const name = String(database || "");
    const tables = (model.catalog?.tables || [])
      .filter((item) => item.database === name && sidebarObjectVisible(item))
      .sort((a, b) => a.name.localeCompare(b.name));
    destroyDatabaseTreemap();
    if (!name || !catalogHasDatabase(name)) {
      showDetailState("empty", { title: "Database unavailable", body: name ? `${name} is not in the catalog of this host, or you cannot read it.` : "Pick a database in the tree." });
      if (dom.explorerDetail) dom.explorerDetail.hidden = true;
      return;
    }

    if (!model.databaseTablesLoaded.has(name)) {
      const error = model.databaseLoadErrors.get(name);
      if (error) showDetailState("error", { title: "The database could not be loaded", body: util.errorText(error, name), retry: () => void loadDatabaseTables(name, true) });
      else showDetailState("loading", { label: `Loading the tables of ${name}\u2026` });
      if (dom.explorerDetail) dom.explorerDetail.hidden = true;
      // A failed load waits for Retry (no automatic retry loop against a failing server).
      if (!error && !model.databaseTablesLoading.has(name)) void loadDatabaseTables(name);
      return;
    }

    if (dom.explorerEmptyState) dom.explorerEmptyState.hidden = true;
    if (dom.explorerDetail) dom.explorerDetail.hidden = false;
    if (dom.explorerDetailName) dom.explorerDetailName.textContent = name;
    if (dom.explorerDetailMeta) {
      const summary = databaseSummary(name);
      const meta = [format.countLabel(tables.length, "object")];
      if (summary && Number.isFinite(Number(summary.bytes))) meta.push(format.bytes(summary.bytes));
      dom.explorerDetailMeta.textContent = meta.join(" \u00b7 ");
    }
    if (dom.explorerHealthBadge) { dom.explorerHealthBadge.hidden = true; dom.explorerHealthBadge.textContent = ""; }
    if (dom.explorerWarnings) { dom.explorerWarnings.hidden = true; dom.explorerWarnings.replaceChildren(); }
    if (dom.explorerSummaryCards) { dom.explorerSummaryCards.hidden = true; dom.explorerSummaryCards.replaceChildren(); }
    // One page, no tabs.
    if (dom.explorerDetailTabs) { dom.explorerDetailTabs.hidden = true; dom.explorerDetailTabs.replaceChildren(); }
    const focus = model.databaseFocus;
    model.databaseFocus = "";
    if (!dom.explorerDetailContent) return;
    clear(dom.explorerDetailContent);
    if (!tables.length) {
      dom.explorerDetailContent.appendChild(ns.uiState.block("empty", { body: "No objects in this database." }));
      return;
    }
    const body = h("div", { class: "explorerDatabaseCard" });
    dom.explorerDetailContent.appendChild(body);
    renderDatabaseObjects(body, name, tables);
    const storage = renderDatabaseStorage(body, name);
    // A former ?tab=storage address: the storage, once, at the top of the pane.
    if (focus === "storage" && storage) requestAnimationFrame(() => storage.scrollIntoView({ block: "start" }));
  }

  // Database detail object table: every visible object of the database in the
  // shared Query result table (sortable headers, numeric gauges). Data comes
  // only from the per-database catalog payload already loaded for the sidebar
  // and the treemap (system.tables + one system.parts GROUP BY), never from
  // per-table requests. Missing values sort last in both directions.
  // Uncompressed bytes live in the Ratio tooltip so the table fits a 1280 px
  // window without horizontal scrolling.
  const DATABASE_OBJECT_COLUMNS = ["Name", "Engine", "Rows", "Size", "Compressed", "Ratio", "% database", "Parts", "Modified"];
  const DATABASE_OBJECT_TYPES = ["String", "String", "UInt64", "UInt64", "UInt64", "Float64", "Float64", "UInt64", "DateTime"];
  const DATABASE_OBJECT_BYTE_COLUMNS = new Set([3, 4]);
  const DATABASE_OBJECT_NUMERIC = (index) => index >= 2 && index <= 7;

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
      ratio,
      share,
      parts,
      times.length ? times[times.length - 1] : null,
    ];
    row.__explorerObject = { database: String(table.database || ""), name: String(table.name || ""), resident, compressed, uncompressed };
    return row;
  }

  // Columns drawn with an in-cell bar normalised to the column maximum.
  const DATABASE_OBJECT_BAR_COLUMNS = new Set([2, 3, 4, 6]);

  function renderDatabaseObjects(container, database, tables) {
    const section = h("section", { class: "explorerSection explorerDatabaseObjects" });
    const head = h("div", { class: "explorerSectionHead" });
    // The page header counts the objects.
    head.append(h("h3", { class: "explorerSectionTitle" }, "Objects"));
    section.appendChild(head);
    container.appendChild(section);
    if (!tables.length) {
      section.appendChild(ns.uiState.block("empty", { body: "No objects in this database.", compact: true }));
      return;
    }
    const onDiskTotal = databaseStorageTree(database).root.bytes;
    const rows = tables.map((table) => databaseObjectRow(table, onDiskTotal));
    const maxima = DATABASE_OBJECT_COLUMNS.map((_, index) => Math.max(0, ...rows.map((row) => Number(row[index]) || 0)));
    const bars = rows.length > 1;
    const setBar = (td, value, max, text) => {
      td.classList.add("num");
      if (bars && DATABASE_OBJECT_BAR_COLUMNS.has(td.__columnIndex)) ns.table.cellBar(td, barPercent(value, max));
      td.textContent = text;
    };
    const objectTable = ns.results?.createStaticResultTable?.({
      columns: DATABASE_OBJECT_COLUMNS,
      types: DATABASE_OBJECT_TYPES,
      rows,
      className: "explorerResultTable explorerDatabaseObjectsTable",
      compact: true,
      nullsLast: true,
      decorateHeader: (th, ctx) => {
        th.title = {
          2: "Rows (buffered rows for Buffer)",
          3: "On-disk bytes of active parts (resident memory for Memory / Buffer / Dictionary)",
          4: "Compressed data bytes of active parts",
          5: "Uncompressed / compressed data bytes of active parts",
          6: "Share of the database on-disk bytes (the treemap area)",
          7: "Active parts",
          8: "Latest of the newest part and the metadata modification time",
        }[ctx.columnIndex] || "";
        th.classList.add(`explorerDatabaseObjectsTable__col--${ctx.columnIndex}`);
      },
      decorateRow: (tr, ctx) => {
        const item = ctx.row?.__explorerObject;
        if (item) tr.dataset.table = item.name;
      },
      renderCell: (td, ctx) => {
        const item = ctx.row?.__explorerObject || null;
        const value = ctx.value;
        td.__columnIndex = ctx.columnIndex;
        td.classList.add(`explorerDatabaseObjectsTable__col--${ctx.columnIndex}`);
        if (DATABASE_OBJECT_NUMERIC(ctx.columnIndex)) td.dataset.value = value == null ? "" : String(value);
        if (ctx.columnIndex === 0) {
          const button = h("button", { class: "explorerDatabaseObjectsTable__open explorerDatabaseObjectsTable__clip" }, String(value || ""));
          button.type = "button";
          button.title = `Open ${database}.${value}`;
          const table = item || { database, name: String(value || "") };
          button.addEventListener("click", () => void selectTable(table.database, table.name));
          td.appendChild(button);
          return true;
        }
        if (value == null) {
          if (DATABASE_OBJECT_NUMERIC(ctx.columnIndex)) td.classList.add("num");
          td.textContent = format.EMPTY;
          td.classList.add("explorerDatabaseObjectsTable__missing");
          return true;
        }
        if (ctx.columnIndex === 1) {
          td.appendChild(h("span", { class: "explorerDatabaseObjectsTable__clip" }, String(value)));
          td.title = String(value);
          return true;
        }
        if (ctx.columnIndex === 2 || ctx.columnIndex === 7) {
          setBar(td, value, maxima[ctx.columnIndex], format.count(value));
          return true;
        }
        if (DATABASE_OBJECT_BYTE_COLUMNS.has(ctx.columnIndex)) {
          const text = format.bytes(value);
          setBar(td, value, maxima[ctx.columnIndex], ctx.columnIndex === 3 && item?.resident ? `${text} RAM` : text);
          if (ctx.columnIndex === 3 && item?.resident) td.title = "RAM held by the object, not on disk";
          return true;
        }
        if (ctx.columnIndex === 5) {
          setBar(td, value, maxima[5], `${value.toFixed(2)}\u00d7`);
          if (item) td.title = `${format.bytes(item.uncompressed)} uncompressed / ${format.bytes(item.compressed)} compressed`;
          return true;
        }
        if (ctx.columnIndex === 6) { setBar(td, value, maxima[6], format.percent(value / 100)); return true; }
        if (ctx.columnIndex === 8) {
          // Server DateTime text, shown in the browser's zone (decision 48).
          const time = ui.serverTime(value);
          td.textContent = time.text;
          td.title = time.title || String(value);
          return true;
        }
        return false;
      },
    });
    if (!objectTable) throw new Error("Shared result table component is unavailable.");
    objectTable.id = "explorerDatabaseObjects";
    section.appendChild(objectTable);
  }

  function selectDatabase(database, { history = "push", expand = true } = {}) {
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
    syncExplorerUrl(history);
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

  // Tree icon per object family: a sprite drawing (ns.icon) in the kind's colour.
  const TREE_KINDS = {
    table: { icon: "table", label: "Table" },
    distributed: { icon: "table-share", label: "Distributed table" },
    buffer: { icon: "stack", label: "Buffer" },
    memory: { icon: "cpu", label: "Memory table" },
    view: { icon: "eye", label: "View" },
    mv: { icon: "eye-table", label: "Materialized view" },
    dict: { icon: "vocabulary", label: "Dictionary" },
  };

  function treeKind(table) {
    const key = engineKey(table);
    if (key === "dictionary") return "dict";
    if (key === "materializedview") return "mv";
    if (key === "view" || key === "parameterizedview") return "view";
    if (key === "distributed") return "distributed";
    if (key === "buffer") return "buffer";
    if (key === "memory") return "memory";
    return "table";
  }

  // Text with every case-insensitive occurrence of `query` wrapped in <mark>.
  // A tree name cut in the middle when it does not fit: the head ends in an
  // ellipsis, the tail (the end that tells "events_local" from "events_dist")
  // stays, and the title gives the whole name. Search matches are marked
  // across both parts.
  function middleText(className, text, query) {
    const value = String(text || "");
    const q = String(query || "").toLowerCase();
    const marks = [];
    if (q) {
      const lower = value.toLowerCase();
      for (let index = lower.indexOf(q); index >= 0; index = lower.indexOf(q, index + q.length)) marks.push([index, index + q.length]);
    }
    const part = (cls, from, to) => {
      const el = h("span", { class: cls });
      let at = from;
      for (const [start, end] of marks) {
        const a = Math.max(start, from);
        const b = Math.min(end, to);
        if (a >= b) continue;
        if (a > at) el.appendChild(document.createTextNode(value.slice(at, a)));
        el.appendChild(h("mark", { class: "explorerTreeMark" }, value.slice(a, b)));
        at = b;
      }
      if (at < to) el.appendChild(document.createTextNode(value.slice(at, to)));
      return el;
    };
    // The cut never splits a search match.
    let cut = value.length > 12 ? value.length - Math.min(10, Math.ceil(value.length / 3)) : value.length;
    for (const [start, end] of marks) if (start < cut && cut < end) cut = end < value.length ? end : start;
    const el = h("span", { class: [className, "midTrunc"], title: value });
    el.append(part("midTrunc__head", 0, cut));
    if (cut > 0 && cut < value.length) el.append(part("midTrunc__tail", cut, value.length));
    return el;
  }

  function barPercent(value, max) {
    const v = Number(value);
    if (!Number.isFinite(v) || v <= 0 || !(max > 0)) return 0;
    const pct = Math.min(100, (v / max) * 100);
    return pct < 1 ? 0 : pct;
  }

  // Right-aligned badge of a tree row: on-disk (or resident) bytes, else
  // buffered rows; nothing for objects that hold no data (views, MVs).
  function treeBadge(table) {
    const footprint = summaryFootprintBytes(table);
    const resident = isResidentMemorySummary(table);
    const rows = finiteOrNull(table.rows);
    if (footprint != null && (footprint > 0 || (!resident && !isViewLikeSummary(table)))) {
      return { text: format.bytes(footprint), value: footprint };
    }
    if (rows != null && rows > 0) return { text: `${format.compact(rows)} rows`, value: null };
    return null;
  }

  function treeObjectTitle(table) {
    const footprint = summaryFootprintBytes(table);
    const bits = [humanEngine(table.engine)];
    const rows = summaryRowsLabel(table);
    if (rows) bits.push(rows);
    if (footprint != null) bits.push(isResidentMemorySummary(table) ? `${format.bytes(footprint)} in memory` : `${format.bytes(footprint)} on disk`);
    const health = String(table.health || "healthy");
    if (health !== "healthy") bits.push(healthLabel(table));
    return `${table.database}.${table.name}\n${bits.join(" · ")}`;
  }

  // The databases the tree lists (the System chip adds the system ones).
  function visibleDatabases() {
    const catalog = model.catalog;
    return [...new Set([
      ...(catalog?.databases || []),
      ...(catalog?.tables || []).map((table) => String(table.database || "")),
    ].filter(Boolean))]
      .filter((database) => model.includeSystem || !isSystemDatabaseName(database))
      .sort((a, b) => a.localeCompare(b));
  }

  // The tree's first row: "All databases", the Catalog root (the databases
  // overview in Browse, every database in Graph); current while nothing is
  // selected.
  function treeRootRow() {
    const current = model.section === "tables" && !model.selectedKey && !model.selectedDatabase && !selectionScope().database;
    const button = h("button", {
      class: `explorerTreeDatabase explorerTreeRoot${current ? " is-selected" : ""}`,
      id: "explorerTreeRoot",
      type: "button",
      title: "All databases: their sizes and the databases overview",
    }, ns.icon.el("stack", { size: "sm", className: "explorerTreeRoot__icon" }), h("span", { class: "explorerTreeDatabase__name" }, "All databases"));
    if (current) button.setAttribute("aria-current", "true");
    button.addEventListener("click", () => {
      setTreeDrawerOpen(false);
      if (!current) openCatalogRoot();
    });
    return h("div", { class: "explorerTreeGroup explorerTreeRootGroup" }, button);
  }

  function renderTableList() {
    if (!dom.explorerTableList) return;
    clear(dom.explorerTableList);
    syncScopeUp();
    // The databases overview follows the catalog (a load, the System chip).
    if (browseRootShown()) renderBrowseRoot();
    const catalog = model.catalog;
    const databases = visibleDatabases();

    if (!databases.length) {
      dom.explorerTableList.appendChild(listState(model.loadingCatalog ? "loading" : "empty", model.loadingCatalog ? "Loading databases\u2026" : "No accessible databases"));
      setSideMeta("explorerTreeMeta", "");
      return;
    }

    dom.explorerTableList.appendChild(treeRootRow());
    const query = String(dom.explorerSearchInput?.value || "").trim().toLowerCase();
    const groupedTables = tablesByDatabase(catalog?.tables || []);
    const summaries = summaryByDatabase(catalog?.database_summaries || []);
    const databaseBytes = (database) => {
      const value = Number(summaries.get(database)?.bytes);
      return Number.isFinite(value) ? value : null;
    };
    let shown = 0;
    for (const database of databases) {
      const allItems = (groupedTables.get(database) || []).filter((table) => sidebarObjectVisible(table));
      const items = allItems.filter((table) => !query || `${table.database}.${table.name} ${table.engine || ""}`.toLowerCase().includes(query));
      const loaded = model.databaseTablesLoaded.has(database);
      const loading = model.databaseTablesLoading.has(database);
      const databaseMatches = !!query && database.toLowerCase().includes(query);
      // While searching, a loaded database without any match is dropped and a
      // loaded database with matches is shown open (its stored state is kept).
      if (query && loaded && !items.length && !databaseMatches) continue;
      shown += 1;
      const expanded = model.expandedDatabases.has(database) || (!!query && loaded && items.length > 0);
      const section = h("section", { class: "explorerTreeGroup" });
      const header = h("div", { class: `explorerTreeDatabaseRow${model.selectedDatabase === database ? " is-selected" : ""}` });
      const toggle = h("button", { class: "explorerTreeDatabaseToggle" }, ns.icon.el("chevron-right", { size: "sm", className: "icon--disclosure" }));
      toggle.type = "button";
      toggle.setAttribute("aria-label", `${expanded ? "Collapse" : "Expand"} ${database}`);
      toggle.title = toggle.getAttribute("aria-label");
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
      const headerMain = h("button", { class: "explorerTreeDatabase" });
      headerMain.type = "button";
      const databaseSummary = summaries.get(database) || null;
      let countText = "";
      if (loading) countText = "Loading\u2026";
      else if (loaded) countText = format.countLabel(allItems.length, "object");
      else if (databaseSummary && Number.isFinite(Number(databaseSummary.tables))) {
        const count = Number(databaseSummary.tables);
        countText = format.countLabel(count, "object");
      }
      const bytes = databaseBytes(database);
      // Sizes are plain figures: the shares are in the databases overview
      // and the database page, as bars of their own.
      const size = h("span", { class: "explorerTreeDatabase__size" }, bytes == null ? "" : format.bytes(bytes));
      if (bytes == null) size.hidden = true;
      headerMain.title = [database, countText, bytes == null ? "" : `${format.bytes(bytes)} on disk`].filter(Boolean).join(" · ");
      headerMain.append(
        middleText("explorerTreeDatabase__name", database, query),
        h("span", { class: "explorerTreeDatabase__count" }, countText),
        size,
      );
      headerMain.addEventListener("click", () => { selectDatabase(database); setTreeDrawerOpen(false); });
      header.append(toggle, headerMain);
      section.appendChild(header);

      if (expanded) {
        const children = h("div", { class: "explorerTreeChildren" });
        if (loading && !loaded) {
          children.appendChild(listState("loading", "Loading tables\u2026"));
        } else if (model.databaseLoadErrors.has(database) && !loaded) {
          children.appendChild(listState("error", "Unable to load tables", () => void loadDatabaseTables(database, true)));
        } else if (loaded && !items.length) {
          const filteredOut = (groupedTables.get(database) || []).length > 0;
          children.appendChild(listState("empty", query ? "No matching objects" : (filteredOut ? "No objects match the type filters" : "No accessible tables or views")));
        } else {
          const badges = new Map(items.map((table) => [table, treeBadge(table)]));
          for (const table of items.sort((a, b) => a.name.localeCompare(b.name))) {
            const key = `${table.database}\0${table.name}`;
            const kind = treeKind(table);
            const button = h("button", { class: `explorerTreeObject explorerTreeObject--${kind}` });
            button.type = "button";
            button.classList.toggle("is-selected", key === model.selectedKey);
            button.dataset.database = table.database;
            button.dataset.table = table.name;
            button.dataset.kind = kind;
            const icon = ns.icon.el(TREE_KINDS[kind].icon, { size: "sm", className: `explorerTreeObject__icon explorerTreeObject__icon--${kind}` });
            const name = middleText("explorerTreeObject__name", table.name, query);
            const srKind = h("span", { class: "srOnly" }, `${TREE_KINDS[kind].label}, `);
            button.append(icon, srKind, name);
            // Replicated tables carry the replica health dot (item 19); other
            // tables only show a dot when they are not healthy.
            const replicaDot = detailView?.replicaHealthDot?.(table);
            const health = String(table.health || "healthy");
            if (replicaDot) {
              button.appendChild(replicaDot);
            } else if (health === "warning" || health === "error") {
              const dot = h("span", { class: `explorerTreeObject__health explorerTreeObject__health--${health}` });
              dot.setAttribute("aria-label", healthLabel(table));
              button.appendChild(dot);
            }
            const badge = badges.get(table);
            if (badge) button.appendChild(h("span", { class: "explorerTreeObject__size" }, badge.text));
            button.title = treeObjectTitle(table);
            const storageBlocked = model.mode === "graph" && graph?.isStorageMode?.() && !storageCatalogEligible(table);
            button.disabled = !!storageBlocked;
            button.classList.toggle("is-storage-blocked", !!storageBlocked);
            if (storageBlocked) button.title = `${button.title}\nThis object does not store data and has no storage topology.`;
            button.addEventListener("click", () => {
              if (button.disabled) return;
              setTreeDrawerOpen(false);
              void selectTable(table.database, table.name);
            });
            children.appendChild(button);
          }
        }
        section.appendChild(children);
        if (!loaded && !loading && !model.databaseLoadErrors.has(database)) queueMicrotask(() => void loadDatabaseTables(database));
      }
      dom.explorerTableList.appendChild(section);
    }
    if (!shown) dom.explorerTableList.appendChild(listState("empty", "No matching databases or objects", null, { handle: searches.tree, input: dom.explorerSearchInput }));
    setSideMeta("explorerTreeMeta", format.countLabel(shown, "database"));
  }

  // The count in a side panel's head.
  function setSideMeta(id, text) {
    const meta = byId(id);
    if (meta && meta.textContent !== text) meta.textContent = text;
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
    ns.uiState.busy(dom.explorerRefreshButton, true);
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
        // The intent stays the Graph scope until it is selected.
        if (route.database) {
          model.expandedDatabases.add(route.database);
          await loadDatabaseTables(route.database, !!force);
        }
        if (route.database && route.table) {
          if (!catalogContainsTable(model.catalog, route.database, route.table) && !force) {
            await loadDatabaseTables(route.database, true);
          }
          if (!catalogContainsTable(model.catalog, route.database, route.table)) {
            if (model.routeIntent === route) model.routeIntent = null;
            throw new Error(`Explorer route object is not visible: ${route.database}.${route.table}`);
          }
          model.tab = route.tab || DEFAULT_TAB;
          await selectTable(route.database, route.table, false, { history: "none" });
        } else if (route.database) {
          selectDatabase(route.database, { history: "none" });
        }
        if (model.routeIntent === route) model.routeIntent = null;
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
      ns.uiState.busy(dom.explorerRefreshButton, false);
    }
  }

  // Table detail (header, tabs and tab bodies) lives in app_explorer_detail.js.
  // The shell hands it the model and the helpers it shares with the tree.
  const detailView = ns.explorerDetail?.create?.({
    model, clear, appRoute, setError, quoteIdent, humanEngine,
    healthLabel, summaryFootprintBytes, summaryRowsLabel, isViewLikeSummary, isMergeTreeSummary, isDictionarySummary,
    isDistributedSummary, isLogFamilySummary, isResidentMemorySummary, renderHighlightedCode, destroyDatabaseTreemap, selectTable,
    setMode, setWorkspace, syncExplorerUrl,
  }) || null;

  function renderDetailHeader() { detailView?.renderDetailHeader(); }
  function renderTabs() { detailView?.renderTabs(); }
  function renderTabContent() { detailView?.renderTabContent(); }
  function sectionTitle(text) { return h("h3", { class: "explorerSectionTitle" }, text); }

  async function selectTable(database, table, force = false, { history = "push", graphOrigin = false } = {}) {
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
    if (model.mode !== "browse") {
      // Graph renders nothing from the card. Keep only the lightweight
      // catalog selection (the graph focus) and leave the card request until
      // the user switches to Browse.
      model.detail = null;
      model.preview = null;
      model.detailLoading = false;
      renderTableList();
      syncExplorerUrl(history);
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
      syncExplorerUrl(history);
    } else {
      showDetailState("loading", { label: `Loading ${database}.${table}\u2026` });
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
      syncExplorerUrl(history);
      ns.uiState.announce(`${database}.${table} loaded.`);

      // SQL formatting is cosmetic and must never delay the first usable table
      // view. Format after the raw DDL/detail has already been rendered.
      if (detail.ddl) {
        void api.formatSqls(hostId, [String(detail.ddl)]).then((formatted) => {
          if (!Array.isArray(formatted) || !formatted[0]) return;
          if (serial !== model.detailSerial || String(state.selectedHostId || "") !== hostId || model.selectedKey !== key || model.detail !== detail) return;
          detail.formatted_ddl = formatted[0];
          if (model.tab === "DDL") renderTabContent();
        }).catch((formatError) => {
          detail.ddl_format_error = ns.util.errorText(formatError, "format failed");
        });
      }
    } catch (e) {
      if (serial !== model.detailSerial || model.selectedKey !== key) return;
      setError(e);
      showDetailState("error", { title: "The table could not be loaded", body: "It may have been dropped, or you can no longer read it." });
    } finally {
      if (serial === model.detailSerial) model.detailLoading = false;
    }
  }

  // The selected host id, once the host list has chosen one ("" after timeoutMs).
  function selectedHostReady(timeoutMs = 10000) {
    if (state.selectedHostId) return Promise.resolve(String(state.selectedHostId));
    return new Promise((resolve) => {
      const done = () => {
        window.removeEventListener("chdash:host-changed", done);
        clearTimeout(timer);
        resolve(state.selectedHostId ? String(state.selectedHostId) : "");
      };
      const timer = setTimeout(done, timeoutMs);
      window.addEventListener("chdash:host-changed", done);
    });
  }

  // /explorer/functions[/<name>] and /explorer/databases predate the reserved
  // "_" segments. A database of that name wins; otherwise the alias opens the
  // section it used to, under its canonical URL.
  async function resolveLegacyAlias(route) {
    const alias = route.legacyAlias;
    if (!alias) return route;
    const location = `${window.location.pathname}${window.location.search || ""}`;
    let exists = false;
    // On a fresh load the host list may not have arrived yet.
    const hostId = model.catalog ? "" : await selectedHostReady();
    if (model.catalog) {
      exists = catalogHasDatabase(route.database);
    } else if (hostId) {
      try {
        const payload = await api.getExplorerCatalog(hostId, "", false);
        exists = (payload?.databases || []).some((name) => String(name || "") === route.database);
      } catch {
        exists = false;
      }
    }
    if (`${window.location.pathname}${window.location.search || ""}` !== location) return null;
    if (exists) return { ...route, legacyAlias: null };
    if (alias.section === "functions") {
      const name = alias.functionName ? `/${encodeRouteSegment(alias.functionName)}` : "";
      router.replace(null, { href: appRoute(`/explorer/${FUNCTIONS_ROUTE_SEGMENT}${name}`), view: "explorer" });
      return { workspace: "explorer", section: "functions", functionName: alias.functionName || "" };
    }
    router.replace(null, { path: "/explorer", view: "explorer" });
    return { ...route, database: "", table: "", legacyAlias: null };
  }

  async function applyRouteFromLocation() {
    const route = await resolveLegacyAlias(parseExplorerRoute());
    // The address changed while the alias was being resolved: that newer
    // navigation applies its own route.
    if (!route) return;
    if (route.workspace === "explorer" && route.section === "tables") {
      // Aliases (?view=, ?mode=storage, /_system, former tab slugs) and
      // partial addresses take the canonical form of the scope and mode they
      // open.
      const canonical = appRoute(catalogPath({
        database: route.database,
        table: route.table,
        tab: route.tab,
        mode: route.mode,
        graphRoute: { mode: route.graphType, depth: route.graphDepth },
      }));
      if (`${window.location.pathname}${window.location.search || ""}` !== canonical) {
        router.replace(null, { href: canonical, view: "explorer" });
      }
    }
    model.routeIntent = route;
    if (route.workspace !== "explorer") {
      setWorkspace("query", { history: "none" });
      if (window.location.pathname === appRoute("/")) router.replace(null, { path: "/query", view: "query" });
      return;
    }

    setWorkspace("explorer", { history: "none" });
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
    graph?.applyRouteState?.({ mode: route.graphType || "logical", depth: route.graphDepth ?? 1 });
    model.mode = route.mode;
    model.tab = route.tab || DEFAULT_TAB;
    model.databaseFocus = route.databaseFocus || "";
    // Panes only: the route's selection is shown below, once resolved.
    setSection("tables", { show: false });
    if (route.database) {
      model.expandedDatabases.add(route.database);
    }
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
        showMode();
        return;
      }
      const key = `${route.database}\0${route.table}`;
      if (model.selectedKey === key && (model.mode !== "browse" || model.detail)) {
        if (model.mode === "browse") {
          if (dom.explorerDetailTabs) dom.explorerDetailTabs.hidden = false;
          renderTabs();
          renderTabContent();
        }
        renderTableList();
        model.routeIntent = null;
        showMode();
      } else {
        await selectTable(route.database, route.table, false, { history: "none" });
        model.routeIntent = null;
        if (model.mode === "graph") graph?.activate(false);
      }
    } else if (route.database && model.catalog) {
      selectDatabase(route.database, { history: "none" });
      model.routeIntent = null;
      if (model.mode === "graph") graph?.activate(false);
    } else if (!route.database) {
      clearSelection();
      if (model.catalog) model.routeIntent = null;
      syncVisibilityOptionLocks({ propagate: true });
      renderTableList();
      showMode();
      // Nothing selected on a phone: start with the tree drawer open.
      if (isMobileShell()) setTreeDrawerOpen(true);
    } else {
      // The catalog is still loading and refreshCatalog() applies the route;
      // Graph already shows its scope (selectionScope()).
      showMode();
    }
  }

  // The highlighter colours function names from the host's function list
  // (ns.meta). A returning visit restores the host from storage without
  // selecting it again, so nothing loads that list on the Explorer: ask for
  // it here, the cached copy at once and the server's when it is missing.
  // The card's expressions repaint when it arrives (chdash:meta-changed).
  function ensureHighlighterMeta() {
    const hostId = String(state.selectedHostId || "");
    if (!hostId || !ns.meta) return;
    ns.meta.hydrateFromStorage?.(hostId);
    const host = state.meta?.hosts?.[hostId];
    const missing = ["functions", "keywords"].filter((type) => !host?.[type]);
    if (missing.length) void ns.meta.fetchAndStore?.(hostId, missing);
  }

  function resetForHost() {
    model.catalog = null;
    model.databaseTablesLoaded.clear();
    model.databaseTablesLoading.clear();
    model.databaseLoadPromises.clear();
    model.databaseLoadErrors.clear();
    model.detailCache.clear();
    model.detailPromises.clear();
    model.databaseDisks.clear();
    model.expandedDatabases.clear();
    ensureHighlighterMeta();
    model.selectedKey = null;
    model.selectedDatabase = null;
    model.detailSerial += 1;
    model.detail = null;
    model.detailLoading = false;
    model.preview = null;
    // A deep link still being applied keeps its card tab: on a first visit
    // the host is chosen while the route waits for the catalog.
    const intent = model.routeIntent?.workspace === "explorer" && model.routeIntent.section === "tables" ? model.routeIntent : null;
    model.tab = intent?.tab || DEFAULT_TAB;
    model.databaseFocus = intent?.databaseFocus || "";
    destroyDatabaseTreemap();
    showDetailState("loading", { label: "Loading databases\u2026" });
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

  // Graph side panel "Open card": the table card in Browse.
  function openTableCardFromGraph(database, table) {
    openCard(database, table);
  }

  function init() {
    graph?.init({ openTable: openTableFromGraph, openCard: openTableCardFromGraph, onStateChange: () => { syncVisibilityOptionLocks(); renderTableList(); syncExplorerUrl("replace"); } });
    dom.navQueryButton?.addEventListener("click", () => setWorkspace("query"));
    dom.navExplorerButton?.addEventListener("click", () => setWorkspace("explorer"));
    // Back / Forward within the Explorer (ns.router: the one popstate listener).
    router.on("/explorer", () => { void applyRouteFromLocation(); });
    // The view and mode tab rows: the shared tab behaviour (app_ui_tabs.js).
    ns.tabs?.bind(shellEl("explorerViewTabs"), {
      attr: "view",
      onSelect: (view) => { if (view !== currentView()) setView(String(view || "catalog")); },
    });
    ns.segmented?.bind(shellEl("explorerModeTabs"), {
      attr: "mode",
      onChange: (mode) => {
        if (mode === model.mode) return;
        setMode(String(mode || "browse"));
        syncExplorerUrl("push");
      },
    });
    shellEl("explorerScopeUp")?.addEventListener("click", scopeUp);
    for (const chip of $$(".explorerFilterChip[data-filter]", shellEl("explorerTreeFilters")) || []) {
      chip.addEventListener("click", () => { if (!chip.disabled) toggleTypeFilter(String(chip.dataset.filter || "")); });
    }
    sidePanel("explorerListPane");
    sidePanel("explorerFunctionListPane");
    shellEl("explorerTreeToggle")?.addEventListener("click", () => setTreeDrawerOpen(!model.treeOpen));
    try {
      window.matchMedia(ns.shell.mediaQuery("md")).addEventListener("change", (event) => { if (!event.matches) setTreeDrawerOpen(false); });
    } catch {}
    dom.explorerRefreshButton?.addEventListener("click", () => refreshCatalog(true));
    dom.explorerFunctionRefreshButton?.addEventListener("click", () => refreshFunctions(true));
    // ns.search: the tree filter is cheap and follows every key. Graph focus
    // re-runs the layout, the fit and a scoped graph fetch, so it follows the
    // query once typing pauses (the one search delay) instead of once per
    // intermediate prefix.
    const graphSearch = util.debounce(() => graph?.searchFocus());
    searches.tree = ns.search.bind(dom.explorerSearchInput, () => { renderTableList(); graphSearch(); }, { debounceMs: 0 });
    searches.functions = ns.search.bind(dom.explorerFunctionSearchInput, () => renderFunctionList());
    dom.explorerFunctionCategorySelect?.addEventListener("change", renderFunctionList);
    // Function kind chips, like the tree's type chips: one kind at a time,
    // pressing the pressed chip again lists every function.
    const functionChips = [...($$(".explorerFilterChip[data-function-kind]", shellEl("explorerFunctionFilters")) || [])];
    for (const chip of functionChips) {
      chip.addEventListener("click", () => {
        const kind = String(chip.dataset.functionKind || "");
        const value = String(dom.explorerFunctionCategorySelect?.value || "") === kind ? "" : kind;
        if (dom.explorerFunctionCategorySelect) dom.explorerFunctionCategorySelect.value = value;
        for (const candidate of functionChips) {
          const pressed = !!value && String(candidate.dataset.functionKind || "") === value;
          candidate.setAttribute("aria-pressed", String(pressed));
          candidate.classList.toggle("is-on", pressed);
        }
        renderFunctionList();
      });
    }
    window.addEventListener("chdash:host-changed", resetForHost);
    // Escape on the tree drawer is ns.layers (ns.sidePanel).
    ns.features.on(applyExplorerFeatures);
    loadVisibilityOptions();
    model.includeNonStoring = model.filters.views !== false || model.filters.mv !== false;
    syncVisibilityOptionLocks({ propagate: true });
    applyExplorerFeatures();
    ensureHighlighterMeta();
    setSection("tables");
    void applyRouteFromLocation();
  }

  ns.explorer = {
    init, setWorkspace, setSection, setMode, setView, currentView,
    refreshCatalog, refreshFunctions, selectTable, selectDatabase,
  };
})();
