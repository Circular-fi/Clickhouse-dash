(() => {
  "use strict";

  const ns = window.ChDash;
  if (!ns) return;

  const { dom, state, api, sql, results, ui } = ns;
  let preparing = false;

  function setPreparing(value) {
    preparing = !!value;
    if (ns.run && typeof ns.run.updateActionButtons === "function") ns.run.updateActionButtons();
    else updateButtons();
  }

  function updateButtons() {
    if (ns.run && typeof ns.run.updateActionButtons === "function") ns.run.updateActionButtons();
  }

  function isPreparing() {
    return preparing;
  }

  function reportError(message) {
    if (results && typeof results.setError === "function") results.setError(message == null ? "" : String(message));
  }

  function triggerDownload(url, format, multi) {
    const anchor = document.createElement("a");
    anchor.href = String(url || "");
    anchor.download = multi ? "queries.zip" : "query.zip";
    anchor.rel = "noopener";
    anchor.dataset.exportFormat = format;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }

  async function prepareQueries() {
    const hostId = state.selectedHostId ? String(state.selectedHostId) : "";
    if (!hostId) throw new Error("No host selected.");

    const raw = dom.queryTextArea ? String(dom.queryTextArea.value || "") : "";
    if (!raw.trim()) throw new Error("Query is empty.");

    let statements = sql.splitSqlStatements(raw.trim());
    if (!statements.length) throw new Error("Query is empty.");
    if (statements.length > 1 && !state.runOptMultiQuery) {
      throw new Error("Multiquery is disabled. Enable “Allow multiquery” in Run settings.");
    }

    if (state.runOptAutoFormat) {
      statements = await api.formatSqls(hostId, statements);
    }
    return { hostId, statements };
  }

  async function start(format) {
    if (preparing || state.isRunning || state.isFormatting) return;
    if (state.apiOnline === false) {
      reportError("API is offline.");
      return;
    }
    const normalizedFormat = String(format || "").toLowerCase();
    if (normalizedFormat !== "csv" && normalizedFormat !== "json") return;

    setPreparing(true);
    if (ui && typeof ui.closeRunMenu === "function") ui.closeRunMenu({ immediate: false });
    reportError("");

    try {
      const { hostId, statements } = await prepareQueries();
      const prepared = await api.prepareExport(hostId, normalizedFormat, statements);
      if (!prepared || typeof prepared.downloadUrl !== "string" || !prepared.downloadUrl) {
        throw new Error("Invalid export handshake response.");
      }
      triggerDownload(prepared.downloadUrl, normalizedFormat, statements.length > 1);
    } catch (error) {
      reportError(error instanceof Error ? error.message : "Export failed.");
    } finally {
      setPreparing(false);
    }
  }

  function init() {
    // The Run menu now executes through the normal query session so live stats
    // remain visible and Debug uses the same post-run archive implementation as
    // the Results menu. Keep the streamed export API available for external/API
    // callers, but do not attach it to these UI buttons.
    updateButtons();
  }

  ns.massExport = { init, start, isPreparing, updateButtons };
})();
