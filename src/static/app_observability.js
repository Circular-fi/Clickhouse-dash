(() => {
  "use strict";
  // Observability page (observability.html): the Traces, Logs and Metrics
  // views of the OpenTelemetry data under one shell, one tab each in the row
  // under the header (#obsNav, which also holds the Traces sub-tabs).
  //
  //   /observability/traces[?search]            trace search (tab=services, tab=map: its sub-tabs)
  //   /observability/traces/<traceId>[?span=...] one trace, with its search context
  //   /observability/logs[?from=&to=&service=...]
  //   /observability/metrics[?from=&to=&service=&metric=&panel=...]
  //   /observability                            the first enabled view
  //
  // Each view keeps its own URL parameters; switching views is a history entry
  // (Back / Forward switch back). A view's modules load the first time it is
  // shown, and its stylesheet with them: the page starts on the sheet of its
  // first view (style.observability.<view>.css, written by the head script)
  // and swaps in the sheet of every view (style.observability.css) once a
  // second one is shown.
  //
  // Shared context: the time range and the selected service follow the user
  // across views. A view publishes them when it is left (getContext) and the
  // next one adopts what changed since it last showed them (applyContext);
  // every other filter stays with its view for the session.
  //
  // A view module (ns.traces, ns.logs, ns.metrics) provides
  //   init()                    first show: reads the URL, binds, loads
  //   onLocation()              the URL changed under it (Back / Forward, view switch)
  //   onShow(scope) / onHide()  optional: resume / pause work while hidden.
  //                             scope (ns.lifecycle.enter(view)) is disposed
  //                             right after onHide(): listeners bound with
  //                             { signal: scope.signal } (document keys,
  //                             window resize) live while the view shows
  //   getContext()              -> { range: { from, to }, service } (service null: several / none to share)
  //   applyContext(params, ctx) writes ctx.range / ctx.service (each may be null) into its URL params
  window.ChDash = window.ChDash || {};
  const VIEWS = ["traces", "logs", "metrics"];
  const LABELS = { traces: "Traces", logs: "Logs", metrics: "Metrics" };
  // The page's modules (src/static/modules.json, through ns.loader): the
  // common ones every view needs, then each view's own (views.<view>), loaded
  // the first time the view is shown. tools/build_page_css.py reads the same
  // lists: a view's stylesheet keeps the rules its modules can use.
  const ALL_VIEWS_SHEET = "style.observability.css";
  const loader = window.ChDash.loader;

  // ------------------------------------------------------------- loading

  // One load per view, however often it is asked for (ns.loader loads each
  // file once).
  const viewLoads = new Map();
  function loadView(view) {
    if (!viewLoads.has(view)) {
      const loading = loader.loadGroup(view);
      viewLoads.set(view, loading);
      loading.catch(() => viewLoads.delete(view));
    }
    return viewLoads.get(view);
  }

  // Views whose rules the page stylesheet holds.
  const styled = new Set();
  let sheetLoad = Promise.resolve();

  function sheetLink() {
    return [...document.querySelectorAll('link[rel="stylesheet"]')]
      .find((link) => /(?:^|\/)style\.observability(?:\.[a-z]+)?\.css(?:[?#]|$)/.test(link.getAttribute("href") || "")) || null;
  }

  function sheetName(views) {
    return views.size > 1 ? ALL_VIEWS_SHEET : `style.observability.${[...views][0]}.css`;
  }

  // The stylesheet for `view` and every view shown before it. The new sheet
  // replaces the old one once it has loaded, so the page never paints without
  // its rules; a superset sheet keeps the cascade order of the sources.
  function ensureSheet(view) {
    if (styled.has(view)) return sheetLoad;
    const wanted = new Set([...styled, view]);
    const name = sheetName(wanted);
    sheetLoad = sheetLoad.then(() => new Promise((resolve) => {
      const current = sheetLink();
      const href = String(current?.getAttribute("href") || "");
      if (current && href.replace(/[?#].*$/, "").endsWith(`/${name}`)) {
        for (const v of wanted) styled.add(v);
        resolve();
        return;
      }
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = loader.url(name);
      const done = (ok) => {
        if (ok) {
          for (const v of wanted) styled.add(v);
          if (current && current !== link) current.remove();
        } else {
          link.remove();
        }
        resolve();
      };
      link.onload = () => done(true);
      link.onerror = () => done(false);
      if (current) current.after(link);
      else document.head.appendChild(link);
    }));
    return sheetLoad;
  }

  // -------------------------------------------------------------- routes

  // The address bar is ns.router's (app_router.js): this controller writes
  // the view switches, each view module its own parameters.
  // It loads with the common modules, after this script.
  const router = () => window.ChDash.router;

  // "traces" for /observability/traces/abc, "" for /observability or another
  // page. Read before the modules load (start): the page is only served
  // under <base>/observability, so the first "/observability/" segment is it.
  function viewFromPath(pathname) {
    const match = /\/observability\/(traces|logs|metrics)(?:\/|$)/.exec(String(pathname || "/"));
    return match ? match[1] : "";
  }

  const viewRoute = (view) => router().url(`/observability/${view}`);
  const currentUrl = () => router().href();

  // ---------------------------------------------------------- controller

  const ctl = {
    active: "",
    started: new Set(),
    // The last URL of each view this session: switching back restores its filters.
    urls: {},
    shared: { range: null, service: null, rangeRev: 0, serviceRev: 0 },
    // The shared revisions each view last showed.
    seen: {},
    seq: 0,
  };

  const viewModule = (view) => window.ChDash[view] || null;

  // The markup of the views not shown yet: the shell ships every view (any of
  // them can be the first paint), and the others leave the document before
  // any module runs, so the page holds one view's elements until another is
  // shown.
  const detached = new Map();

  function detachViews(keep) {
    for (const view of VIEWS) {
      const panel = view === keep ? null : document.querySelector(`.obsView[data-obs-panel="${view}"]`);
      if (!panel) continue;
      const mark = document.createComment(`observability:${view}`);
      detached.set(view, { mark, html: panel.outerHTML });
      panel.replaceWith(mark);
    }
  }

  function attachView(view) {
    const entry = detached.get(view);
    if (!entry) return;
    detached.delete(view);
    const template = document.createElement("template");
    template.innerHTML = entry.html;
    entry.mark.replaceWith(template.content);
    window.ChDash.dom?.refresh?.();
  }

  function featuresKnown() {
    return window.ChDash.features?.known?.() === true;
  }

  function enabledViews() {
    if (featuresKnown()) return VIEWS.filter((view) => window.ChDash.features.get(`${view}.enabled`));
    const early = String(document.documentElement.dataset.obsEnabled || "").split(/\s+/).filter((v) => VIEWS.includes(v));
    return early.length ? early : [...VIEWS];
  }

  const sameRange = (a, b) => !!a && !!b && String(a.from) === String(b.from) && String(a.to) === String(b.to);

  // The left view's range and service become the shared context.
  function publish(view) {
    const context = viewModule(view)?.getContext?.();
    const shared = ctl.shared;
    if (context?.range?.from && context?.range?.to && !sameRange(context.range, shared.range)) {
      shared.range = { from: String(context.range.from), to: String(context.range.to) };
      shared.rangeRev += 1;
    }
    if (context && context.service != null && String(context.service) !== shared.service) {
      shared.service = String(context.service);
      shared.serviceRev += 1;
    }
    markSeen(view);
  }

  function markSeen(view) {
    ctl.seen[view] = { rangeRev: ctl.shared.rangeRev, serviceRev: ctl.shared.serviceRev };
  }

  // The URL `view` opens on: its last URL with the shared context it has not
  // shown yet. A link (`explicit`) names what it shows: it only gets the
  // shared range, when it has none.
  function targetUrl(view, explicit) {
    const url = new URL(explicit || ctl.urls[view] || viewRoute(view), window.location.href);
    const seen = ctl.seen[view] || { rangeRev: 0, serviceRev: 0 };
    const shared = ctl.shared;
    const context = {
      range: shared.range && shared.rangeRev > seen.rangeRev ? { ...shared.range } : null,
      service: shared.service != null && shared.serviceRev > seen.serviceRev ? shared.service : null,
    };
    if (explicit) {
      context.service = null;
      if (window.ChDash.timeRange.url.has(url.searchParams)) context.range = null;
    }
    if (context.range || context.service != null) viewModule(view)?.applyContext?.(url.searchParams, context);
    markSeen(view);
    return `${url.pathname}${url.search}${url.hash}`;
  }

  function renderTabs() {
    const enabled = enabledViews();
    document.documentElement.dataset.obsEnabled = enabled.join(" ");
    const bar = document.getElementById("obsTabs");
    if (bar) bar.hidden = enabled.length < 2;
    window.ChDash.tabs?.select(bar, ctl.active, "obsTab");
    const active = bar?.querySelector(`[data-obs-tab="${ctl.active}"]`);
    if (active) window.ChDash.shell?.revealInRow?.(document.getElementById("obsNav"), active);
    for (const button of document.querySelectorAll("#obsTabs [data-obs-tab]")) {
      const view = button.getAttribute("data-obs-tab");
      button.hidden = !enabled.includes(view);
      // A view not shown yet has no panel in the document.
      const panel = document.querySelector(`.obsView[data-obs-panel="${view}"]`);
      if (panel) button.setAttribute("aria-controls", panel.id);
      else button.removeAttribute("aria-controls");
    }
  }

  function applyActive(view) {
    ctl.active = view;
    document.documentElement.dataset.obsView = view;
    document.title = `ClickHouse Dash · ${LABELS[view]}`;
    renderTabs();
  }

  // history: "push" (a tab click or a link: its own entry), "replace" (page
  // load, a view turned off) or "none" (Back / Forward: the URL is the entry).
  // The shown view's lifecycle scope opens before its module runs: the view
  // owns its address (ns.router.owner) from init() on, and a hidden view
  // never writes it.
  async function show(view, { history = "push", url = "" } = {}) {
    if (!VIEWS.includes(view)) return;
    if (view === ctl.active && !url) return;
    const seq = ++ctl.seq;
    const leaving = ctl.active && ctl.active !== view ? ctl.active : "";
    // Hidden until applyActive() (the view rule every sheet holds), so its
    // markup lands before its modules run.
    attachView(view);
    try {
      await Promise.all([loadView(view), ensureSheet(view)]);
    } catch (error) {
      console.error(error);
      return;
    }
    if (seq !== ctl.seq) return;
    if (leaving) {
      ctl.urls[leaving] = currentUrl();
      publish(leaving);
      viewModule(leaving)?.onHide?.();
      window.ChDash.lifecycle?.leave(leaving);
    }
    if (history !== "none") {
      // Another view's entry state (a panel's entry, the trace steps back to
      // its search) does not carry over a replaced switch.
      const fresh = leaving ? { detail: undefined, detailOf: undefined, searchBack: undefined } : null;
      router().write(history, null, { href: targetUrl(view, url), view, state: fresh });
    } else {
      markSeen(view);
    }
    applyActive(view);
    const module = viewModule(view);
    const scope = window.ChDash.lifecycle?.enter(view) || null;
    if (!ctl.started.has(view)) {
      ctl.started.add(view);
      module?.init?.();
      compactView(view);
    } else {
      module?.onLocation?.();
    }
    module?.onShow?.(scope);
  }

  // ------------------------------------------------------------- phones

  // At --bp-sm (600 px) and below a view leads with its content
  // (docs/ui-foundations.md, "Touch and phones"):
  //  - its filter bar folds into one summary line ("<time range> · N
  //    filters") that unfolds it; a search folds it again (the filter bar
  //    component, ns.filterBar.mountSummary, app_ui_filterbar.js; System's
  //    bars fold the same way);
  //  - its overview charts ([data-phone-fold]: the Traces analytics, the Logs
  //    histogram) start folded to their head, a chevron unfolds each.
  // The folds only bite at that width (their rules sit in max-width: 600px
  // blocks): a wider window shows everything, the summary and chevrons hidden.
  const compacted = new WeakSet();

  function chevron(className) {
    return window.ChDash.icon.el("chevron-down", { className });
  }

  function mountChartFold(card) {
    const ns = window.ChDash;
    const head = ns.dom.$(":scope > .chartCard__head", card);
    if (!head) return;
    const title = card.getAttribute("aria-label") || String(ns.dom.$(".chartCard__title", head)?.textContent || "chart").trim();
    const button = ns.h("button", { type: "button", class: "chartCard__fold" }, chevron(""));
    head.appendChild(button);
    const fold = (folded) => {
      card.classList.toggle("is-folded", folded);
      button.setAttribute("aria-expanded", folded ? "false" : "true");
      button.setAttribute("aria-label", `${folded ? "Show" : "Hide"} the chart: ${title}`);
    };
    button.addEventListener("click", () => fold(!card.classList.contains("is-folded")));
    fold(!!ns.shell?.isAtMost("sm"));
  }

  function compactView(view) {
    const { dom } = window.ChDash;
    const panel = dom.$(`.obsView[data-obs-panel="${view}"]`);
    if (!panel || compacted.has(panel)) return;
    compacted.add(panel);
    for (const form of dom.$$("form.obsFilterBar", panel)) window.ChDash.filterBar?.mountSummary(form);
    for (const card of dom.$$(".chartCard[data-phone-fold]", panel)) mountChartFold(card);
  }

  // An observability URL of another view, followed in place.
  function open(href) {
    let url;
    try { url = new URL(String(href || ""), window.location.href); } catch (_) { return false; }
    if (url.origin !== window.location.origin) return false;
    const view = viewFromPath(url.pathname);
    if (!view || view === ctl.active || !enabledViews().includes(view)) return false;
    void show(view, { history: "push", url: `${url.pathname}${url.search}${url.hash}` });
    return true;
  }

  function isActive(view) {
    return ctl.active === view;
  }

  function defaultView() {
    return enabledViews()[0] || VIEWS[0];
  }

  // Back / Forward (ns.router.on("/observability")): the entry's view shows,
  // or the shown one follows its URL (onLocation).
  function onPopState() {
    const named = viewFromPath(window.location.pathname);
    const view = named && enabledViews().includes(named) ? named : defaultView();
    if (view !== named) {
      void show(view, { history: "replace", url: viewRoute(view) });
      return;
    }
    if (view !== ctl.active) void show(view, { history: "none" });
    else viewModule(view)?.onLocation?.();
  }

  function onFeatures() {
    const enabled = enabledViews();
    renderTabs();
    if (!enabled.length) return; // app_ui.js leaves the page
    if (ctl.active && !enabled.includes(ctl.active)) void show(enabled[0], { history: "replace", url: viewRoute(enabled[0]) });
  }

  // A plain click on a link to another view switches tab without a reload.
  function onDocumentClick(event) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!link || (link.getAttribute("target") || "") === "_blank" || link.hasAttribute("download")) return;
    if (open(link.getAttribute("href"))) event.preventDefault();
  }

  function bindShell() {
    const ns = window.ChDash;
    const dom = ns.dom || {};
    const ui = ns.ui;
    const route = (path) => ns.api.resolveUrl(path);
    ui?.setPageSelectorValue?.("observability");
    dom.navQueryButton?.addEventListener("click", () => window.location.assign(route("query")));
    dom.navExplorerButton?.addEventListener("click", () => window.location.assign(route("explorer")));
    dom.navObservabilityButton?.addEventListener("click", () => ui?.closePageMenu?.());
    // Click, arrows, Home / End: the shared tab behaviour (app_ui_tabs.js);
    // the selected tab keeps the focus once its view is shown.
    ns.tabs?.bind(document.getElementById("obsTabs"), { attr: "obsTab", onSelect: (view) => show(view) });
    ns.shell?.edgeCues?.(document.getElementById("obsNav"));
    document.addEventListener("click", onDocumentClick);
    router().on("/observability", onPopState);
    window.ChDash.features.on(onFeatures);
  }


  // Every request of the page's API client rejects with util.errorText's
  // message (the original text on error.rawMessage), so each view (and every
  // module of the Traces view, the service map included) shows a sentence
  // rather than "trace_not_found: Trace was not found...".
  function humanizeApiErrors(api) {
    if (!api || api.__humanErrors) return;
    for (const [name, fn] of Object.entries(api)) {
      if (typeof fn !== "function" || name === "resolveUrl") continue;
      api[name] = function (...args) {
        const out = fn.apply(this, args);
        if (!out || typeof out.then !== "function") return out;
        return out.catch((error) => {
          if (error instanceof Error && error.code && error.rawMessage == null) {
            error.rawMessage = error.message;
            error.message = window.ChDash.util.errorText(error);
          }
          throw error;
        });
      };
    }
    Object.defineProperty(api, "__humanErrors", { value: true });
  }

  async function start() {
    window.ChDash.observability = { show, open, isActive, active: () => ctl.active, viewFromPath, VIEWS };
    // --shell-top (the header and #obsNav) is measured by app_dom.js
    // (ns.shell), as on every page.
    const named = viewFromPath(window.location.pathname);
    const view = named && enabledViews().includes(named) ? named : defaultView();
    detachViews(view);
    await loader.startModules();
    humanizeApiErrors(window.ChDash.api);
    const early = String(document.documentElement.dataset.obsView || "");
    styled.add(VIEWS.includes(early) ? early : VIEWS[0]);
    bindShell();
    window.ChDash.ui?.init?.();
    // /observability: the first enabled view, its parameters kept; a view
    // turned off: the first enabled one, on its own URL.
    const url = view === named ? currentUrl() : named ? viewRoute(view) : `${viewRoute(view)}${window.location.search}${window.location.hash}`;
    await show(view, { history: "replace", url });
    // /api/version answered during the first load and turned this view off.
    if (featuresKnown() && enabledViews().length && !enabledViews().includes(ctl.active)) onFeatures();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => start().catch(console.error), { once: true });
  else start().catch(console.error);
})();
