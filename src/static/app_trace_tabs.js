(() => {
  "use strict";
  // Tabs of the Traces page search view: "Search" (the result list) and the
  // tabs other modules register with ns.traceTabs.register(). Every tab shares
  // the search bar (time range, filters and chips); the selected tab lives in
  // the URL as ?tab=<id> next to the search parameters (app_trace_search.js
  // calls writeParams / applyParams), and the Search button runs the selected
  // tab's search.
  //
  //   register({ id, label, order, panelId, onSearch(filters, options), onShow(), onHide() })
  //
  // onSearch replaces the result list search while the tab is selected;
  // onShow runs when the tab becomes visible from a click or Back / Forward.
  const ns = window.ChDash;
  if (!ns) return;

  const SEARCH_TAB = "search";
  const tabs = [{ id: SEARCH_TAB, label: "Search", order: 0, panelSelector: ".traceSearchBody" }];
  let current = SEARCH_TAB;
  let ctx = null;

  const byId = (id) => document.getElementById(id);
  const find = (id) => tabs.find((tab) => tab.id === id) || null;
  const valid = (id) => (find(id) ? id : SEARCH_TAB);

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
    bar.hidden = tabs.length < 2;
    bar.innerHTML = tabs.map((tab) => {
      const selected = tab.id === current;
      return `<button type="button" class="traceTabs__tab${selected ? " is-active" : ""}" role="tab" id="tracesTab-${tab.id}" data-trace-tab="${tab.id}" aria-selected="${selected}" tabindex="${selected ? 0 : -1}"${tab.panelId ? ` aria-controls="${tab.panelId}"` : ""}>${ctx ? ctx.esc(tab.label) : tab.label}</button>`;
    }).join("");
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
    if (changed && !initial && current !== SEARCH_TAB) queueMicrotask(() => activate(current));
  }

  function writeParams(params) {
    if (current !== SEARCH_TAB) params.set("tab", current);
  }

  // The selected tab's search, or null for the result list.
  function activeSearch() {
    return current === SEARCH_TAB ? null : find(current)?.onSearch || null;
  }

  function onKeydown(event) {
    const target = event.target instanceof Element ? event.target.closest("[data-trace-tab]") : null;
    if (!target || (event.key !== "ArrowRight" && event.key !== "ArrowLeft")) return;
    event.preventDefault();
    const at = tabs.findIndex((tab) => tab.id === target.getAttribute("data-trace-tab"));
    const next = tabs[(at + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
    select(next.id);
    byId(`tracesTab-${next.id}`)?.focus();
  }

  function install(context) {
    ctx = context;
    const bar = byId("tracesTabs");
    bar?.addEventListener("click", (event) => {
      const button = event.target instanceof Element ? event.target.closest("[data-trace-tab]") : null;
      if (button) select(button.getAttribute("data-trace-tab"));
    });
    bar?.addEventListener("keydown", onKeydown);
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
    current: () => current,
    context: () => ctx,
  };
})();
