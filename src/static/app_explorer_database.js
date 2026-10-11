// The Browse pane when no table is open: the databases overview (the size treemap and the table of the databases), the page of one
// database (its objects, then its storage) and the "not found" page for an address that names nothing.
//
// The areas of the storage are local on-disk bytes, the same accounting as the database header and the sidebar summaries
// (system.parts bytes_on_disk for MergeTree, total_bytes for Log-family and other disk engines). Memory, Buffer and Dictionary
// objects report resident RAM (isResidentMemorySummary): mixing RAM into an on-disk area would make the storage view disagree with
// the header total, so resident bytes are left out of the areas and reported separately.

import { dom, h } from "./app_dom.js";
import { loadDatabaseTables } from "./app_explorer_data.js";
import { actions, catalogHasDatabase, clear, clearSelection, databaseSummary, model, parts, setError, showDetailState, syncExplorerUrl } from "./app_explorer_store.js";
import { barPercent, humanEngine, isMergeTreeSummary, isResidentMemorySummary, summaryByDatabase, summaryFootprintBytes, validCatalogTime } from "./app_explorer_summary.js";
import { renderTableList, sidebarObjectVisible, syncVisibilityOptionLocks, visibleDatabases } from "./app_explorer_tree.js";
import { format } from "./app_format.js";
import { header } from "./app_header.js";
import { uiState } from "./app_ui_state.js";
import { table } from "./app_ui_table.js";
import { util } from "./app_util.js";

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
  // No section title: the page's h2 ("All databases") already names it.
  const section = h("section", { class: "explorerSection explorerDatabasesOverview", "aria-label": "Databases" });
  dom.explorerDetailContent.appendChild(section);
  renderDatabasesTreemap(section, rows);
  const maxima = [0, 1, 2, 3, 4].map((index) => Math.max(0, ...rows.map((row) => Number(row[index]) || 0)));
  const overview = parts.results?.createStaticResultTable?.({
    columns: ["Database", "Objects", "Rows", "Size", "% server"],
    types: ["String", "UInt64", "UInt64", "UInt64", "Float64"],
    rows,
    className: "explorerResultTable explorerDatabasesTable",
    compact: true,
    nullsLast: true,
    // On a phone the table keeps the database, its size and its share of the server.
    priorities: [null, "xs", "xs"],
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
      if (rows.length > 1 && ctx.columnIndex >= 2) table.cellBar(td, barPercent(value, maxima[ctx.columnIndex]));
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
  const storageView = parts.storage;
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

// An address naming a database (or a table) this host does not show: a
// "not found" page with the ways out, instead of a fabricated empty
// database in the tree. The address stays as typed; Refresh reloads the
// catalog and applies it again (the object may have just been created).
function showNotFound(database, table = "") {
  clearSelection();
  const db = String(database || "");
  const missingDatabase = !catalogHasDatabase(db);
  model.notFound = { database: db, table: missingDatabase ? "" : String(table || "") };
  model.routeIntent = null;
  setError(null);
  syncVisibilityOptionLocks({ propagate: true });
  renderTableList();
  renderNotFound();
}

function renderNotFound() {
  const missing = model.notFound;
  if (!missing) return;
  destroyDatabaseTreemap();
  if (dom.explorerDetail) dom.explorerDetail.hidden = true;
  const buttons = [{ label: "All databases", primary: true, onClick: () => actions.openCatalogRoot() }];
  if (missing.table) buttons.push({ label: `Open ${missing.database}`, onClick: () => selectDatabase(missing.database) });
  buttons.push({
    label: "Refresh",
    onClick: () => { void actions.refreshCatalog(true).then(() => actions.applyRouteFromLocation()); },
  });
  showDetailState("empty", missing.table
    ? { title: "Table not found", body: `${missing.database}.${missing.table} is not in the catalog of this host, or you cannot read it.`, actions: buttons }
    : { title: "Database not found", body: `${missing.database} is not a database of this host, or you cannot read it.`, actions: buttons });
  const box = dom.explorerEmptyState?.firstElementChild;
  if (box) box.id = "explorerNotFound";
}

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

// The storage of a database page, above its objects (the size band first,
// then the table): a treemap of its tables (or one share strip when fewer
// than three hold >= 1%), and the disks it uses (into disksContainer, under
// the objects); nothing when nothing of it is stored (on disk or in RAM).
// A table opens on its own Storage tab.
function renderDatabaseStorage(container, database, disksContainer = null) {
  destroyDatabaseTreemap();
  const storageView = parts.storage;
  if (!storageView) return null;
  const { root, residentBytes } = databaseStorageTree(database);
  if (!(root.bytes > 0) && !(residentBytes > 0)) return null;
  model.databaseStorage = storageView.renderDatabase(container, {
    root,
    residentBytes,
    name: database,
    disks: model.databaseDisks.get(database) || [],
    disksContainer,
    onOpen: (db, table) => {
      model.tab = "Storage";
      void actions.selectTable(db, table);
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
    dom.explorerDetailContent.appendChild(uiState.block("empty", { body: "No objects in this database." }));
    return;
  }
  // Tables by size (the size band), then the objects, then the disks.
  const body = h("div", { class: "explorerDatabaseCard" });
  dom.explorerDetailContent.appendChild(body);
  const disks = document.createDocumentFragment();
  const storage = renderDatabaseStorage(body, name, disks);
  renderDatabaseObjects(body, name, tables);
  body.appendChild(disks);
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
    section.appendChild(uiState.block("empty", { body: "No objects in this database.", compact: true }));
    return;
  }
  const onDiskTotal = databaseStorageTree(database).root.bytes;
  const rows = tables.map((table) => databaseObjectRow(table, onDiskTotal));
  const maxima = DATABASE_OBJECT_COLUMNS.map((_, index) => Math.max(0, ...rows.map((row) => Number(row[index]) || 0)));
  const bars = rows.length > 1;
  const setBar = (td, value, max, text) => {
    td.classList.add("num");
    if (bars && DATABASE_OBJECT_BAR_COLUMNS.has(td.__columnIndex)) table.cellBar(td, barPercent(value, max));
    td.textContent = text;
  };
  const objectTable = parts.results?.createStaticResultTable?.({
    columns: DATABASE_OBJECT_COLUMNS,
    types: DATABASE_OBJECT_TYPES,
    rows,
    className: "explorerResultTable explorerDatabaseObjectsTable",
    compact: true,
    nullsLast: true,
    // Name, Rows, Size, % database and Modified stay as long as they fit; Engine, Compressed, Ratio and Parts go first (Ratio keeps the
    // figures of the two in its tooltip, and the Engine is in the card of the object), then Modified, then Rows.
    priorities: [null, "low", "xs", null, "low", "low", null, "low", "mid"],
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
        button.addEventListener("click", () => void actions.selectTable(table.database, table.name));
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
        const time = header.serverTime(value);
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
    showNotFound(name);
    syncExplorerUrl(history);
    return;
  }
  model.notFound = null;
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
  if (model.mode === "graph") parts.graph?.focusDatabase?.(name);
  else renderDatabaseDetail(name);
  if (!model.databaseTablesLoaded.has(name)) void loadDatabaseTables(name);
  syncExplorerUrl(history);
}

Object.assign(actions, { selectDatabase, renderDatabaseDetail, renderBrowseRoot });

export { destroyDatabaseTreemap, renderBrowseRoot, renderDatabaseDetail, renderNotFound, selectDatabase, showNotFound };
