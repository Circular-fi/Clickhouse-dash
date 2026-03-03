(() => {
  "use strict";

  const ns = window.ChDash;
  if (!ns) return;

  const { dom, util } = ns;

  let resultsStackElement = null;

  let resultColumns = [];
  let resultTypes = [];
  let resultTypeAsts = [];
  let pendingRows = [];
  let allResultRows = [];
  let lastErrorMessage = "";
  let currentStatusValue = "";

  let scheduledFlush = false;
  let flushRafId = 0;
  const flushBatchSize = 400;

  let isVerticalResults = false;

  let rowIndexCounter = 0;
  let sortKey = null;
  let sortDir = "";
  let scheduledFullRender = false;
  let fullRenderRafId = 0;
  let fullRenderToken = 0;

  let gaugeNumericCols = [];
  let gaugeMaxPos = [];
  let gaugeMaxAbs = [];
  let gaugeDirty = false;

  function setResultsVisible(visible) {
    if (!dom.resultsPanel) return;
    dom.resultsPanel.classList.toggle("is-hidden", !visible);
  }

  function getErrorText() {
    return String(lastErrorMessage || "").trim();
  }

  function setError(message) {
    lastErrorMessage = String(message || "").trim();
    if (!dom.errorBanner) return;
    if (lastErrorMessage) {
      dom.errorBanner.hidden = false;
      dom.errorBanner.textContent = lastErrorMessage;
      setResultsVisible(true);
    } else {
      dom.errorBanner.hidden = true;
      dom.errorBanner.textContent = "";
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

  function clearTable() {
    if (dom.resultTableHead) dom.resultTableHead.innerHTML = "";
    if (dom.resultTableBody) dom.resultTableBody.innerHTML = "";
  }

  function resetTableMode() {
    isVerticalResults = false;
    const tableEl = dom.resultTableHead ? dom.resultTableHead.closest("table") : null;
    if (tableEl) tableEl.classList.remove("resultTable--vertical");
  }

  function clearLiveResults() {
    resultColumns = [];
    resultTypes = [];
    resultTypeAsts = [];
    gaugeNumericCols = [];
    gaugeMaxPos = [];
    gaugeMaxAbs = [];
    gaugeDirty = false;
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
    currentStatusValue = "";
    lastErrorMessage = "";

    scheduledFlush = false;
    if (flushRafId) {
      cancelAnimationFrame(flushRafId);
      flushRafId = 0;
    }

    resetTableMode();
    clearTable();

    if (dom.resultColumnsText) util.setText(dom.resultColumnsText, "-");
    setError("");
    updateCopyButtonState();

    if (dom.liveResultsWrap) dom.liveResultsWrap.hidden = false;
    if (resultsStackElement && resultsStackElement.childElementCount > 0) setResultsVisible(true);
    else setResultsVisible(false);
  }

  function ensureResultsStack() {
    if (resultsStackElement || !dom.resultsPanel) return;
    resultsStackElement = document.createElement("div");
    resultsStackElement.className = "resultsStack";
    const header = dom.resultsPanel.querySelector(".panel__header");
    const anchor = header ? header.nextSibling : dom.resultsPanel.firstChild;
    dom.resultsPanel.insertBefore(resultsStackElement, anchor);
  }

  function clearResultsStack() {
    if (!resultsStackElement) return;
    resultsStackElement.remove();
    resultsStackElement = null;
  }

  function removeIds(root) {
    if (!root) return;
    if (root.removeAttribute) root.removeAttribute("id");
    const nodes = root.querySelectorAll("[id]");
    for (const n of nodes) n.removeAttribute("id");
  }

  function safelyParseJson(text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function parseJsonStringIfLikely(v) {
    if (typeof v !== "string") return v;
    const s = v.trim();
    if (!s) return v;
    const first = s[0];
    const last = s[s.length - 1];
    const looks =
      (first === "[" && last === "]") ||
      (first === "{" && last === "}") ||
      (first === "\"" && last === "\"");
    if (!looks) return v;
    const parsed = safelyParseJson(s);
    return parsed === null ? v : parsed;
  }

  const NUMERIC_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

  function coerceNumberLike(v) {
    if (typeof v !== "string") return v;
    const s = v.trim();
    if (!s) return v;
    if (!NUMERIC_RE.test(s)) return v;
    const n = Number(s);
    if (!Number.isFinite(n)) return v;
    const isIntegerLike = /^[+-]?\d+$/.test(s);
    if (isIntegerLike) {
      try {
        const bi = BigInt(s);
        const abs = bi < 0n ? -bi : bi;
        if (abs > BigInt(Number.MAX_SAFE_INTEGER)) return v;
      } catch {
        return v;
      }
    }
    return n;
  }

  function coerceDeep(v) {
    v = parseJsonStringIfLikely(v);
    if (Array.isArray(v)) return v.map(coerceDeep);
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, val] of Object.entries(v)) out[k] = coerceDeep(val);
      return out;
    }
    return coerceNumberLike(v);
  }

  function splitTopLevel(str, sepChar) {
    const out = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth = Math.max(0, depth - 1);
      else if (ch === sepChar && depth === 0) {
        out.push(str.slice(start, i));
        start = i + 1;
      }
    }
    out.push(str.slice(start));
    return out.map((s) => s.trim()).filter((s) => s.length > 0);
  }

  function stripIdentifierQuotes(name) {
    const t = String(name ?? "").trim();
    if (t.length >= 2) {
      const first = t[0];
      const last = t[t.length - 1];
      if ((first === "`" && last === "`") || (first === "\"" && last === "\"")) {
        return t.slice(1, -1);
      }
    }
    return t;
  }

  function parseChType(typeStr) {
    const s = String(typeStr ?? "").trim();
    if (!s) return null;

    const unwrap = (prefix) => {
      if (!s.startsWith(prefix + "(") || !s.endsWith(")")) return null;
      return s.slice(prefix.length + 1, -1).trim();
    };

    const innerNullable = unwrap("Nullable");
    if (innerNullable) return parseChType(innerNullable);

    const innerLc = unwrap("LowCardinality");
    if (innerLc) return parseChType(innerLc);

    const innerArray = unwrap("Array");
    if (innerArray) return { kind: "Array", inner: parseChType(innerArray) };

    const innerMap = unwrap("Map");
    if (innerMap) {
      const parts = splitTopLevel(innerMap, ",");
      return { kind: "Map", key: parseChType(parts[0]), value: parseChType(parts[1]) };
    }

    const innerTuple = unwrap("Tuple");
    if (innerTuple) {
      const parts = splitTopLevel(innerTuple, ",");
      const fields = parts.map((part, idx) => {
        let depth = 0;
        let splitAt = -1;
        for (let i = 0; i < part.length; i++) {
          const ch = part[i];
          if (ch === "(") depth++;
          else if (ch === ")") depth = Math.max(0, depth - 1);
          else if (depth === 0 && /\s/.test(ch)) {
            splitAt = i;
            break;
          }
        }

        if (splitAt > 0) {
          const maybeNameRaw = part.slice(0, splitAt).trim();
          const maybeName = stripIdentifierQuotes(maybeNameRaw);
          const rest = part.slice(splitAt).trim();
          if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(maybeName) && rest) {
            return { name: maybeName, type: parseChType(rest) };
          }
        }
        return { name: `_${idx}`, type: parseChType(part) };
      });
      return { kind: "Tuple", fields };
    }

    return { kind: "Scalar", name: s };
  }

  function coerceDeepTyped(v, typeAst) {
    v = parseJsonStringIfLikely(v);
    if (!typeAst) return coerceDeep(v);

    if (v === null || v === undefined) return v;

    if (typeAst.kind === "Tuple") {
      if (Array.isArray(v)) {
        const out = {};
        const fields = Array.isArray(typeAst.fields) ? typeAst.fields : [];
        for (let i = 0; i < fields.length; i++) {
          const f = fields[i];
          out[String(f.name ?? `_${i}`)] = coerceDeepTyped(v[i], f.type);
        }
        return out;
      }
      if (v && typeof v === "object") {
        const out = {};
        for (const [k, val] of Object.entries(v)) out[k] = coerceDeep(val);
        return out;
      }
      return coerceNumberLike(v);
    }

    if (typeAst.kind === "Array") {
      if (Array.isArray(v)) return v.map((x) => coerceDeepTyped(x, typeAst.inner));
      return coerceDeep(v);
    }

    if (typeAst.kind === "Map") {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const out = {};
        for (const [k, val] of Object.entries(v)) out[k] = coerceDeepTyped(val, typeAst.value);
        return out;
      }
      if (Array.isArray(v)) {
        return v.map((pair) => {
          if (!Array.isArray(pair) || pair.length < 2) return coerceDeep(pair);
          return [coerceDeepTyped(pair[0], typeAst.key), coerceDeepTyped(pair[1], typeAst.value)];
        });
      }
      return coerceDeep(v);
    }

    return coerceNumberLike(v);
  }

  function formatCellForDisplay(raw, colIndex, pretty = false) {
    const typed = coerceDeepTyped(raw, resultTypeAsts[colIndex] || null);
    if (typed === null || typed === undefined) return "";
    if (typeof typed === "string") return typed;
    if (typeof typed === "number" || typeof typed === "boolean") return String(typed);
    return JSON.stringify(typed, null, pretty ? 2 : 0);
  }

  function setResultColumnsText() {
    if (!dom.resultColumnsText) return;
    const n = resultColumns.length || 0;
    util.setText(dom.resultColumnsText, `${n} ${n === 1 ? "column" : "columns"}`);
  }  function extractFiniteNumber(raw) {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
    const s = typeof raw === "string" ? raw.trim() : String(raw).trim();
    if (!s) return null;
    if (s.length > 2 && s[0] === "0" && (s[1] === "x" || s[1] === "X")) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  function computeGaugeScale(n, maxPos, maxAbs) {
    const base = maxPos > 0 ? maxPos : maxAbs;
    if (!(base > 0) || n === null || n === undefined) return 0;
    let ratio = Math.abs(n) / base;
    if (!Number.isFinite(ratio) || ratio <= 0) return 0;
    if (ratio > 1) ratio = 1;
    if (ratio < 0.001) ratio = 0.001;
    return ratio;
  }

  function resetLiveGaugeState() {
    gaugeNumericCols = resultTypeAsts.map(isScalarNumericType);
    gaugeMaxPos = new Array(gaugeNumericCols.length).fill(0);
    gaugeMaxAbs = new Array(gaugeNumericCols.length).fill(0);
    gaugeDirty = false;
  }

  function updateLiveGaugeMaximaFromRow(row) {
    if (!Array.isArray(row) || gaugeNumericCols.length === 0) return;
    let changed = false;
    for (let i = 0; i < gaugeNumericCols.length; i++) {
      if (!gaugeNumericCols[i]) continue;
      const n = extractFiniteNumber(row[i]);
      if (n === null) continue;
      const abs = Math.abs(n);
      if (abs > gaugeMaxAbs[i]) {
        gaugeMaxAbs[i] = abs;
        changed = true;
      }
      if (n > gaugeMaxPos[i]) {
        gaugeMaxPos[i] = n;
        changed = true;
      }
    }
    if (changed) gaugeDirty = true;
  }

  function setGaugeCell(td, raw, colIndex, text, maxPosArr, maxAbsArr) {
    td.classList.add("resultTable__gaugeCell");
    const n = extractFiniteNumber(raw);
    const scale = computeGaugeScale(n, maxPosArr[colIndex] || 0, maxAbsArr[colIndex] || 0);
    const fill = scale > 0 ? String(scale * 100) + "%" : "0%";
    td.style.setProperty("--gaugeFill", fill);
    td.textContent = text;
  }

  function refreshLiveGauges() {
    gaugeDirty = false;
  }



  function isScalarNumericType(typeAst) {
    if (!typeAst || typeAst.kind !== "Scalar") return false;
    const name = String(typeAst.name ?? "");
    if (/^(?:U?Int)(?:8|16|32|64|128|256)$/.test(name)) return true;
    if (/^Float(?:32|64)$/.test(name)) return true;
    if (/^Decimal(?:32|64|128|256)?\(/.test(name)) return true;
    return false;
  }

  function normalizeNumericForSort(raw) {
    if (raw === null || raw === undefined) return { t: "z", v: null };
    if (typeof raw === "number") {
      if (!Number.isFinite(raw)) return { t: "z", v: null };
      return { t: "n", v: raw };
    }
    const s = typeof raw === "string" ? raw.trim() : String(raw).trim();
    if (!s) return { t: "z", v: null };
    if (/^[+-]?\d+$/.test(s)) {
      try {
        return { t: "bi", v: BigInt(s) };
      } catch {
        return { t: "s", v: s.toLowerCase() };
      }
    }
    if (NUMERIC_RE.test(s)) {
      const n = Number(s);
      if (Number.isFinite(n)) return { t: "n", v: n };
    }
    return { t: "s", v: s.toLowerCase() };
  }

  function compareNumericForSort(a, b) {
    const na = normalizeNumericForSort(a);
    const nb = normalizeNumericForSort(b);

    if (na.t === "z" && nb.t === "z") return 0;
    if (na.t === "z") return 1;
    if (nb.t === "z") return -1;

    if (na.t === "bi" && nb.t === "bi") return na.v < nb.v ? -1 : na.v > nb.v ? 1 : 0;

    if (na.t === "n" && nb.t === "n") return na.v < nb.v ? -1 : na.v > nb.v ? 1 : 0;

    if (na.t === "bi" && nb.t === "n") {
      if (Number.isSafeInteger(nb.v)) {
        const bbi = BigInt(nb.v);
        return na.v < bbi ? -1 : na.v > bbi ? 1 : 0;
      }
      const an = Number(na.v);
      if (Number.isFinite(an)) return an < nb.v ? -1 : an > nb.v ? 1 : 0;
    }

    if (na.t === "n" && nb.t === "bi") {
      if (Number.isSafeInteger(na.v)) {
        const abi = BigInt(na.v);
        return abi < nb.v ? -1 : abi > nb.v ? 1 : 0;
      }
      const bn = Number(nb.v);
      if (Number.isFinite(bn)) return na.v < bn ? -1 : na.v > bn ? 1 : 0;
    }

    const sa = na.t === "bi" ? na.v.toString() : String(na.v);
    const sb = nb.t === "bi" ? nb.v.toString() : String(nb.v);

    if (sa.length !== sb.length) return sa.length < sb.length ? -1 : 1;
    if (sa < sb) return -1;
    if (sa > sb) return 1;
    return 0;
  }

  function compareTextForSort(a, b) {
    const sa = String(a ?? "");
    const sb = String(b ?? "");
    const la = sa.toLowerCase();
    const lb = sb.toLowerCase();
    if (la < lb) return -1;
    if (la > lb) return 1;
    if (sa < sb) return -1;
    if (sa > sb) return 1;
    return 0;
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
    if (!dom.resultTableHead) return;
    const ths = dom.resultTableHead.querySelectorAll("th.resultTable__thSortable");
    for (const th of ths) {
      const k = Number(th.dataset.sortKey || "");
      if (sortKey !== null && sortDir && k === sortKey) th.dataset.sort = sortDir;
      else th.removeAttribute("data-sort");
    }
  }

  function buildLiveViewRows() {
    const rows = allResultRows.slice();
    if (!isLiveSortActive()) return rows;
    const key = sortKey;
    const dir = sortDir;
    const mode = getLiveSortMode(key);
    const numeric = mode === "numeric";
    rows.sort((a, b) => {
      const av = key === -1 ? a.__chdashRowIndex : a[key];
      const bv = key === -1 ? b.__chdashRowIndex : b[key];

      let cmp = 0;
      if (numeric) cmp = compareNumericForSort(av, bv);
      else {
        const as = key === -1 ? String(av ?? "") : formatCellForDisplay(av, key, false);
        const bs = key === -1 ? String(bv ?? "") : formatCellForDisplay(bv, key, false);
        cmp = compareTextForSort(as, bs);
      }

      if (cmp === 0) cmp = (a.__chdashRowIndex || 0) - (b.__chdashRowIndex || 0);
      return dir === "desc" ? -cmp : cmp;
    });
    return rows;
  }

  function appendLiveRowCells(tr, row) {
    const tdIndex = document.createElement("td");
    tdIndex.className = "resultTable__rowIndex resultTable__stickyLeft";
    tdIndex.textContent = row && row.__chdashRowIndex ? String(row.__chdashRowIndex) : "";
    tr.appendChild(tdIndex);

    if (Array.isArray(row)) {
      for (let columnIndex = 0; columnIndex < resultColumns.length; columnIndex++) {
        const td = document.createElement("td");
        const text = formatCellForDisplay(row[columnIndex], columnIndex, false);
        if (gaugeNumericCols[columnIndex]) setGaugeCell(td, row[columnIndex], columnIndex, text, gaugeMaxPos, gaugeMaxAbs);
        else td.textContent = text;
        tr.appendChild(td);
      }
      return;
    }

    const td = document.createElement("td");
    td.textContent = String(row ?? "");
    td.colSpan = Math.max(1, resultColumns.length);
    tr.appendChild(td);
  }

  function renderLiveTableFull() {
    if (isVerticalResults) return;
    if (!dom.resultTableBody) return;

    pendingRows.length = 0;
    scheduledFlush = false;
    if (flushRafId) {
      cancelAnimationFrame(flushRafId);
      flushRafId = 0;
    }

    const tbody = dom.resultTableBody;
    tbody.innerHTML = "";

    const rows = buildLiveViewRows();
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
    };

    renderBatch(0);
  }

  function scheduleLiveTableFullRender() {
    if (scheduledFullRender) return;
    scheduledFullRender = true;
    fullRenderRafId = requestAnimationFrame(() => {
      scheduledFullRender = false;
      fullRenderRafId = 0;
      renderLiveTableFull();
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

  function renderTableMeta(columns, types) {
    resultColumns = Array.isArray(columns) ? columns.map((c) => String(c ?? "")) : [];
    resultTypes = Array.isArray(types) ? types.map((t) => String(t ?? "")) : [];
    resultTypeAsts = resultTypes.map(parseChType);
    resetLiveGaugeState();

    resetTableMode();
    setResultColumnsText();
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

    if (!dom.resultTableHead) return;
    const tr = document.createElement("tr");

    const thIndex = document.createElement("th");
    thIndex.textContent = "#";
    thIndex.className = "resultTable__rowIndex resultTable__stickyLeft resultTable__thSortable";
    thIndex.dataset.sortKey = "-1";
    thIndex.addEventListener("click", () => setLiveSort(-1));
    tr.appendChild(thIndex);

    for (let i = 0; i < resultColumns.length; i++) {
      const th = document.createElement("th");
      th.textContent = resultColumns[i];
      if (resultTypes[i]) th.title = resultTypes[i];
      th.classList.add("resultTable__thSortable");
      th.dataset.sortKey = String(i);
      th.addEventListener("click", () => setLiveSort(i));
      tr.appendChild(th);
    }
    dom.resultTableHead.appendChild(tr);
    updateLiveSortIndicators();
    setResultsVisible(true);
  }

  function enqueueRowForRender(row) {
    pendingRows.push(row);
    scheduleFlush();
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
    if (!dom.resultTableBody) return;

    const frag = document.createDocumentFragment();
    const toRender = Math.min(flushBatchSize, pendingRows.length);

    for (let i = 0; i < toRender; i++) {
      const row = pendingRows.shift();
      const tr = document.createElement("tr");
      appendLiveRowCells(tr, row);
      frag.appendChild(tr);
    }

    dom.resultTableBody.appendChild(frag);
    if (pendingRows.length > 0) scheduleFlush();
  }

  function appendRows(rowsChunk) {
    if (!Array.isArray(rowsChunk)) return;
    for (const row of rowsChunk) {
      if (!Array.isArray(row)) continue;
      rowIndexCounter++;
      row.__chdashRowIndex = rowIndexCounter;
      updateLiveGaugeMaximaFromRow(row);
      allResultRows.push(row);
      if (isLiveSortActive()) scheduleLiveTableFullRender();
      else enqueueRowForRender(row);
    }
    setResultsVisible(true);
    updateCopyButtonState();
  }

  function renderVerticalSingleRow(row) {
    if (!dom.resultTableHead || !dom.resultTableBody) return;

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

    const tableEl = dom.resultTableHead.closest("table");
    if (tableEl) tableEl.classList.add("resultTable--vertical");

    const headRow = document.createElement("tr");
    const th1 = document.createElement("th");
    th1.textContent = "Column";
    const th2 = document.createElement("th");
    th2.textContent = "Value";
    headRow.appendChild(th1);
    headRow.appendChild(th2);

    dom.resultTableHead.innerHTML = "";
    dom.resultTableHead.appendChild(headRow);

    dom.resultTableBody.innerHTML = "";
    const frag = document.createDocumentFragment();

    for (let i = 0; i < resultColumns.length; i++) {
      const tr = document.createElement("tr");

      const th = document.createElement("th");
      const colName = String(resultColumns[i] ?? "");
      th.textContent = colName;
      th.title = colName;

      const td = document.createElement("td");
      td.textContent = formatCellForDisplay(Array.isArray(row) ? row[i] : null, i, true);

      tr.appendChild(th);
      tr.appendChild(td);
      frag.appendChild(tr);
    }

    dom.resultTableBody.appendChild(frag);
  }

  function maybeSwitchToVerticalSingleRow() {
    if (isVerticalResults) return;
    if (!Array.isArray(resultColumns) || resultColumns.length < 2) return;
    if (!Array.isArray(allResultRows) || allResultRows.length !== 1) return;
    renderVerticalSingleRow(allResultRows[0]);
  }

  function maybePrettifySingleRowComplexCells() {
    if (isVerticalResults) return;
    if (!Array.isArray(resultColumns) || resultColumns.length !== 1) return;
    if (!Array.isArray(allResultRows) || allResultRows.length !== 1) return;
    if (!dom.resultTableBody) return;

    const row = allResultRows[0];
    const raw = Array.isArray(row) ? row[0] : row;
    const typed = coerceDeepTyped(raw, resultTypeAsts[0] || null);
    if (!typed || typeof typed !== "object") return;

    if (scheduledFlush || pendingRows.length) flushPendingRows();

    const td = dom.resultTableBody.querySelector("tr td:not(.resultTable__rowIndex)");
    if (!td) {
      requestAnimationFrame(() => {
        const td2 = dom.resultTableBody ? dom.resultTableBody.querySelector("tr td:not(.resultTable__rowIndex)") : null;
        if (td2) td2.textContent = formatCellForDisplay(raw, 0, true);
      });
      return;
    }
    td.textContent = formatCellForDisplay(raw, 0, true);
  }

  function finalizeAfterDone() {
    if (scheduledFlush || pendingRows.length) flushPendingRows();
    if (!isVerticalResults && isLiveSortActive()) {
      renderLiveTableFull();
      gaugeDirty = false;
    }
    maybeSwitchToVerticalSingleRow();
    maybePrettifySingleRowComplexCells();
  }

  function buildCopyValue(value) {
    if (value === null || value === undefined) return "";
    const typed = coerceDeepTyped(value, null);
    if (typeof typed === "string") {
      const parsed = safelyParseJson(typed);
      if (parsed && (Array.isArray(parsed) || (parsed && typeof parsed === "object"))) {
        return JSON.stringify(parsed, null, 2);
      }
      return typed;
    }
    if (typeof typed === "number" || typeof typed === "boolean") return String(typed);
    return JSON.stringify(typed, null, 2);
  }

  function rowToObject(row) {
    const obj = {};
    for (let i = 0; i < resultColumns.length; i++) {
      const key = String(resultColumns[i] ?? "");
      const rawVal = Array.isArray(row) ? row[i] : (i === 0 ? row : null);
      obj[key] = coerceDeepTyped(rawVal, resultTypeAsts[i] || null);
    }
    return obj;
  }

  function buildCopyJsonText() {
    const st = String(currentStatusValue || "").toLowerCase();
    const err = String(lastErrorMessage || "").trim();

    if (err && ["error", "canceled", "cancelled"].includes(st)) return err;

    if (allResultRows.length === 1 && resultColumns.length === 1) {
      const row = allResultRows[0];
      const v = Array.isArray(row) ? row[0] : row;
      return buildCopyValue(coerceDeepTyped(v, resultTypeAsts[0] || null));
    }

    if (allResultRows.length === 1) {
      const row = allResultRows[0];
      return JSON.stringify(rowToObject(row), null, 2);
    }

    if (resultColumns.length === 1) {
      const arr = allResultRows.map((r) => {
        const v = Array.isArray(r) ? r[0] : r;
        return coerceDeepTyped(v, resultTypeAsts[0] || null);
      });
      return JSON.stringify(arr, null, 2);
    }

    const objects = allResultRows.map(rowToObject);
    return JSON.stringify(objects, null, 2);
  }

  function updateCopyButtonState() {
    if (!dom.copyJsonButton) return;

    const err = String(lastErrorMessage || "").trim();
    const hasError = err.length > 0;

    const hasRows = Array.isArray(allResultRows) && allResultRows.length > 0;

    const st = String(currentStatusValue || "").toLowerCase();
    const finishedLike = ["finished", "done", "error", "canceled", "cancelled", "result_limit_reached"].includes(st);

    dom.copyJsonButton.disabled = !(hasError || hasRows || finishedLike);
  }

  function getRowCount() {
    return Array.isArray(allResultRows) ? allResultRows.length : 0;
  }

  function getColCount() {
    return Array.isArray(resultColumns) ? resultColumns.length : 0;
  }

  function pushResultsBlock(title, metaText, copyText, { expandedByDefault = false, errorText = "" } = {}) {
    ensureResultsStack();
    if (!resultsStackElement) return;

    const block = document.createElement("div");
    block.className = "resultsStack__block";

    const header = document.createElement("div");
    header.className = "resultsStack__header";

    const t = document.createElement("span");
    t.textContent = title || "Result";
    header.appendChild(t);

    const right = document.createElement("div");
    right.className = "resultsStack__right";

    if (metaText) {
      const m = document.createElement("span");
      m.className = "resultsStack__meta";
      m.textContent = metaText;
      right.appendChild(m);
    }

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "button button--small resultsStack__copy";
    copyBtn.textContent = "Copy JSON";
    right.appendChild(copyBtn);

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "button button--small resultsStack__toggle";
    toggle.textContent = expandedByDefault ? "Hide" : "Show";
    right.appendChild(toggle);

    header.appendChild(right);

    const body = document.createElement("div");
    body.className = "resultsStack__body";
    body.hidden = !expandedByDefault;

    toggle.addEventListener("click", () => {
      body.hidden = !body.hidden;
      toggle.textContent = body.hidden ? "Show" : "Hide";
    });

    copyBtn.addEventListener("click", async () => {
      const text = copyText == null ? "" : String(copyText);
      // Optimistic UI: flash immediately so the user gets feedback even if
      // clipboard permissions cause delays.
      util.flashButtonText(copyBtn, { copiedText: "Copied" });
      try {
        await util.copyTextToClipboard(text);
      } catch {
        // If copy fails, show a brief error then revert.
        util.flashButtonText(copyBtn, { copiedText: "Copy failed", durationMs: 1500 });
      }
    });

    const err = String(errorText || "").trim();
    if (err) {
      const eb = document.createElement("div");
      eb.className = "errorBanner";
      eb.textContent = err;
      body.appendChild(eb);
    }

    const wrap = dom.liveResultsWrap || (dom.resultsPanel ? dom.resultsPanel.querySelector(".tableWrap") : null);
    if (wrap) {
      const clone = wrap.cloneNode(true);
      removeIds(clone);
      body.appendChild(clone);
    }

    block.appendChild(header);
    block.appendChild(body);
    resultsStackElement.appendChild(block);
    setResultsVisible(true);
  }

  function setMultiqueryMode(enabled) {
    if (!dom.resultsPanel) return;
    dom.resultsPanel.classList.toggle("is-multiquery", !!enabled);
    if (dom.copyJsonButton) dom.copyJsonButton.hidden = !!enabled;
    if (dom.copyJsonToast) dom.copyJsonToast.hidden = true;
    if (dom.resultColumnsText) dom.resultColumnsText.hidden = !!enabled;
  }

  function hideLiveWrapIfStackHasBlocks() {
    if (!dom.liveResultsWrap) return;
    const hasBlocks = !!(resultsStackElement && resultsStackElement.childElementCount > 0);
    dom.liveResultsWrap.hidden = hasBlocks;
    if (hasBlocks) {
      if (dom.copyJsonButton) dom.copyJsonButton.hidden = true;
      if (dom.resultColumnsText) dom.resultColumnsText.hidden = true;
    }
    dom.copyJsonButton && (dom.copyJsonButton.disabled = true);
  }

  
  // --- Multiquery streaming panels (Query x/n) ---
  // These helpers let app_run route streaming table meta/rows into a per-query panel,
  // while keeping the single-query live renderer unchanged.

  let activeMultiqueryPanel = null;

  function findTablePartsIn(wrap) {
    if (!wrap) return { thead: null, tbody: null, table: null };
    const table = wrap.querySelector("table");
    const thead = wrap.querySelector("thead");
    const tbody = wrap.querySelector("tbody");
    return { thead, tbody, table };
  }

  function clearTableIn(wrap) {
    const { thead, tbody } = findTablePartsIn(wrap);
    if (thead) thead.innerHTML = "";
    if (tbody) tbody.innerHTML = "";
  }

  function ensureLocalErrorBanner(body) {
    if (!body) return null;
    let el = body.querySelector(".errorBanner");
    if (!el) {
      el = document.createElement("div");
      el.className = "errorBanner";
      el.hidden = true;
      body.insertBefore(el, body.firstChild);
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

    // Collapse previous active panel if requested
    if (autoToggle && activeMultiqueryPanel) {
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

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "button button--small resultsStack__copy";
    copyBtn.textContent = "Copy JSON";
    right.appendChild(copyBtn);

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
      setBlockExpandedLocal(blockObj, expanded);
    });

    // Clone the live tableWrap template so structure/classes match 1:1.
    const wrap = dom.liveResultsWrap || (dom.resultsPanel ? dom.resultsPanel.querySelector(".tableWrap") : null);
    let wrapClone = null;
    if (wrap) {
      wrapClone = wrap.cloneNode(true);
      removeIds(wrapClone);
      body.appendChild(wrapClone);
    }

    block.appendChild(header);
    block.appendChild(body);
    resultsStackElement.appendChild(block);
    setResultsVisible(true);

    // local state for copy/meta
    const local = {
      columns: [],
      types: [],
      typeAsts: [],
      allRows: [],
      rowIndexCounter: 0,
      sortKey: null,
      sortDir: "",
      errorText: "",
      wrap: wrapClone,
      errorBanner: ensureLocalErrorBanner(body),
      gaugeNumericCols: [],
      gaugeMaxPos: [],
      gaugeMaxAbs: [],
      gaugeDirty: false,
    };

    function updateMetaText() {
      const r = local.allRows.length;
      const c = local.columns.length;
      metaSpan.textContent = c ? `${r} row${r === 1 ? "" : "s"} ${c} column${c === 1 ? "" : "s"}` : `${r} row${r === 1 ? "" : "s"}`;
    }

    // Allow the runner to override the meta text at the end (e.g., include status/elapsed/cpu).
    function setMetaTextLocal(text) {
      metaSpan.textContent = String(text ?? "");
    }    function resetLocalGaugeState() {
      local.gaugeNumericCols = local.typeAsts.map(isScalarNumericType);
      local.gaugeMaxPos = new Array(local.gaugeNumericCols.length).fill(0);
      local.gaugeMaxAbs = new Array(local.gaugeNumericCols.length).fill(0);
      local.gaugeDirty = false;
    }

    function updateLocalGaugeMaximaFromRow(row) {
      if (!Array.isArray(row) || local.gaugeNumericCols.length === 0) return;
      let changed = false;
      for (let i = 0; i < local.gaugeNumericCols.length; i++) {
        if (!local.gaugeNumericCols[i]) continue;
        const n = extractFiniteNumber(row[i]);
        if (n === null) continue;
        const abs = Math.abs(n);
        if (abs > local.gaugeMaxAbs[i]) {
          local.gaugeMaxAbs[i] = abs;
          changed = true;
        }
        if (n > local.gaugeMaxPos[i]) {
          local.gaugeMaxPos[i] = n;
          changed = true;
        }
      }
      if (changed) local.gaugeDirty = true;
    }

    function refreshLocalGauges() {
        local.gaugeDirty = false;
      }



    let localScheduledFullRender = false;
    let localFullRenderRafId = 0;
    let localFullRenderToken = 0;

    function isLocalSortActive() {
      return local.sortKey !== null && !!local.sortDir;
    }

    function getLocalSortMode(key) {
      if (key === -1) return "numeric";
      return isScalarNumericType(local.typeAsts[key] || null) ? "numeric" : "text";
    }

    function nextLocalSortDir(key) {
      const mode = getLocalSortMode(key);
      if (local.sortKey !== key) return mode === "numeric" ? "desc" : "asc";
      if (mode === "numeric") {
        if (local.sortDir === "desc") return "asc";
        if (local.sortDir === "asc") return "";
        return "desc";
      }
      if (local.sortDir === "asc") return "desc";
      if (local.sortDir === "desc") return "";
      return "asc";
    }

    function updateLocalSortIndicators() {
      if (!local.wrap) return;
      const ths = local.wrap.querySelectorAll("thead th.resultTable__thSortable");
      for (const th of ths) {
        const k = Number(th.dataset.sortKey || "");
        if (local.sortKey !== null && local.sortDir && k === local.sortKey) th.dataset.sort = local.sortDir;
        else th.removeAttribute("data-sort");
      }
    }

    function buildLocalViewRows() {
      const rows = local.allRows.slice();
      if (!isLocalSortActive()) return rows;
      const key = local.sortKey;
      const dir = local.sortDir;
      const mode = getLocalSortMode(key);
      const numeric = mode === "numeric";
      rows.sort((a, b) => {
        const av = key === -1 ? a.__chdashRowIndex : a[key];
        const bv = key === -1 ? b.__chdashRowIndex : b[key];

        let cmp = 0;
        if (numeric) cmp = compareNumericForSort(av, bv);
        else cmp = compareTextForSort(String(av ?? ""), String(bv ?? ""));

        if (cmp === 0) cmp = (a.__chdashRowIndex || 0) - (b.__chdashRowIndex || 0);
        return dir === "desc" ? -cmp : cmp;
      });
      return rows;
    }

    function appendLocalRowCells(tr, row) {
      const tdIndex = document.createElement("td");
      tdIndex.className = "resultTable__rowIndex resultTable__stickyLeft";
      tdIndex.textContent = row && row.__chdashRowIndex ? String(row.__chdashRowIndex) : "";
      tr.appendChild(tdIndex);

      if (Array.isArray(row)) {
        for (let i = 0; i < local.columns.length; i++) {
          const td = document.createElement("td");
          const text = row[i] == null ? "" : String(row[i]);
          if (local.gaugeNumericCols[i]) setGaugeCell(td, row[i], i, text, local.gaugeMaxPos, local.gaugeMaxAbs);
          else td.textContent = text;
          tr.appendChild(td);
        }
        return;
      }

      const td = document.createElement("td");
      td.textContent = row == null ? "" : String(row);
      td.colSpan = Math.max(1, local.columns.length);
      tr.appendChild(td);
    }

    function renderLocalTableFull() {
      if (!local.wrap) return;
      const { tbody } = findTablePartsIn(local.wrap);
      if (!tbody) return;

      tbody.innerHTML = "";
      const rows = buildLocalViewRows();
      const token = ++localFullRenderToken;

      const renderBatch = (offset) => {
        if (token !== localFullRenderToken) return;
        const frag = document.createDocumentFragment();
        const end = Math.min(rows.length, offset + flushBatchSize);
        for (let i = offset; i < end; i++) {
          const tr = document.createElement("tr");
          appendLocalRowCells(tr, rows[i]);
          frag.appendChild(tr);
        }
        tbody.appendChild(frag);
        if (end < rows.length) requestAnimationFrame(() => renderBatch(end));
      };

      renderBatch(0);
    }

    function scheduleLocalTableFullRender() {
      if (localScheduledFullRender) return;
      localScheduledFullRender = true;
      localFullRenderRafId = requestAnimationFrame(() => {
        localScheduledFullRender = false;
        localFullRenderRafId = 0;
        renderLocalTableFull();
      });
    }

    function setLocalSort(key) {
      const nextDir = nextLocalSortDir(key);
      local.sortKey = nextDir ? key : null;
      local.sortDir = nextDir || "";
      updateLocalSortIndicators();
      renderLocalTableFull();
    }


    function renderTableMetaLocal(columns, types) {
      local.columns = Array.isArray(columns) ? columns.map((c) => String(c ?? "")) : [];
      local.types = Array.isArray(types) ? types.map((t) => String(t ?? "")) : [];
      local.typeAsts = local.types.map(parseChType);
      resetLocalGaugeState();
      local.allRows.length = 0;
      local.rowIndexCounter = 0;
      local.sortKey = null;
      local.sortDir = "";
      localScheduledFullRender = false;
      localFullRenderToken++;
      if (localFullRenderRafId) {
        cancelAnimationFrame(localFullRenderRafId);
        localFullRenderRafId = 0;
      }
      if (!local.wrap) return;
      resetTableMode();
      clearTableIn(local.wrap);
      const { thead } = findTablePartsIn(local.wrap);
      if (!thead) return;
      const tr = document.createElement("tr");

      const thIndex = document.createElement("th");
      thIndex.textContent = "#";
      thIndex.className = "resultTable__rowIndex resultTable__stickyLeft resultTable__thSortable";
      thIndex.dataset.sortKey = "-1";
      thIndex.addEventListener("click", () => setLocalSort(-1));
      tr.appendChild(thIndex);

      for (let i = 0; i < local.columns.length; i++) {
        const th = document.createElement("th");
        th.textContent = local.columns[i];
        if (local.types[i]) th.title = local.types[i];
        th.classList.add("resultTable__thSortable");
        th.dataset.sortKey = String(i);
        th.addEventListener("click", () => setLocalSort(i));
        tr.appendChild(th);
      }
      thead.appendChild(tr);
      updateLocalSortIndicators();
      updateMetaText();
    }

    function appendRowsLocal(rowsChunk) {
      if (!Array.isArray(rowsChunk)) return;
      if (!local.wrap) {
        for (const row of rowsChunk) {
          local.rowIndexCounter++;
          if (row && typeof row === "object") row.__chdashRowIndex = local.rowIndexCounter;
          updateLocalGaugeMaximaFromRow(row);
          local.allRows.push(row);
        }
        updateMetaText();
        return;
      }
      const { tbody } = findTablePartsIn(local.wrap);
      if (!tbody) return;

      const shouldFullRender = isLocalSortActive();

      const frag = shouldFullRender ? null : document.createDocumentFragment();

      for (const row of rowsChunk) {
        local.rowIndexCounter++;
        if (row && typeof row === "object") row.__chdashRowIndex = local.rowIndexCounter;
        updateLocalGaugeMaximaFromRow(row);
        local.allRows.push(row);

        if (shouldFullRender) continue;

        const tr = document.createElement("tr");
        appendLocalRowCells(tr, row);
        frag.appendChild(tr);
      }

      if (shouldFullRender) scheduleLocalTableFullRender();
      else tbody.appendChild(frag);

      updateMetaText();
    }

    function buildCopyJsonTextLocal() {
      // Keep same behavior as live: rows are array-of-arrays; we stringify that.
      return JSON.stringify(local.allRows, null, 2);
    }

    function setErrorLocal(message) {
      local.errorText = String(message || "").trim();
      if (!local.errorBanner) return;
      if (local.errorText) {
        local.errorBanner.hidden = false;
        local.errorBanner.textContent = local.errorText;
      } else {
        local.errorBanner.hidden = true;
        local.errorBanner.textContent = "";
      }
    }

    copyBtn.addEventListener("click", async () => {
      const text = buildCopyJsonTextLocal();
      // Optimistic UI feedback.
      util.flashButtonText(copyBtn, { copiedText: "Copied" });
      try {
        await util.copyTextToClipboard(text);
      } catch {
        util.flashButtonText(copyBtn, { copiedText: "Copy failed", durationMs: 1500 });
      }
    });

    // Mark as active and expanded
    activeMultiqueryPanel = blockObj;
    if (autoToggle) setBlockExpandedLocal(blockObj, true);

    return {
      renderTableMeta: renderTableMetaLocal,
      appendRows: appendRowsLocal,
      clearLiveResults: () => clearTableIn(local.wrap),
      getRowCount: () => local.allRows.length,
      getColumnCount: () => local.columns.length,
      buildCopyJsonText: buildCopyJsonTextLocal,
      setError: setErrorLocal,
      getErrorText: () => local.errorText,
      takeErrorText: () => { const t = local.errorText; local.errorText = ""; setErrorLocal(""); return t; },
      setMetaText: setMetaTextLocal,
      setExpanded: (expanded) => setBlockExpandedLocal(blockObj, !!expanded),
      finalize: ({ expandedByDefault = false } = {}) => {
        if (local.wrap && local.gaugeDirty) {
          if (isLocalSortActive()) renderLocalTableFull();
          local.gaugeDirty = false;
        }
        if (autoToggle) setBlockExpandedLocal(blockObj, !!expandedByDefault);
      },
    };
  }

  function endMultiqueryPanel(sink, { expandedByDefault = false, metaText = null } = {}) {
    if (sink && typeof sink.setMetaText === "function" && metaText != null) sink.setMetaText(metaText);
    if (sink && typeof sink.finalize === "function") sink.finalize({ expandedByDefault });
  }

ns.results = { beginMultiqueryPanel, endMultiqueryPanel,
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
    getRowCount,
    getColCount,
    pushResultsBlock,
    setMultiqueryMode,
    hideLiveWrapIfStackHasBlocks,
    ensureResultsStack,
    setResultsVisible,
  };
})();
