(() => {
  "use strict";

  window.ChDash = window.ChDash || {};
  const ns = window.ChDash;

  const byId = (id) => document.getElementById(id);

  const build = () => ({
    root: document.documentElement,

    queryTextArea: byId("queryTextArea"),
    editorCopyButton: byId("editorCopyButton"),
    autocompleteMenu: byId("autocompleteMenu"),

    runSplit: byId("runSplit"),
    runButton: byId("runButton"),
    runMenuButton: byId("runMenuButton"),
    runMenu: byId("runMenu"),
    runWithProfilingButton: byId("runWithProfilingButton"),
    runSettings: byId("runSettings"),
    runSettingsButton: byId("runSettingsButton"),
    runSettingsMenu: byId("runSettingsMenu"),
    downloadDebugButton: byId("downloadDebugButton"),
    downloadCsvButton: byId("downloadCsvButton"),
    downloadJsonButton: byId("downloadJsonButton"),
    runOptAutoFormat: byId("runOptAutoFormat"),
    runOptMultiQuery: byId("runOptMultiQuery"),
    runOptExecutionStats: byId("runOptExecutionStats"),
    runOptFlattenTuple: byId("runOptFlattenTuple"),

    formatButton: byId("formatButton"),
    clearResultsButton: byId("clearResultsButton"),
    clearButton: byId("clearButton"),

    // Query library dialog (saved queries and History), opened by its toolbar
    // button; app_ui.js builds the dialog (and these refs) when it first opens.
    queryLibrary: byId("queryLibrary"),
    queryLibraryButton: byId("queryLibraryButton"),
    queryLibraryMenu: byId("queryLibraryMenu"),
    queryLibraryClose: byId("queryLibraryClose"),
    queryLibraryTabSaved: byId("queryLibraryTabSaved"),
    queryLibraryTabHistory: byId("queryLibraryTabHistory"),
    queryLibraryViewSaved: byId("queryLibraryViewSaved"),
    queryLibraryViewHistory: byId("queryLibraryViewHistory"),

    hostPicker: byId("hostPicker"),
    hostPickerButton: byId("hostPickerButton"),
    hostPickerMenu: byId("hostPickerMenu"),
    hostPickerText: byId("hostPickerText"),
    hostPickerVersion: byId("hostPickerVersion"),
    hostPickerDot: byId("hostPickerDot"),
    hostPickerPing: byId("hostPickerPing"),

    pageSelect: byId("pageSelect"),
    pageSelectButton: byId("pageSelectButton"),
    pageSelectMenu: byId("pageSelectMenu"),

    themeSelect: byId("themeSelect"),
    themeSelectButton: byId("themeSelectButton"),
    themeSelectMenu: byId("themeSelectMenu"),
    themeSelectText: byId("themeSelectText"),

    versionBadge: byId("versionBadge"),

    navQueryButton: byId("navQueryButton"),
    navExplorerButton: byId("navExplorerButton"),
    navObservabilityButton: byId("navObservabilityButton"),
    queryWorkspace: byId("queryWorkspace"),
    explorerWorkspace: byId("explorerWorkspace"),
    tracesWorkspace: byId("tracesWorkspace"),
    tracesSearchView: byId("tracesSearchView"),
    tracesForm: byId("tracesForm"),
    tracesRangeUnit: byId("tracesRangeUnit"),
    tracesService: byId("tracesService"),
    tracesOperation: byId("tracesOperation"),
    tracesTagKey: byId("tracesTagKey"),
    tracesTagValue: byId("tracesTagValue"),
    tracesStatus: byId("tracesStatus"),
    tracesLimit: byId("tracesLimit"),
    tracesSort: byId("tracesSort"),
    traceAnalyticsGrid: byId("traceAnalyticsGrid"),
    traceServiceChart: byId("traceServiceChart"),
    traceDurationChart: byId("traceDurationChart"),
    traceServiceChartMeta: byId("traceServiceChartMeta"),
    traceDurationChartMeta: byId("traceDurationChartMeta"),
    tracesSearchButton: byId("tracesSearchButton"),
    tracesError: byId("tracesError"),
    tracesResults: byId("tracesResults"),
    traceDetail: byId("traceDetail"),
    traceDetailHeader: byId("traceDetailHeader"),
    traceDetailTitle: byId("traceDetailTitle"),
    traceDetailStats: byId("traceDetailStats"),
    traceCopyJsonButton: byId("traceCopyJsonButton"),
    traceCopySplit: byId("traceCopySplit"),
    traceCopyMenuButton: byId("traceCopyMenuButton"),
    traceCopyMenu: byId("traceCopyMenu"),
    traceDownloadJsonButton: byId("traceDownloadJsonButton"),
    traceServiceFilters: byId("traceServiceFilters"),
    traceBackButton: byId("traceBackButton"),
    traceOverview: byId("traceOverview"),
    traceWaterfall: byId("traceWaterfall"),
    traceInspector: byId("traceInspector"),
    explorerSectionSelect: byId("explorerSectionSelect"),
    explorerSectionSelectButton: byId("explorerSectionSelectButton"),
    explorerSectionSelectMenu: byId("explorerSectionSelectMenu"),
    explorerTablesSectionButton: byId("explorerTablesSectionButton"),
    explorerFunctionsSectionButton: byId("explorerFunctionsSectionButton"),
    explorerSystemSectionButton: byId("explorerSystemSectionButton"),
    explorerSystemPane: byId("explorerSystemPane"),
    explorerOpsSectionButton: byId("explorerOpsSectionButton"),
    explorerOpsPane: byId("explorerOpsPane"),
    explorerTableModeTabs: byId("explorerTableModeTabs"),
    explorerModeSelectButton: byId("explorerModeSelectButton"),
    explorerModeSelectMenu: byId("explorerModeSelectMenu"),
    explorerListModeButton: byId("explorerListModeButton"),
    explorerGraphModeButton: byId("explorerGraphModeButton"),
    explorerGraphTypeSelect: byId("explorerGraphTypeSelect"),
    explorerGraphLogicalButton: byId("explorerGraphLogicalButton"),
    explorerGraphPhysicalButton: byId("explorerGraphPhysicalButton"),
    explorerGraphContractButton: byId("explorerGraphContractButton"),
    explorerGraphExpandButton: byId("explorerGraphExpandButton"),
    explorerGraphDepthControls: byId("explorerGraphDepthControls"),
    explorerGraphDepthValue: byId("explorerGraphDepthValue"),
    explorerGraphFitButton: byId("explorerGraphFitButton"),
    explorerGraphZoomInButton: byId("explorerGraphZoomInButton"),
    explorerGraphZoomOutButton: byId("explorerGraphZoomOutButton"),
    explorerGraphRefreshButton: byId("explorerGraphRefreshButton"),
    explorerSearchInput: byId("explorerSearchInput"),
    explorerTableSettings: byId("explorerTableSettings"),
    explorerTableSettingsButton: byId("explorerTableSettingsButton"),
    explorerTableSettingsMenu: byId("explorerTableSettingsMenu"),
    explorerIncludeSystem: byId("explorerIncludeSystem"),
    explorerIncludeNonStoring: byId("explorerIncludeNonStoring"),
    explorerRefreshButton: byId("explorerRefreshButton"),
    explorerFunctionSearchInput: byId("explorerFunctionSearchInput"),
    explorerFunctionRefreshButton: byId("explorerFunctionRefreshButton"),
    explorerError: byId("explorerError"),
    explorerListView: byId("explorerListView"),
    explorerDetailPane: byId("explorerDetailPane"),
    explorerGraphPane: byId("explorerGraphPane"),
    explorerGraphCanvas: byId("explorerGraphCanvas"),
    explorerGraphStatus: byId("explorerGraphStatus"),
    explorerGraphMinimap: byId("explorerGraphMinimap"),
    explorerTableList: byId("explorerTableList"),
    explorerFunctionsPane: byId("explorerFunctionsPane"),
    explorerFunctionToolbar: byId("explorerFunctionToolbar"),
    explorerFunctionCategorySelect: byId("explorerFunctionCategorySelect"),
    explorerFunctionList: byId("explorerFunctionList"),
    explorerFunctionEmpty: byId("explorerFunctionEmpty"),
    explorerFunctionDetail: byId("explorerFunctionDetail"),
    explorerFunctionDetailName: byId("explorerFunctionDetailName"),
    explorerFunctionDetailMeta: byId("explorerFunctionDetailMeta"),
    explorerFunctionDescription: byId("explorerFunctionDescription"),
    explorerEmptyState: byId("explorerEmptyState"),
    explorerDetail: byId("explorerDetail"),
    explorerDetailName: byId("explorerDetailName"),
    explorerDetailMeta: byId("explorerDetailMeta"),
    explorerHealthBadge: byId("explorerHealthBadge"),
    explorerWarnings: byId("explorerWarnings"),
    explorerSummaryCards: byId("explorerSummaryCards"),
    explorerDetailTabs: byId("explorerDetailTabs"),
    explorerDetailContent: byId("explorerDetailContent"),

    queryStatusText: byId("queryStatusText"),
    queryIdentifierText: byId("queryIdentifierText"),

    elapsedSecondsText: byId("elapsedSecondsText"),
    clickhouseElapsedWrap: byId("clickhouseElapsedWrap"),
    clickhouseElapsedText: byId("clickhouseElapsedText"),
    progressCard: byId("progressCard"),
    progressPercentText: byId("progressPercentText"),
    readRowsRateText: byId("readRowsRateText"),
    readRowsTotalText: byId("readRowsTotalText"),
    readBytesRateText: byId("readBytesRateText"),
    readBytesTotalText: byId("readBytesTotalText"),
    writtenRowsCard: byId("writtenRowsCard"),
    writtenRowsRateText: byId("writtenRowsRateText"),
    writtenRowsTotalText: byId("writtenRowsTotalText"),
    writtenBytesCard: byId("writtenBytesCard"),
    writtenBytesRateText: byId("writtenBytesRateText"),
    writtenBytesTotalText: byId("writtenBytesTotalText"),
    readRowsChart: byId("readRowsChart"),
    readBytesChart: byId("readBytesChart"),
    writtenRowsChart: byId("writtenRowsChart"),
    writtenBytesChart: byId("writtenBytesChart"),
    cpuChart: byId("cpuChart"),
    memoryChart: byId("memoryChart"),
    cpuText: byId("cpuText"),
    cpuMaxText: byId("cpuMaxText"),
    memoryText: byId("memoryText"),
    memoryMaxText: byId("memoryMaxText"),

    resultsPanel: byId("resultsPanel") || document.querySelector(".panel--results"),
    resultColumnsText: byId("resultColumnsText"),
    resultSummaryText: byId("resultSummaryText"),
    analyzeQueryButton: byId("analyzeQueryButton"),
    analysisModal: byId("analysisModal"),
    analysisCloseButton: byId("analysisCloseButton"),
    analysisSummary: byId("analysisSummary"),
    analysisNotice: byId("analysisNotice"),
    analysisTabs: byId("analysisTabs"),
    analysisPipelineTab: byId("analysisPipelineTab"),
    analysisTraceTab: byId("analysisTraceTab"),
    analysisContent: byId("analysisContent"),
    copySplit: byId("copySplit"),
    copyMenuButton: byId("copyMenuButton"),
    copyMenu: byId("copyMenu"),
    copyCsvButton: byId("copyCsvButton"),
    downloadReceivedJsonButton: byId("downloadReceivedJsonButton"),
    downloadReceivedZipButton: byId("downloadReceivedZipButton"),
    copyJsonButton: byId("copyJsonButton"),
    errorBanner: byId("errorBanner"),
    resultTableHead: byId("resultTableHead"),
    resultTableBody: byId("resultTableBody"),
  });
  const dom = build();

  dom.liveResultsWrap = dom.resultTableBody ? dom.resultTableBody.closest(".tableWrap") : null;

  // Markup added after load (an Observability view shown for the first time,
  // app_observability.js) gets its element references too.
  dom.refresh = () => {
    for (const [key, value] of Object.entries(build())) if (value && dom[key] !== value) dom[key] = value;
  };

  // Element lookups, one convention on every page: dom.byId(id) for an id,
  // dom.$(selector, root) for the first match and dom.$$(selector, root) for
  // every match (an array). root defaults to the document only when it is
  // left out: an explicit null or undefined root finds nothing, so a lookup
  // inside a component never falls back to the whole page.
  function $(selector, root) {
    const scope = arguments.length < 2 ? document : root;
    return scope ? scope.querySelector(selector) : null;
  }
  function $$(selector, root) {
    const scope = arguments.length < 2 ? document : root;
    return scope ? Array.from(scope.querySelectorAll(selector)) : [];
  }
  dom.byId = byId;
  dom.$ = $;
  dom.$$ = $$;

  ns.dom = dom;

  // ------------------------------------------------------- element builder
  //
  // ns.h(tag, props, ...children) -> an element (docs/ui-foundations.md,
  // "Building elements"). props (null for none):
  //   class      a string, an array (nested, falsy entries skipped) or an
  //              object { name: on }
  //   dataset    { key: value } -> data-* (camelCase keys, like el.dataset)
  //   style      a string, or { prop: value } (camelCase or --custom)
  //   aria       { label: "..." } -> aria-label; "aria-*" keys work too, and
  //              false prints "false" there (aria-pressed="false")
  //   on         { click: fn, ... }; signal: an AbortSignal or an
  //              ns.lifecycle scope that removes them
  //   value      the attribute, like markup; on <select> and <textarea> the
  //              property, set after the children (a select needs its options)
  //   indeterminate: the property
  //   anything else: an attribute (true -> present, false / null -> absent)
  // children: strings and numbers (always text, never markup), nodes, arrays
  // of children; null, undefined, false, true and "" are skipped.
  // h.frag(...children) -> a DocumentFragment. h.html(trusted) -> a fragment
  // parsed from markup the caller vouches for (the SQL highlighter output,
  // icons): the one, greppable way to insert markup next to h().
  // h.replace(container, ...children) replaces the container's children.
  const SVG_NS = "http://www.w3.org/2000/svg";
  const PROPERTIES = new Set(["indeterminate"]);
  const VALUE_PROPERTY = new Set(["SELECT", "TEXTAREA"]);
  const deferred = (el, key) => PROPERTIES.has(key) || (key === "value" && VALUE_PROPERTY.has(el.tagName));
  const ATTRIBUTE_NAMES = { className: "class", htmlFor: "for", tabIndex: "tabindex" };
  const URL_ATTRIBUTES = new Set(["href", "src", "action", "formaction", "xlink:href"]);
  const SCRIPT_URL = /^[\s\u0000-\u001f]*(javascript|vbscript):/i;

  function classList(value, out) {
    if (!value) return out;
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) for (const item of value) classList(item, out);
    else if (typeof value === "object") { for (const key of Object.keys(value)) if (value[key]) out.push(key); }
    else out.push(String(value));
    return out;
  }

  function setAttribute(el, name, value) {
    if (value == null || value === false) return;
    const text = value === true ? "" : String(value);
    // A URL attribute never takes a script URL (an API value as a link).
    el.setAttribute(name, URL_ATTRIBUTES.has(name) && SCRIPT_URL.test(text) ? "about:blank" : text);
  }

  function applyProps(el, props) {
    let signal = null;
    for (const key of Object.keys(props)) {
      const value = props[key];
      if (key === "class" || key === "className") {
        const cls = typeof value === "string" ? value : classList(value, []).join(" ").trim();
        if (cls) el.setAttribute("class", cls);
      } else if (key === "dataset" || key === "data") {
        if (value) for (const name of Object.keys(value)) {
          const item = value[name];
          if (item != null && item !== false) el.dataset[name] = item === true ? "" : String(item);
        }
      } else if (key === "style") {
        if (typeof value === "string") { if (value) el.setAttribute("style", value); }
        else if (value) for (const name of Object.keys(value)) {
          const item = value[name];
          if (item == null || item === false || item === "") continue;
          if (name.includes("-")) el.style.setProperty(name, String(item));
          else el.style[name] = String(item);
        }
      } else if (key === "aria") {
        if (value) for (const name of Object.keys(value)) if (value[name] != null) el.setAttribute(`aria-${name}`, String(value[name]));
      } else if (key === "on" || key === "signal") {
        if (key === "signal") signal = value ? (value.signal || value) : null;
      } else if (deferred(el, key)) {
        // Set after the children: a <select> value needs its options.
      } else if (key.startsWith("aria-")) {
        if (value != null) el.setAttribute(key, String(value));
      } else {
        setAttribute(el, ATTRIBUTE_NAMES[key] || key, value);
      }
    }
    const on = props.on;
    if (on) {
      const options = signal ? { signal } : undefined;
      for (const type of Object.keys(on)) if (typeof on[type] === "function") el.addEventListener(type, on[type], options);
    }
  }

  function append(parent, child) {
    if (child == null || child === false || child === true || child === "") return;
    if (typeof child === "string" || typeof child === "number" || typeof child === "bigint") {
      parent.appendChild(document.createTextNode(String(child)));
    } else if (child instanceof Node) {
      parent.appendChild(child);
    } else if (Array.isArray(child)) {
      for (const item of child) append(parent, item);
    } else if (typeof child[Symbol.iterator] === "function") {
      for (const item of Array.from(child)) append(parent, item);
    } else {
      parent.appendChild(document.createTextNode(String(child)));
    }
  }

  function fill(el, props, children) {
    if (props) applyProps(el, props);
    for (const child of children) append(el, child);
    if (props) {
      if (props.indeterminate != null) el.indeterminate = !!props.indeterminate;
      if (props.value != null && VALUE_PROPERTY.has(el.tagName)) el.value = String(props.value);
    }
    return el;
  }

  function h(tag, props, ...children) {
    return fill(document.createElement(tag), props, children);
  }
  h.svg = (tag, props, ...children) => fill(document.createElementNS(SVG_NS, tag), props, children);
  h.frag = (...children) => {
    const fragment = document.createDocumentFragment();
    for (const child of children) append(fragment, child);
    return fragment;
  };
  // Trusted markup only: never an API value that has not been escaped.
  h.html = (trusted) => {
    const template = document.createElement("template");
    template.innerHTML = String(trusted ?? "");
    return template.content;
  };
  h.replace = (container, ...children) => {
    if (!container) return container;
    if (!children.length) { container.replaceChildren(); return container; }
    container.replaceChildren(h.frag(...children));
    return container;
  };
  ns.h = Object.freeze(h);

  // The page shell (style.css "Page shell" block), shared by every page.
  // BREAKPOINTS mirror --bp-sm / --bp-md / --bp-lg: media queries cannot read
  // custom properties, so CSS and scripts both name these three numbers.
  const BREAKPOINTS = Object.freeze({ sm: 600, md: 820, lg: 1100 });
  const mediaQuery = (name) => `(max-width: ${BREAKPOINTS[name]}px)`;
  const isAtMost = (name) => {
    try { return window.matchMedia(mediaQuery(name)).matches; } catch { return false; }
  };

  // The chrome above the content region (the header and the page's nav row,
  // both of which wrap on narrow windows) as --shell-top on the root element,
  // in px: drawers and bottom sheets start under it rather than under a
  // literal offset that a wrapped header outgrows.
  const SHELL_ROWS = ["body > .appHeader", "#obsNav", "#explorerTopBar"];
  let shellTopTracked = false;
  function trackShellTop() {
    if (shellTopTracked) return;
    shellTopTracked = true;
    const root = document.documentElement;
    const rows = SHELL_ROWS.map((selector) => document.querySelector(selector)).filter(Boolean);
    const update = () => {
      const visible = rows.filter((el) => el.getClientRects().length > 0);
      const bottom = Math.max(0, ...visible.map((el) => el.getBoundingClientRect().bottom));
      const value = `${Math.round(bottom)}px`;
      if (root.style.getPropertyValue("--shell-top") !== value) root.style.setProperty("--shell-top", value);
    };
    update();
    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(update);
      for (const el of rows) observer.observe(el);
    }
    window.addEventListener("resize", update);
  }

  ns.shell = Object.freeze({ BREAKPOINTS, mediaQuery, isAtMost, trackShellTop });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", trackShellTop, { once: true });
  else trackShellTop();
})();