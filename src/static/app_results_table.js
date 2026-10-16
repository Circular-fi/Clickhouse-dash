// The live result table (ARCH-F-048). One implementation serves the result of a query and each statement of a batch. The table takes
// the rows as the stream sends them, through a cooperative queue that keeps the editor responsive. It shows the table when the layout is known.
// A horizontal table is known from the second row. One row and one value have their own layouts, shown at the end of the stream.
//
// The table sorts the rows, draws the bars of the numeric columns, and mounts only the rows in view for a long result.
// It also keeps the row details (app_results_rowdetails.js). The page around it gives a few hooks. This module does not read the page.
//
//   const table = createLiveTable({ wrap, host: { visible, metaChanged, rowsChanged, rendered } });
//     wrap          the element that holds <table><thead><tbody> (a .tableWrap)
//     host.visible()      the table has something to show
//     host.metaChanged()  the columns are known (a new result)
//     host.rowsChanged()  rows were added
//     host.rendered()     rows were written to the table
//   table.renderTableMeta(columns, types)   a new result starts          table.appendRows(rows)   rows of the stream
//   table.whenIdle()    the rows that were queued are in             table.finalize()         the stream ended: the layout is final
//   table.clear()       reset to nothing                             table.destroy()          remove the listeners and timers
//   table.rowCount() / columnCount() / columns() / types() / typeAsts() / rows() / setChart(chart) / relayout()

import { dom } from "./app_dom.js";
import { renderSingleValueCell, renderValueInto, setCellTextFlat, setDisplayCell, setQueryGaugeCell } from "./app_results_cells.js";
import { bindRowDetails, findVerticalScrollOwner, markKeyboardRow, refreshRowDetailsAfterRender, registerRowDetailsSource, replaceVirtualBodyRows, rowDetailsSpacerExtra, rowDetailsVirtualSlot, virtualRowAt } from "./app_results_rowdetails.js";
import { SORT_WASM_MIN_ROWS, requestSortKernel, sortNumericRows, sortTextRows } from "./app_results_sort.js";
import { createTupleFlattenPlan, extractDecimalScale, extractFiniteNumber, flattenTupleRow, formatCellForDisplayWithTypes, formatNumericCellText, isScalarNumericType, parseChType } from "./app_results_values.js";
import { table as tableMod } from "./app_ui_table.js";

const { $, $$ } = dom;

const flushBatchSize = 400;

// DOM virtualization. Thousands of rows and dozens of columns create hundreds of thousands of <td> nodes. Scroll and sort actions are then very costly.
// Keep all rows in memory for the copy, export, and sort actions. Mount only the rows in view in the main page viewport.
// The results table must not become a separate vertical scroll container.
const virtualRowThreshold = 500;
const virtualOverscanMinRows = 96;
const virtualOverscanViewports = 6;
const virtualDefaultRowHeight = 32;

