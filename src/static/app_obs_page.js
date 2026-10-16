// This is the page of one Observability view (traces.html, logs.html, metrics.html). Each view is a page
// of its own, at /observability/<view>. This controller starts the view with the modules that the
// page lists (src/static/modules.json). The row under the header links the three pages
// (#obsNav). One trace (/observability/traces/<traceId>) is a fourth page (trace.html,
// app_page_trace.js).
//
//   /observability/traces[?search]            trace search (tab=services, tab=map: its sub-tabs)
//   /observability/logs[?from=&to=&service=...]
//   /observability/metrics[?from=&to=&service=&metric=&panel=...]
//   /observability                            the server sends it to the first enabled view
//
// The time range and the selected service are shared context. They follow the person from page to page. A
// page saves them when it is left (getContext). The next page takes the values that changed since it
// last showed them (applyContext). Both live in the sessionStorage of this tab
// (ns.storage.observabilityContext), with the last query string of each view. When the person returns to a
// view from the row, its filters are restored. Every other filter stays with its view.
//
// The module of each view (traces, logs, metrics) provides:
//   init()                    first show: reads the URL, binds the events, and loads the data
//   onLocation()              the URL changed (Back / Forward)
//   getContext()              -> { range: { from, to }, service } (service null: several services, or none, to share)
//   applyContext(params, ctx) writes ctx.range and ctx.service into its URL params. Each may be null.

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
// startObservabilityPage() names the view that this page shows, and its module.
let view = "";
let current = null;
const store = () => ({
  get: () => ({ range: null, service: null, rangeRev: 0, serviceRev: 0, seen: {}, urls: {}, ...storage.observabilityContext.get() }),
  set: (value) => storage.observabilityContext.set(value),
});
const viewModule = () => current;
const sameRange = (a, b) => !!a && !!b && String(a.from) === String(b.from) && String(a.to) === String(b.to);

// ------------------------------------------------------ shared context

// This page saves the range and the service that it leaves for the next page. It also saves its own query string for its next visit.
// The values are written whenever the page is left, in any way (pagehide).
function publish() {
  const stored = store().get();
  const next = { ...stored, seen: { ...stored.seen }, urls: { ...stored.urls } };
  const context = viewModule()?.getContext?.();
  if (context?.range?.from && context?.range?.to && !sameRange(context.range, stored.range)) {
    next.range = { from: String(context.range.from), to: String(context.range.to) };
    next.rangeRev += 1;
  }
  // null and "" are the same service ("All"). Traces on All does not count as a change to what Logs restored.
  if (context && context.service != null && String(context.service) !== String(stored.service ?? "")) {
    next.service = String(context.service);
    next.serviceRev += 1;
  }
  next.seen[view] = { rangeRev: next.rangeRev, serviceRev: next.serviceRev };
  next.urls[view] = `${window.location.search}${window.location.hash}`;
  store().set(next);
}

// A person can reach this page from another Observability page (the row, a link). The view then switches in place.
// A typed address, a bookmark, or the switcher of another product page opens the page as the address names it.
function fromObservability() {
  try {
    const from = new URL(document.referrer);
    return from.origin === window.location.origin && /\/observability(?:\/|$)/.test(from.pathname);
  } catch (_) {
    return false;
  }
}

// The page opens on this address. It uses the last query string when the person reached the page from the row, and the page has no query of its own.
// It adds the shared range and service that it has not shown yet. A link names what it shows. Such a link gets the shared range only when it has none.
function adopt() {
  const stored = store().get();
  const url = new URL(window.location.href);
  const mark = () => store().set({ ...stored, seen: { ...stored.seen, [view]: { rangeRev: stored.rangeRev, serviceRev: stored.serviceRev } } });
  // The history entry always gets the router state (its view). This happens whether the address changes or not.
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

// /api/version turned this view off. The page shows the first enabled view.
// If no view is left, app_ui.js leaves the product.
function onFeatures() {
  const enabled = enabledViews();
  renderRow();
  if (enabled.length && !enabled.includes(view)) window.location.replace(api.resolveUrl(`observability/${enabled[0]}`));
}

// ------------------------------------------------------------- phones

// At --bp-sm (600 px) and below, the view shows its content first (docs/ui-foundations.md, "Touch
// and phones"):
//  - Its filter bar folds into one summary line ("<time range> . N filters"). A tap on the line unfolds the bar. A search folds the bar again (ns.filterBar.mountSummary, app_ui_filterbar.js).
//  - Its overview charts ([data-phone-fold]: the Traces analytics, the Logs histogram) start folded to their head. A chevron unfolds each chart.
// The folds apply only at that width, because their rules sit in max-width: 600px blocks. A wider window shows everything. It hides the summary and the chevrons.
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
  // A page restored from the back/forward cache never ran start(). It takes the shared range and service that the other pages changed meanwhile.
  // Then it publishes its own context again at the next pagehide.
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
  // The page shows one view for as long as the page lives. The scope of the view (listeners bound with lifecycle.bind) belongs to the page.
  lifecycle?.enter(view);
  viewModule()?.init?.();
  compactView();
  // Back / Forward move within the page. The query string changes, but the view stays the same.
  router.on("/observability", () => viewModule()?.onLocation?.());
  // /api/version answered during the first load. It turned this view off.
  if (featuresKnown() && enabledViews().length && !enabledViews().includes(view)) onFeatures();
}

