// The result panel of the Query page (and the Explorer's preview): the status and the error of the result, its Copy buttons, the
// blocks of a batch of statements. The table itself is app_results_table.js: this panel has one for the result of a query and
// each statement of a batch has its own. The values, the cells, the sort and the row details are the modules app_results_*.js.
import { dom } from "./app_dom.js";
import { setNullCell } from "./app_results_cells.js";
import { closeRowDetails, closeRowDetailsMenu } from "./app_results_rowdetails.js";
import { SORT_WASM_MIN_ROWS, compareNumericForSort, numericSortKeys, orderByKeysJs, orderByKeysWasm, setSortWasm, sortNumericRows, sortNumericRowsByComparator, sortTextRows, sortTextRowsByComparator } from "./app_results_sort.js";
import { createStaticResultTable } from "./app_results_static.js";
import { createLiveTable } from "./app_results_table.js";
import { flattenTupleTableData, jsonText, parseChType, parseJsonText, resultCsvText, resultJsonText, serialize, valueText } from "./app_results_values.js";
import { state } from "./app_state.js";
import { copy as copyMod } from "./app_ui_copy.js";
import { uiState } from "./app_ui_state.js";
import { util } from "./app_util.js";

const { $, $$ } = dom;

// The Table / Chart toggle of the result (app_query_chart.js) is the Query page's: its entry hands it over with
// results.use({ queryChart }); the Explorer's static tables have none.
let queryChart = null;

let resultsStackElement = null;
// Table / Chart view of the main result panel (multiquery panels own theirs).
let mainChart = null;

let lastErrorMessage = "";
let currentStatusValue = "";
let liveBodyHold = null;

function getDocumentScrollHeight() {
  const bodyH = document.body ? document.body.scrollHeight : 0;
  const rootH = document.documentElement ? document.documentElement.scrollHeight : 0;
  return Math.max(bodyH, rootH);
}

function applyLiveBodyHold() {
  const hold = liveBodyHold;
  if (!hold) return;
  const body = document.body;
  const spacer = hold.spacer;
  if (!body || !spacer) {
    if (spacer && spacer.parentNode) spacer.remove();
    liveBodyHold = null;
    return;
  }
  const spacerH = spacer.parentNode ? spacer.offsetHeight : 0;
  const contentH = Math.max(0, getDocumentScrollHeight() - spacerH);
  const viewportMax = Math.max(0, window.innerHeight || 0);
  const target = viewportMax > 0 ? Math.min(hold.targetScrollHeight, contentH + viewportMax) : hold.targetScrollHeight;
  const need = Math.max(0, target - contentH);
  if (need <= 0) {
    if (spacer.parentNode) spacer.remove();
    liveBodyHold = null;
    return;
  }
  spacer.style.height = `${need}px`;
  if (!spacer.parentNode) body.appendChild(spacer);
}

function setLiveBodyHold(targetScrollHeight) {
  const body = document.body;
  const target = Number(targetScrollHeight) || 0;
  if (!body || target <= 0) {
    if (liveBodyHold && liveBodyHold.spacer && liveBodyHold.spacer.parentNode) liveBodyHold.spacer.remove();
    liveBodyHold = null;
    return;
  }
  if (!liveBodyHold) {
    const spacer = document.createElement("div");
    spacer.className = "resultsScrollHold";
    spacer.setAttribute("aria-hidden", "true");
    liveBodyHold = { spacer, targetScrollHeight: target };
  } else {
    liveBodyHold.targetScrollHeight = target;
  }
  applyLiveBodyHold();
}

function setResultsVisible(visible) {
  if (!dom.resultsPanel) return;
  if (visible && state.suppressResultsVisibility) {
    dom.resultsPanel.classList.add("is-hidden");
    return;
  }
  dom.resultsPanel.classList.toggle("is-hidden", !visible);
}

function getErrorText() {
  return String(lastErrorMessage || "").trim();
}

