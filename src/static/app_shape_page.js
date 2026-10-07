(() => {
  "use strict";
  // The page of one query shape (shape.html, /system/queries/<hash>): a page
  // of its own, not a view of the System page. It has the page header, but
  // not the System section tabs (Overview, Queries, Disks) nor the list of
  // shapes: the Queries section (app_system_queries.js) runs on the one
  // shape, with the time range and the refresh button of its filter bar.
  //
  //   /system/queries/<hash>[?from=&to=&runs=<order>&<the list's parameters>]
  //
  // The address keeps the list's parameters (sort, kind, errors, user,
  // database, table, hide) from the list the shape was opened from, so "All
  // queries" returns to that list: to the very list entry (the browser
  // restores that page as it was left, or reads it again) when the shape was
  // opened from it, else to the list of those parameters. The former address
  // of a shape, /system/queries?q=<hash>, opens this page (the server
  // redirects it; the Queries section does when the server is a proxy away).
  window.ChDash = window.ChDash || {};
  const LIST_ROUTE = "/system/queries";
  const SHAPE_PATH = /^\/system\/queries\/(\d{1,20})\/?$/;

  const router = () => window.ChDash.router;

  const hashOf = (path = router().current().path) => SHAPE_PATH.exec(String(path || ""))?.[1] || "";

  function href(path, params) {
    const query = params.toString();
    return `${router().url(path)}${query ? `?${query}` : ""}`;
  }

  // The list's parameters of the address: everything but the shape's own.
  function listParams() {
    const params = new URLSearchParams(router().current().params);
    params.delete("runs");
    return params;
  }

  const listHref = () => href(LIST_ROUTE, listParams());

  // The list page is the entry right before this one: marked on the entry
  // itself, so a reload keeps it (the referrer and the entry state both
  // survive one). state.listBack counts the entries this page pushed since.
  function markOpenedFromList() {
    if (Number(router().state().listBack) > 0 || !document.referrer) return;
    let from;
    try { from = new URL(document.referrer); } catch (_) { return; }
    if (from.origin !== window.location.origin) return;
    if (router().path(from.pathname).replace(/\/+$/, "") !== LIST_ROUTE) return;
    router().replace(null, { href: router().href(), state: { listBack: 1 } });
  }

  function back() {
    const steps = Number(router().state().listBack) || 0;
    if (steps > 0) router().back(steps);
    else window.location.assign(listHref());
  }

  // The address of the shape with the section's parameters (its range, the
  // runs' order and the list's filters).
  function writeAddress(query, history) {
    const steps = Number(router().state().listBack) || 0;
    const state = steps > 0 && history === "push" ? { listBack: steps + 1 } : undefined;
    router().write(history, null, { href: href(`${LIST_ROUTE}/${hashOf()}`, new URLSearchParams(query)), view: "shape", state });
  }

  // Another shape: its own page (the list's parameters travel with it).
  function openShape(hash, { replace = false } = {}) {
    const target = href(`${LIST_ROUTE}/${encodeURIComponent(hash)}`, router().current().params);
    if (replace) window.location.replace(target);
    else window.location.assign(target);
  }

  function show() {
    const ns = window.ChDash;
    ns.systemView.show(ns.dom.byId("systemPage"), {
      section: "queries",
      shape: hashOf(),
      query: router().current().params.toString(),
      onQuery: (query, { history: mode = "push" } = {}) => writeAddress(query, mode),
      onOpenShape: openShape,
      onBack: back,
      // "Open in Query": the Query page's editor, through the session draft the
      // Query page reads on load. Never run.
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

  // Back / Forward within the shape's page: its range or runs' order.
  function onPopState() {
    if (hashOf()) show();
  }

  function bindShell() {
    const ns = window.ChDash;
    const dom = ns.dom || {};
    const route = (path) => ns.api.resolveUrl(path);
    ns.ui?.setPageSelectorValue?.("system");
    dom.navQueryButton?.addEventListener("click", () => window.location.assign(route("query")));
    dom.navExplorerButton?.addEventListener("click", () => window.location.assign(route("explorer/catalog")));
    router().on("/system", onPopState);
    // Another host: the shape on screen reads it.
    window.addEventListener("chdash:host-changed", () => ns.systemView?.refresh?.(false));
    // Queries turned off (system.top_queries): the System page is what is left.
    ns.features?.on?.(() => {
      if (!ns.features.get("system.enabled")) return; // app_ui.js leaves the page
      if (!ns.systemView.sections().includes("queries")) window.location.replace(route("system"));
    });
  }

  async function start() {
    const ns = window.ChDash;
    await ns.loader.startModules();
    bindShell();
    ns.ui?.init?.();
    if (!hashOf()) {
      window.location.replace(router().url("/system/queries"));
      return;
    }
    markOpenedFromList();
    show();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => start().catch(console.error), { once: true });
  else start().catch(console.error);
})();
