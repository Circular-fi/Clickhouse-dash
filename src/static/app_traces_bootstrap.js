(() => {
  "use strict";
  const base = (() => {
    if (typeof window.__chdashUrl === "function") return new URL(window.__chdashUrl("static/"), window.location.href).toString();
    const script = document.currentScript;
    return script && script.src ? script.src.replace(/[^/]*$/, "") : new URL("./static/", window.location.href).toString();
  })();
  const load = (name) => new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = base + name;
    el.async = false;
    el.onload = resolve;
    el.onerror = () => reject(new Error(`Failed to load ${name}`));
    document.head.appendChild(el);
  });
  const start = async () => {
    window.ChDash = window.ChDash || {};
    for (const name of ["app_dom.js", "app_state.js", "app_util.js", "app_api.js", "app_ui.js", "app_traces.js"]) await load(name);
    window.ChDash.ui?.init?.();
    window.ChDash.traces?.init?.();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => start().catch(console.error), { once: true });
  else start().catch(console.error);
})();
