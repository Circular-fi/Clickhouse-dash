// The card of a table in Browse: selecting a table (the branch of its database, the summary that the tree already has, then the card
// from the server), and the three parts of the card that app_explorer_detail.js draws (the header, the tabs, the tab content).

import { api } from "./app_api.js";
import { dom } from "./app_dom.js";
import { catalogContainsTable, fetchTableDetail, loadDatabaseTables } from "./app_explorer_data.js";
import { showNotFound } from "./app_explorer_database.js";
import { actions, model, parts, selectedTable, setError, showDetailState, syncExplorerUrl } from "./app_explorer_store.js";
import { renderTableList, syncVisibilityOptionLocks } from "./app_explorer_tree.js";
import { state } from "./app_state.js";
import { uiState } from "./app_ui_state.js";
import { util } from "./app_util.js";

const { $ } = dom;

function renderDetailHeader() { parts.detail?.renderDetailHeader(); }
function renderTabs() { parts.detail?.renderTabs(); }
function renderTabContent() { parts.detail?.renderTabContent(); }

async function selectTable(database, table, force = false, { history = "push", graphOrigin = false } = {}) {
  if (model.mode === "graph" && parts.graph?.isStorageMode?.() && parts.graph?.canUseStorageForTable?.(database, table) === false) return;
  // This selection takes its serial first: a click that comes while a branch loads supersedes it, and the older one
  // stops at the next check instead of replacing the newer card (ARCH-F-100).
  const serial = ++model.detailSerial;
  const startHost = String(state.selectedHostId || "");
  const superseded = () => serial !== model.detailSerial || String(state.selectedHostId || "") !== startHost;
  // The top-level catalog intentionally contains only database names. Load
  // exactly the branch the user is navigating to before resolving selection.
  if (model.catalog && !model.databaseTablesLoaded.has(database)) {
    await loadDatabaseTables(database, false);
    if (superseded()) return;
  }
  if (model.catalog && !catalogContainsTable(model.catalog, database, table)) {
    await loadDatabaseTables(database, true);
    if (superseded()) return;
    if (!catalogContainsTable(model.catalog, database, table)) {
      showNotFound(database, table);
      return;
    }
  }
  model.notFound = null;
  const key = `${database}\0${table}`;
  if (model.mode === "graph") parts.graph?.focusTable?.(database, table, { ensureVisible: !graphOrigin });
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
  const req = util.latest("explorer.detail");
  try {
    const detail = await fetchTableDetail(hostId, database, table, !!force, req.signal);
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
    uiState.announce(`${database}.${table} loaded.`);

    // SQL formatting is cosmetic and must never delay the first usable table
    // view. Format after the raw DDL/detail has already been rendered.
    if (detail.ddl) {
      void api.formatSqls(hostId, [String(detail.ddl)], { signal: util.latest("explorer.ddlformat").signal }).then((formatted) => {
        if (!Array.isArray(formatted) || !formatted[0]) return;
        if (serial !== model.detailSerial || String(state.selectedHostId || "") !== hostId || model.selectedKey !== key || model.detail !== detail) return;
        detail.formatted_ddl = formatted[0];
        if (model.tab === "DDL") renderTabContent();
      }).catch((formatError) => {
        if (util.isAbort(formatError)) return;
        detail.ddl_format_error = util.errorText(formatError, "format failed");
      });
    }
  } catch (e) {
    if (util.isAbort(e) || serial !== model.detailSerial || model.selectedKey !== key) return;
    setError(e);
    showDetailState("error", { title: "The table could not be loaded", body: "It may have been dropped, or you can no longer read it." });
  } finally {
    if (serial === model.detailSerial) model.detailLoading = false;
  }
}

actions.selectTable = selectTable;

export { renderDetailHeader, renderTabContent, renderTabs, selectTable };
