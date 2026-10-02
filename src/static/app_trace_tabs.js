(() => {
  "use strict";
  // Tabs of the Traces search view: "Search" (the result list) and the tabs
  // other modules register with ns.traceTabs.register(). They sit in the
  // Observability tab row (#tracesTabs in #obsNav, after the view tabs, in
  // the same view tab row: .viewTabs, app_ui_tabs.js). Every tab shares
  // the search bar (time range, filters and chips); the selected tab lives in
  // the URL as ?tab=<id> next to the search parameters (app_trace_search.js
  // calls writeParams / applyParams), and the Search button runs the selected
  // tab's search.
  //
  //   register({ id, label, order, panelId, install(ctx), onSearch(filters, options), onShow(), onHide(),
  //              available(meta), params, writeParams(params), applyParams(params, { initial }) })
  //
  // onSearch replaces the result list search while the tab is selected;
  // onShow runs when the tab becomes visible from a click or Back / Forward.
  // available(meta) false hides the tab (/api/traces/meta decides, e.g. the
  // Services view needs traces.analytics). params lists the tab's own URL
  // parameters that only change what it shows (not a new search: they are
  // left out of the search key); writeParams / applyParams write and read the
  // tab's URL state while it is selected.
  const ns = window.ChDash;
  if (!ns) return;

  const SEARCH_TAB = "search";
  const tabs = [{ id: SEARCH_TAB, label: "Search", order: 0, panelSelector: ".traceSearchBody" }];
  let current = SEARCH_TAB;
  let ctx = null;
  let meta = null;

  const byId = (id) => document.getElementById(id);
  const find = (id) => tabs.find((tab) => tab.id === id) || null;
  const available = (tab) => !!tab && (!meta || typeof tab.available !== "function" || tab.available(meta) !== false);
  const valid = (id) => (available(find(id)) ? id : SEARCH_TAB);

  function panelOf(tab) {
    if (tab.panelId) return byId(tab.panelId);
    return tab.panelSelector ? document.querySelector(tab.panelSelector) : null;
  }

  function register(tab) {
    if (!tab || !tab.id || find(tab.id)) return;
    tabs.push({ order: tabs.length * 10, ...tab });
    tabs.sort((a, b) => a.order - b.order);
    if (ctx) {
      find(tab.id).install?.(ctx);
      render();
    }
  }

  function render() {
    const bar = byId("tracesTabs");
    if (!bar) return;
    const shown = tabs.filter(available);
    bar.hidden = shown.length < 2;
    ns.tabs?.render(bar, shown.map((tab) => ({ value: tab.id, label: tab.label, id: `tracesTab-${tab.id}`, controls: tab.panelId || "" })), { attr: "traceTab", tier: "view", selected: current });
    // A narrow window scrolls the tab row sideways: keep the selected tab in view.
    const row = bar.parentElement;
    const active = bar.querySelector(".is-active");
    if (active && row && row.scrollWidth > row.clientWidth) active.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  // Shows `id` without side effects (no URL write, no search).
  function show(id) {
    const next = valid(id);
    const previous = current;
    current = next;
    for (const tab of tabs) {
      const panel = panelOf(tab);
      if (panel) panel.hidden = tab.id !== next;
      document.documentElement.classList.toggle(`chdash-trace-tab-${tab.id}`, tab.id === next && tab.id !== SEARCH_TAB);
    }
    byId("tracesSearchView")?.classList.toggle("is-alt-tab", next !== SEARCH_TAB);
    render();
    if (previous !== next) find(previous)?.onHide?.();
    return previous !== next;
  }

  function activate(id) {
    if (id === SEARCH_TAB) ctx?.showSearch?.();
    else find(id)?.onShow?.();
  }

  // A tab click: its own history entry, then the tab refreshes if needed.
  // activate: false only switches the panels (a caller that searches next).
  function select(id, { url = "push", activate: run = true } = {}) {
    if (!show(id)) return;
    if (url !== "none") ns.traceSearch?.writeUrl?.(url);
    if (run) activate(current);
  }

  // From the URL (page load, Back / Forward). The page-load search runs the
  // selected tab's search itself, and so does Back / Forward to the Search
  // tab (app_traces.js backToSearch); another tab refreshes if it is stale.
  function applyParams(params, { initial = false } = {}) {
    const changed = show(params.get("tab") || SEARCH_TAB);
    find(current)?.applyParams?.(params, { initial });
    if (changed && !initial && current !== SEARCH_TAB) queueMicrotask(() => activate(current));
  }

  function writeParams(params) {
    if (current !== SEARCH_TAB) params.set("tab", current);
    find(current)?.writeParams?.(params);
  }

  // /api/traces/meta answered: hide the tabs it does not enable (a selected
  // one falls back to Search).
  function onMeta(value) {
    meta = value || null;
    if (current !== SEARCH_TAB && !available(find(current))) {
      show(SEARCH_TAB);
      ns.traceSearch?.writeUrl?.("replace");
    }
    render();
  }

  // Every tab's view-only URL parameters (left out of the search key).
  function viewParams() {
    return tabs.flatMap((tab) => tab.params || []);
  }

  function hasParams(params) {
    return params.has("tab") || viewParams().some((name) => params.has(name));
  }

  // The selected tab's search, or null for the result list.
  function activeSearch() {
    return current === SEARCH_TAB ? null : find(current)?.onSearch || null;
  }

  function install(context) {
    ctx = context;
    // Click, arrows, Home / End: the shared tab behaviour (app_ui_tabs.js).
    ns.tabs?.bind(byId("tracesTabs"), { attr: "traceTab", onSelect: (id) => select(id) });
    for (const tab of tabs) tab.install?.(ctx);
    render();
  }

  ns.traceTabs = {
    register,
    install,
    select,
    applyParams,
    writeParams,
    activeSearch,
    onMeta,
    viewParams,
    hasParams,
    current: () => current,
    context: () => ctx,
  };
})();
