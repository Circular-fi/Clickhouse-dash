// This file is the controller of the Explorer's Catalog. It controls the mode on screen (Browse or Graph).
// It also controls the selection (a database or a table), its address, the catalog of the host and the start of the page.
// The tree, the database page, the table card, the graph, the shell and the pure parts are the modules app_explorer_*.js under this file.
// These modules get what they need from `actions` (app_explorer_store.js). The Functions page has its own controller (app_explorer_functions_page.js).

import { api } from "./app_api.js";
import { dom, shell } from "./app_dom.js";
import { catalogContainsTable, loadBranches, loadDatabaseTables } from "./app_explorer_data.js";
import { destroyDatabaseTreemap, renderBrowseRoot, renderDatabaseDetail, renderNotFound, selectDatabase, showNotFound } from "./app_explorer_database.js";
import { CATALOG_ROUTE_SEGMENT, DEFAULT_TAB, MODES, appRoute, catalogPath, parseExplorerRoute } from "./app_explorer_route.js";
import { currentView, modeAvailability, setTreeDrawerOpen, sidePanel, syncModeTabs, syncViewTabs } from "./app_explorer_shell.js";
import { actions, clearSelection, explorerFeatures, model, parts, searches, selectionScope, setError, shellEl, showDetailState, syncExplorerUrl } from "./app_explorer_store.js";
import { renderTabContent, renderTabs, selectTable } from "./app_explorer_table.js";
import { loadVisibilityOptions, renderTableList, syncVisibilityOptionLocks, toggleTypeFilter } from "./app_explorer_tree.js";
import { header } from "./app_header.js";
import { meta } from "./app_meta.js";
import { router } from "./app_router.js";
import { features, state } from "./app_state.js";
import { search } from "./app_ui_search.js";
import { uiState } from "./app_ui_state.js";
import { tabs } from "./app_ui_tabs.js";
import { util } from "./app_util.js";

const { byId, $, $$ } = dom;

function scopeUp() {
  const scope = selectionScope();
  if (scope.table) selectDatabase(scope.database);
  else if (scope.database) openCatalogRoot();
}

// ns.explorer.setView() takes a top view or a Catalog mode by name ("browse" or "graph"). "graph" is the former Graph view.
// "storage" is the former Storage view. It opens Browse on the storage of the selection.
// That means the Storage tab of the table card, or the database page scrolled to its storage.
function setView(view, { history = "push" } = {}) {
  if (view === "storage") {
    model.tab = "Storage";
    model.databaseFocus = model.selectedKey ? "" : "storage";
    view = "browse";
  }
  if (MODES.includes(view)) setMode(view);
  else showTables();
  syncExplorerUrl(history);
}

// If nothing is selected, the Catalog root is shown. In Browse, this is the databases overview. In Graph, this is all databases.
function openCatalogRoot({ history = "push" } = {}) {
  clearSelection();
  syncVisibilityOptionLocks({ propagate: true });
  renderTableList();
  showMode();
  syncExplorerUrl(history);
}

// The Catalog on screen: its panes, the mode and the tree. With show: false, only the panes switch.
// The caller must apply the selection (applyRouteFromLocation, openCard).
function showTables({ show = true } = {}) {
  model.section = "tables";
  syncViewTabs();
  setMode(model.mode, { show });
  renderTableList();
  if (model.active) refreshCatalog(false);
}

function applyExplorerFeatures() {
  const gf = explorerFeatures().graph || {};
  const available = modeAvailability();
  // If the server disables a mode, the first available mode is used.
  if (!available[model.mode]) setMode(model.mode);

  const modes = [];
  if (available.graph && gf.lineage !== false) modes.push("logical");
  if (available.graph && gf.storage_topology !== false) modes.push("physical");
  const explicitTypeChoice = modes.length > 1;
  if (dom.explorerGraphTypeSelect) dom.explorerGraphTypeSelect.hidden = !explicitTypeChoice;
  if (dom.explorerGraphLogicalButton) dom.explorerGraphLogicalButton.hidden = gf.lineage === false;
  if (dom.explorerGraphPhysicalButton) dom.explorerGraphPhysicalButton.hidden = gf.storage_topology === false;
  if (modes.length === 1) parts.graph?.setDetailMode?.(modes[0]);
  syncModeTabs();
  syncViewTabs();
}

// Switches the Catalog mode. The selection stays the same.
// With show: false, only the panes switch (see showTables).
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
  if (next !== "graph") parts.graph?.deactivate();
  // The tree shows storage-less objects in grey. This happens in the Storage topology of the graph only.
  if (previous !== next) {
    syncVisibilityOptionLocks({ propagate: next === "graph" });
    renderTableList();
  }
  if (show) showMode();
}