// The Query result error: the server's sentence cleaned up
// (util.queryErrorParts: no code prefix, no formatQuery wrapper, "Syntax
// error, line 1 col 8 near FROM"), the parser's "Expected one of" list
// behind a toggle. getErrorText() keeps the message as sent (history,
// downloads).
function queryErrorBanner(el, message, where = null) {
  const parts = message ? util.queryErrorParts(message, where) : null;
  return uiState.banner(el, {
    message: parts ? parts.summary : "",
    verbatim: true,
    details: parts?.expected || "",
    detailsLabel: "Expected one of\u2026",
  });
}

function setError(message, where = null) {
  lastErrorMessage = String(message || "").trim();
  if (!dom.errorBanner) return;
  queryErrorBanner(dom.errorBanner, lastErrorMessage, where);
  if (lastErrorMessage) {
    if (dom.liveResultsWrap) dom.liveResultsWrap.hidden = true;
    setResultsVisible(true);
  }
  updateCopyButtonState();
}

function takeErrorText() {
  const text = getErrorText();
  if (text) setError("");
  return text;
}

function setStatus(status) {
  currentStatusValue = String(status || "");
  updateCopyButtonState();
}

// The table of the main result: the one live table (app_results_table.js) that the statements of a batch have as well. The
// panel gives it what the table does not know about the page: that the results panel shows, the "N columns" of its header,
// the Copy buttons and the height that the page holds while a result replaces another.
const mainTable = dom.liveResultsWrap && $("table", dom.liveResultsWrap)
  ? createLiveTable({
    wrap: dom.liveResultsWrap,
    host: {
      visible: () => setResultsVisible(true),
      metaChanged: setResultColumnsText,
      rowsChanged: updateCopyButtonState,
      rendered: applyLiveBodyHold,
    },
  })
  : null;

function setResultColumnsText() {
  if (!dom.resultColumnsText) return;
  const n = mainTable?.columnCount() || 0;
  util.setText(dom.resultColumnsText, `${n} ${n === 1 ? "column" : "columns"}`);
}

function clearLiveResults() {
  closeRowDetailsMenu();
  closeRowDetails({ silent: true });
  if (mainChart) mainChart.reset();
  const wasResultsVisible = dom.resultsPanel && !dom.resultsPanel.classList.contains("is-hidden");
  const preservedBodyScrollHeight = getDocumentScrollHeight();
  mainTable?.clear();

  currentStatusValue = "";
  lastErrorMessage = "";

  setLiveBodyHold(preservedBodyScrollHeight);

  // Empty until the result has columns (no stray "-" beside an error).
  if (dom.resultColumnsText) util.setText(dom.resultColumnsText, "");
  setError("");
  updateCopyButtonState();

  if (dom.liveResultsWrap) dom.liveResultsWrap.hidden = false;
  if (resultsStackElement && resultsStackElement.childElementCount > 0) setResultsVisible(true);
  else if (wasResultsVisible) setResultsVisible(true);
  else setResultsVisible(false);
}

// The result of the query: the stream's rows go to the table, and the end of the stream makes its layout final.
const renderTableMeta = (columns, types) => mainTable?.renderTableMeta(columns, types);
const appendRows = (rows) => mainTable?.appendRows(rows);
const finalizeAfterDone = () => (mainTable ? mainTable.whenIdle().then(() => mainTable.finalize()) : Promise.resolve());

function ensureResultsStack() {
  if (resultsStackElement || !dom.resultsPanel) return;
  resultsStackElement = document.createElement("div");
  resultsStackElement.className = "resultsStack";
  const header = $(".panel__header", dom.resultsPanel);
  const anchor = header ? header.nextSibling : dom.resultsPanel.firstChild;
  dom.resultsPanel.insertBefore(resultsStackElement, anchor);
}

// Per-panel teardown callbacks (document/window listeners registered by
// multiquery panels). Without them every virtualized panel stayed reachable
// through its scroll/resize closures after the stack was cleared, retaining
// all of its rows and re-running layout reads on each page scroll.
const resultsStackDisposers = [];

