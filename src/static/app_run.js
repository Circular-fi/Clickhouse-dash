(() => {
  "use strict";

  const ns = window.ChDash;
  if (!ns) return;

  const { dom, state, storage, api, sql, results, util, ui } = ns;

  let activeEventSource = null;

  function setQueryIdText(queryId) {
    util.setText(dom.queryIdentifierText, queryId ? `#${queryId}` : "#-");
  }

  function setQueryStatusText(value) {
    util.setText(dom.queryStatusText, value || "-");
  }

  function closeActiveStream() {
    if (!activeEventSource) return;
    try {
      activeEventSource.close();
    } catch {
      return;
    } finally {
      activeEventSource = null;
    }
  }

  function updateActionButtons() {
    const busy = state.isRunning || state.isFormatting;
    if (dom.runButton) dom.runButton.disabled = busy;
    if (dom.formatButton) dom.formatButton.disabled = busy;

    if (dom.cancelButton) {
      dom.cancelButton.disabled = state.isFormatting;
      dom.cancelButton.textContent = state.isRunning ? "Cancel" : "Clear";
    }
  }

  function setBusy({ running, formatting, batch }) {
    state.isRunning = !!running;
    state.isFormatting = !!formatting;
    state.isBatchRun = !!batch;
    updateActionButtons();
  }

  function getSelectedHostId() {
    return state.selectedHostId;
  }

  async function handleCopyLiveJson() {
    try {
      const copyText = results.buildCopyJsonText();
      await util.copyTextToClipboard(copyText);
      util.flashButtonText(dom.copyJsonButton, { copiedText: "Copied" });
    } catch {
      return;
    }
  }

  async function formatEditorSql() {
    const hostId = getSelectedHostId();
    const raw = dom.queryTextArea ? dom.queryTextArea.value : "";
    const trimmed = String(raw || "").trim();
    if (!trimmed) throw new Error("Nothing to format.");

    const statements = sql.splitSqlStatements(trimmed);
    if (!statements.length) throw new Error("Nothing to format.");

    const formatted = await api.formatSqls(hostId, statements);
    const normalized = formatted.map(sql.normalizeStatementText).filter(Boolean);
    const joined = sql.joinSqlStatements(normalized);

    if (dom.queryTextArea) util.replaceTextAreaValue(dom.queryTextArea, joined);

    storage.addHistoryEntry({
      ts_ms: Date.now(),
      host_id: hostId,
      sql_raw: trimmed,
      sql_formatted: joined,
    });

    return normalized;
  }

  function isFormatFailedError(err) {
    const code = err && err.code ? String(err.code) : "";
    const payloadCode = err && err.payload && err.payload.error_code ? String(err.payload.error_code) : "";
    return code === "format_failed" || payloadCode === "format_failed";
  }

  function buildFormatErrorText(err) {
    const payload = err && err.payload ? err.payload : null;
    const code = payload && payload.error_code ? String(payload.error_code) : err && err.code ? String(err.code) : "";
    const msg = payload && payload.message ? String(payload.message) : err instanceof Error ? String(err.message || "") : String(err || "");
    const clean = msg.trim();
    if (!code) return clean || "Format failed.";
    if (clean.toLowerCase().startsWith(code.toLowerCase() + ":")) return clean;
    return `${code}: ${clean || "Format failed."}`;
  }

  function showFormatFailure(err) {
    const msg = buildFormatErrorText(err);
    results.clearResultsStack();
    results.clearLiveResults();
    results.setError(msg);
    results.setStatus("error");
    setQueryStatusText("error");
    results.setResultsVisible(true);
    if (dom.liveResultsWrap) dom.liveResultsWrap.hidden = true;
  }

  function parseSseJson(ev) {
    try {
      return JSON.parse(ev.data);
    } catch {
      return null;
    }
  }

  function streamQuery(streamUrl) {
    return new Promise((resolve) => {
      let doneReceived = false;
      let sseErrorEventReceived = false;

      const es = new EventSource(streamUrl);
      activeEventSource = es;

      es.addEventListener("result_meta", (ev) => {
        const data = parseSseJson(ev);
        if (!data) return;
        const cols = Array.isArray(data.columns) ? data.columns : [];
        const types = Array.isArray(data.types) ? data.types : [];
        results.renderTableMeta(cols, types);
      });

      es.addEventListener("result_rows", (ev) => {
        const data = parseSseJson(ev);
        if (!data) return;
        results.appendRows(Array.isArray(data.rows) ? data.rows : []);
      });

      es.addEventListener("error", (ev) => {
        const data = parseSseJson(ev);
        sseErrorEventReceived = true;
        const msg = data && data.message ? String(data.message) : "Query error.";
        results.setError(msg);
        results.setStatus("error");
      });

      es.addEventListener("done", (ev) => {
        const data = parseSseJson(ev) || {};
        doneReceived = true;
        const st = data && data.status ? String(data.status) : "done";
        results.setStatus(st);
        closeActiveStream();
        resolve({ ...data, status: st });
      });

      es.onerror = () => {
        if (doneReceived || sseErrorEventReceived) return;
        const errVisible = dom.errorBanner && !dom.errorBanner.hidden && String(dom.errorBanner.textContent || "").trim().length > 0;
        if (errVisible) return;
        results.setError("Connection lost.");
        results.setStatus("error");
        closeActiveStream();
        resolve({ status: "error" });
      };
    });
  }

  function getLiveRowCount() {
    if (!dom.resultTableBody) return 0;
    return dom.resultTableBody.querySelectorAll("tr").length;
  }

  function getLiveColCount() {
    if (!dom.resultTableHead) return 0;
    const tr = dom.resultTableHead.querySelector("tr");
    if (!tr) return 0;
    return tr.querySelectorAll("th").length;
  }

  function statusLabel(status) {
    const s = String(status || "").toLowerCase();
    if (s === "finished") return "finished";
    if (s === "done") return "done";
    if (s === "error") return "error";
    if (s === "canceled" || s === "cancelled") return "canceled";
    return s || "-";
  }

  async function runOneStatement(statement) {
    const hostId = getSelectedHostId();
    const { queryId, cancelToken, streamUrl } = await api.runSql(hostId, statement);

    state.activeQueryId = queryId;
    state.cancelToken = cancelToken;

    setQueryIdText(queryId);
    setQueryStatusText("running");
    results.setStatus("running");

    const done = await streamQuery(streamUrl);

    const finalStatus = done && done.status ? String(done.status) : "done";
    setQueryStatusText(statusLabel(finalStatus));
    results.setStatus(finalStatus);

    state.activeQueryId = null;
    state.cancelToken = null;

    return done;
  }

  async function handleRun() {
    if (state.isRunning || state.isFormatting) return;

    results.setError("");
    ui && ui.closeRunMenu && ui.closeRunMenu({ immediate: false });

    const hostId = getSelectedHostId();
    if (!hostId) {
      results.setError("No host selected.");
      results.setStatus("error");
      return;
    }

    const raw = dom.queryTextArea ? dom.queryTextArea.value : "";
    const trimmed = String(raw || "").trim();
    if (!trimmed) {
      results.setError("Query is empty.");
      results.setStatus("error");
      return;
    }

    let statements = sql.splitSqlStatements(trimmed);
    if (!statements.length) {
      results.setError("Query is empty.");
      results.setStatus("error");
      return;
    }

    if (statements.length > 1 && !state.runOptMultiQuery) {
      results.setError("Multiquery is disabled. Enable “Allow multiquery” in the Run menu.");
      results.setStatus("error");
      return;
    }

    results.clearResultsStack();
    results.clearLiveResults();
    setQueryIdText(null);
    setQueryStatusText("running");

    if (statements.length > 1) {
      state.lastRunMode = "batch";
      results.setMultiqueryMode(true);
    } else {
      state.lastRunMode = "single";
      results.setMultiqueryMode(false);
    }

    setBusy({ running: true, formatting: false, batch: statements.length > 1 });
    state.batchStopRequested = false;

    try {
      if (state.runOptAutoFormat) {
        const formattedStatements = await formatEditorSql();
        statements = formattedStatements;
      }

      storage.addHistoryEntry({
        ts_ms: Date.now(),
        host_id: hostId,
        sql_raw: trimmed,
        sql_formatted: dom.queryTextArea ? dom.queryTextArea.value : trimmed,
      });

      if (statements.length === 1) {
        await runOneStatement(statements[0]);
        if (dom.liveResultsWrap) dom.liveResultsWrap.hidden = false;
        return;
      }

      const total = statements.length;

      for (let i = 0; i < total; i++) {
        if (state.batchStopRequested) break;

        results.clearLiveResults();
        setQueryIdText(null);
        setQueryStatusText(`running (${i + 1}/${total})`);

        const stmt = statements[i];
        const done = await runOneStatement(stmt);

        const st = done && done.status ? String(done.status) : "done";
        const rows = getLiveRowCount();
        const cols = getLiveColCount();
        const metaText = `${statusLabel(st)} · ${rows} rows · ${cols} cols`;

        const errVisible = dom.errorBanner && !dom.errorBanner.hidden && String(dom.errorBanner.textContent || "").trim().length > 0;
        const expandedByDefault = errVisible || ["error", "canceled", "cancelled"].includes(String(st).toLowerCase());

        const copyText = results.buildCopyJsonText();
        results.pushResultsBlock(`Query ${i + 1}/${total}`, metaText, copyText, { expandedByDefault });

        if (["error", "canceled", "cancelled"].includes(String(st).toLowerCase())) {
          state.batchStopRequested = true;
          break;
        }
      }

      results.hideLiveWrapIfStackHasBlocks();
      setQueryIdText(null);
      setQueryStatusText("done");
    } catch (err) {
      if (isFormatFailedError(err)) {
        showFormatFailure(err);
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        results.setError(msg);
        results.setStatus("error");
        setQueryStatusText("error");
        results.setResultsVisible(true);
      }
    } finally {
      closeActiveStream();
      state.cancelToken = null;
      state.activeQueryId = null;
      setBusy({ running: false, formatting: false, batch: false });
    }
  }

  async function handleFormat() {
    if (state.isRunning || state.isFormatting) return;

    results.setError("");
    const hostId = getSelectedHostId();
    if (!hostId) {
      results.setError("No host selected.");
      results.setStatus("error");
      return;
    }

    setBusy({ running: false, formatting: true, batch: false });

    try {
      await formatEditorSql();
    } catch (err) {
      showFormatFailure(err);
    } finally {
      setBusy({ running: false, formatting: false, batch: false });
    }
  }

  async function handleCancelOrClear() {
    if (state.isFormatting) return;

    if (!state.isRunning) {
      closeActiveStream();
      state.batchStopRequested = false;
      state.cancelToken = null;
      state.activeQueryId = null;
      state.lastRunMode = "single";
      results.setMultiqueryMode(false);
      results.clearResultsStack();
      results.clearLiveResults();
      setQueryIdText(null);
      setQueryStatusText("-");
      updateActionButtons();
      return;
    }

    state.batchStopRequested = true;

    const token = state.cancelToken;
    if (!token) {
      results.setError("No active query to cancel.");
      results.setStatus("error");
      return;
    }

    try {
      const ok = await api.cancelQuery(token);
      if (ok && state.isBatchRun) {
        results.setError("Query canceled successfully.");
        results.setStatus("canceled");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.setError(msg);
      results.setStatus("error");
    }
  }

  function init() {
    updateActionButtons();
    if (dom.runButton) dom.runButton.addEventListener("click", handleRun);
    if (dom.formatButton) dom.formatButton.addEventListener("click", handleFormat);
    if (dom.cancelButton) dom.cancelButton.addEventListener("click", handleCancelOrClear);
    if (dom.copyJsonButton) dom.copyJsonButton.addEventListener("click", handleCopyLiveJson);
  }

  ns.run = { init, handleRun, handleFormat, handleCancelOrClear, updateActionButtons };
})();