// Shows the selection in the current mode. In Browse, it shows the card. In Graph, it shows the graph focused on the selection.
function showMode() {
  if (!model.active || model.section !== "tables") return;
  const scope = selectionScope();
  if (model.mode === "graph") {
    if (scope.table) {
      if (parts.graph?.isStorageMode?.() && parts.graph?.canUseStorageForTable?.(scope.database, scope.table) === false) {
        parts.graph?.setDetailMode?.("logical");
      }
      parts.graph?.focusTable?.(scope.database, scope.table, { ensureVisible: true });
    } else {
      parts.graph?.focusDatabase?.(scope.database);
    }
    parts.graph?.activate(false);
    return;
  }
  // Graph never fetches the card. Browse loads the card when it is shown.
  // The caller owns the history entry. A mode switch adds the Browse URL to the history.
  if (model.selectedKey) {
    if (!model.detailLoading && !model.detail) void selectTable(scope.database, scope.table, false, { history: "none" });
  } else if (model.selectedDatabase) {
    renderDatabaseDetail(model.selectedDatabase);
  } else if (model.notFound) {
    renderNotFound();
  } else if (!scope.database) {
    renderBrowseRoot();
  }
}

// "Open card" (Graph side panel) shows the object's card in Browse. It opens the card the way its deep link does.
function openCard(database, table) {
  if (!database || !table) return;
  model.tab = DEFAULT_TAB;
  setMode("browse", { show: false });
  void selectTable(database, table, false, { history: "push" });
}

function setWorkspace(name, { history = "push" } = {}) {
  if (name === "explorer" && explorerFeatures().enabled === false) name = "query";
  const explorer = name === "explorer";
  // Query and Explorer are separate HTML documents. A move across that boundary must load the other document.
  // Do not keep the current DOM mounted. Do not emulate a page transition with pushState.
  if (explorer && !dom.explorerWorkspace) {
    if (history !== "none") window.location.assign(appRoute(`/explorer/${CATALOG_ROUTE_SEGMENT}`));
    return;
  }
  if (!explorer && !dom.queryWorkspace) {
    if (history !== "none") window.location.assign(appRoute("/query"));
    return;
  }
  model.active = explorer;
  if (dom.queryWorkspace) dom.queryWorkspace.hidden = explorer;
  if (dom.explorerWorkspace) dom.explorerWorkspace.hidden = !explorer;
  header.setPageSelectorValue(explorer ? "explorer" : "query");

  const route = explorer ? (parseExplorerRoute().workspace === "explorer" ? window.location.pathname : appRoute(`/explorer/${CATALOG_ROUTE_SEGMENT}`)) : appRoute("/query");
  if (window.location.pathname !== route) router.write(history, null, { href: route, view: explorer ? "explorer" : "query" });

  if (explorer) {
    refreshCatalog(false);
    if (model.mode === "graph") parts.graph?.activate(false);
  } else {
    parts.graph?.deactivate();
  }
}

// The catalog load in flight has the form { hostId, force, promise }. The same host reuses this load.
// The exception is a forced Refresh over a plain load. A load for another host replaces it. The old answer is dropped (ARCH-F-097).
let catalogLoad = null;

