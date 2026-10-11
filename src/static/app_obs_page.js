// The page of one Observability view (traces.html, logs.html, metrics.html): each view is a page
// of its own, at /observability/<view>, started by this one controller with the modules the
// page lists (src/static/modules.json). The row under the header links the three pages
// (#obsNav); one trace (/observability/traces/<traceId>) is a fourth page (trace.html,
// app_page_trace.js).
//
//   /observability/traces[?search]            trace search (tab=services, tab=map: its sub-tabs)
//   /observability/logs[?from=&to=&service=...]
//   /observability/metrics[?from=&to=&service=&metric=&panel=...]
//   /observability                            the server sends it to the first enabled view
//
// Shared context: the time range and the selected service follow the user from page to page. A
// page publishes them when it is left (getContext) and the next one adopts what changed since it
// last showed them (applyContext); both live in this tab's sessionStorage
// (ns.storage.observabilityContext), with each view's last query string, so coming back to a
// view from the row restores its filters. Every other filter stays with its view.
//
// The view's module (traces, logs, metrics) provides
//   init()                    first show: reads the URL, binds, loads
//   onLocation()              the URL changed under it (Back / Forward)
//   getContext()              -> { range: { from, to }, service } (service null: several / none to share)
//   applyContext(params, ctx) writes ctx.range / ctx.service (each may be null) into its URL params

import { api } from "./app_api.js";
import { dom as domMod, h, shell } from "./app_dom.js";
import { header } from "./app_header.js";
import { router } from "./app_router.js";
import { features, storage } from "./app_state.js";
import { timeRange } from "./app_timerange.js";
import { filterBar } from "./app_ui_filterbar.js";
import { icon } from "./app_ui_icon.js";
import { lifecycle } from "./app_ui_layers.js";

const VIEWS = ["traces", "logs", "metrics"];
// The view this page shows and its module: startObservabilityPage() names them.
let view = "";
let current = null;
const store = () => ({
  get: () => ({ range: null, service: null, rangeRev: 0, serviceRev: 0, seen: {}, urls: {}, ...storage.observabilityContext.get() }),
  set: (value) => storage.observabilityContext.set(value),
});
const viewModule = () => current;
const sameRange = (a, b) => !!a && !!b && String(a.from) === String(b.from) && String(a.to) === String(b.to);

// ------------------------------------------------------ shared context

// The range and service this page leaves for the next one, and its query string for its own
// next visit. Written whenever the page is left, whatever the way (pagehide).
function publish() {
  const stored = store().get();
  const next = { ...stored, seen: { ...stored.seen }, urls: { ...stored.urls } };
  const context = viewModule()?.getContext?.();
  if (context?.range?.from && context?.range?.to && !sameRange(context.range, stored.range)) {
    next.range = { from: String(context.range.from), to: String(context.range.to) };
    next.rangeRev += 1;
  }
  // null and "" are the same service ("All"): Traces on All must not count as a change of what Logs restored.
  if (context && context.service != null && String(context.service) !== String(stored.service ?? "")) {
    next.service = String(context.service);
    next.serviceRev += 1;
  }
  next.seen[view] = { rangeRev: next.rangeRev, serviceRev: next.serviceRev };
  next.urls[view] = `${window.location.search}${window.location.hash}`;
  store().set(next);
}

// Reached from another Observability page (the row, a link): the way a view used to be switched
// in place. A typed address, a bookmark or another product page's switcher open the page as it
// is named.
function fromObservability() {
  try {
    const from = new URL(document.referrer);
    return from.origin === window.location.origin && /\/observability(?:\/|$)/.test(from.pathname);
  } catch (_) {
    return false;
  }
}

// The address this page opens on: its last query string when it was reached from the row (no
// query of its own), with the shared range and service it has not shown yet. A link names what
// it shows: it only gets the shared range, when it has none.
function adopt() {
  const stored = store().get();
  const url = new URL(window.location.href);
  const mark = () => store().set({ ...stored, seen: { ...stored.seen, [view]: { rangeRev: stored.rangeRev, serviceRev: stored.serviceRev } } });
  // The entry always gets the router's state (its view), whether the address changes or not.
  const open = () => router.write("replace", null, { href: `${url.pathname}${url.search}${url.hash}`, view });
  if (!fromObservability()) {
    mark();
    open();
    return;
  }
  const explicit = !!url.search;
  if (!explicit && stored.urls[view]) {
    const rest = String(stored.urls[view]);
    const hash = rest.indexOf("#");
    url.search = hash < 0 ? rest : rest.slice(0, hash);
    if (hash >= 0 && !url.hash) url.hash = rest.slice(hash);
  }
  const seen = stored.seen[view] || { rangeRev: 0, serviceRev: 0 };
  const context = {
    range: stored.range && stored.rangeRev > seen.rangeRev ? { ...stored.range } : null,
    service: stored.service != null && stored.serviceRev > seen.serviceRev ? stored.service : null,
  };
  if (explicit) {
    context.service = null;
    if (timeRange.url.has(url.searchParams)) context.range = null;
  }
  if (context.range || context.service != null) viewModule()?.applyContext?.(url.searchParams, context);
  mark();
  open();
}

