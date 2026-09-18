(() => {
  "use strict";

  const bootstrap = () => {
    const ns = window.ChDash;
    if (!ns) return;

    const { ui, run, results, explorer, analysis, download, massExport } = ns;

    if (results) {
      results.clearResultsStack();
      results.clearLiveResults();
      results.setMultiqueryMode(false);
    }

    if (ui) ui.init();
    if (analysis) analysis.init();
    if (download) download.init();
    if (massExport) massExport.init();
    if (run) run.init();
    if (explorer) explorer.init();
  };

  const hasCore = () => {
    const ns = window.ChDash;
    return !!(ns && ns.dom && ns.ui && ns.run && ns.results && ns.api && ns.sql && ns.util && ns.storage && ns.pipelineViewer && ns.analysisData && ns.analysis && ns.download && ns.massExport && ns.explorerGraph && ns.explorer);
  };

  // Capture the bootstrap script location while document.currentScript is
  // still defined. start() runs after DOMContentLoaded, where currentScript is
  // null; recomputing it there used to make deep Explorer routes load the app
  // shell as JavaScript. The browser-visible base path remains authoritative so
  // reverse-proxy subpaths work without backend configuration.
  const bootstrapBaseUrl = (() => {
    if (typeof window.__chdashUrl === "function") {
      // __chdashUrl intentionally returns a root-relative path so it can also be
      // used directly by fetch(), <link> and <script>. URL(), however, requires
      // an absolute base URL. Resolve the detected mount path against the current
      // absolute document URL before using it as the module-loader base.
      return new URL(window.__chdashUrl("static/"), window.location.href).toString();
    }
    const script = document.currentScript;
    if (script && script.src) return script.src.replace(/[^/]*$/, "");
    return new URL("./static/", window.location.href).toString();
  })();

  const getBaseUrl = () => bootstrapBaseUrl;

  const loadScript = (src) =>
    new Promise((resolve, reject) => {
      const el = document.createElement("script");
      el.src = src;
      el.async = false;
      el.onload = () => resolve();
      el.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(el);
    });

  const ensureLoaded = async () => {
    if (hasCore()) return;

    const base = getBaseUrl();
    const files = [
      "app_dom.js",
      "app_state.js",
      "app_util.js",
      "app_sql.js",
      "app_api.js",
      "app_meta.js",
      "app_highlight.js",
      "app_autocomplete.js",
      "app_results.js",
      "app_ui.js",
      "app_trace_viewer.js",
      "app_pipeline_viewer.js",
      "app_analysis_data.js",
      "app_analysis.js",
      "app_download.js",
      "app_export.js",
      "app_run.js",
      "app_explorer_graph.js",
      "app_explorer.js",
    ];

    for (const f of files) {
      if (hasCore()) break;
      const url = new URL(f, base).toString();
      await loadScript(url);
    }
  };

  const start = async () => {
    try {
      await ensureLoaded();
      bootstrap();
    } catch (e) {
      console.error(e);
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