async function refreshCatalog(force) {
  if (!model.active) return null;
  const hostId = String(state.selectedHostId || "");
  if (!hostId) return null;
  if (catalogLoad && catalogLoad.hostId === hostId && (!force || catalogLoad.force)) return catalogLoad.promise;
  const req = util.latest("explorer.catalog");
  const load = { hostId, force: !!force, promise: null };
  catalogLoad = load;
  const current = () => req.isCurrent() && String(state.selectedHostId || "") === hostId && model.active;
  model.loadingCatalog = true;
  setError(null);
  uiState.busy(dom.explorerRefreshButton, true);
  renderTableList();
  load.promise = (async () => {
    try {
      const payload = await api.getExplorerCatalog(hostId, "", !!force, { signal: req.signal });
      if (!current()) return;

      // A plain refresh keeps the loaded branches. It removes the databases that the server no longer lists.
      const listed = new Set(payload?.databases || []);
      const previousTables = force ? [] : (model.catalog?.tables || []).filter((item) => listed.has(String(item.database || "")));
      model.catalog = { ...payload, tables: previousTables };
      if (force) {
        model.databaseTablesLoaded.clear();
        model.databaseLoadErrors.clear();
      }
      renderTableList();
      if (model.mode === "graph") parts.graph?.onScopeChanged();

      const route = model.routeIntent;
      if (route?.workspace === "explorer" && route.section === "tables") {
        // The intent stays the Graph scope until the scope is selected.
        if (route.database) {
          model.expandedDatabases.add(route.database);
          await loadDatabaseTables(route.database, !!force);
          if (!current()) return;
        }
        if (route.database && route.table) {
          if (!catalogContainsTable(model.catalog, route.database, route.table) && !force) {
            await loadDatabaseTables(route.database, true);
            if (!current()) return;
          }
          if (!catalogContainsTable(model.catalog, route.database, route.table)) {
            if (model.routeIntent === route) model.routeIntent = null;
            showNotFound(route.database, route.table);
            return;
          }
          model.tab = route.tab || DEFAULT_TAB;
          await selectTable(route.database, route.table, false, { history: "none" });
          if (!current()) return;
        } else if (route.database) {
          selectDatabase(route.database, { history: "none" });
        }
        if (model.routeIntent === route) model.routeIntent = null;
      }

      if (force) {
        await loadBranches([...model.expandedDatabases], true, current);
        if (!current()) return;
        if (model.selectedKey) {
          const [database, table] = model.selectedKey.split("\0");
          if (database && table) await selectTable(database, table, true);
        }
      }
    } catch (e) {
      if (!req.isCurrent() || util.isAbort(e)) return;
      setError(e);
      renderTableList();
    } finally {
      if (catalogLoad === load) {
        catalogLoad = null;
        model.loadingCatalog = false;
        uiState.busy(dom.explorerRefreshButton, false);
      }
    }
  })();
  return load.promise;
}

