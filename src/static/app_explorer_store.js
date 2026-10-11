// What the modules of the Explorer share: the model (the selection, the catalog, the caches), the address, the parts of the Catalog page
// that the entry hands over, and the error strip. It holds no view. The functions that the controller provides to the modules under it
// are in `actions`: they cannot be imported, the controller imports the modules (ARCH-F-155).

import { dom } from "./app_dom.js";
import { FUNCTIONS_ROUTE_SEGMENT, appRoute, catalogPath, encodeRouteSegment } from "./app_explorer_route.js";
import { functionKey, summaryByDatabase } from "./app_explorer_summary.js";
import { router } from "./app_router.js";
import { features } from "./app_state.js";
import { uiState } from "./app_ui_state.js";
import { util } from "./app_util.js";

const { byId } = dom;

// The Catalog page is made of more than this controller: the graph, the size views of the databases and tables, the
// table card and the static result tables. The Functions page has none of them, so the page's entry
// (app_page_explorer.js) hands them over with explorer.use() before init(), and they never load on the Functions page.
const parts = { graph: null, storage: null, detail: null, results: null, detailView: null };

// What a module provides to the modules that cannot import it, because it imports them. Each is set once, when its module loads. A call before that is a bug that shows at once (a TypeError).
//   openCatalogRoot(options)  refreshCatalog(force)  applyRouteFromLocation()                      the controller
//   renderTableList()                                                                              the tree
//   selectDatabase(name, options)  renderDatabaseDetail(name)  renderBrowseRoot()                  the database page
//   selectTable(database, table, force, options)                                                   the card of a table
const actions = {
  selectDatabase: null, selectTable: null, openCatalogRoot: null, refreshCatalog: null, applyRouteFromLocation: null,
  renderTableList: null, renderDatabaseDetail: null, renderBrowseRoot: null,
};

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
  // The newest address being applied: a slower, older one stops at its next await (applyRouteFromLocation).
  routeSerial: 0,
  tab: "Columns",
  // The database page shows its storage below its objects; "storage"
  // scrolls it into view once (a former ?tab=storage address).
  databaseFocus: "",
  preview: null,
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
  routeIntent: null,
  // An address that names no visible database or table: { database, table }
  // ("Database not found" / "Table not found" in Browse; never a tree row).
  notFound: null,
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

const address = router.owner("explorer", { view: () => model.active });

function currentExplorerPath() {
  if (model.section === "functions") {
    const selected = (model.functionsCatalog?.functions || []).find((candidate) => functionKey(candidate) === model.selectedFunctionKey) || null;
    return selected?.name ? `/explorer/${FUNCTIONS_ROUTE_SEGMENT}/${encodeRouteSegment(selected.name)}` : `/explorer/${FUNCTIONS_ROUTE_SEGMENT}`;
  }
  // A not-found page keeps the address it was opened with.
  return catalogPath({
    ...(model.notFound || selectionScope()),
    tab: model.tab,
    mode: model.mode,
    graphRoute: model.mode === "graph" ? (parts.graph?.getRouteState?.() || null) : null,
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
  const message = !error ? "" : util.errorText(error, "The Explorer request failed.");
  uiState.banner(dom.explorerError, { message });
}

// The detail pane's state when no object is shown: empty, loading or
// error (ns.uiState), in #explorerEmptyState.
function showDetailState(kind, options) {
  const box = dom.explorerEmptyState;
  if (!box) return;
  box.hidden = false;
  uiState[kind](box, options);
}

function selectedTable() {
  if (!model.catalog || !model.selectedKey) return null;
  return (model.catalog.tables || []).find((t) => `${t.database}\0${t.name}` === model.selectedKey) || null;
}

function shellEl(id) {
  return dom[id] || byId(id);
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

function clearSelection() {
  model.notFound = null;
  model.selectedKey = null;
  model.selectedDatabase = null;
  model.detailSerial += 1;
  model.detail = null;
  model.detailLoading = false;
  model.preview = null;
}

// Is the Browse pane showing the Catalog root (the databases overview)?
function browseRootShown() {
  return model.active && model.section === "tables" && model.mode === "browse" && !model.notFound && !model.selectedKey && !model.selectedDatabase && !selectionScope().database;
}

function explorerFeatures() {
  return features.get("explorer");
}

const searches = { tree: null, functions: null };

function catalogHasDatabase(name) {
  const target = String(name || "");
  return (model.catalog?.databases || []).some((item) => String(item || "") === target)
    || (model.catalog?.tables || []).some((item) => String(item.database || "") === target);
}

function databaseSummary(name) {
  return summaryByDatabase(model.catalog?.database_summaries || []).get(String(name || "")) || null;
}

export { actions, browseRootShown, catalogHasDatabase, clear, clearSelection, databaseSummary, explorerFeatures, model, parts, searches, selectedTable, selectionScope, setError, shellEl, showDetailState, syncExplorerUrl };
