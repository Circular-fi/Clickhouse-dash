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
  //   onShow() / onHide()       optional: resume / pause work while hidden
  //   getContext()              -> { range: { from, to }, service } (service null: several / none to share)
  //   applyContext(params, ctx) writes ctx.range / ctx.service (each may be null) into its URL params
  window.ChDash = window.ChDash || {};
  const VIEWS = ["traces", "logs", "metrics"];
  const LABELS = { traces: "Traces", logs: "Logs", metrics: "Metrics" };
  // Modules every view needs, then each view's own. tools/build_page_css.py
  // reads both lists: a view's stylesheet keeps the rules its modules can use.
  const COMMON_MODULES = ["app_dom.js", "app_state.js", "app_util.js", "app_api.js", "app_ui.js", "app_timerange.js"];
  const VIEW_MODULES = {
    traces: ["app_traces.js", "app_trace_views.js", "app_trace_insights.js", "app_trace_search.js", "app_trace_spans.js", "app_trace_logs.js", "app_trace_tabs.js", "app_trace_services.js", "app_trace_map.js", "app_trace_heatmap.js"],
    logs: ["app_chart_core.js", "app_logs.js"],
    metrics: ["app_chart_core.js", "app_metrics.js"],
  };
  const ALL_VIEWS_SHEET = "style.observability.css";

  const base = (() => {
    if (typeof window.__chdashUrl === "function") return new URL(window.__chdashUrl("static/"), window.location.href).toString();
    const script = document.currentScript;
    return script && script.src ? script.src.replace(/[^/]*$/, "") : new URL("./static/", window.location.href).toString();
  })();

  // ------------------------------------------------------------- loading

  const loadedModules = new Set();
  const loadScript = (name) => new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = base + name;
    el.async = false;
    el.onload = resolve;
    el.onerror = () => reject(new Error(`Failed to load ${name}`));
    document.head.appendChild(el);
  });

  async function loadModules(names) {
    for (const name of names) {
      if (loadedModules.has(name)) continue;
      await loadScript(name);
      loadedModules.add(name);
    }
  }

  // One load per view, however often it is asked for.
  const viewLoads = new Map();
  function loadView(view) {
    if (!viewLoads.has(view)) {
      const loading = loadModules(VIEW_MODULES[view]);
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
  // its rules; a superset sheet keeps style.css order for every rule.
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
      link.href = base + name;
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

  function appBasePath() {
    const raw = String(window.__CHDASH_BASE_PATH__ || "/");
    return raw === "/" ? "" : raw.replace(/\/+$/, "");
  }

  // "traces" for /observability/traces/abc, "" for /observability or another page.
  function viewFromPath(pathname) {
    let path = String(pathname || "/");
    const prefix = appBasePath();
    if (prefix && path.startsWith(prefix)) path = path.slice(prefix.length);
    const match = /^\/observability\/(traces|logs|metrics)(?:\/|$)/.exec(path);
    return match ? match[1] : "";
  }

  function isObservabilityPath(pathname) {
    let path = String(pathname || "/");
    const prefix = appBasePath();
    if (prefix && path.startsWith(prefix)) path = path.slice(prefix.length);
    return /^\/observability(?:\/|$)/.test(path);
  }

  const viewRoute = (view) => `${appBasePath()}/observability/${view}`;
  const currentUrl = () => `${window.location.pathname}${window.location.search}${window.location.hash}`;

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
    return window.ChDash.observability?.featuresKnown === true;
  }

  function enabledViews() {
    if (featuresKnown()) {
      const features = window.ChDash.state?.features || {};
      return VIEWS.filter((view) => features[view]?.enabled === true);
    }
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
      if (url.searchParams.has("from") || url.searchParams.has("to")) context.range = null;
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
    for (const button of document.querySelectorAll("#obsTabs [data-obs-tab]")) {
      const view = button.getAttribute("data-obs-tab");
      const selected = view === ctl.active;
      button.hidden = !enabled.includes(view);
      button.classList.toggle("is-active", selected);
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
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
    }
    if (history !== "none") {
      const next = targetUrl(view, url);
      if (history === "push" && next !== currentUrl()) window.history.pushState({ obsView: view }, "", next);
      else window.history.replaceState({ ...(window.history.state || {}), obsView: view }, "", next);
    } else {
      markSeen(view);
    }
    applyActive(view);
    const module = viewModule(view);
    if (!ctl.started.has(view)) {
      ctl.started.add(view);
      module?.init?.();
    } else {
      module?.onLocation?.();
    }
    module?.onShow?.();
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

  function onPopState() {
    if (!isObservabilityPath(window.location.pathname)) return;
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
    const api = window.ChDash.observability;
    if (api) api.featuresKnown = true;
    const enabled = enabledViews();
    renderTabs();
    if (!enabled.length) return; // app_ui.js leaves the page
    if (ctl.active && !enabled.includes(ctl.active)) void show(enabled[0], { history: "replace", url: viewRoute(enabled[0]) });
  }

  // The Explorer view tabs' keys: Left / Right wrap, Home / End go to the ends.
  function onTabKeydown(event) {
    const target = event.target instanceof Element ? event.target.closest("[data-obs-tab]") : null;
    if (!target || !["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const shown = enabledViews();
    const at = shown.indexOf(target.getAttribute("data-obs-tab"));
    const next = event.key === "Home" ? shown[0] : event.key === "End" ? shown[shown.length - 1]
      : shown[(at + (event.key === "ArrowRight" ? 1 : -1) + shown.length) % shown.length];
    void show(next).then(() => document.getElementById(`obsTab-${next}`)?.focus());
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
    const bar = document.getElementById("obsTabs");
    bar?.addEventListener("click", (event) => {
      const button = event.target instanceof Element ? event.target.closest("[data-obs-tab]") : null;
      if (button) void show(button.getAttribute("data-obs-tab"));
    });
    bar?.addEventListener("keydown", onTabKeydown);
    document.addEventListener("click", onDocumentClick);
    window.addEventListener("popstate", onPopState);
    window.addEventListener("chdash:features-changed", onFeatures);
  }

  async function start() {
    window.ChDash.observability = { show, open, isActive, active: () => ctl.active, viewFromPath, featuresKnown: false, VIEWS, VIEW_MODULES };
    const named = viewFromPath(window.location.pathname);
    const view = named && enabledViews().includes(named) ? named : defaultView();
    detachViews(view);
    await loadModules(COMMON_MODULES);
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