function clearResultsStack() {
  closeRowDetailsMenu();
  closeRowDetails({ silent: true });
  while (resultsStackDisposers.length) {
    const dispose = resultsStackDisposers.pop();
    try { dispose(); } catch { /* teardown must not block clearing */ }
  }
  if (!resultsStackElement) return;
  resultsStackElement.remove();
  resultsStackElement = null;
}

function removeIds(root) {
  if (!root) return;
  if (root.removeAttribute) root.removeAttribute("id");
  const nodes = $$("[id]", root);
  for (const n of nodes) n.removeAttribute("id");
}

// Copy JSON and Copy CSV of the result: the same text as Download JSON and Download CSV
// (serialize, app_download.js). A failed or canceled query copies its error.
// Copy JSON and Copy CSV of the result: the same text as Download JSON and Download CSV
// (serialize, app_download.js). A failed or canceled query copies its error.
function terminalErrorText(status, error) {
  const st = String(status || "").toLowerCase();
  const err = String(error || "").trim();
  return err && ["error", "canceled", "cancelled"].includes(st) ? err : "";
}

function buildCopyJsonText() {
  const err = terminalErrorText(currentStatusValue, lastErrorMessage);
  if (err) return err;
  return resultJsonText(mainTable?.columns() || [], mainTable?.typeAsts() || [], mainTable?.rows() || []);
}

function buildCopyCsvText() {
  const err = terminalErrorText(currentStatusValue, lastErrorMessage);
  if (err) return err;
  return resultCsvText(mainTable?.columns() || [], mainTable?.typeAsts() || [], mainTable?.rows() || []);
}

function buildCopyText(format) {
  const v = String(format || "json").toLowerCase();
  return v === "csv" ? buildCopyCsvText() : buildCopyJsonText();
}

function getSnapshot() {
  return {
    columns: (mainTable?.columns() || []).slice(),
    types: (mainTable?.types() || []).slice(),
    // Download/history consumers rebuild JSON/CSV from `rows` on demand.
    // Pre-rendering both texts here converted every cell twice after each
    // statement (seconds for 100k-row results) and retained the strings.
    rows: (mainTable?.rows() || []).slice(),
    errorText: String(lastErrorMessage || ""),
    status: String(currentStatusValue || ""),
  };
}

function updateCopyButtonState() {
  if (!dom.copyJsonButton) return;

  const err = String(lastErrorMessage || "").trim();
  const hasError = err.length > 0;

  const hasRows = (mainTable?.rowCount() || 0) > 0;

  const st = String(currentStatusValue || "").toLowerCase();
  const finishedLike = ["finished", "done", "error", "canceled", "cancelled", "result_limit_reached"].includes(st);

  const disabled = !(hasError || hasRows || finishedLike);

  dom.copyJsonButton.disabled = disabled;
  if (dom.copyMenuButton) dom.copyMenuButton.disabled = disabled;
  if (dom.copyCsvButton) dom.copyCsvButton.disabled = disabled;
  // A query that failed has no result to copy: no Copy JSON beside its
  // error (multiquery keeps its "Copy all", the other statements' results).
  const multi = !!(dom.resultsPanel && dom.resultsPanel.classList.contains("is-multiquery"));
  if (dom.copySplit && !multi) dom.copySplit.hidden = hasError && !hasRows;
}

const getRowCount = () => mainTable?.rowCount() || 0;
const getColCount = () => mainTable?.columnCount() || 0;

// A query block's Copy JSON split (copy.split): JSON, and CSV in the menu.
function createCopySplitSmall({ getJsonText, getCsvText }) {
  const ctrl = copyMod.split({
    getText: () => (typeof getJsonText === "function" ? getJsonText() : ""),
    items: [{ label: "Copy CSV", copy: () => (typeof getCsvText === "function" ? getCsvText() : "") }],
  });
  return { el: ctrl.el, mainBtn: ctrl.main, menuBtn: ctrl.toggle, menu: ctrl.menu, setDisabled: ctrl.setDisabled };
}