// A streamed result batch can contain hundreds or thousands of rows. When tuple projection, numeric scans, and array growth run for the whole SSE batch in one task, they block the editor input.
//
// Drain the rows in short background slices. This keeps the text input, scroll, and paint actions on the main thread.
// Each slice processes about SLICE_MS of rows. Its size follows the measured cost of a row (64 to 4096 rows).
// Narrow rows do not pay one task for each 128 rows. Wide rows still yield often.
const SLICE_MS = 4;
function createCooperativeRowQueue(processRows) {
  let queue = [];
  let scheduled = false;
  let generation = 0;
  let idleWaiters = [];
  let sliceRows = 128;

  function resolveIdle() {
    if (queue.length || scheduled) return;
    const waiters = idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  function postBackground(fn) {
    if (globalThis.scheduler && typeof globalThis.scheduler.postTask === "function") {
      try {
        globalThis.scheduler.postTask(fn, { priority: "background" });
        return;
      } catch {
        // Use the timer queue. It has the broadest browser support.
      }
    }
    setTimeout(fn, 0);
  }

  function schedule() {
    if (scheduled || !queue.length) return;
    scheduled = true;
    const taskGeneration = generation;
    postBackground(() => {
      if (taskGeneration !== generation) {
        scheduled = false;
        resolveIdle();
        return;
      }
      scheduled = false;
      // When the user sends input, the thread is released sooner.
      const size = globalThis.navigator?.scheduling?.isInputPending?.() ? 64 : sliceRows;
      const batch = [];
      while (queue.length && batch.length < size) {
        const head = queue[0];
        const take = Math.min(head.rows.length - head.index, size - batch.length);
        for (let k = 0; k < take; k++) batch.push(head.rows[head.index++]);
        if (head.index >= head.rows.length) queue.shift();
      }
      try {
        if (batch.length) {
          const start = performance.now();
          processRows(batch);
          const perRow = (performance.now() - start) / batch.length;
          const target = Math.floor(SLICE_MS / Math.max(perRow, 1e-4));
          sliceRows = Math.max(64, Math.min(4096, sliceRows * 2, Math.max(sliceRows >> 1, target)));
        }
      } catch (error) {
        // The module reports a row that fails to render. The queue continues, so the run still ends
        // (whenIdle resolves). It does not stay in the "running" state.
        if (typeof reportError === "function") reportError(error);
      } finally {
        if (queue.length) schedule();
        else resolveIdle();
      }
    });
  }

  return {
    enqueue(rows) {
      if (!Array.isArray(rows) || !rows.length) return;
      queue.push({ rows, index: 0 });
      schedule();
    },
    whenIdle() {
      if (!queue.length && !scheduled) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
    reset() {
      generation += 1;
      queue = [];
      scheduled = false;
      resolveIdle();
    },
  };
}

function getVirtualRange(rowsLength, rowH, bodyEl) {
  if (!bodyEl?.getBoundingClientRect) return { start: 0, end: Math.min(rowsLength, 50) };
  const bodyRect = bodyEl.getBoundingClientRect();
  const owner = findVerticalScrollOwner(bodyEl);
  const windowHeight = Math.max(rowH, window.innerHeight || document.documentElement?.clientHeight || rowH * 12);
  let viewportTop = 0;
  let viewportBottom = windowHeight;
  if (owner?.getBoundingClientRect) {
    const ownerRect = owner.getBoundingClientRect();
    viewportTop = Math.max(0, ownerRect.top);
    viewportBottom = Math.min(windowHeight, ownerRect.bottom);
  }
  const viewportH = Math.max(rowH, viewportBottom - viewportTop);
  const visibleRows = Math.max(1, Math.ceil(viewportH / rowH));
  // Keep several full viewports mounted. A small fixed overscan can show the spacer background before the next rAF.
  // This happens when a trackpad or thumb scroll jumps over several screens in one frame.
  const overscanRows = Math.max(virtualOverscanMinRows, visibleRows * virtualOverscanViewports);
  // An expanded row (inline details) pushes every later row down by its measured height. Map the viewport offsets to row indexes around it.
  const detail = rowDetailsVirtualSlot(bodyEl);
  let start = Math.max(0, Math.floor(virtualRowAt(viewportTop - bodyRect.top, rowH, detail)) - overscanRows);
  let end = Math.min(rowsLength, Math.ceil(virtualRowAt(viewportBottom - bodyRect.top, rowH, detail)) + overscanRows);

  if (end <= start) {
    const visibleCount = visibleRows + overscanRows * 2;
    if (viewportBottom < bodyRect.top) {
      start = 0;
      end = Math.min(rowsLength, visibleCount);
    } else {
      end = rowsLength;
      start = Math.max(0, end - visibleCount);
    }
  }

  return { start, end };
}

function createLiveTable({ wrap, host = {} }) {
  if (wrap) tableMod.scrollCues(wrap);
  const table = $("table", wrap);
  const thead = $("thead", wrap);
  const tbody = $("tbody", wrap);
  let chart = null;

  let resultColumns = [];
  let resultTypes = [];
  let resultTypeAsts = [];
  let resultTupleFlattenPlan = null;
  let pendingRows = [];
  let allResultRows = [];

  let scheduledFlush = false;
  let flushRafId = 0;

  let isVerticalResults = false;
  // Do not commit to a horizontal result layout until the stream shows at least two rows. A one-row result is rendered vertically only after the terminal event.
  // So the UI never shows a wide header and then changes it.
  let livePresentationCommitted = false;

  let rowIndexCounter = 0;
  let sortKey = null;
  let sortDir = "";
  let scheduledFullRender = false;
  let fullRenderRafId = 0;
  let scheduledFullRenderRebuild = false;
  let fullRenderToken = 0;

  let isVirtualResults = false;
  let virtualViewRows = [];
  let virtualRowHeight = virtualDefaultRowHeight;
  let virtualLastStart = -1;
  let virtualLastEnd = -1;
  let virtualScrollRafId = 0;
  let virtualScrollAttached = false;

  let gaugeNumericCols = [];
  let gaugeMax = [];
  let gaugeMin = [];
  let gaugeDirty = false;
  let numericMaxScale = [];
  let numericDirty = false;

  let liveGaugesEnabled = false;
  let liveGaugesPainted = false;
  const liveRowIngest = createCooperativeRowQueue(appendRowsImmediate);

  function resetTableMode() {
    isVerticalResults = false;
    if (table) table.classList.remove("resultTable--vertical", "resultTable--single");
  }

  function clearTable() {
    if (table) table.classList.remove("resultTable--single");
    if (thead) thead.replaceChildren();
    if (tbody) tbody.replaceChildren();
  }

  // The text of a cell in the table, on one line. See valueText. The text is "null" for SQL NULL. The setDisplayCell function shows it as the NULL token.
  function formatCellForDisplay(raw, colIndex) {
    return formatCellForDisplayWithTypes(raw, colIndex, resultTypeAsts);
  }

  function setVerticalValueCell(td, raw, colIndex) {
    renderValueInto(td, raw, resultTypeAsts[colIndex] || null);
  }

  // A Query result tracks the lowest and the largest value of each numeric column. The base and top of the bars use these values (setQueryGaugeCell).
  function resetLiveGaugeState() {
    gaugeNumericCols = resultTypeAsts.map(isScalarNumericType);
    gaugeMax = new Array(gaugeNumericCols.length).fill(-Infinity);
    gaugeMin = new Array(gaugeNumericCols.length).fill(Infinity);
    gaugeDirty = false;
    numericMaxScale = new Array(gaugeNumericCols.length).fill(0);
    numericDirty = false;
    liveGaugesEnabled = false;
    liveGaugesPainted = false;
  }

  function updateLiveGaugeMaximaFromRow(row) {
    if (!Array.isArray(row) || gaugeNumericCols.length === 0) return;
    let changed = false;
    let scaleChanged = false;
    for (let i = 0; i < gaugeNumericCols.length; i++) {
      if (!gaugeNumericCols[i]) continue;

      const scale = extractDecimalScale(row[i]);
      if (scale > (numericMaxScale[i] || 0)) {
        numericMaxScale[i] = scale;
        scaleChanged = true;
      }

      const n = extractFiniteNumber(row[i]);
      if (n === null) continue;
      if (n < gaugeMin[i]) {
        gaugeMin[i] = n;
        changed = true;
      }
      if (n > gaugeMax[i]) {
        gaugeMax[i] = n;
        changed = true;
      }
    }
    if (changed) gaugeDirty = true;
    if (scaleChanged) numericDirty = true;
  }

  function refreshLiveGauges() {
    gaugeDirty = false;
  }

  function isLiveSortActive() {
    return sortKey !== null && !!sortDir;
  }

  function getLiveSortMode(key) {
    if (key === -1) return "numeric";
    return isScalarNumericType(resultTypeAsts[key] || null) ? "numeric" : "text";
  }

  function nextLiveSortDir(key) {
    const mode = getLiveSortMode(key);
    if (sortKey !== key) return mode === "numeric" ? "desc" : "asc";
    if (mode === "numeric") {
      if (sortDir === "desc") return "asc";
      if (sortDir === "asc") return "";
      return "desc";
    }
    if (sortDir === "asc") return "desc";
    if (sortDir === "desc") return "";
    return "asc";
  }

  function updateLiveSortIndicators() {
    if (!thead) return;
    const ths = $$("th.is-sortable", thead);
    for (const th of ths) {
      const k = Number(th.dataset.sortKey || "");
      tableMod.setSort(th, sortKey !== null && sortDir && k === sortKey ? sortDir : "");
    }
  }

  function buildLiveViewRows() {
    if (!isLiveSortActive()) return allResultRows;
    const key = sortKey;
    const dir = sortDir;
    const mode = getLiveSortMode(key);
    const numeric = mode === "numeric";
    if (numeric) return sortNumericRows(allResultRows, key, dir);
    return sortTextRows(allResultRows, key, dir, liveSortText);
  }

  // The live table shows this value for a cell of the column, and sorts by it.
  function liveSortText(row, key) {
    const av = key === -1 ? row.__chdashRowIndex : row[key];
    return key === -1 ? String(av ?? "") : formatCellForDisplay(av, key);
  }

  function appendLiveRowCells(tr, row) {
    markKeyboardRow(tr, row && row.__chdashRowIndex);
    const tdIndex = document.createElement("td");
    tdIndex.className = "dataTable__rowNum";
    tdIndex.textContent = row && row.__chdashRowIndex ? String(row.__chdashRowIndex) : "";
    tr.appendChild(tdIndex);

    if (Array.isArray(row)) {
      bindRowDetails(tr, row, row.__chdashRowIndex);
      for (let columnIndex = 0; columnIndex < resultColumns.length; columnIndex++) {
        const td = document.createElement("td");
        if (gaugeNumericCols[columnIndex] && allResultRows.length > 1) {
          const text = formatNumericCellText(row[columnIndex], columnIndex, numericMaxScale);
          if (liveGaugesEnabled) setQueryGaugeCell(td, row[columnIndex], columnIndex, text, gaugeMax, gaugeMin);
          else {
            td.classList.add("num");
            setDisplayCell(td, row[columnIndex], text);
          }
        } else {
          const text = formatCellForDisplay(row[columnIndex], columnIndex);
          if (isScalarNumericType(resultTypeAsts[columnIndex] || null)) td.classList.add("num");
          setDisplayCell(td, row[columnIndex], text);
        }
        tr.appendChild(td);
      }
      return;
    }

    const td = document.createElement("td");
    setCellTextFlat(td, row ?? "");
    td.colSpan = Math.max(1, resultColumns.length);
    tr.appendChild(td);
  }

  function createVirtualSpacerRow(heightPx) {
    const tr = document.createElement("tr");
    tr.className = "resultTable__spacerRow";
    tr.setAttribute("aria-hidden", "true");
    const td = document.createElement("td");
    td.colSpan = Math.max(1, resultColumns.length + 1);
    td.style.height = `${Math.max(0, Math.round(heightPx))}px`;
    td.style.padding = "0";
    td.style.border = "0";
    td.style.lineHeight = "0";
    tr.appendChild(td);
    return tr;
  }

  function scheduleVirtualRender() {
    if (!isVirtualResults || virtualScrollRafId) return;
    virtualScrollRafId = requestAnimationFrame(() => {
      virtualScrollRafId = 0;
      renderVirtualRows(false);
    });
  }

  function handleVirtualScroll() {
    if (!isVirtualResults || isVerticalResults || !tbody) return;
    const rows = Array.isArray(virtualViewRows) ? virtualViewRows : [];
    const rowH = Math.max(18, Number(virtualRowHeight) || virtualDefaultRowHeight);
    const target = getVirtualRange(rows.length, rowH, tbody);
    // A scrollbar thumb or a rapid trackpad jump can move the viewport outside the mounted overscan window before the next animation frame.
    // Render that jump at once, so the user never lands on a blank area with only spacers. Ordinary scroll events stay coalesced in rAF.
    if (virtualLastStart < 0 || target.start >= virtualLastEnd || target.end <= virtualLastStart) {
      renderVirtualRows(false);
      return;
    }
    scheduleVirtualRender();
  }

  function ensureVirtualScrollListener() {
    if (virtualScrollAttached) return;
    virtualScrollAttached = true;
    // The Query page scrolls inside #queryWorkspace. The Explorer scrolls inside its detail pane.
    // A scroll event does not bubble. So the listener uses the capture phase to find the real scroll owner.
    document.addEventListener("scroll", handleVirtualScroll, { passive: true, capture: true });
    window.addEventListener("resize", scheduleVirtualRender, { passive: true });
  }

  function renderVirtualRows(force) {
    if (!isVirtualResults || isVerticalResults || !tbody) return;

    const rows = Array.isArray(virtualViewRows) ? virtualViewRows : [];
    const rowH = Math.max(18, Number(virtualRowHeight) || virtualDefaultRowHeight);
    const { start, end } = getVirtualRange(rows.length, rowH, tbody);

    if (!force && start === virtualLastStart && end === virtualLastEnd) return;
    virtualLastStart = start;
    virtualLastEnd = end;

    const frag = document.createDocumentFragment();
    const extra = rowDetailsSpacerExtra(rowDetailsVirtualSlot(tbody), start, end);

    if (start > 0) frag.appendChild(createVirtualSpacerRow(start * rowH + extra.top));

    for (let i = start; i < end; i++) {
      const tr = document.createElement("tr");
      appendLiveRowCells(tr, rows[i]);
      frag.appendChild(tr);
    }

    if (end < rows.length) frag.appendChild(createVirtualSpacerRow((rows.length - end) * rowH + extra.bottom));

    replaceVirtualBodyRows(tbody, frag);
    refreshRowDetailsAfterRender(tbody);

    const firstRow = $("tr:not(.resultTable__spacerRow):not(.resultTable__detailRow)", tbody);
    if (firstRow) {
      const h = firstRow.getBoundingClientRect().height;
      if (Number.isFinite(h) && h >= 22 && h <= 72 && Math.abs(h - rowH) > 0.05) {
        virtualRowHeight = h;
        virtualLastStart = -1;
        virtualLastEnd = -1;
        scheduleVirtualRender();
      }
    }
  }

  // Returns true when the mounted virtual window still matches the grown row set. This applies after the bottom spacer is resized, created, or removed.
  function updateVirtualTailSpacer() {
    if (!tbody || virtualLastStart < 0 || isVerticalResults) return false;
    const rows = virtualViewRows;
    const rowH = Math.max(18, Number(virtualRowHeight) || virtualDefaultRowHeight);
    const { start, end } = getVirtualRange(rows.length, rowH, tbody);
    if (start !== virtualLastStart || end !== virtualLastEnd) return false;
    const last = tbody.lastElementChild;
    const hasBottomSpacer = !!last && last.classList.contains("resultTable__spacerRow")
      && !(start > 0 && last === tbody.firstElementChild);
    if (end >= rows.length) {
      if (hasBottomSpacer) last.remove();
      return true;
    }
    const extra = rowDetailsSpacerExtra(rowDetailsVirtualSlot(tbody), start, end);
    const tailHeight = (rows.length - end) * rowH + extra.bottom;
    if (hasBottomSpacer && last.firstElementChild) {
      last.firstElementChild.style.height = `${Math.max(0, Math.round(tailHeight))}px`;
    } else {
      tbody.appendChild(createVirtualSpacerRow(tailHeight));
    }
    return true;
  }

  function renderLiveTableFull({ allowTailOnly = false } = {}) {
    if (isVerticalResults) return;
    if (!tbody) return;

    pendingRows.length = 0;
    scheduledFlush = false;
    if (flushRafId) {
      cancelAnimationFrame(flushRafId);
      flushRafId = 0;
    }

    const rows = buildLiveViewRows();

    if (rows.length > virtualRowThreshold && wrap) {
      // An unsorted stream only appends to allResultRows. When the mounted window is unchanged, a larger bottom spacer is enough.
      // A rebuild of every mounted row (hundreds of rows times columns) on each SSE batch was the main cost of large result streams.
      const appendOnly = allowTailOnly && isVirtualResults && rows === allResultRows && virtualViewRows === allResultRows;
      if (appendOnly && updateVirtualTailSpacer()) return;
      isVirtualResults = true;
      virtualViewRows = rows;
      virtualLastStart = -1;
      virtualLastEnd = -1;
      wrap.classList.add("tableWrap--virtual");
      ensureVirtualScrollListener();
      renderVirtualRows(true);
      return;
    }

    isVirtualResults = false;
    virtualViewRows = [];
    virtualLastStart = -1;
    virtualLastEnd = -1;
    if (wrap) wrap.classList.remove("tableWrap--virtual");

    tbody.replaceChildren();

    const token = ++fullRenderToken;

    const renderBatch = (offset) => {
      if (token !== fullRenderToken) return;
      const frag = document.createDocumentFragment();
      const end = Math.min(rows.length, offset + flushBatchSize);
      for (let i = offset; i < end; i++) {
        const tr = document.createElement("tr");
        appendLiveRowCells(tr, rows[i]);
        frag.appendChild(tr);
      }
      tbody.appendChild(frag);
      if (end < rows.length) requestAnimationFrame(() => renderBatch(end));
      else refreshRowDetailsAfterRender(tbody);
    };

    renderBatch(0);
  }

  // The appendOnly callers only add rows at the end of an unsorted stream. Any other caller in the same frame forces a full rebuild.
  function scheduleLiveTableFullRender({ appendOnly = false } = {}) {
    if (!appendOnly) scheduledFullRenderRebuild = true;
    if (scheduledFullRender) return;
    scheduledFullRender = true;
    fullRenderRafId = requestAnimationFrame(() => {
      const rebuild = scheduledFullRenderRebuild;
      scheduledFullRender = false;
      scheduledFullRenderRebuild = false;
      fullRenderRafId = 0;
      renderLiveTableFull({ allowTailOnly: !rebuild });
    });
  }

  function setLiveSort(key) {
    if (isVerticalResults) return;
    const nextDir = nextLiveSortDir(key);
    sortKey = nextDir ? key : null;
    sortDir = nextDir || "";
    updateLiveSortIndicators();
    renderLiveTableFull();
  }

  function renderHorizontalHeader() {
    if (!thead) return;
    thead.replaceChildren();
    const tr = document.createElement("tr");

    const thIndex = document.createElement("th");
    thIndex.textContent = "#";
    thIndex.className = "dataTable__rowNum";
    tableMod.sortHeader(thIndex, { key: -1, onSort: () => setLiveSort(-1), title: "Sort by row number" });
    tr.appendChild(thIndex);

    for (let i = 0; i < resultColumns.length; i++) {
      const th = document.createElement("th");
      th.textContent = resultColumns[i];
      if (resultTypes[i]) th.title = resultTypes[i];
      // The header of a number sits over its figures, on the right (the cells are .num).
      if (isScalarNumericType(resultTypeAsts[i] || null)) th.classList.add("num");
      tableMod.sortHeader(th, { key: i, onSort: () => setLiveSort(i) });
      tr.appendChild(th);
    }
    thead.appendChild(tr);
    updateLiveSortIndicators();
  }

  function commitHorizontalPresentation() {
    if (livePresentationCommitted) return;
    livePresentationCommitted = true;
    resetTableMode();
    renderHorizontalHeader();
    host.visible?.();
    if (allResultRows.length) {
      pendingRows = allResultRows.slice();
      if (allResultRows.length > virtualRowThreshold) scheduleLiveTableFullRender();
      else scheduleFlush();
    }
    host.rendered?.();
  }

  function renderTableMeta(columns, types) {
    liveRowIngest.reset();
    if (wrap) wrap.hidden = false;
    resultTupleFlattenPlan = createTupleFlattenPlan(columns, types);
    resultColumns = resultTupleFlattenPlan.columns;
    resultTypes = resultTupleFlattenPlan.types;
    resultTypeAsts = resultTypes.map(parseChType);
    resetLiveGaugeState();

    resetTableMode();
    livePresentationCommitted = false;
    host.metaChanged?.();
    clearTable();

    rowIndexCounter = 0;
    sortKey = null;
    sortDir = "";
    scheduledFullRender = false;
    fullRenderToken++;
    if (fullRenderRafId) {
      cancelAnimationFrame(fullRenderRafId);
      fullRenderRafId = 0;
    }
    isVirtualResults = false;
    virtualViewRows = [];
    virtualRowHeight = virtualDefaultRowHeight;
    virtualLastStart = -1;
    virtualLastEnd = -1;
    if (virtualScrollRafId) {
      cancelAnimationFrame(virtualScrollRafId);
      virtualScrollRafId = 0;
    }
    if (wrap) wrap.classList.remove("tableWrap--virtual");
    if (chart) chart.setMeta(resultColumns, resultTypes);
    // Do not show the headers yet on purpose. The layout needs either two rows (horizontal),
    // or the terminal event (0 rows, or one row in vertical layout).
  }

  function scheduleFlush() {
    if (scheduledFlush) return;
    scheduledFlush = true;
    flushRafId = requestAnimationFrame(flushPendingRows);
  }

  function flushPendingRows() {
    scheduledFlush = false;
    if (isVerticalResults) {
      pendingRows.length = 0;
      return;
    }

    if (isLiveSortActive()) {
      pendingRows.length = 0;
      return;
    }

    if (pendingRows.length === 0) return;
    if (!tbody) return;

    if (isVirtualResults || allResultRows.length > virtualRowThreshold) {
      pendingRows.length = 0;
      scheduleLiveTableFullRender();
      return;
    }

    const frag = document.createDocumentFragment();
    const toRender = Math.min(flushBatchSize, pendingRows.length);
    // One splice is O(n). Repeated head shifts are O(n²) for large result streams, because each row moves the rest of the array.
    const rowsToRender = pendingRows.splice(0, toRender);

    for (const row of rowsToRender) {
      const tr = document.createElement("tr");
      appendLiveRowCells(tr, row);
      frag.appendChild(tr);
    }

    tbody.appendChild(frag);
    if (pendingRows.length > 0) scheduleFlush();
    host.rendered?.();
  }

  function appendRows(rowsChunk) {
    liveRowIngest.enqueue(rowsChunk);
  }

  function appendRowsImmediate(rowsChunk) {
    if (!Array.isArray(rowsChunk) || rowsChunk.length === 0) return;

    let needsFullRender = isLiveSortActive() || isVirtualResults;
    for (const sourceRow of rowsChunk) {
      if (!Array.isArray(sourceRow)) continue;
      rowIndexCounter++;
      const row = flattenTupleRow(sourceRow, resultTupleFlattenPlan);
      row.__chdashRowIndex = rowIndexCounter;
      updateLiveGaugeMaximaFromRow(row);
      allResultRows.push(row);

      if (livePresentationCommitted) {
        if (!needsFullRender && allResultRows.length <= virtualRowThreshold) pendingRows.push(row);
        else needsFullRender = true;
      }
    }
    if (chart) chart.rowsChanged();

    if (!livePresentationCommitted && allResultRows.length >= 2) {
      commitHorizontalPresentation();
      host.rowsChanged?.();
      return;
    }

    if (!livePresentationCommitted) {
      // Keep the first row in memory until the module knows whether it is the only row.
      host.rowsChanged?.();
      return;
    }

    // Schedule at most one DOM update for each SSE batch. Earlier versions called the scheduler once for each row of a large batch.
    // This created work on the main thread that was not needed.
    if (needsFullRender) {
      pendingRows.length = 0;
      scheduleLiveTableFullRender({ appendOnly: !isLiveSortActive() });
    } else if (pendingRows.length > 0) {
      scheduleFlush();
    }

    host.visible?.();
    host.rowsChanged?.();
    host.rendered?.();
  }

  function renderVerticalSingleRow(row) {
    if (!thead || !tbody) return;

    isVerticalResults = true;
    pendingRows.length = 0;
    scheduledFullRender = false;
    fullRenderToken++;
    if (fullRenderRafId) {
      cancelAnimationFrame(fullRenderRafId);
      fullRenderRafId = 0;
    }
    scheduledFlush = false;
    if (flushRafId) {
      cancelAnimationFrame(flushRafId);
      flushRafId = 0;
    }

    if (table) table.classList.add("resultTable--vertical");

    const headRow = document.createElement("tr");
    const th1 = document.createElement("th");
    th1.textContent = "Column";
    const th2 = document.createElement("th");
    th2.textContent = "Value";
    headRow.appendChild(th1);
    headRow.appendChild(th2);

    thead.replaceChildren();
    thead.appendChild(headRow);

    tbody.replaceChildren();
    const frag = document.createDocumentFragment();

    for (let i = 0; i < resultColumns.length; i++) {
      const tr = document.createElement("tr");

      const th = document.createElement("th");
      const colName = String(resultColumns[i] ?? "");
      th.textContent = colName;
      th.title = colName;

      const td = document.createElement("td");
      setVerticalValueCell(td, Array.isArray(row) ? row[i] : null, i);

      tr.appendChild(th);
      tr.appendChild(td);
      frag.appendChild(tr);
    }

    tbody.appendChild(frag);
  }

  function maybeSwitchToVerticalSingleRow() {
    if (isVerticalResults) return;
    if (!Array.isArray(resultColumns) || resultColumns.length < 2) return;
    if (!Array.isArray(allResultRows) || allResultRows.length !== 1) return;
    renderVerticalSingleRow(allResultRows[0]);
  }

  function simplifySingleValueTable() {
    if (!thead || !tbody) return null;

    // One value needs no column title above it: the table keeps the name for assistive technology only.
    const colName = String((Array.isArray(resultColumns) && resultColumns[0]) ?? "");
    thead.replaceChildren();
    const tableEl = thead.closest("table");
    if (tableEl) {
      tableEl.setAttribute("aria-label", resultTypes[0] ? `${colName} (${resultTypes[0]})` : colName);
      tableEl.classList.add("resultTable--single");
    }

    let tr = $("tr", tbody);
    if (!tr) {
      tr = document.createElement("tr");
      tbody.appendChild(tr);
    }

    let td = $("td:not(.dataTable__rowNum)", tr);
    if (!td) td = document.createElement("td");

    tr.replaceChildren();
    tr.appendChild(td);
    return td;
  }

  function maybeRenderSingleRowValueCell() {
    if (isVerticalResults) return;
    if (!Array.isArray(resultColumns) || resultColumns.length !== 1) return;
    if (!Array.isArray(allResultRows) || allResultRows.length !== 1) return;
    if (!tbody) return;

    const row = allResultRows[0];
    const raw = Array.isArray(row) ? row[0] : row;

    if (scheduledFlush || pendingRows.length) flushPendingRows();

    const apply = () => {
      const cell = simplifySingleValueTable();
      if (!cell) return;
      renderSingleValueCell(cell, raw, 0, resultTypeAsts);
    };

    const td = $("tr td:not(.dataTable__rowNum)", tbody);
    if (!td) {
      requestAnimationFrame(() => apply());
      return;
    }
    apply();
  }

  function finalizeAfterDone() {
    return liveRowIngest.whenIdle().then(() => finalizeAfterDoneImmediate());
  }

  function finalizeAfterDoneImmediate() {
    if (!livePresentationCommitted) {
      if (allResultRows.length === 1) {
        livePresentationCommitted = true;
        host.visible?.();
        if (resultColumns.length === 1) {
          resetTableMode();
          const td = simplifySingleValueTable();
          const row = allResultRows[0];
          if (td) renderSingleValueCell(td, Array.isArray(row) ? row[0] : row, 0, resultTypeAsts);
        } else {
          renderVerticalSingleRow(allResultRows[0]);
        }
      } else {
        // A zero-row result can finally show its schema. Two or more rows is a defensive fallback for a terminal batch that skipped the live threshold.
        commitHorizontalPresentation();
      }
    }
    if (scheduledFlush || pendingRows.length) flushPendingRows();

    if (!liveGaugesEnabled) liveGaugesEnabled = true;
    const hasGaugeCols = allResultRows.length > 1 && Array.isArray(gaugeNumericCols) && gaugeNumericCols.some(Boolean);
    const needFinalGaugeRender = !isVerticalResults && hasGaugeCols && allResultRows.length > 0 && !liveGaugesPainted;

    if (!isVerticalResults && (isLiveSortActive() || gaugeDirty || numericDirty || needFinalGaugeRender)) {
      renderLiveTableFull();
      gaugeDirty = false;
      numericDirty = false;
      if (liveGaugesEnabled && hasGaugeCols) liveGaugesPainted = true;
    }
    maybeSwitchToVerticalSingleRow();
    maybeRenderSingleRowValueCell();
    if (chart) chart.done();
    // A result long enough for the sort kernel requests the kernel now. So its first sort does not run in JavaScript.
    if (allResultRows.length >= SORT_WASM_MIN_ROWS) requestSortKernel();
  }

  // Reset to nothing: remove the rows, the layout, the sort, the bars, and the table.
  function clear() {
    liveRowIngest.reset();
    resultColumns = [];
    resultTypes = [];
    resultTypeAsts = [];
    resultTupleFlattenPlan = null;
    gaugeNumericCols = [];
    gaugeMax = [];
    gaugeMin = [];
    gaugeDirty = false;
    numericMaxScale = [];
    numericDirty = false;
    liveGaugesEnabled = false;
    liveGaugesPainted = false;
    pendingRows = [];
    allResultRows = [];
    rowIndexCounter = 0;
    sortKey = null;
    sortDir = "";
    scheduledFullRender = false;
    fullRenderToken++;
    if (fullRenderRafId) {
      cancelAnimationFrame(fullRenderRafId);
      fullRenderRafId = 0;
    }
    isVirtualResults = false;
    virtualViewRows = [];
    virtualRowHeight = virtualDefaultRowHeight;
    virtualLastStart = -1;
    virtualLastEnd = -1;
    if (virtualScrollRafId) {
      cancelAnimationFrame(virtualScrollRafId);
      virtualScrollRafId = 0;
    }
    wrap.classList.remove("tableWrap--virtual");
    scheduledFlush = false;
    if (flushRafId) {
      cancelAnimationFrame(flushRafId);
      flushRafId = 0;
    }
    resetTableMode();
    livePresentationCommitted = false;
    clearTable();
  }

  // This removes the listeners that a long result added to the document and the window. It also stops the timers and the queue.
  function destroy() {
    liveRowIngest.reset();
    if (virtualScrollAttached) {
      document.removeEventListener("scroll", handleVirtualScroll, { capture: true });
      window.removeEventListener("resize", scheduleVirtualRender);
      virtualScrollAttached = false;
    }
    for (const id of [virtualScrollRafId, fullRenderRafId, flushRafId]) if (id) cancelAnimationFrame(id);
    virtualScrollRafId = 0;
    fullRenderRafId = 0;
    flushRafId = 0;
    fullRenderToken++;
  }

  registerRowDetailsSource(table, () => ({
    columns: resultColumns,
    types: resultTypes,
    typeAsts: resultTypeAsts,
  }), {
    rowCount: () => (isVerticalResults ? 1 : allResultRows.length),
    allRows: () => allResultRows,
    viewRows: () => (isVirtualResults && !isVerticalResults ? virtualViewRows : null),
    relayout: () => { if (isVirtualResults && !isVerticalResults) renderVirtualRows(true); },
  });

  return {
    renderTableMeta,
    appendRows,
    whenIdle: () => liveRowIngest.whenIdle(),
    finalize: finalizeAfterDoneImmediate,
    clear,
    destroy,
    rowCount: () => allResultRows.length,
    columnCount: () => resultColumns.length,
    columns: () => resultColumns,
    types: () => resultTypes,
    typeAsts: () => resultTypeAsts,
    rows: () => allResultRows,
    // The Table / Chart toggle of the result. The chart reads the rows and the columns of this table.
    setChart(next) { chart = next; },
    // The table is shown again after the Chart view hid it. The mounted rows are drawn again.
    relayout() { if (isVirtualResults && !isVerticalResults) renderVirtualRows(true); },
  };
}

export { createLiveTable };
