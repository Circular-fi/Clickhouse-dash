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
  let numericMaxScale = [];
  let numericDirty = false;

  let liveGaugesEnabled = false;
  let liveGaugesPainted = false;
  let liveWrapHold = null;

  function applyLiveWrapHold() {
    const hold = liveWrapHold;
    if (!hold) return;
    const wrap = hold.wrap;
    const spacer = hold.spacer;
    if (!wrap || !spacer) {
      liveWrapHold = null;
      return;
    }
    const spacerH = spacer.parentNode ? spacer.offsetHeight : 0;
    const contentH = Math.max(0, wrap.scrollHeight - spacerH);
    const need = Math.max(0, hold.targetScrollHeight - contentH);
    if (need <= 0) {
      if (spacer.parentNode) spacer.remove();
      liveWrapHold = null;
      return;
    }
    spacer.style.height = `${need}px`;
    if (!spacer.parentNode) wrap.appendChild(spacer);
  }

  function setLiveWrapHold(targetScrollHeight) {
    const wrap = dom.liveResultsWrap;
    const target = Number(targetScrollHeight) || 0;
    if (!wrap || target <= 0) {
      if (liveWrapHold && liveWrapHold.spacer && liveWrapHold.spacer.parentNode) liveWrapHold.spacer.remove();
      liveWrapHold = null;
      return;
    }
    if (!liveWrapHold || liveWrapHold.wrap !== wrap) {
      const spacer = document.createElement("div");
      spacer.className = "resultsScrollHold";
      spacer.setAttribute("aria-hidden", "true");
      liveWrapHold = { wrap, spacer, targetScrollHeight: target };
    } else {
      liveWrapHold.targetScrollHeight = target;
    }
    applyLiveWrapHold();
  }

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
    const wasResultsVisible = dom.resultsPanel && !dom.resultsPanel.classList.contains("is-hidden");
    const preservedWrapScrollHeight = dom.liveResultsWrap ? dom.liveResultsWrap.scrollHeight : 0;
    resultColumns = [];
    resultTypes = [];
    resultTypeAsts = [];
    gaugeNumericCols = [];
    gaugeMaxPos = [];
    gaugeMaxAbs = [];
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
    currentStatusValue = "";
    lastErrorMessage = "";

    scheduledFlush = false;
    if (flushRafId) {
      cancelAnimationFrame(flushRafId);
      flushRafId = 0;
    }

    resetTableMode();
    clearTable();

    setLiveWrapHold(preservedWrapScrollHeight);

    if (dom.resultColumnsText) util.setText(dom.resultColumnsText, "-");
    setError("");
    updateCopyButtonState();

    if (dom.liveResultsWrap) dom.liveResultsWrap.hidden = false;
    if (resultsStackElement && resultsStackElement.childElementCount > 0) setResultsVisible(true);
    else if (wasResultsVisible) setResultsVisible(true);
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
      let hasNamedFields = false;
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
            hasNamedFields = true;
            return { name: maybeName, type: parseChType(rest), named: true };
          }
        }
        return { name: `_${idx}`, type: parseChType(part), named: false };
      });
      return { kind: "Tuple", fields, named: hasNamedFields };
    }

    return { kind: "Scalar", name: s };
  }

  function coerceDeepTyped(v, typeAst) {
    v = parseJsonStringIfLikely(v);
    if (!typeAst) return coerceDeep(v);

    if (v === null || v === undefined) return v;

    if (typeAst.kind === "Tuple") {
      const fields = Array.isArray(typeAst.fields) ? typeAst.fields : [];
      const isNamedTuple = !!typeAst.named;

      if (Array.isArray(v)) {
        if (!isNamedTuple) {
          return v.map((item, i) => coerceDeepTyped(item, fields[i] ? fields[i].type : null));
        }
        const out = {};
        for (let i = 0; i < fields.length; i++) {
          const f = fields[i];
          out[String(f.name ?? `_${i}`)] = coerceDeepTyped(v[i], f.type);
        }
        return out;
      }
      if (v && typeof v === "object") {
        if (!isNamedTuple) {
          const keys = Object.keys(v);
          const synthetic = fields.length > 0 && fields.every((f, i) => String(f.name ?? `_${i}`) === `_${i}`);
          if (synthetic && keys.every((k) => /^_\d+$/.test(k))) {
            return fields.map((f, i) => coerceDeepTyped(v[`_${i}`], f.type));
          }
          return Array.isArray(v) ? v.map(coerceDeep) : Object.values(v).map(coerceDeep);
        }
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

    return isScalarNumericType(typeAst) ? coerceNumberLike(v) : v;
  }

  function formatCellForDisplay(raw, colIndex, pretty = false) {
    const typed = coerceDeepTyped(raw, resultTypeAsts[colIndex] || null);
    if (typed === null || typed === undefined) return "null";
    if (typeof typed === "string") return typed;
    if (typeof typed === "number" || typeof typed === "boolean") return String(typed);
    return JSON.stringify(typed, null, pretty ? 4 : 0);
  }

  function formatCellForDisplayWithTypes(raw, colIndex, pretty, typeAsts) {
    const typed = coerceDeepTyped(raw, (typeAsts && typeAsts[colIndex]) || null);
    if (typed === null || typed === undefined) return "null";
    if (typeof typed === "string") return typed;
    if (typeof typed === "number" || typeof typed === "boolean") return String(typed);
    return JSON.stringify(typed, null, pretty ? 4 : 0);
  }

  function decodeEscapedDisplayText(value) {
    if (typeof value !== "string") return value;
    if (!/\\/.test(value)) return value;

    return value.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|n|r|t|\\|\")/g, (m, token) => {
      if (token === "n") return "\n";
      if (token === "r") return "\r";
      if (token === "t") return "\t";
      if (token === '"') return '"';
      if (token === "\\") return "\\";
      if (token[0] === "u") {
        try { return String.fromCharCode(parseInt(token.slice(1), 16)); } catch { return m; }
      }
      if (token[0] === "x") {
        try { return String.fromCharCode(parseInt(token.slice(1), 16)); } catch { return m; }
      }
      return m;
    });
  }

  function setCellTextPreserve(td, text) {
    let s = "";
    if (text === null || text === undefined) s = "null";
    else if (typeof text === "string") s = decodeEscapedDisplayText(text);
    else if (typeof text === "number" || typeof text === "boolean" || typeof text === "bigint") s = String(text);
    else if (typeof text === "object") {
      try { s = JSON.stringify(text, null, 4); } catch { s = String(text); }
    } else s = String(text);

    td.textContent = s;
    td.removeAttribute("title");
  }

  function renderSingleValueCell(td, raw, colIndex, typeAsts) {
    const typed = coerceDeepTyped(raw, (typeAsts && typeAsts[colIndex]) || null);

    function setScalar(cls, text) {
      td.textContent = "";
      const el = document.createElement("span");
      el.className = cls;
      el.textContent = text;
      td.appendChild(el);
    }

    if (typed === null || typed === undefined) {
      setScalar("tok-null", "null");
      return;
    }
    if (typeof typed === "string") {
      const decoded = decodeEscapedDisplayText(typed);
      const reparsed = parseJsonStringIfLikely(decoded);
      if (reparsed && typeof reparsed === "object") {
        renderJsonHighlightedInto(td, JSON.stringify(coerceDeep(reparsed), null, 4));
        return;
      }
      setCellTextPreserve(td, decoded);
      return;
    }
    if (typeof typed === "number" || typeof typed === "boolean") {
      setScalar(typeof typed === "number" ? "tok-num" : "tok-kw", String(typed));
      return;
    }

    renderJsonHighlightedInto(td, JSON.stringify(typed, null, 4));
  }

  function renderJsonHighlightedInto(td, jsonText) {
    td.textContent = "";
    const frag = document.createDocumentFragment();

    function appendText(t) {
      if (!t) return;
      frag.appendChild(document.createTextNode(t));
    }

    function appendSpan(cls, t) {
      const el = document.createElement("span");
      el.className = cls;
      el.textContent = t;
      frag.appendChild(el);
    }

    const s = String(jsonText ?? "");
    let i = 0;

    while (i < s.length) {
      const ch = s[i];

      if (ch === '"') {
        let j = i + 1;
        let esc = false;
        for (; j < s.length; j++) {
          const cj = s[j];
          if (esc) {
            esc = false;
            continue;
          }
          if (cj === "\\") {
            esc = true;
            continue;
          }
          if (cj === '"') {
            j++;
            break;
          }
        }
        let k = j;
        while (k < s.length) {
          const ck = s[k];
          if (ck === " " || ck === "\n" || ck === "\r" || ck === "\t") {
            k++;
            continue;
          }
          break;
        }
        const cls = k < s.length && s[k] === ":" ? "tok-kw" : "tok-str";
        appendSpan(cls, s.slice(i, j));
        i = j;
        continue;
      }

      if ((ch >= "0" && ch <= "9") || ch === "-") {
        const m = s.slice(i).match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/);
        if (m && m[0]) {
          appendSpan("tok-num", m[0]);
          i += m[0].length;
          continue;
        }
      }

      if (ch === "t" && s.startsWith("true", i)) {
        appendSpan("tok-kw", "true");
        i += 4;
        continue;
      }
      if (ch === "f" && s.startsWith("false", i)) {
        appendSpan("tok-kw", "false");
        i += 5;
        continue;
      }
      if (ch === "n" && s.startsWith("null", i)) {
        appendSpan("tok-null", "null");
        i += 4;
        continue;
      }

      if (ch === "{" || ch === "}" || ch === "[" || ch === "]" || ch === "(" || ch === ")" || ch === "," || ch === ":") {
        appendSpan("tok-com", ch);
        i++;
        continue;
      }

      appendText(ch);
      i++;
    }

    td.appendChild(frag);
  }

  function stringifyCompactJson(value) {
    const maxInlineChars = 90;
    const maxInlineItems = 8;
    const indentStep = 2;

    function scalar(v) {
      if (v === null) return "null";
      if (typeof v === "string") return JSON.stringify(v);
      if (typeof v === "number") return Number.isFinite(v) ? String(v) : JSON.stringify(v);
      if (typeof v === "boolean") return v ? "true" : "false";
      return JSON.stringify(v);
    }

    function formatInline(v) {
      if (v === null || typeof v !== "object") return scalar(v);

      if (Array.isArray(v)) {
        if (v.length > maxInlineItems) return null;
        const parts = new Array(v.length);
        for (let i = 0; i < v.length; i++) {
          const t = formatInline(v[i]);
          if (t === null) return null;
          parts[i] = t;
        }
        const out = `[${parts.join(", ")}]`;
        return out.length <= maxInlineChars ? out : null;
      }

      const keys = Object.keys(v);
      if (keys.length > maxInlineItems) return null;
      const parts = [];
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const t = formatInline(v[k]);
        if (t === null) return null;
        parts.push(`${JSON.stringify(k)}: ${t}`);
      }
      const out = `{${parts.join(", ")}}`;
      return out.length <= maxInlineChars ? out : null;
    }

    function formatMultiline(v, indent) {
      const one = formatInline(v);
      if (one !== null) return one;

      if (v === null || typeof v !== "object") return scalar(v);

      const pad = " ".repeat(indent);
      const padIn = " ".repeat(indent + indentStep);

      if (Array.isArray(v)) {
        if (v.length === 0) return "[]";
        const items = v.map((x) => formatMultiline(x, indent + indentStep));
        const lines = ["["];
        for (let i = 0; i < items.length; i++) {
          const itemLines = items[i].split("\n");
          itemLines[0] = padIn + itemLines[0];
          if (i < items.length - 1) itemLines[itemLines.length - 1] += ",";
          lines.push(itemLines.join("\n"));
        }
        lines.push(pad + "]");
        return lines.join("\n");
      }

      const keys = Object.keys(v);
      if (keys.length === 0) return "{}";

      const lines = ["{"];
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const valText = formatMultiline(v[k], indent + indentStep);
        const valLines = valText.split("\n");
        valLines[0] = `${padIn}${JSON.stringify(k)}: ${valLines[0]}`;
        if (i < keys.length - 1) valLines[valLines.length - 1] += ",";
        lines.push(valLines.join("\n"));
      }
      lines.push(pad + "}");
      return lines.join("\n");
    }

    return formatMultiline(value, 0);
  }

  function stringifyCompactValue(value, typeAst) {
    const maxInlineChars = 90;
    const maxInlineItems = 8;
    const indentStep = 2;

    function scalar(v) {
      if (v === null || v === undefined) return "null";
      if (typeof v === "string") return JSON.stringify(v);
      if (typeof v === "number") return Number.isFinite(v) ? String(v) : JSON.stringify(v);
      if (typeof v === "boolean") return v ? "true" : "false";
      return JSON.stringify(v);
    }

    function tupleElems(v, t) {
      if (!t || t.kind !== "Tuple") return null;
      const fields = Array.isArray(t.fields) ? t.fields : [];
      if (fields.length === 0) return [];
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const out = new Array(fields.length);
        for (let i = 0; i < fields.length; i++) {
          const f = fields[i];
          out[i] = v[f.name];
        }
        return out;
      }
      if (Array.isArray(v)) return v;
      return null;
    }

    function formatInline(v, t) {
      if (t && t.kind === "Tuple") {
        const elems = tupleElems(v, t);
        if (!elems) return null;
        if (elems.length > maxInlineItems) return null;
        const parts = new Array(elems.length);
        for (let i = 0; i < elems.length; i++) {
          const subT = t.fields && t.fields[i] ? t.fields[i].type : null;
          const sub = formatInline(elems[i], subT);
          if (sub === null) return null;
          parts[i] = sub;
        }
        const out = `(${parts.join(", ")})`;
        return out.length <= maxInlineChars ? out : null;
      }

      if (v === null || v === undefined || typeof v !== "object") return scalar(v);

      if (Array.isArray(v)) {
        if (v.length > maxInlineItems) return null;
        const parts = new Array(v.length);
        const innerT = t && t.kind === "Array" ? t.inner : null;
        for (let i = 0; i < v.length; i++) {
          const sub = formatInline(v[i], innerT);
          if (sub === null) return null;
          parts[i] = sub;
        }
        const out = `[${parts.join(", ")}]`;
        return out.length <= maxInlineChars ? out : null;
      }

      const keys = Object.keys(v);
      if (keys.length > maxInlineItems) return null;
      const parts = [];
      const valT = t && t.kind === "Map" ? t.value : null;
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const sub = formatInline(v[k], valT);
        if (sub === null) return null;
        parts.push(`${JSON.stringify(k)}: ${sub}`);
      }
      const out = `{${parts.join(", ")}}`;
      return out.length <= maxInlineChars ? out : null;
    }

    function formatMultiline(v, t, indent) {
      const one = formatInline(v, t);
      if (one !== null) return one;

      if (t && t.kind === "Tuple") {
        const elems = tupleElems(v, t);
        if (!elems) return scalar(v);
        if (elems.length === 0) return "()";

        const pad = " ".repeat(indent);
        const padIn = " ".repeat(indent + indentStep);
        const lines = ["("];
        for (let i = 0; i < elems.length; i++) {
          const subT = t.fields && t.fields[i] ? t.fields[i].type : null;
          const valText = formatMultiline(elems[i], subT, indent + indentStep);
          const valLines = valText.split("\n");
          valLines[0] = padIn + valLines[0];
          if (i < elems.length - 1) valLines[valLines.length - 1] += ",";
          lines.push(valLines.join("\n"));
        }
        lines.push(pad + ")");
        return lines.join("\n");
      }

      if (v === null || v === undefined || typeof v !== "object") return scalar(v);

      const pad = " ".repeat(indent);
      const padIn = " ".repeat(indent + indentStep);

      if (Array.isArray(v)) {
        if (v.length === 0) return "[]";
        const innerT = t && t.kind === "Array" ? t.inner : null;
        const items = v.map((x) => formatMultiline(x, innerT, indent + indentStep));
        const lines = ["["];
        for (let i = 0; i < items.length; i++) {
          const itemLines = items[i].split("\n");
          itemLines[0] = padIn + itemLines[0];
          if (i < items.length - 1) itemLines[itemLines.length - 1] += ",";
          lines.push(itemLines.join("\n"));
        }
        lines.push(pad + "]");
        return lines.join("\n");
      }

      const keys = Object.keys(v);
      if (keys.length === 0) return "{}";
      const valT = t && t.kind === "Map" ? t.value : null;

      const lines = ["{"];
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const valText = formatMultiline(v[k], valT, indent + indentStep);
        const valLines = valText.split("\n");
        valLines[0] = `${padIn}${JSON.stringify(k)}: ${valLines[0]}`;
        if (i < keys.length - 1) valLines[valLines.length - 1] += ",";
        lines.push(valLines.join("\n"));
      }
      lines.push(pad + "}");
      return lines.join("\n");
    }

    return formatMultiline(value, typeAst, 0);
  }

  function setVerticalValueCell(td, raw, colIndex) {
    const typeAst = resultTypeAsts[colIndex] || null;
    const typed = coerceDeepTyped(raw, typeAst);

    function setScalar(cls, text) {
      td.textContent = "";
      const el = document.createElement("span");
      el.className = cls;
      el.textContent = text;
      td.appendChild(el);
    }

    if (typed === null || typed === undefined) {
      setScalar("tok-null", "null");
      return;
    }
    if (typeof typed === "string") {
      const decoded = decodeEscapedDisplayText(typed);
      const reparsed = parseJsonStringIfLikely(decoded);
      if (reparsed && typeof reparsed === "object") {
        renderJsonHighlightedInto(td, JSON.stringify(coerceDeep(reparsed), null, 4));
        return;
      }
      setCellTextPreserve(td, decoded);
      return;
    }
    if (typeof typed === "number" || typeof typed === "boolean") {
      setScalar(typeof typed === "number" ? "tok-num" : "tok-kw", String(typed));
      return;
    }

    try {
      renderJsonHighlightedInto(td, JSON.stringify(typed, null, 4));
    } catch {
      td.textContent = String(typed);
    }
  }


  function setCellTextFlat(td, text) {
    let s = "";
    if (text === null || text === undefined) s = "null";
    else if (typeof text === "string") s = text;
    else if (typeof text === "number" || typeof text === "boolean" || typeof text === "bigint") s = String(text);
    else if (typeof text === "object") {
      try { s = JSON.stringify(text); } catch { s = String(text); }
    } else s = String(text);

    const flat = s.replace(/\s+/g, " ").trim();
    td.textContent = flat;
    if (flat !== s && s.trim()) td.title = s;
    else td.removeAttribute("title");
  }

  function setResultColumnsText() {
    if (!dom.resultColumnsText) return;
    const n = resultColumns.length || 0;
    util.setText(dom.resultColumnsText, `${n} ${n === 1 ? "column" : "columns"}`);
  }

  function extractFiniteNumber(raw) {
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
    numericMaxScale = new Array(gaugeNumericCols.length).fill(0);
    numericDirty = false;
    liveGaugesEnabled = false;
    liveGaugesPainted = false;
  }

  function extractDecimalScale(raw) {
    if (raw === null || raw === undefined) return 0;
    if (typeof raw === "number") {
      if (!Number.isFinite(raw)) return 0;
      const s = String(raw);
      if (s.includes("e") || s.includes("E")) return 0;
      const dot = s.indexOf(".");
      return dot >= 0 ? Math.max(0, s.length - dot - 1) : 0;
    }
    if (typeof raw !== "string") return 0;
    const s = raw.trim();
    if (!s) return 0;
    if (s.includes("e") || s.includes("E")) return 0;
    const m = s.match(/^[+-]?(?:\d+)?\.(\d+)$/);
    return m ? m[1].length : 0;
  }

  function formatNumericWithScale(raw, scale) {
    if (raw === null || raw === undefined) return "null";
    if (!scale) return String(raw);
    if (typeof raw === "number") {
      if (!Number.isFinite(raw)) return String(raw);
      try {
        return raw.toFixed(scale);
      } catch {
        return String(raw);
      }
    }
    if (typeof raw !== "string") return String(raw);
    const s0 = raw.trim();
    if (!s0) return s0;
    if (!NUMERIC_RE.test(s0)) return s0;
    if (s0.includes("e") || s0.includes("E")) return s0;
    const dot = s0.indexOf(".");
    if (dot < 0) return s0 + "." + "0".repeat(scale);
    const head = s0.slice(0, dot);
    const tail = s0.slice(dot + 1);
    if (tail.length >= scale) return s0;
    return head + "." + tail + "0".repeat(scale - tail.length);
  }

  function formatNumericCellText(raw, colIndex, scaleArr) {
    const scale = (scaleArr && scaleArr[colIndex]) || 0;
    return formatNumericWithScale(raw, scale);
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
    if (scaleChanged) numericDirty = true;
  }

  function setGaugeCell(td, raw, colIndex, text, maxPosArr, maxAbsArr) {
    td.classList.add("resultTable__gaugeCell");
    td.classList.add("resultTable__numeric");
    const n = extractFiniteNumber(raw);
    const scale = computeGaugeScale(n, maxPosArr[colIndex] || 0, maxAbsArr[colIndex] || 0);
    const fill = scale > 0 ? String(scale * 100) + "%" : "0%";
    td.style.setProperty("--gaugeFill", fill);
    setCellTextFlat(td, text);
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
        if (gaugeNumericCols[columnIndex]) {
          const text = formatNumericCellText(row[columnIndex], columnIndex, numericMaxScale);
          if (liveGaugesEnabled) setGaugeCell(td, row[columnIndex], columnIndex, text, gaugeMaxPos, gaugeMaxAbs);
          else {
            td.classList.add("resultTable__numeric");
            setCellTextFlat(td, text);
          }
        } else {
          const text = formatCellForDisplay(row[columnIndex], columnIndex, false);
          if (isScalarNumericType(resultTypeAsts[columnIndex] || null)) td.classList.add("resultTable__numeric");
          setCellTextFlat(td, text);
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
    applyLiveWrapHold();
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
    applyLiveWrapHold();
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
    applyLiveWrapHold();
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
      setVerticalValueCell(td, Array.isArray(row) ? row[i] : null, i);

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

  function simplifySingleValueTable() {
    if (!dom.resultTableHead || !dom.resultTableBody) return null;

    const headRow = document.createElement("tr");
    const th = document.createElement("th");
    const colName = String((Array.isArray(resultColumns) && resultColumns[0]) ?? "");
    th.textContent = colName;
    th.title = resultTypes[0] || colName;
    headRow.appendChild(th);

    dom.resultTableHead.innerHTML = "";
    dom.resultTableHead.appendChild(headRow);

    let tr = dom.resultTableBody.querySelector("tr");
    if (!tr) {
      tr = document.createElement("tr");
      dom.resultTableBody.appendChild(tr);
    }

    let td = tr.querySelector("td:not(.resultTable__rowIndex)");
    if (!td) td = document.createElement("td");

    tr.innerHTML = "";
    tr.appendChild(td);
    return td;
  }

  function maybeRenderSingleRowValueCell() {
    if (isVerticalResults) return;
    if (!Array.isArray(resultColumns) || resultColumns.length !== 1) return;
    if (!Array.isArray(allResultRows) || allResultRows.length !== 1) return;
    if (!dom.resultTableBody) return;

    const row = allResultRows[0];
    const raw = Array.isArray(row) ? row[0] : row;

    if (scheduledFlush || pendingRows.length) flushPendingRows();

    const apply = () => {
      const cell = simplifySingleValueTable();
      if (!cell) return;
      renderSingleValueCell(cell, raw, 0, resultTypeAsts);
    };

    const td = dom.resultTableBody.querySelector("tr td:not(.resultTable__rowIndex)");
    if (!td) {
      requestAnimationFrame(() => apply());
      return;
    }
    apply();
  }

  function finalizeAfterDone() {
    if (scheduledFlush || pendingRows.length) flushPendingRows();

    if (!liveGaugesEnabled) liveGaugesEnabled = true;
    const hasGaugeCols = Array.isArray(gaugeNumericCols) && gaugeNumericCols.some(Boolean);
    const needFinalGaugeRender = !isVerticalResults && hasGaugeCols && allResultRows.length > 0 && !liveGaugesPainted;

    if (!isVerticalResults && (isLiveSortActive() || gaugeDirty || numericDirty || needFinalGaugeRender)) {
      renderLiveTableFull();
      gaugeDirty = false;
      numericDirty = false;
      if (liveGaugesEnabled && hasGaugeCols) liveGaugesPainted = true;
    }
    maybeSwitchToVerticalSingleRow();
    maybeRenderSingleRowValueCell();
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

  function csvEscapeField(value) {
    const s = String(value ?? "");
    if (!s) return "";
    const needsQuote = s.includes(",") || s.includes("\n") || s.includes("\r") || s.includes("\"") || /^\s|\s$/.test(s);
    if (!needsQuote) return s;
    return `"${s.replace(/"/g, '""')}"`;
  }

  function buildCopyCsvText() {
    const st = String(currentStatusValue || "").toLowerCase();
    const err = String(lastErrorMessage || "").trim();

    if (err && ["error", "canceled", "cancelled"].includes(st)) return err;

    const cols = Array.isArray(resultColumns) ? resultColumns : [];
    const hasCols = cols.length > 0;
    const header = hasCols ? cols.map((c) => csvEscapeField(String(c ?? ""))).join(",") : "";

    const rows = Array.isArray(allResultRows) ? allResultRows : [];
    if (!rows.length) return header;

    const lines = [];
    if (header) lines.push(header);

    for (const row of rows) {
      if (Array.isArray(row)) {
        const parts = [];
        for (let i = 0; i < cols.length; i++) {
          parts.push(csvEscapeField(formatCellForDisplay(row[i], i, false)));
        }
        lines.push(parts.join(","));
        continue;
      }

      if (cols.length <= 1) {
        lines.push(csvEscapeField(formatCellForDisplay(row, 0, false)));
        continue;
      }

      const parts = new Array(cols.length);
      for (let i = 0; i < cols.length; i++) parts[i] = "";
      lines.push(parts.join(","));
    }

    return lines.join("\n");
  }

  function buildCopyText(format) {
    const v = String(format || "json").toLowerCase();
    return v === "csv" ? buildCopyCsvText() : buildCopyJsonText();
  }

  function updateCopyButtonState() {
    if (!dom.copyJsonButton) return;

    const err = String(lastErrorMessage || "").trim();
    const hasError = err.length > 0;

    const hasRows = Array.isArray(allResultRows) && allResultRows.length > 0;

    const st = String(currentStatusValue || "").toLowerCase();
    const finishedLike = ["finished", "done", "error", "canceled", "cancelled", "result_limit_reached"].includes(st);

    const disabled = !(hasError || hasRows || finishedLike);

    dom.copyJsonButton.disabled = disabled;
    if (dom.copyMenuButton) dom.copyMenuButton.disabled = disabled;
    if (dom.copyCsvButton) dom.copyCsvButton.disabled = disabled;
  }

  function getRowCount() {
    return Array.isArray(allResultRows) ? allResultRows.length : 0;
  }

  function getColCount() {
    return Array.isArray(resultColumns) ? resultColumns.length : 0;
  }

  async function copyTextWithFlash(btn, text) {
    const v = text == null ? "" : String(text);
    util.flashButtonText(btn, { copiedText: "Copied" });
    try {
      await util.copyTextToClipboard(v);
    } catch {
      util.flashButtonText(btn, { copiedText: "Copy failed", durationMs: 1500 });
    }
  }

  function createCopySplitSmall({ getJsonText, getCsvText }) {
    const split = document.createElement("div");
    split.className = "runSplit copySplit";

    const buttons = document.createElement("div");
    buttons.className = "runSplit__buttons";

    const mainBtn = document.createElement("button");
    mainBtn.type = "button";
    mainBtn.className = "button button--small resultsStack__copy runSplit__main";
    mainBtn.textContent = "Copy JSON";

    const menuBtn = document.createElement("button");
    menuBtn.type = "button";
    menuBtn.className = "button button--small runSplit__toggle";
    menuBtn.setAttribute("aria-haspopup", "menu");
    menuBtn.setAttribute("aria-expanded", "false");
    menuBtn.title = "Copy options";

    buttons.appendChild(mainBtn);
    buttons.appendChild(menuBtn);

    const menu = document.createElement("div");
    menu.className = "runMenu copyMenu";
    menu.setAttribute("role", "menu");
    menu.tabIndex = -1;
    menu.hidden = true;

    const csvBtn = document.createElement("button");
    csvBtn.type = "button";
    csvBtn.className = "runMenu__opt";
    csvBtn.setAttribute("role", "menuitem");

    const csvText = document.createElement("span");
    csvText.className = "runMenu__optText";
    csvText.textContent = "Copy CSV";
    csvBtn.appendChild(csvText);

    menu.appendChild(csvBtn);

    split.appendChild(buttons);
    split.appendChild(menu);

    let onDocClick = null;
    let onKey = null;

    const isOpen = () => split.classList.contains("is-open");

    const cleanup = () => {
      if (onDocClick) document.removeEventListener("click", onDocClick);
      if (onKey) document.removeEventListener("keydown", onKey);
      onDocClick = null;
      onKey = null;
    };

    const openMenu = () => {
      if (!menu.hidden) return;
      menu.hidden = false;
      menuBtn.setAttribute("aria-expanded", "true");
      requestAnimationFrame(() => split.classList.add("is-open"));
      try {
        menu.focus({ preventScroll: true });
      } catch {
        null;
      }
      onDocClick = (ev) => {
        const t = ev.target;
        if (t instanceof Node && !split.contains(t)) closeMenu();
      };
      onKey = (ev) => {
        if (ev.key === "Escape") closeMenu({ immediate: true });
      };
      document.addEventListener("click", onDocClick);
      document.addEventListener("keydown", onKey);
    };

    const closeMenu = ({ immediate = false } = {}) => {
      menuBtn.setAttribute("aria-expanded", "false");
      split.classList.remove("is-open");
      if (immediate) {
        menu.hidden = true;
        cleanup();
        return;
      }
      setTimeout(() => {
        if (!isOpen()) {
          menu.hidden = true;
          cleanup();
        }
      }, 160);
    };

    menuBtn.addEventListener("click", () => {
      if (menu.hidden) openMenu();
      else closeMenu();
    });

    mainBtn.addEventListener("click", async () => {
      const text = typeof getJsonText === "function" ? getJsonText() : "";
      await copyTextWithFlash(mainBtn, text);
    });

    csvBtn.addEventListener("click", async () => {
      closeMenu({ immediate: true });
      const text = typeof getCsvText === "function" ? getCsvText() : "";
      await copyTextWithFlash(mainBtn, text);
    });

    return { el: split, mainBtn, menuBtn, menu, csvBtn, setDisabled: (v) => {
      const disabled = !!v;
      mainBtn.disabled = disabled;
      menuBtn.disabled = disabled;
      if (disabled) closeMenu({ immediate: true });
    } };
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

    const copyPayload = copyText && typeof copyText === "object" && !Array.isArray(copyText) ? copyText : { json: copyText };
    const copyCtrl = createCopySplitSmall({
      getJsonText: () => (copyPayload && copyPayload.json != null ? String(copyPayload.json) : ""),
      getCsvText: () => {
        if (copyPayload && copyPayload.csv != null) return String(copyPayload.csv);
        if (copyPayload && copyPayload.json != null) return String(copyPayload.json);
        return "";
      },
    });
    right.appendChild(copyCtrl.el);

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
    if (dom.copySplit) dom.copySplit.hidden = !!enabled;
    if (dom.copyJsonToast) dom.copyJsonToast.hidden = true;
    if (dom.resultColumnsText) dom.resultColumnsText.hidden = !!enabled;
  }

  function hideLiveWrapIfStackHasBlocks() {
    if (!dom.liveResultsWrap) return;
    const hasBlocks = !!(resultsStackElement && resultsStackElement.childElementCount > 0);
    dom.liveResultsWrap.hidden = hasBlocks;
    if (hasBlocks) {
      if (dom.copySplit) dom.copySplit.hidden = true;
      if (dom.resultColumnsText) dom.resultColumnsText.hidden = true;
    }
    if (dom.copyJsonButton) dom.copyJsonButton.disabled = true;
    if (dom.copyMenuButton) dom.copyMenuButton.disabled = true;
    if (dom.copyCsvButton) dom.copyCsvButton.disabled = true;
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

    const copyCtrl = createCopySplitSmall({
      getJsonText: () => buildCopyTextLocal("json"),
      getCsvText: () => buildCopyTextLocal("csv"),
    });
    right.appendChild(copyCtrl.el);

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
      numericMaxScale: [],
      numericDirty: false,
      isVertical: false,
      gaugesEnabled: false,
      gaugesPainted: false,
    };

    function updateCopyEnabledLocal() {
      const hasError = String(local.errorText || "").trim().length > 0;
      const hasRows = Array.isArray(local.allRows) && local.allRows.length > 0;
      copyCtrl.setDisabled(!(hasError || hasRows));
    }

    function updateMetaText() {
      const r = local.allRows.length;
      const c = local.columns.length;
      metaSpan.textContent = c ? `${r} row${r === 1 ? "" : "s"} ${c} column${c === 1 ? "" : "s"}` : `${r} row${r === 1 ? "" : "s"}`;
      updateCopyEnabledLocal();
    }

    function setMetaTextLocal(text) {
      metaSpan.textContent = String(text ?? "");
    }

    function resetLocalGaugeState() {
      local.gaugeNumericCols = local.typeAsts.map(isScalarNumericType);
      local.gaugeMaxPos = new Array(local.gaugeNumericCols.length).fill(0);
      local.gaugeMaxAbs = new Array(local.gaugeNumericCols.length).fill(0);
      local.gaugeDirty = false;
      local.numericMaxScale = new Array(local.gaugeNumericCols.length).fill(0);
      local.numericDirty = false;
      local.gaugesEnabled = false;
      local.gaugesPainted = false;
    }

    function updateLocalGaugeMaximaFromRow(row) {
      if (!Array.isArray(row) || local.gaugeNumericCols.length === 0) return;
      let changed = false;
      let scaleChanged = false;
      for (let i = 0; i < local.gaugeNumericCols.length; i++) {
        if (!local.gaugeNumericCols[i]) continue;

        const scale = extractDecimalScale(row[i]);
        if (scale > (local.numericMaxScale[i] || 0)) {
          local.numericMaxScale[i] = scale;
          scaleChanged = true;
        }

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
      if (scaleChanged) local.numericDirty = true;
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
          if (local.gaugeNumericCols[i]) {
            const text = formatNumericCellText(row[i], i, local.numericMaxScale);
            if (local.gaugesEnabled) setGaugeCell(td, row[i], i, text, local.gaugeMaxPos, local.gaugeMaxAbs);
            else {
              td.classList.add("resultTable__numeric");
              setCellTextFlat(td, text);
            }
          } else {
            const text = formatCellForDisplayWithTypes(row[i], i, false, local.typeAsts);
            if (isScalarNumericType(local.typeAsts[i] || null)) td.classList.add("resultTable__numeric");
            setCellTextFlat(td, text);
          }
          tr.appendChild(td);
        }
        return;
      }

      const td = document.createElement("td");
      setCellTextFlat(td, row);
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

    function resetTableModeLocal() {
      local.isVertical = false;
      if (!local.wrap) return;
      const { table } = findTablePartsIn(local.wrap);
      if (table) table.classList.remove("resultTable--vertical");
    }

    function renderVerticalSingleRowLocal(row) {
      if (!local.wrap) return;
      const { thead, tbody, table } = findTablePartsIn(local.wrap);
      if (!thead || !tbody || !table) return;

      local.isVertical = true;
      table.classList.add("resultTable--vertical");

      const headRow = document.createElement("tr");
      const th1 = document.createElement("th");
      th1.textContent = "Column";
      const th2 = document.createElement("th");
      th2.textContent = "Value";
      headRow.appendChild(th1);
      headRow.appendChild(th2);

      thead.innerHTML = "";
      thead.appendChild(headRow);

      tbody.innerHTML = "";
      const frag = document.createDocumentFragment();

      for (let i = 0; i < local.columns.length; i++) {
        const tr = document.createElement("tr");

        const th = document.createElement("th");
        const colName = String(local.columns[i] ?? "");
        th.textContent = colName;
        th.title = colName;

        const td = document.createElement("td");
        renderSingleValueCell(td, Array.isArray(row) ? row[i] : null, i, local.typeAsts);

        tr.appendChild(th);
        tr.appendChild(td);
        frag.appendChild(tr);
      }

      tbody.appendChild(frag);
    }

    function maybeSwitchToVerticalSingleRowLocal() {
      if (local.isVertical) return;
      if (!Array.isArray(local.columns) || local.columns.length < 2) return;
      if (!Array.isArray(local.allRows) || local.allRows.length !== 1) return;
      renderVerticalSingleRowLocal(local.allRows[0]);
    }

    function simplifySingleValueTableLocal() {
      if (!local.wrap) return null;
      const { thead, tbody } = findTablePartsIn(local.wrap);
      if (!thead || !tbody) return null;

      const headRow = document.createElement("tr");
      const th = document.createElement("th");
      const colName = String((Array.isArray(local.columns) && local.columns[0]) ?? "");
      th.textContent = colName;
      th.title = local.types[0] || colName;
      headRow.appendChild(th);

      thead.innerHTML = "";
      thead.appendChild(headRow);

      let tr = tbody.querySelector("tr");
      if (!tr) {
        tr = document.createElement("tr");
        tbody.appendChild(tr);
      }

      let td = tr.querySelector("td:not(.resultTable__rowIndex)");
      if (!td) td = document.createElement("td");

      tr.innerHTML = "";
      tr.appendChild(td);
      return td;
    }

    function maybeRenderSingleRowValueCellLocal() {
      if (local.isVertical) return;
      if (!Array.isArray(local.columns) || local.columns.length !== 1) return;
      if (!Array.isArray(local.allRows) || local.allRows.length !== 1) return;
      if (!local.wrap) return;

      const { tbody } = findTablePartsIn(local.wrap);
      if (!tbody) return;
      const row = local.allRows[0];
      const raw = Array.isArray(row) ? row[0] : row;
      const apply = () => {
        const td = simplifySingleValueTableLocal();
        if (td) renderSingleValueCell(td, raw, 0, local.typeAsts);
      };
      const td = tbody.querySelector("tr td:not(.resultTable__rowIndex)");
      if (!td) {
        requestAnimationFrame(() => apply());
        return;
      }
      apply();
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
      resetTableModeLocal();
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
      return JSON.stringify(local.allRows, null, 2);
    }

    function buildCopyCsvTextLocal() {
      const err = String(local.errorText || "").trim();
      if (err && (!Array.isArray(local.allRows) || local.allRows.length === 0)) return err;

      const cols = Array.isArray(local.columns) ? local.columns : [];
      const header = cols.length ? cols.map((c) => csvEscapeField(String(c ?? ""))).join(",") : "";

      const rows = Array.isArray(local.allRows) ? local.allRows : [];
      if (!rows.length) return header;

      const lines = [];
      if (header) lines.push(header);

      for (const row of rows) {
        if (Array.isArray(row)) {
          const parts = [];
          for (let i = 0; i < cols.length; i++) {
            parts.push(csvEscapeField(formatCellForDisplayWithTypes(row[i], i, false, local.typeAsts)));
          }
          lines.push(parts.join(","));
          continue;
        }

        if (cols.length <= 1) {
          lines.push(csvEscapeField(formatCellForDisplayWithTypes(row, 0, false, local.typeAsts)));
          continue;
        }

        const parts = new Array(cols.length);
        for (let i = 0; i < cols.length; i++) parts[i] = "";
        lines.push(parts.join(","));
      }

      return lines.join("\n");
    }

    function buildCopyTextLocal(format) {
      const v = String(format || "json").toLowerCase();
      return v === "csv" ? buildCopyCsvTextLocal() : buildCopyJsonTextLocal();
    }

    function setErrorLocal(message) {
      local.errorText = String(message || "").trim();
      updateCopyEnabledLocal();
      if (!local.errorBanner) return;
      if (local.errorText) {
        local.errorBanner.hidden = false;
        local.errorBanner.textContent = local.errorText;
      } else {
        local.errorBanner.hidden = true;
        local.errorBanner.textContent = "";
      }
    }

    updateCopyEnabledLocal();

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
      takeErrorText: () => {
        const t = local.errorText;
        local.errorText = "";
        setErrorLocal("");
        return t;
      },
      setMetaText: setMetaTextLocal,
      setExpanded: (expanded) => setBlockExpandedLocal(blockObj, !!expanded),
      finalize: ({ expandedByDefault = false } = {}) => {
        if (!local.gaugesEnabled) local.gaugesEnabled = true;
        const hasGaugeCols = Array.isArray(local.gaugeNumericCols) && local.gaugeNumericCols.some(Boolean);
        const needFinalGaugeRender = local.wrap && !local.isVertical && hasGaugeCols && local.allRows.length > 0 && !local.gaugesPainted;

        if (local.wrap && !local.isVertical && (local.gaugeDirty || local.numericDirty || needFinalGaugeRender)) {
          renderLocalTableFull();
          local.gaugeDirty = false;
          local.numericDirty = false;
          if (local.gaugesEnabled && hasGaugeCols) local.gaugesPainted = true;
        }
        maybeSwitchToVerticalSingleRowLocal();
        maybeRenderSingleRowValueCellLocal();
        if (autoToggle) setBlockExpandedLocal(blockObj, !!expandedByDefault);
      },
    };
  }

  function endMultiqueryPanel(sink, { expandedByDefault = false, metaText = null } = {}) {
    if (sink && typeof sink.setMetaText === "function" && metaText != null) sink.setMetaText(metaText);
    if (sink && typeof sink.finalize === "function") sink.finalize({ expandedByDefault });
  }

  ns.results = {
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
    getRowCount,
    getColCount,
    pushResultsBlock,
    setMultiqueryMode,
    hideLiveWrapIfStackHasBlocks,
    ensureResultsStack,
    setResultsVisible,
  };
})();