async function applyRouteFromLocation() {
  // Back and Forward in quick succession start several of these. The newest one wins. The others stop at their next await.
  const gen = ++model.routeSerial;
  const route = parseExplorerRoute();
  if (route.workspace === "explorer" && route.section === "tables") {
    // Aliases (?view=, ?mode=storage, /_system, former tab slugs) and partial addresses use the canonical form.
    // The canonical form gives the scope and the mode that they open.
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
  parts.graph?.applyRouteState?.({ mode: route.graphType || "logical", depth: route.graphDepth ?? 1 });
  model.mode = route.mode;
  model.tab = route.tab || DEFAULT_TAB;
  model.databaseFocus = route.databaseFocus || "";
  // Panes only. The selection of the route appears below, when the route is resolved.
  showTables({ show: false });
  if (route.database) {
    model.expandedDatabases.add(route.database);
  }
  if (route.database && route.table && model.catalog) {
    // A route needs only the addressed database branch. Never refresh or list every database.
    // Do not refresh every database only because the selected table is not in the lightweight top-level catalog yet.
    await loadDatabaseTables(route.database, false);
    if (gen !== model.routeSerial) return;
    if (!catalogContainsTable(model.catalog, route.database, route.table)) {
      await loadDatabaseTables(route.database, true);
      if (gen !== model.routeSerial) return;
    }
    if (!catalogContainsTable(model.catalog, route.database, route.table)) {
      showNotFound(route.database, route.table);
      if (model.mode === "graph") showMode();
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
      if (gen !== model.routeSerial) return;
      model.routeIntent = null;
      if (model.mode === "graph") parts.graph?.activate(false);
    }
  } else if (route.database && model.catalog) {
    selectDatabase(route.database, { history: "none" });
    model.routeIntent = null;
    if (model.mode === "graph") parts.graph?.activate(false);
  } else if (!route.database) {
    clearSelection();
    if (model.catalog) model.routeIntent = null;
    syncVisibilityOptionLocks({ propagate: true });
    renderTableList();
    // A phone opens on the root page (All databases). The tree drawer waits for its toggle.
    // The drawer never covers the page when the page opens.
    showMode();
  } else {
    // The catalog is not loaded yet. refreshCatalog() applies the route when the load ends.
    // Graph already shows its scope (selectionScope()).
    showMode();
  }
}

function resetForHost() {
  // All work for the old host stops now. Its reads abort. The loads that wait for them are forgotten.
  // The new host starts its own loads (ARCH-F-097, ARCH-F-140).
  util.latest.cancelPrefix("explorer.");
  catalogLoad = null;
  model.loadingCatalog = false;
  uiState.busy(dom.explorerRefreshButton, false);
  model.routeSerial += 1;
  model.catalog = null;
  model.databaseTablesLoaded.clear();
  model.databaseTablesLoading.clear();
  model.databaseLoadPromises.clear();
  model.databaseLoadErrors.clear();
  model.detailCache.clear();
  model.databaseDisks.clear();
  model.expandedDatabases.clear();
  meta.ensureHighlighterData();
  model.selectedKey = null;
  model.selectedDatabase = null;
  model.detailSerial += 1;
  model.detail = null;
  model.detailLoading = false;
  model.preview = null;
  // A deep link that the code still applies keeps its card tab. On a first visit, the host is chosen while the route waits for the catalog.
  const intent = model.routeIntent?.workspace === "explorer" && model.routeIntent.section === "tables" ? model.routeIntent : null;
  model.tab = intent?.tab || DEFAULT_TAB;
  model.databaseFocus = intent?.databaseFocus || "";
  destroyDatabaseTreemap();
  showDetailState("loading", { label: "Loading databases\u2026" });
  if (dom.explorerDetail) dom.explorerDetail.hidden = true;
  renderTableList();
  parts.graph?.onHostChanged();
  syncVisibilityOptionLocks();
  if (model.active) refreshCatalog(false);
}

function openTableFromGraph(database, table) {
  // Canvas clicks must never restart the catalog loader.
  // A restart can replay an old route intent. Focus then returns to the table that originally opened Explorer.
  selectTable(database, table, false, { graphOrigin: true });
}

// Graph side panel "Open card": shows the table card in Browse.
function openTableCardFromGraph(database, table) {
  openCard(database, table);
}

function init() {
  parts.graph?.init({ openTable: openTableFromGraph, openCard: openTableCardFromGraph, onStateChange: () => { syncVisibilityOptionLocks(); renderTableList(); syncExplorerUrl("replace"); } });
  // The detail pane scrolls. A keyboard user can reach it. It is a region while it overflows.
  for (const pane of $$(".explorerDetailPane")) util.scrollFocus(pane, { label: pane.id ? "Object details" : "Function details", mutations: true });
  // Back and Forward work inside the Explorer. ns.router has the one popstate listener.
  router.on("/explorer", () => { void applyRouteFromLocation(); });
  // The Catalog | Functions row contains links to two pages.
  // The Browse | Graph row of the Catalog contains tabs. These tabs use the shared tab behaviour (app_ui_tabs.js).
  shell?.edgeCues?.(shellEl("explorerNavTabs"));
  tabs?.bind(shellEl("explorerModeTabs"), {
    attr: "mode",
    onSelect: (mode) => {
      if (mode === model.mode) return;
      setMode(String(mode || "browse"));
      syncExplorerUrl("push");
    },
  });
  shellEl("explorerScopeUp")?.addEventListener("click", scopeUp);
  for (const chip of $$(".explorerFilterChip[data-filter]", shellEl("explorerTreeFilters")) || []) {
    chip.addEventListener("click", () => { if (chip.getAttribute("aria-disabled") !== "true") toggleTypeFilter(String(chip.dataset.filter || "")); });
  }
  sidePanel("explorerListPane");
  shellEl("explorerTreeToggle")?.addEventListener("click", () => setTreeDrawerOpen(!model.treeOpen));
  try {
    window.matchMedia(shell.mediaQuery("md")).addEventListener("change", (event) => { if (!event.matches) setTreeDrawerOpen(false); });
  } catch {}
  dom.explorerRefreshButton?.addEventListener("click", () => refreshCatalog(true));
  // ns.search: the tree filter is cheap, so it follows every key.
  // Graph focus runs the layout again, then the fit and a scoped graph fetch. So it follows the query only after a pause in typing (the one search delay). It does not follow each intermediate prefix.
  const graphSearch = util.debounce(() => parts.graph?.searchFocus());
  searches.tree = search.bind(dom.explorerSearchInput, () => { renderTableList(); graphSearch(); }, { debounceMs: 0 });
  window.addEventListener("chdash:host-changed", resetForHost);
  // Escape on the tree drawer is handled by ns.layers (ns.sidePanel).
  features.on(applyExplorerFeatures);
  loadVisibilityOptions();
  model.includeNonStoring = model.filters.views !== false || model.filters.mv !== false;
  syncVisibilityOptionLocks({ propagate: true });
  applyExplorerFeatures();
  meta.ensureHighlighterData();
  showTables();
  void applyRouteFromLocation();
}

// These functions are the ones that the modules under this controller call (app_explorer_store.js, `actions`).
Object.assign(actions, { openCatalogRoot, refreshCatalog, applyRouteFromLocation, setMode });

// explorer.use({ graph, storage, detail, results }) takes the parts of the Catalog page (see `parts`).
function use({ graph: graphView = null, storage: storageViews = null, detail = null, results = null } = {}) {
  parts.graph = graphView;
  parts.storage = storageViews;
  parts.detail = detail;
  parts.results = results;
  parts.detail?.init();
}

export const explorer = {
  use, init, setWorkspace, setMode, setView, currentView,
  refreshCatalog, selectTable, selectDatabase,
};
