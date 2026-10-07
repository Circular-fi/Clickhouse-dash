(() => {
  "use strict";
  // A System page (docs/system.md): the selected server, one section per page, a row of links to
  // the sections under the header (app_system_view.js):
  //
  //   /system[?from=&to=]                  Overview (system.html): the charts' time range
  //   /system/queries[?from=&to=&sort=&kind=&hide=0&runs=]   (queries.html)
  //   /system/disks[?from=&to=]                              (disks.html)
  //
  // Each page loads its own section's module (src/static/modules.json) and each section keeps
  // its own parameters; Back / Forward walk the browser's history, from page to page and, within
  // a page, from one query string to the next. One query shape is a page of its own too
  // (shape.html, app_shape_page.js). The former Explorer addresses
  // (/explorer/_monitoring[/<section>], /explorer/_operations) answer a redirect here
  // (server.cpp redirect_to_system).
  //
  // This controller starts the page's modules (through ns.loader), the header (ns.ui.init: host
  // picker, page switcher, theme) and the view; a host change refreshes the section on screen.
  window.ChDash = window.ChDash || {};
  const ns = window.ChDash;
  const ROUTE = "/system";
  // The page names of modules.json, and the section each one is.
  const SECTION_OF = { system: "overview", queries: "queries", disks: "disks" };
  const SECTION = SECTION_OF[ns.loader.page.name] || "overview";

  const router = () => ns.router;

  const sectionPath = () => (SECTION === "overview" ? ROUTE : `${ROUTE}/${SECTION}`);

  // The address of the section with its query, as a replace (the page's own address is the
  // section's: a change of parameters) or a push (a new search).
  function writeAddress(query, history) {
    const href = `${router().url(sectionPath())}${query ? `?${query}` : ""}`;
    router().write(history, null, { href, view: "system" });
  }

  let shownQuery = "";

  function show(query) {
    shownQuery = String(query || "");
    ns.systemView.show(ns.dom.byId("systemPage"), {
      section: SECTION,
      query: shownQuery,
      links: true,
      onQuery: (nextQuery, { history: mode = "push" } = {}) => {
        shownQuery = String(nextQuery || "");
        writeAddress(shownQuery, mode);
      },
      // A shape of the list: its own page (shape.html), with the list's
      // parameters; replace: the former /system/queries?q=<hash> address.
      onOpenShape: (hash, { replace = false } = {}) => {
        const params = new URLSearchParams(shownQuery);
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
  }

  // A database's Explorer page (tab: "storage" scrolls to its storage).
  function databaseHref(database, { tab = "" } = {}) {
    const path = `/explorer/${encodeURIComponent(String(database || ""))}${tab ? `?tab=${encodeURIComponent(tab)}` : ""}`;
    return router().url(path);
  }

  // Back / Forward within the page: another query string of the section.
  function onPopState() {
    const query = router().current().params.toString();
    if (query !== shownQuery) show(query);
  }

  // The links to the sections the server offers: Queries only with system.top_queries.
  function renderRow() {
    const f = ns.features.get("system");
    for (const link of ns.dom.$$("#systemTabs [data-section]")) {
      link.hidden = link.getAttribute("data-section") === "queries" && f?.top_queries === false;
    }
  }

  function bindShell() {
    const dom = ns.dom || {};
    const route = (path) => ns.api.resolveUrl(path);
    ns.ui?.setPageSelectorValue?.("system");
    dom.navQueryButton?.addEventListener("click", () => window.location.assign(route("query")));
    dom.navExplorerButton?.addEventListener("click", () => window.location.assign(route("explorer")));
    router().on(ROUTE, onPopState);
    // Another host: the section on screen reads it.
    window.addEventListener("chdash:host-changed", () => ns.systemView?.refresh?.(false));
    // A section a new answer of /api/version turns off (Queries without
    // system.top_queries) leaves for Overview.
    ns.features?.on?.(() => {
      if (!ns.features.get("system.enabled")) return; // app_ui.js leaves the page
      renderRow();
      if (SECTION !== "overview" && !ns.systemView.sections().includes(SECTION)) window.location.replace(route("system"));
    });
  }

  async function start() {
    await ns.loader.startModules();
    bindShell();
    ns.ui?.init?.();
    renderRow();
    show(router().current().params.toString());
    // The entry carries the router's state (its view) from the first paint on; the address, its
    // fragment (#performance) included, stays as it is.
    router().write("replace", null, { href: router().href(), view: "system" });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => start().catch(console.error), { once: true });
  else start().catch(console.error);
})();
