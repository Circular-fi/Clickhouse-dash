(() => {
  "use strict";
  // ns.loader: the one script loader of every page shell.
  //
  // The module lists live in src/static/modules.json; tools/build_page_css.py
  // copies the page's entry into its shell as <script type="application/json"
  // id="chdashModules"> (no request before the first module), and the shell
  // starts this file and the page controller it names (pages.<page>.bootstrap).
  //
  //   ns.loader.page             { name, common, modules, lazy, views } of this page
  //   ns.loader.url(file)        the absolute URL of a static file (reverse-proxy subpaths included; ?v=<hash> on a build's)
  //   ns.loader.load(files)      Promise: every file has run, in list order; each file loads once
  //   ns.loader.startModules()   load(common + modules): what the controller runs on
  //   ns.loader.loadGroup(name)  load(lazy[name] or views[name]): a group loaded on first use
  //
  // Scripts are inserted with async = false: they download in parallel and run
  // in insertion order, so a list keeps its order without waiting for each
  // file in turn.
  const ns = (window.ChDash = window.ChDash || {});
  if (ns.loader) return;

  const page = (() => {
    try {
      const raw = document.getElementById("chdashModules")?.textContent || "";
      const entry = raw ? JSON.parse(raw) : null;
      if (entry && typeof entry === "object") return entry;
    } catch (error) {
      console.error(error);
    }
    return { name: document.body?.dataset.page || "", common: [], modules: [], lazy: {}, views: {} };
  })();

  // Resolved now: document.currentScript is null once the page has started,
  // and __chdashUrl (the shell head script) returns a root-relative path.
  const base = (() => {
    if (typeof window.__chdashUrl === "function") return new URL(window.__chdashUrl("static/"), window.location.href).toString();
    const script = document.currentScript;
    if (script && script.src) return script.src.replace(/[^/]*$/, "");
    return new URL("./static/", window.location.href).toString();
  })();

  // The staged shells carry each script's content hash (tools/stage_static.py): the address with it
  // never changes content, so the browser keeps the file without asking again.
  const versions = window.__chdashAssetVersions || {};
  const url = (file) => {
    const name = String(file || "");
    const out = new URL(name, base);
    const hash = versions[`static/${name}`];
    if (hash) out.searchParams.set("v", hash);
    return out.toString();
  };

  const loads = new Map();
  function loadOne(file) {
    let loading = loads.get(file);
    if (!loading) {
      loading = new Promise((resolve, reject) => {
        const el = document.createElement("script");
        el.src = url(file);
        el.async = false;
        // Settled once: the handlers are dropped with the outcome, so a page does not keep two
        // listeners per script it ran (56 to 78 on a page).
        el.onload = () => {
          el.onload = el.onerror = null;
          resolve();
        };
        el.onerror = () => {
          el.onload = el.onerror = null;
          loads.delete(file);
          reject(new Error(`Failed to load ${file}`));
        };
        document.head.appendChild(el);
      });
      loads.set(file, loading);
    }
    return loading;
  }

  // Already-running files (the shell starts this one and the controller).
  for (const file of ["app_loader.js", page.bootstrap]) if (file) loads.set(file, Promise.resolve());

  const load = (files) => Promise.all((Array.isArray(files) ? files : []).map(loadOne)).then(() => undefined);
  const startModules = () => load([...(page.common || []), ...(page.modules || [])]);
  const group = (name) => page.lazy?.[name] || page.views?.[name] || [];
  const loadGroup = (name) => load(group(name));

  ns.loader = Object.freeze({ page, base: () => base, url, load, startModules, group, loadGroup });
})();
