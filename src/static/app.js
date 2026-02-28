(() => {
  "use strict";

  const bootstrap = () => {
    const ns = window.ChDash;
    if (!ns) return;

    const { ui, run, results } = ns;

    if (results) {
      results.clearResultsStack();
      results.clearLiveResults();
      results.setMultiqueryMode(false);
    }

    if (ui) ui.init();
    if (run) run.init();
  };

  const hasCore = () => {
    const ns = window.ChDash;
    return !!(ns && ns.dom && ns.ui && ns.run && ns.results && ns.api && ns.sql && ns.utils);
  };

  const getBaseUrl = () => {
    const s = document.currentScript;
    if (s && s.src) return s.src.replace(/[^/]*$/, "");
    return "/static/";
  };

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
      "app_utils.js",
      "app_sql.js",
      "app_api.js",
      "app_results.js",
      "app_ui.js",
      "app_run.js",
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