// ------------------------------------------------------------ the row

function featuresKnown() {
  return features?.known?.() === true;
}

function enabledViews() {
  if (featuresKnown()) return VIEWS.filter((name) => features.get(`${name}.enabled`));
  const early = String(document.documentElement.dataset.obsEnabled || "").split(/\s+/).filter((name) => VIEWS.includes(name));
  return early.length ? early : [...VIEWS];
}

function renderRow() {
  const enabled = enabledViews();
  document.documentElement.dataset.obsEnabled = enabled.join(" ");
  const { byId, $, $$ } = domMod;
  const bar = byId("obsTabs");
  if (bar) bar.hidden = enabled.length < 2;
  for (const link of $$("[data-obs-tab]", bar)) link.hidden = !enabled.includes(link.getAttribute("data-obs-tab"));
  const active = bar ? $(`[data-obs-tab="${view}"]`, bar) : null;
  if (active) shell?.revealInRow?.(byId("obsNav"), active);
}

// /api/version turned this view off: the first enabled one (app_ui.js leaves the product when
// none is left).
function onFeatures() {
  const enabled = enabledViews();
  renderRow();
  if (enabled.length && !enabled.includes(view)) window.location.replace(api.resolveUrl(`observability/${enabled[0]}`));
}

// ------------------------------------------------------------- phones

// At --bp-sm (600 px) and below the view leads with its content (docs/ui-foundations.md, "Touch
// and phones"):
//  - its filter bar folds into one summary line ("<time range> . N filters") that unfolds it; a
//    search folds it again (ns.filterBar.mountSummary, app_ui_filterbar.js);
//  - its overview charts ([data-phone-fold]: the Traces analytics, the Logs histogram) start
//    folded to their head, a chevron unfolds each.
// The folds only bite at that width (their rules sit in max-width: 600px blocks): a wider window
// shows everything, the summary and chevrons hidden.
function mountChartFold(card) {
  const head = domMod.$(":scope > .chartCard__head", card);
  if (!head) return;
  const title = card.getAttribute("aria-label") || String(domMod.$(".chartCard__title", head)?.textContent || "chart").trim();
  const button = h("button", { type: "button", class: "chartCard__fold" }, icon.el("chevron-down", { className: "" }));
  head.appendChild(button);
  const fold = (folded) => {
    card.classList.toggle("is-folded", folded);
    button.setAttribute("aria-expanded", folded ? "false" : "true");
    button.setAttribute("aria-label", `${folded ? "Show" : "Hide"} the chart: ${title}`);
  };
  button.addEventListener("click", () => fold(!card.classList.contains("is-folded")));
  fold(!!shell?.isAtMost("sm"));
}

function compactView() {
  const panel = domMod.$(`.obsView[data-obs-panel="${view}"]`);
  if (!panel) return;
  for (const form of domMod.$$("form.obsFilterBar", panel)) filterBar?.mountSummary(form);
  for (const card of domMod.$$(".chartCard[data-phone-fold]", panel)) mountChartFold(card);
}

// -------------------------------------------------------------- start

function bindShell() {
  const dom = domMod || {};
  header.setPageSelectorValue("observability");
  shell?.edgeCues?.(domMod.byId("obsNav"));
  window.addEventListener("pagehide", publish);
  // A page restored from the back/forward cache never ran start(): it takes what the other pages changed meanwhile
  // (the shared range and service) before it publishes its own context again at the next pagehide.
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    adopt();
    viewModule()?.onLocation?.();
    renderRow();
  });
  features.on(onFeatures);
}

export async function startObservabilityPage(name, viewInstance) {
  view = name;
  current = viewInstance;
  api.humanizeErrors();
  bindShell();
  header.init();
  adopt();
  renderRow();
  // The page shows one view for as long as it lives: its scope (listeners bound with lifecycle.bind) is the page's.
  lifecycle?.enter(view);
  viewModule()?.init?.();
  compactView();
  // Back / Forward within the page: another query string of the same view.
  router.on("/observability", () => viewModule()?.onLocation?.());
  // /api/version answered during the first load and turned this view off.
  if (featuresKnown() && enabledViews().length && !enabledViews().includes(view)) onFeatures();
}

