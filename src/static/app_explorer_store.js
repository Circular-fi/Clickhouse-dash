// This module holds the state that the modules of the Explorer share. The state has the model, the address, the parts of the Catalog page, and the error strip.
// The model has the selection, the catalog and the caches. This module has no view.
// The functions that the controller gives to the modules below it are in `actions`. These modules cannot import the controller.
// The controller imports them, so the functions cannot be imported (ARCH-F-155).

import { dom } from "./app_dom.js";
import { FUNCTIONS_ROUTE_SEGMENT, appRoute, catalogPath, encodeRouteSegment } from "./app_explorer_route.js";
import { functionKey, summaryByDatabase } from "./app_explorer_summary.js";
import { router } from "./app_router.js";
import { features } from "./app_state.js";
import { uiState } from "./app_ui_state.js";
import { util } from "./app_util.js";

const { byId } = dom;

// The Catalog page has more parts than this controller: the graph, the size views of the databases and tables, the table card, and the static result tables.
// The Functions page has none of these parts. The entry of the page, app_page_explorer.js, gives the parts to this module with explorer.use() before init().
// So the parts never load on the Functions page.
const parts = { graph: null, storage: null, detail: null, results: null };

// A module gives these functions to the modules that cannot import it. A module cannot import a module that imports it.
// Each function is set one time, when its module loads. A call before that is a bug. The bug shows at once as a TypeError.
//   openCatalogRoot(options)  refreshCatalog(force)  applyRouteFromLocation()  setMode(mode)       the controller
//   renderTableList()                                                                              the tree
//   selectDatabase(name, options)  renderDatabaseDetail(name)  renderBrowseRoot()                  the database page
//   selectTable(database, table, force, options)                                                   the card of a table
//   openTab(label)  renderTabContent()                                                             the card's tabs (app_explorer_detail.js)
const actions = {
  selectDatabase: null, selectTable: null, openCatalogRoot: null, refreshCatalog: null, applyRouteFromLocation: null, setMode: null,
  renderTableList: null, renderDatabaseDetail: null, renderBrowseRoot: null, openTab: null, renderTabContent: null,
};

const model = {
  active: false,
  section: "tables",
  // Catalog mode: "browse" (the card) or "graph". The tree selection (selectedKey / selectedDatabase) is the scope of both modes.
  mode: "browse",
  loadingCatalog: false,
  catalog: null,
  selectedKey: null,
  selectedDatabase: null,
  detail: null,
  detailLoading: false,
  detailSerial: 0,
  // The newest address that is applied. A slower, older address stops at its next await (applyRouteFromLocation).
  routeSerial: 0,
  tab: "Columns",
  // The table card keeps these values for the session. They are the About panel tiles after the first four (narrow panes),
  // the row limit of the preview, and the measure of the column size treemap.
  aboutExpanded: false,
  previewLimit: 0,
  columnSizeMeasure: "",
  // The database page shows its storage below its objects. The value "storage" scrolls the storage into view one time (a former ?tab=storage address).
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
  // An address that names no visible database or table: { database, table }.
  // The page shows "Database not found" or "Table not found" in Browse. It is never a tree row.
  notFound: null,
  includeSystem: false,
  // The graph projection derives this value from the Views and MV chips, and from the selected object.
  // When this value is false, the projection hides or contracts non-storing objects.
  includeNonStoring: true,
  // Tree object-type chips (Tables / Views / MV / Dict). The System chip uses includeSystem.
  filters: { tables: true, views: true, mv: true, dict: true },
  treeOpen: false,
  // The side panel that the mobile drawer toggle controls (drawerPane()).
  drawerPaneId: "",
  // The treemap of the database page or of the databases overview. The treemap is destroyed on each re-render.
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
  // A not-found page keeps the address that it was opened with.
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

// The history mode is "push", "replace" or "none". This is the option of every Explorer navigation function.
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

// The state of the detail pane when no object is shown. The state is empty, loading or error (ns.uiState), in #explorerEmptyState.
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

// The scope that every Catalog mode shows. It is the tree selection, or the route that is still resolved while the catalog loads.
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

// Does the Browse pane show the Catalog root (the databases overview)?
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