function setMultiqueryMode(enabled) {
  if (!dom.resultsPanel) return;
  const multi = !!enabled;
  dom.resultsPanel.classList.toggle("is-multiquery", multi);
  // Keep the global split visible in multiquery mode: its main action becomes
  // the global JSON copy ("Copy all": each statement's panel has its own
  // Copy JSON) and its menu contains the cumulative ZIP download.
  if (dom.copySplit) dom.copySplit.hidden = false;
  if (dom.copyCsvButton) dom.copyCsvButton.hidden = multi;
  if (dom.copyJsonButton) {
    dom.copyJsonButton.textContent = multi ? "Copy all" : "Copy JSON";
    dom.copyJsonButton.title = multi ? "Copy every statement's result as one JSON document" : "";
  }
  if (dom.resultColumnsText) dom.resultColumnsText.hidden = multi;
}

function hideLiveWrapIfStackHasBlocks() {
  if (!dom.liveResultsWrap) return;
  const hasBlocks = !!(resultsStackElement && resultsStackElement.childElementCount > 0);
  const multi = !!(dom.resultsPanel && dom.resultsPanel.classList.contains("is-multiquery"));
  dom.liveResultsWrap.hidden = hasBlocks;
  if (hasBlocks) {
    if (dom.copySplit) dom.copySplit.hidden = !multi;
    if (dom.resultColumnsText) dom.resultColumnsText.hidden = true;
  }
  if (!multi) {
    if (dom.copyJsonButton) dom.copyJsonButton.disabled = true;
    if (dom.copyMenuButton) dom.copyMenuButton.disabled = true;
    if (dom.copyCsvButton) dom.copyCsvButton.disabled = true;
  }
}

// --- Multiquery streaming panels (Query x/n) ---
// A batch shows one block for each statement: a header (title, rows and columns, Copy, Profiling, Show / Hide), the Table /
// Chart view, and a live table (app_results_table.js: the table of the main result is the same module). app_run routes the
// stream of a statement into the block that beginMultiqueryPanel returns.

let activeMultiqueryPanel = null;

function ensureLocalErrorBanner(body) {
  if (!body) return null;
  let el = $(".uiBanner", body);
  if (!el) {
    el = document.createElement("div");
    body.insertBefore(el, body.firstChild);
    queryErrorBanner(el, "");
  }
  return el;
}

function setBlockExpandedLocal(blockObj, expanded) {
  if (!blockObj || !blockObj.body || !blockObj.toggleBtn) return;
  blockObj.body.hidden = !expanded;
  blockObj.toggleBtn.textContent = expanded ? "Hide" : "Show";
  blockObj.block.classList.toggle("is-collapsed", !expanded);
}

