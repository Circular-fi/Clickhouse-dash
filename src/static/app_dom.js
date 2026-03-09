(() => {
  "use strict";

  window.ChDash = window.ChDash || {};
  const ns = window.ChDash;

  const byId = (id) => document.getElementById(id);

  const dom = {
    root: document.documentElement,

    queryTextArea: byId("queryTextArea"),

    runSplit: byId("runSplit"),
    runButton: byId("runButton"),
    runMenuButton: byId("runMenuButton"),
    runMenu: byId("runMenu"),
    runOptAutoFormat: byId("runOptAutoFormat"),
    runOptMultiQuery: byId("runOptMultiQuery"),

    formatButton: byId("formatButton"),
    cancelButton: byId("cancelButton"),
    clearButton: byId("clearButton"),

    historyButton: byId("historyButton"),
    historyPanel: byId("historyPanel"),

    saveButton: byId("saveButton"),
    savePanel: byId("savePanel"),
    saveNameInput: byId("saveNameInput"),
    saveConfirmButton: byId("saveConfirmButton"),

    savedButton: byId("savedButton"),
    savedQueriesPanel: byId("savedQueriesPanel"),

    hostPicker: byId("hostPicker"),
    hostPickerButton: byId("hostPickerButton"),
    hostPickerMenu: byId("hostPickerMenu"),
    hostPickerText: byId("hostPickerText"),
    hostPickerDot: byId("hostPickerDot"),
    hostPickerPing: byId("hostPickerPing"),

    themeSelect: byId("themeSelect"),
    themeSelectButton: byId("themeSelectButton"),
    themeSelectMenu: byId("themeSelectMenu"),
    themeSelectText: byId("themeSelectText"),

    versionBadge: byId("versionBadge"),

    queryStatusText: byId("queryStatusText"),
    queryIdentifierText: byId("queryIdentifierText"),

    elapsedSecondsText: byId("elapsedSecondsText"),
    progressCard: byId("progressCard"),
    progressPercentText: byId("progressPercentText"),
    readRowsRateText: byId("readRowsRateText"),
    readRowsTotalText: byId("readRowsTotalText"),
    readBytesRateText: byId("readBytesRateText"),
    readBytesTotalText: byId("readBytesTotalText"),
    readRowsChart: byId("readRowsChart"),
    readBytesChart: byId("readBytesChart"),
    cpuChart: byId("cpuChart"),
    memoryChart: byId("memoryChart"),
    threadChart: byId("threadChart"),
    cpuText: byId("cpuText"),
    cpuMaxText: byId("cpuMaxText"),
    memoryText: byId("memoryText"),
    memoryMaxText: byId("memoryMaxText"),
    threadText: byId("threadText"),
    threadMaxText: byId("threadMaxText"),

    resultsPanel: byId("resultsPanel") || document.querySelector(".panel--results"),
    resultColumnsText: byId("resultColumnsText"),
    copySplit: byId("copySplit"),
    copyMenuButton: byId("copyMenuButton"),
    copyMenu: byId("copyMenu"),
    copyCsvButton: byId("copyCsvButton"),
    copyJsonButton: byId("copyJsonButton"),
    copyJsonToast: byId("copyJsonToast"),
    errorBanner: byId("errorBanner"),
    resultTableHead: byId("resultTableHead"),
    resultTableBody: byId("resultTableBody"),
  };

  dom.liveResultsWrap = dom.resultTableBody ? dom.resultTableBody.closest(".tableWrap") : null;

  ns.dom = dom;
})();