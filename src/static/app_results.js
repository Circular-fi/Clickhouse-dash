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
    pendingRows = [];
    allResultRows = [];
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
  }

  function renderTableMeta(columns, types) {
    resultColumns = Array.isArray(columns) ? columns.map((c) => String(c ?? "")) : [];
    resultTypes = Array.isArray(types) ? types.map((t) => String(t ?? "")) : [];
    resultTypeAsts = resultTypes.map(parseChType);

    resetTableMode();
    setResultColumnsText();
    clearTable();

    if (!dom.resultTableHead) return;
    const tr = document.createElement("tr");
    for (let i = 0; i < resultColumns.length; i++) {
      const th = document.createElement("th");
      th.textContent = resultColumns[i];
      if (resultTypes[i]) th.title = resultTypes[i];
      tr.appendChild(th);
    }
    dom.resultTableHead.appendChild(tr);
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

    if (pendingRows.length === 0) return;
    if (!dom.resultTableBody) return;

    const frag = document.createDocumentFragment();
    const toRender = Math.min(flushBatchSize, pendingRows.length);

    for (let i = 0; i < toRender; i++) {
      const row = pendingRows.shift();
      const tr = document.createElement("tr");

      if (Array.isArray(row)) {
        for (let columnIndex = 0; columnIndex < resultColumns.length; columnIndex++) {
          const td = document.createElement("td");
          td.textContent = formatCellForDisplay(row[columnIndex], columnIndex, false);
          tr.appendChild(td);
        }
      } else {
        const td = document.createElement("td");
        td.textContent = String(row);
        tr.appendChild(td);
      }

      frag.appendChild(tr);
    }

    dom.resultTableBody.appendChild(frag);
    if (pendingRows.length > 0) scheduleFlush();
  }

  function appendRows(rowsChunk) {
    if (!Array.isArray(rowsChunk)) return;
    for (const row of rowsChunk) {
      if (!Array.isArray(row)) continue;
      allResultRows.push(row);
      enqueueRowForRender(row);
    }
    setResultsVisible(true);
    updateCopyButtonState();
  }

  function renderVerticalSingleRow(row) {
    if (!dom.resultTableHead || !dom.resultTableBody) return;

    isVerticalResults = true;
    pendingRows.length = 0;
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

    const td = dom.resultTableBody.querySelector("tr td");
    if (!td) {
      requestAnimationFrame(() => {
        const td2 = dom.resultTableBody ? dom.resultTableBody.querySelector("tr td") : null;
        if (td2) td2.textContent = formatCellForDisplay(raw, 0, true);
      });
      return;
    }
    td.textContent = formatCellForDisplay(raw, 0, true);
  }

  function finalizeAfterDone() {
    if (scheduledFlush || pendingRows.length) flushPendingRows();
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
      try {
        const text = copyText == null ? "" : String(copyText);
        await util.copyTextToClipboard(text);
        util.flashButtonText(copyBtn, { copiedText: "Copied" });
      } catch {
        return;
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
      allRows: [],
      errorText: "",
      wrap: wrapClone,
      errorBanner: ensureLocalErrorBanner(body),
    };

    function updateMetaText() {
      const r = local.allRows.length;
      const c = local.columns.length;
      metaSpan.textContent = c ? `${r} row${r === 1 ? "" : "s"} × ${c} col${c === 1 ? "" : "s"}` : `${r} row${r === 1 ? "" : "s"}`;
    }

    // Allow the runner to override the meta text at the end (e.g., include status/elapsed/cpu).
    function setMetaTextLocal(text) {
      metaSpan.textContent = String(text ?? "");
    }

    function renderTableMetaLocal(columns, types) {
      local.columns = Array.isArray(columns) ? columns.map((c) => String(c ?? "")) : [];
      local.types = Array.isArray(types) ? types.map((t) => String(t ?? "")) : [];
      local.allRows.length = 0;
      if (!local.wrap) return;
      resetTableMode();
      clearTableIn(local.wrap);
      const { thead } = findTablePartsIn(local.wrap);
      if (!thead) return;
      const tr = document.createElement("tr");
      for (let i = 0; i < local.columns.length; i++) {
        const th = document.createElement("th");
        th.textContent = local.columns[i];
        if (local.types[i]) th.title = local.types[i];
        tr.appendChild(th);
      }
      thead.appendChild(tr);
      updateMetaText();
    }

    function appendRowsLocal(rowsChunk) {
      if (!Array.isArray(rowsChunk)) return;
      local.allRows.push(...rowsChunk);
      if (!local.wrap) return;
      const { tbody } = findTablePartsIn(local.wrap);
      if (!tbody) return;
      for (const row of rowsChunk) {
        const tr = document.createElement("tr");
        if (Array.isArray(row)) {
          for (let i = 0; i < row.length; i++) {
            const td = document.createElement("td");
            td.textContent = row[i] == null ? "" : String(row[i]);
            tr.appendChild(td);
          }
        } else {
          const td = document.createElement("td");
          td.textContent = row == null ? "" : String(row);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
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
      try { await navigator.clipboard.writeText(text); } catch {}
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
