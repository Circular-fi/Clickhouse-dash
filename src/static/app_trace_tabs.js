// Tabs of the Traces search view: "Search" (the result list) and the tabs
// that other modules register with ns.traceTabs.register().
// The tabs sit in the Observability tab row (#tracesTabs in #obsNav).
// They come after the view tabs, in the same underline row (.contentTabs--nav, app_ui_tabs.js).
//
// Every tab uses the search bar (time range, filters and chips).
// The selected tab is in the URL as ?tab=<id>, next to the search parameters.
// app_trace_search.js calls writeParams / applyParams.
// The Search button runs the search of the selected tab.
//
//   register({ id, label, order, panelId, init(), onSearch(filters, options), onShow(), onHide(),
//              available(meta), params, writeParams(params), applyParams(params, { initial }) })
//
// onSearch replaces the result list search while the tab is selected.
// onShow runs when the tab becomes visible from a click, or from Back / Forward.
//
// available(meta) false hides the tab. /api/traces/meta decides this.
// For example, the Services view needs traces.analytics.
// params lists the URL parameters of the tab. These parameters only change the view.
// They are not a new search, so they are left out of the search key.
// writeParams / applyParams write and read the URL state of the tab while the tab is selected.

import { dom, shell } from "./app_dom.js";
import { actions, address } from "./app_trace_store.js";
import { tabs as tabsMod } from "./app_ui_tabs.js";

const SEARCH_TAB = "search";
const tabs = [{ id: SEARCH_TAB, label: "Search", order: 0, panelSelector: ".traceSearchBody" }];
let current = SEARCH_TAB;
let started = false;
let meta = null;

const { byId, $ } = dom;
const find = (id) => tabs.find((tab) => tab.id === id) || null;
const available = (tab) => !!tab && (!meta || typeof tab.available !== "function" || tab.available(meta) !== false);
const valid = (id) => (available(find(id)) ? id : SEARCH_TAB);

function panelOf(tab) {
  if (tab.panelId) return byId(tab.panelId);
  return tab.panelSelector ? $(tab.panelSelector) : null;
}

function register(tab) {
  if (!tab || !tab.id || find(tab.id)) return;
  tabs.push({ order: tabs.length * 10, ...tab });
  tabs.sort((a, b) => a.order - b.order);
  if (started) {
    find(tab.id).init?.();
    render();
  }
}

function render() {
  const bar = byId("tracesTabs");
  if (!bar) return;
  const shown = tabs.filter(available);
  bar.hidden = shown.length < 2;
  tabsMod?.render(bar, shown.map((tab) => ({ value: tab.id, label: tab.label, id: `tracesTab-${tab.id}`, controls: tab.panelId || "" })), { attr: "traceTab", selected: current });
  // On a narrow window, the tab row scrolls sideways.
  // Keep the selected tab in view, clear of the faded edges of the row (ns.shell.revealInRow).
  const row = bar.parentElement;
  const active = $(".is-active", bar);
  if (active && row) shell?.revealInRow?.(row, active);
}

// Show `id` with no side effects. It writes no URL and runs no search.
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
  if (id === SEARCH_TAB) actions.showSearch();
  else find(id)?.onShow?.();
}

// A tab click adds its own history entry. Then the tab refreshes if needed.
// activate: false only switches the panels. Use it when the caller runs a search next.
function select(id, { url = "push", activate: run = true } = {}) {
  if (!show(id)) return;
  address.write(url);
  if (run) activate(current);
}

// This handles the URL at page load and at Back / Forward.
// The page-load search runs the search of the selected tab.
// Back / Forward to the Search tab also runs that search (app_traces.js restoreSearch).
// Another tab refreshes only when its data is stale.
function applyParams(params, { initial = false } = {}) {
  const changed = show(params.get("tab") || SEARCH_TAB);
  find(current)?.applyParams?.(params, { initial });
  if (changed && !initial && current !== SEARCH_TAB) queueMicrotask(() => activate(current));
}

function writeParams(params) {
  if (current !== SEARCH_TAB) params.set("tab", current);
  find(current)?.writeParams?.(params);
}

// When /api/traces/meta answers, hide the tabs that it does not enable.
// If the selected tab is hidden, the Search tab is selected.
function onMeta(value) {
  meta = value || null;
  if (current !== SEARCH_TAB && !available(find(current))) {
    show(SEARCH_TAB);
    address.replace();
  }
  render();
}

// The view-only URL parameters of every tab. They are left out of the search key.
function viewParams() {
  return tabs.flatMap((tab) => tab.params || []);
}

function hasParams(params) {
  return params.has("tab") || viewParams().some((name) => params.has(name));
}

// The search of the selected tab. The value is null for the result list.
function activeSearch() {
  return current === SEARCH_TAB ? null : find(current)?.onSearch || null;
}

function init() {
  started = true;
  // Click, arrow keys, Home and End use the shared tab behavior (app_ui_tabs.js).
  tabsMod?.bind(byId("tracesTabs"), { attr: "traceTab", onSelect: (id) => select(id) });
  for (const tab of tabs) tab.init?.();
  render();
}

export const traceTabs = {
  register,
  init,
  select,
  applyParams,
  writeParams,
  activeSearch,
  onMeta,
  viewParams,
  hasParams,
  current: () => current,
};