function beginMultiqueryPanel({ index = 0, total = 1, autoToggle = true } = {}) {
  ensureResultsStack();
  if (!resultsStackElement) return null;

  // The previous panel folds while the next one streams, unless it ended
  // expanded (the first panel, a short batch, an error: app_run.js).
  if (autoToggle && activeMultiqueryPanel && !activeMultiqueryPanel.keepExpanded) {
    setBlockExpandedLocal(activeMultiqueryPanel, false);
  }

  const title = `Query ${index + 1}/${total}`;

  const block = document.createElement("div");
  block.className = "resultsStack__block";
  block.dataset.qIndex = String(index);

  const header = document.createElement("div");
  header.className = "resultsStack__header";

  const t = document.createElement("span");
  t.textContent = title;
  header.appendChild(t);

  const right = document.createElement("div");
  right.className = "resultsStack__right";

  const metaSpan = document.createElement("span");
  metaSpan.className = "resultsStack__meta";
  metaSpan.textContent = "";
  right.appendChild(metaSpan);

  let errorText = "";
  let table = null;

  const copyCtrl = createCopySplitSmall({
    getJsonText: () => buildCopyText("json"),
    getCsvText: () => buildCopyText("csv"),
  });
  right.appendChild(copyCtrl.el);

  const analyzeBtn = document.createElement("button");
  analyzeBtn.type = "button";
  analyzeBtn.className = "button button--small resultsStack__analyze";
  analyzeBtn.textContent = "Profiling";
  analyzeBtn.hidden = true;
  right.appendChild(analyzeBtn);

  const toggleBtn = document.createElement("button");
  toggleBtn.type = "button";
  toggleBtn.className = "button button--small resultsStack__toggle";
  toggleBtn.textContent = "Hide";
  right.appendChild(toggleBtn);

  header.appendChild(right);

  const body = document.createElement("div");
  body.className = "resultsStack__body";
  body.hidden = false;

  const blockObj = { block, body, toggleBtn };
  toggleBtn.addEventListener("click", () => {
    const expanded = body.hidden;
    // The viewer's choice wins over the batch's default (finalize).
    blockObj.userToggled = true;
    setBlockExpandedLocal(blockObj, expanded);
  });

  const mainWrap = dom.liveResultsWrap || (dom.resultsPanel ? $(".tableWrap", dom.resultsPanel) : null);
  if (!mainWrap) return null;
  const wrap = mainWrap.cloneNode(true);
  removeIds(wrap);
  body.appendChild(wrap);

  // The statement's rows, as many rows and columns as it has: the header says so, the Copy buttons follow.
  const updateMetaText = () => {
    const r = table.rowCount();
    const c = table.columnCount();
    util.setMetaLine(metaSpan, c ? `${r} row${r === 1 ? "" : "s"} ${c} column${c === 1 ? "" : "s"}` : `${r} row${r === 1 ? "" : "s"}`);
    updateCopyEnabled();
  };
  table = createLiveTable({ wrap, host: { metaChanged: updateMetaText, rowsChanged: updateMetaText } });
  resultsStackDisposers.push(() => table.destroy());

  // The panel's Copy JSON / Copy CSV: the same serializer as the single result and the downloads; a statement that failed
  // without rows copies its error.
  const errorWithoutRows = () => (errorText && !table.rowCount() ? errorText : "");
  const copyText = (format) => errorWithoutRows()
    || (format === "csv" ? resultCsvText : resultJsonText)(table.columns(), table.typeAsts(), table.rows());
  const updateCopyEnabled = () => copyCtrl.setDisabled(!(errorText || table.rowCount() > 0));

  // Each panel keeps its own Table / Chart view and chart settings.
  const panelChart = queryChart ? queryChart.createController({
    getData: () => ({ rows: table.rows() }),
    viewRoot: body,
    onViewChange: (view) => {
      closeRowDetailsMenu();
      if (view === "table") table.relayout();
    },
  }) : null;
  if (panelChart) {
    right.insertBefore(panelChart.toggleEl, copyCtrl.el);
    body.appendChild(panelChart.hostEl);
    table.setChart(panelChart);
    resultsStackDisposers.push(() => panelChart.destroy());
  }

  block.appendChild(header);
  block.appendChild(body);
  resultsStackElement.appendChild(block);
  setResultsVisible(true);

  const errorBanner = ensureLocalErrorBanner(body);

  function setErrorLocal(message, where = null) {
    errorText = String(message || "").trim();
    updateCopyEnabled();
    if (!errorBanner) return;
    queryErrorBanner(errorBanner, errorText, where);
    if (errorText) wrap.hidden = true;
  }

  updateCopyEnabled();

  activeMultiqueryPanel = blockObj;
  if (autoToggle) setBlockExpandedLocal(blockObj, true);

  return {
    renderTableMeta: (columns, types) => table.renderTableMeta(columns, types),
    appendRows: (rows) => table.appendRows(rows),
    clearLiveResults: () => {
      table.clear();
      if (panelChart) panelChart.reset();
    },
    finalizeAfterDone: () => table.whenIdle(),
    getRowCount: () => table.rowCount(),
    getColumnCount: () => table.columnCount(),
    buildCopyJsonText: () => copyText("json"),
    getSnapshot: () => ({
      columns: table.columns().slice(),
      types: table.types().slice(),
      rows: table.rows().slice(),
      errorText: String(errorText || ""),
    }),
    setError: setErrorLocal,
    getErrorText: () => errorText,
    takeErrorText: () => {
      const t = errorText;
      setErrorLocal("");
      return t;
    },
    setMetaText: (text) => util.setMetaLine(metaSpan, String(text ?? "")),
    setAnalyzeAction: (fn) => {
      analyzeBtn.hidden = typeof fn !== "function";
      analyzeBtn.onclick = typeof fn === "function" ? fn : null;
    },
    setExpanded: (expanded) => setBlockExpandedLocal(blockObj, !!expanded),
    finalize: ({ expandedByDefault = false } = {}) => {
      table.finalize();
      if (panelChart) panelChart.done();
      if (blockObj.userToggled) {
        blockObj.keepExpanded = !blockObj.body.hidden;
      } else {
        blockObj.keepExpanded = !!expandedByDefault;
        if (autoToggle) setBlockExpandedLocal(blockObj, !!expandedByDefault);
      }
    },
  };
}

