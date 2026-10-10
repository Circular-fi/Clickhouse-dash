(() => {
  "use strict";

  const bootstrap = () => {
    const ns = window.ChDash;
    if (!ns) return;

    const { header, meta, queryUi, run, results, explorer, analysis, download } = ns;

    if (results) {
      results.clearResultsStack();
      results.clearLiveResults();
      results.setMultiqueryMode(false);
    }

    // The order is the order of the host hooks (header.onHostSelected): the metadata, the editor, the Run buttons.
    header.init();
    meta.init();
    if (queryUi) {
      queryUi.init({ onRun: () => run.handleRun() });
      meta.ensureHighlighterData();
    }
    if (analysis) analysis.init();
    if (download) download.init();
    if (run) run.init();
    if (explorer) explorer.init();
  };

  // The page's modules (src/static/modules.json, through ns.loader): Query
  // has no Explorer graph or storage treemap; Explorer has no editor, Run
  // controls, downloads, profiling dialog, modal dialogs, result charts or
  // query library. Every module a page loads costs its source, compiled code
  // and the stylesheet rules it can use (tools/build_page_css.py reads the
  // same manifest).
  const ensureLoaded = () => {
    const loader = window.ChDash?.loader;
    if (!loader) return Promise.reject(new Error("app_loader.js is missing"));
    return loader.startModules();
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
