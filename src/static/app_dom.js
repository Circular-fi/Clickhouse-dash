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
    explorerGraphTypeSelectButton: byId("explorerGraphTypeSelectButton"),
    explorerGraphTypeSelectMenu: byId("explorerGraphTypeSelectMenu"),
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
    copyJsonToast: byId("copyJsonToast"),
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

  ns.dom = dom;

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