function endMultiqueryPanel(sink, { expandedByDefault = false, metaText = null } = {}) {
  if (sink && typeof sink.setMetaText === "function" && metaText != null) sink.setMetaText(metaText);
  if (sink && typeof sink.finalize === "function") sink.finalize({ expandedByDefault });
}











































function mountMainChart() {
  if (!(queryChart && mainTable && dom.resultsPanel && dom.liveResultsWrap)) return;
  mainChart = queryChart.createController({
    getData: () => ({ rows: mainTable.rows() }),
    viewRoot: dom.resultsPanel,
    toggleClassName: "resultsViewToggle--main",
    onViewChange: (view) => {
      closeRowDetailsMenu();
      if (view === "table") mainTable.relayout();
    },
  });
  mainTable.setChart(mainChart);
  const headerMeta = $(".panel__header .panel__meta", dom.resultsPanel);
  if (headerMeta) headerMeta.insertBefore(mainChart.toggleEl, dom.copySplit && dom.copySplit.parentElement === headerMeta ? dom.copySplit : null);
  dom.liveResultsWrap.after(mainChart.hostEl);
}

function use(parts = {}) {
  queryChart = parts.queryChart || null;
  mountMainChart();
}

export const results = {
  use,
  setNullCell,
  beginMultiqueryPanel,
  endMultiqueryPanel,
  clearLiveResults,
  clearResultsStack,
  setError,
  takeErrorText,
  getErrorText,
  setStatus,
  renderTableMeta,
  appendRows,
  finalizeAfterDone,
  buildCopyJsonText,
  buildCopyCsvText,
  buildCopyText,
  getSnapshot,
  getRowCount,
  getColCount,
  setMultiqueryMode,
  hideLiveWrapIfStackHasBlocks,
  ensureResultsStack,
  setResultsVisible,
  createStaticResultTable,
  flattenTupleTableData,
  // The value contract (docs/telemetry.md, "Result values"): one serializer for Copy JSON / CSV,
  // Download JSON / CSV and the Debug archive (app_download.js), and the text of one value.
  serialize,
  cellText: (value, type = "") => valueText(value, parseChType(type)),
  // The sort paths and the kernel switch, for the equivalence tests (tests/frontend/specs/wasm-rowsort.spec.js).
  testing: {
    sortNumericRows,
    sortNumericRowsByComparator,
    sortTextRows,
    sortTextRowsByComparator,
    numericSortKeys,
    orderByKeysJs,
    orderByKeysWasm,
    sortWasmMinRows: SORT_WASM_MIN_ROWS,
    setWasm: setSortWasm,
    parseJsonText,
    jsonText: (value, type = "", indent = 0) => jsonText(value, parseChType(type), indent),
    compareNumericForSort,
  },
};
