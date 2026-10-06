(() => {
  "use strict";
  // The System page (system.html, docs/system.md): the selected server, its
  // sections as underlined tabs under the header (app_system_view.js):
  //
  //   /system[?from=&to=]                  Overview (the charts' time range)
  //   /system/queries[?from=&to=&sort=&kind=&hide=0&q=<hash>&runs=]
  //   /system/disks[?from=&to=]
  //
  // A section tab is a history entry (Back / Forward switch back); each
  // section keeps its own parameters. The former Explorer addresses
  // (/explorer/_monitoring[/<section>], /explorer/_operations) answer a
  // redirect here (server.cpp redirect_to_system).
  //
  // This controller starts the page's modules (src/static/modules.json,
  // through ns.loader), the header (ns.ui.init: host picker, page switcher,
  // theme) and the view; a host change refreshes the section on screen.
  window.ChDash = window.ChDash || {};
  const SECTIONS = ["overview", "queries", "disks"];
  const DEFAULT_SECTION = "overview";
  const ROUTE = "/system";

  const router = () => window.ChDash.router;

  // "queries" for /system/queries, "" for /system (Overview) or a section
  // this page does not know (it falls back to Overview).
  function sectionFromPath(path) {
    const match = /^\/system\/([^/?#]+)\/?$/.exec(String(path || ""));
    const name = match ? decodeURIComponent(match[1]).toLowerCase() : "";
    return SECTIONS.includes(name) ? name : "";
  }

  function sectionPath(section) {
    return section && section !== DEFAULT_SECTION ? `${ROUTE}/${encodeURIComponent(section)}` : ROUTE;
  }

  function currentRoute() {
    const route = router().current();
    return { section: sectionFromPath(route.path) || DEFAULT_SECTION, query: route.params.toString(), named: sectionFromPath(route.path) || (route.path.replace(/\/+$/, "") === ROUTE ? DEFAULT_SECTION : "") };
  }

  // The address of `section` with its query; history "push" (a tab, a range)
  // or "replace" (a fallback).
  function writeAddress(section, query, history) {
    const href = `${router().url(sectionPath(section))}${query ? `?${query}` : ""}`;
    router().write(history, null, { href, view: "system" });
  }

  let shown = { section: "", query: "" };

  function show(section, query, { history = "none" } = {}) {
    const ns = window.ChDash;
    shown = { section, query };
    ns.systemView.show(ns.dom.byId("systemPage"), {
      section,
      query,
      onSection: (next, { history: mode = "push", query: nextQuery = "" } = {}) => {
        shown = { section: next, query: String(nextQuery || "") };
        writeAddress(next, shown.query, mode);
      },
      onQuery: (nextQuery, { history: mode = "push" } = {}) => {
        shown = { ...shown, query: String(nextQuery || "") };
        writeAddress(shown.section, shown.query, mode);
      },
      // A shape of the list: its own page (shape.html), with the list's
      // parameters; replace: the former /system/queries?q=<hash> address.
      onOpenShape: (hash, { replace = false } = {}) => {
        const params = new URLSearchParams(shown.query);
        params.delete("q");
        const query = params.toString();
        const target = `${router().url(`${ROUTE}/queries/${encodeURIComponent(hash)}`)}${query ? `?${query}` : ""}`;
        if (replace) window.location.replace(target);
        else window.location.assign(target);
      },
      // A table of the Activity: its card in the Explorer.
      onOpenTable: (database, table) => {
        window.location.assign(router().url(`/explorer/${encodeURIComponent(database)}/${encodeURIComponent(table)}`));
      },
      onOpenDatabase: (database, options = {}) => {
        window.location.assign(databaseHref(database, options));
      },
      databaseHref,
      // "Open in Query" (Queries): the Query page's editor, through the
      // session draft the Query page reads on load. Never run.
      onOpenSql: async (sql, { formatted = true } = {}) => {
        let text = String(sql || "");
        if (formatted) {
          const out = await ns.api.formatSqls(ns.state.selectedHostId, [text]);
          if (!Array.isArray(out) || !out.length || !String(out[0] || "").trim()) throw new Error("Formatter returned an empty query.");
          text = out[0];
        }
        ns.storage.pref(ns.storage.KEYS.editorDraft, "", { session: true }).set(text);
        window.location.assign(router().url("/query"));
      },
    });
    if (history !== "none") writeAddress(section, query, history);
  }

  // A database's Explorer page (tab: "storage" scrolls to its storage).
  function databaseHref(database, { tab = "" } = {}) {
    const path = `/explorer/${encodeURIComponent(String(database || ""))}${tab ? `?tab=${encodeURIComponent(tab)}` : ""}`;
    return router().url(path);
  }

  // Back / Forward: the entry's section, with its parameters.
  function onPopState() {
    const route = currentRoute();
    if (route.section === shown.section && route.query === shown.query) return;
    show(route.section, route.query);
  }

  function bindShell() {
    const ns = window.ChDash;
    const dom = ns.dom || {};
    const route = (path) => ns.api.resolveUrl(path);
    ns.ui?.setPageSelectorValue?.("system");
    dom.navQueryButton?.addEventListener("click", () => window.location.assign(route("query")));
    dom.navExplorerButton?.addEventListener("click", () => window.location.assign(route("explorer")));
    router().on(ROUTE, onPopState);
    // Another host: the section on screen reads it.
    window.addEventListener("chdash:host-changed", () => ns.systemView?.refresh?.(false));
    // A section a new answer of /api/version turns off (Queries without
    // system.top_queries) falls back to Overview.
    ns.features?.on?.(() => {
      if (!ns.features.get("system.enabled")) return; // app_ui.js leaves the page
      if (shown.section && !ns.systemView.sections().includes(shown.section)) show(DEFAULT_SECTION, "", { history: "replace" });
    });
  }

  async function start() {
    const ns = window.ChDash;
    await ns.loader.startModules();
    bindShell();
    ns.ui?.init?.();
    const route = currentRoute();
    // An unknown section (/system/whatever): Overview, on its own address.
    show(route.section, route.query, { history: route.named ? "none" : "replace" });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => start().catch(console.error), { once: true });
  else start().catch(console.error);
})();
