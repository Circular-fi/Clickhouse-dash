(() => {
  "use strict";

  const ns = window.ChDash;
  if (!ns) return;

  const { dom, util, state } = ns;

  let resultsStackElement = null;

  let resultColumns = [];
  let resultTypes = [];
  let allResultRows = [];
  let lastErrorMessage = "";
  let currentStatusValue = "";

  function setResultsVisible(visible) {
    if (!dom.resultsPanel) return;
    dom.resultsPanel.classList.toggle("is-hidden", !visible);
  }

  function setError(message) {
    lastErrorMessage = String(message || "").trim();
    if (!dom.errorBanner) return;
    if (lastErrorMessage) {
      dom.errorBanner.hidden = false;
      dom.errorBanner.textContent = lastErrorMessage;
    } else {
      dom.errorBanner.hidden = true;
      dom.errorBanner.textContent = "";
    }
    updateCopyButtonState();
  }

  function setStatus(status) {
    currentStatusValue = String(status || "");
    updateCopyButtonState();
  }

  function clearTable() {
    if (dom.resultTableHead) dom.resultTableHead.innerHTML = "";
    if (dom.resultTableBody) dom.resultTableBody.innerHTML = "";
  }

  function clearLiveResults() {
    resultColumns = [];
    resultTypes = [];
    allResultRows = [];
    currentStatusValue = "";
    lastErrorMessage = "";
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

  function renderTableMeta(columns, types) {
    resultColumns = Array.isArray(columns) ? columns.map((c) => String(c ?? "")) : [];
    resultTypes = Array.isArray(types) ? types.map((t) => String(t ?? "")) : [];

    if (dom.resultColumnsText) {
      const n = resultColumns.length || 0;
      util.setText(dom.resultColumnsText, `${n} ${n === 1 ? "column" : "columns"}`);
    }
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

  function parseJsonIfLikely(value) {
    if (typeof value !== "string") return null;
    const s = value.trim();
    if (!s) return null;
    if (!(s.startsWith("{") || s.startsWith("["))) return null;
    if (s.includes("\n")) return null;
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  }

  function cellToDisplayNode(value, { allowPrettyJson = false } = {}) {
    if (value === null || value === undefined) return document.createTextNode("");
    if (typeof value === "string") {
      const parsed = allowPrettyJson ? parseJsonIfLikely(value) : null;
      if (parsed && (Array.isArray(parsed) || (parsed && typeof parsed === "object"))) {
        const pre = document.createElement("pre");
        util.renderPrettyJson(pre, parsed);
        return pre;
      }
      return document.createTextNode(value);
    }
    if (typeof value === "number" || typeof value === "boolean") return document.createTextNode(String(value));
    if (typeof value === "object") {
      if (allowPrettyJson) {
        const pre = document.createElement("pre");
        util.renderPrettyJson(pre, value);
        return pre;
      }
      return document.createTextNode(JSON.stringify(value));
    }
    return document.createTextNode(String(value));
  }

  function appendRows(rowsChunk) {
    if (!Array.isArray(rowsChunk) || !dom.resultTableBody) return;

    const allowPrettySingleCell =
      resultColumns.length === 1 &&
      allResultRows.length === 0 &&
      rowsChunk.length === 1;

    const frag = document.createDocumentFragment();

    for (const row of rowsChunk) {
      if (!Array.isArray(row)) continue;
      allResultRows.push(row);

      const tr = document.createElement("tr");
      for (let c = 0; c < row.length; c++) {
        const td = document.createElement("td");
        const node = cellToDisplayNode(row[c], { allowPrettyJson: allowPrettySingleCell });
        td.appendChild(node);
        tr.appendChild(td);
      }
      frag.appendChild(tr);
    }

    dom.resultTableBody.appendChild(frag);
    setResultsVisible(true);
    updateCopyButtonState();
  }

  function buildCopyValue(value) {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") {
      const parsed = parseJsonIfLikely(value);
      if (parsed) return JSON.stringify(parsed, null, 2);
      return value;
    }
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return JSON.stringify(value, null, 2);
  }

  function buildCopyJsonText() {
    const st = String(currentStatusValue || "").toLowerCase();
    const err = String(lastErrorMessage || "").trim();

    if (err && ["error", "canceled", "cancelled"].includes(st)) return err;

    if (allResultRows.length === 1 && resultColumns.length === 1) {
      const row = allResultRows[0];
      const v = Array.isArray(row) ? row[0] : row;
      return buildCopyValue(v);
    }

    if (allResultRows.length === 1) {
      const row = allResultRows[0];
      const obj = {};
      for (let i = 0; i < resultColumns.length; i++) {
        obj[resultColumns[i]] = Array.isArray(row) ? row[i] : null;
      }
      return JSON.stringify(obj, null, 2);
    }

    const objects = allResultRows.map((row) => {
      const obj = {};
      for (let i = 0; i < resultColumns.length; i++) {
        obj[resultColumns[i]] = Array.isArray(row) ? row[i] : null;
      }
      return obj;
    });

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

  function pushResultsBlock(title, metaText, copyText, { expandedByDefault = false } = {}) {
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
        util.flashButtonText(copyBtn, { copiedText: "Copied (multiquery)" });
      } catch {
        return;
      }
    });

    const err = dom.errorBanner && !dom.errorBanner.hidden ? String(dom.errorBanner.textContent || "") : "";
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
    dom.copyJsonButton && (dom.copyJsonButton.disabled = true);
  }

  ns.results = {
    clearLiveResults,
    clearResultsStack,
    setError,
    setStatus,
    renderTableMeta,
    appendRows,
    buildCopyJsonText,
    pushResultsBlock,
    setMultiqueryMode,
    hideLiveWrapIfStackHasBlocks,
    ensureResultsStack,
    setResultsVisible,
  };
})();