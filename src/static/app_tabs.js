(() => {
  "use strict";

  const ns = window.ChDash;
  if (!ns) return;

  const { dom, util, results, run, state } = ns;

  const STORAGE_KEY = "chdash.tabs.v1";
  const ENABLED_KEY = "chdash.tabs.enabled";
  const MAX_TABS = 20;
  const TAB_TITLE_MAX = 32;

  // In-memory tab list. Each tab keeps its editor SQL plus a snapshot of the
  // results table and metrics column. Snapshots are null until the tab has been
  // visited at least once (an unvisited/empty tab simply shows a blank state).
  //   { id, title, sql, resultsState, metricsState }
  let tabs = [];
  let activeId = null;
  let seq = 0;
  let dragId = null;

  // Whether the multi-tab UI is enabled (toggled from the editor options menu).
  // Written there; read here at init and applied as a root class.
  const readEnabled = () => {
    try {
      const v = localStorage.getItem(ENABLED_KEY);
      return v == null ? true : v !== "false" && v !== "0";
    } catch {
      return true;
    }
  };
  let enabled = readEnabled();

  const applyEnabledVisibility = () => {
    const root = document.documentElement;
    if (root && root.classList) root.classList.toggle("chdash-tabs-disabled", !enabled);
  };

  // --- persistence (SQL + titles only; live results are not persisted) -------

  const persist = () => {
    try {
      const payload = {
        activeId,
        tabs: tabs.map((t) => ({ id: t.id, title: t.title, sql: t.sql })),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      /* ignore quota / privacy errors */
    }
  };

  const loadPersisted = () => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || !Array.isArray(obj.tabs) || obj.tabs.length === 0) return null;
      const list = obj.tabs
        .filter((t) => t && typeof t === "object")
        .map((t) => ({
          id: String(t.id || ""),
          title: String(t.title || "Query"),
          sql: typeof t.sql === "string" ? t.sql : "",
          resultsState: null,
          metricsState: null,
        }))
        .filter((t) => t.id);
      if (!list.length) return null;
      const active = list.some((t) => t.id === obj.activeId) ? String(obj.activeId) : list[0].id;
      return { tabs: list, activeId: active };
    } catch {
      return null;
    }
  };

  // --- helpers ----------------------------------------------------------------

  const nextId = () => {
    seq += 1;
    return `tab_${Date.now().toString(36)}_${seq}`;
  };

  const getActive = () => tabs.find((t) => t.id === activeId) || null;

  const isBusy = () => !!(ns.state && ns.state.isRunning);

  const editorValue = () => (dom.queryTextArea ? String(dom.queryTextArea.value || "") : "");

  const setEditorValue = (sql) => {
    if (!dom.queryTextArea) return;
    if (util && typeof util.replaceTextAreaValue === "function") {
      util.replaceTextAreaValue(dom.queryTextArea, String(sql || ""));
    } else {
      dom.queryTextArea.value = String(sql || "");
    }
    const ctrl = ns.state && ns.state.highlightCtrl;
    if (ctrl && typeof ctrl.refresh === "function") ctrl.refresh();
  };

  // Save everything that belongs to the active tab into its record.
  const snapshotActive = () => {
    const active = getActive();
    if (!active) return;
    active.sql = editorValue();
    if (results && typeof results.captureState === "function") {
      active.resultsState = results.captureState();
    }
    if (run && typeof run.captureMetrics === "function") {
      active.metricsState = run.captureMetrics();
    }
  };

  // Bring the given tab's editor + results + metrics on screen.
  const applyTab = (tab) => {
    if (!tab) return;
    setEditorValue(tab.sql);
    if (results && typeof results.restoreState === "function") results.restoreState(tab.resultsState);
    if (run && typeof run.restoreMetrics === "function") run.restoreMetrics(tab.metricsState);
  };

  // --- rendering --------------------------------------------------------------

  const renderTabs = () => {
    const list = dom.queryTabsList;
    if (!list) return;
    list.innerHTML = "";

    const closable = tabs.length > 1;

    for (const tab of tabs) {
      const el = document.createElement("div");
      el.className = "queryTab";
      el.dataset.tabId = tab.id;
      el.setAttribute("role", "tab");
      el.setAttribute("draggable", "true");
      el.tabIndex = 0;
      if (tab.id === activeId) {
        el.classList.add("is-active");
        el.setAttribute("aria-selected", "true");
      } else {
        el.setAttribute("aria-selected", "false");
      }

      const label = document.createElement("span");
      label.className = "queryTab__label";
      label.textContent = tab.title;
      label.title = tab.title;
      el.appendChild(label);

      if (closable) {
        const close = document.createElement("button");
        close.type = "button";
        close.className = "queryTab__close";
        close.setAttribute("aria-label", `Close ${tab.title}`);
        close.title = "Close tab";
        close.textContent = "×";
        el.appendChild(close);
      }

      list.appendChild(el);
    }

    if (dom.queryTabsAdd) {
      const atLimit = tabs.length >= MAX_TABS;
      dom.queryTabsAdd.disabled = atLimit;
      dom.queryTabsAdd.classList.toggle("is-disabled", atLimit);
      dom.queryTabsAdd.title = atLimit ? `Tab limit reached (${MAX_TABS})` : "New query tab";
    }

    if (dom.queryTabs) dom.queryTabs.classList.toggle("is-busy", isBusy());
  };

  // --- actions ----------------------------------------------------------------

  const activate = (id) => {
    if (id === activeId) return;
    if (isBusy()) return;
    const target = tabs.find((t) => t.id === id);
    if (!target) return;

    snapshotActive();
    activeId = id;
    applyTab(target);
    renderTabs();
    persist();
  };

  const addTab = () => {
    if (isBusy()) return;
    if (tabs.length >= MAX_TABS) return;

    snapshotActive();

    const used = new Set(tabs.map((t) => t.title));
    let n = tabs.length + 1;
    let title = `Query ${n}`;
    while (used.has(title)) {
      n += 1;
      title = `Query ${n}`;
    }

    const tab = { id: nextId(), title, sql: "", resultsState: null, metricsState: null };
    tabs.push(tab);
    activeId = tab.id;
    applyTab(tab);
    renderTabs();
    persist();

    if (dom.queryTextArea) {
      try {
        dom.queryTextArea.focus();
      } catch {
        /* ignore */
      }
    }
  };

  const closeTab = (id) => {
    if (isBusy()) return;
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;

    // Keep at least one tab around: closing the last one just clears it.
    if (tabs.length === 1) {
      const only = tabs[0];
      only.sql = "";
      only.title = "Query 1";
      only.resultsState = null;
      only.metricsState = null;
      applyTab(only);
      renderTabs();
      persist();
      return;
    }

    const wasActive = id === activeId;
    tabs.splice(idx, 1);

    if (wasActive) {
      const neighbor = tabs[Math.min(idx, tabs.length - 1)];
      activeId = neighbor.id;
      applyTab(neighbor);
    }
    renderTabs();
    persist();
  };

  const renameTab = (tab, el) => {
    const label = el.querySelector(".queryTab__label");
    if (!label) return;

    const input = document.createElement("input");
    input.type = "text";
    input.className = "queryTab__rename";
    input.maxLength = TAB_TITLE_MAX;
    input.value = tab.title;
    label.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const commit = (save) => {
      if (done) return;
      done = true;
      if (save) {
        const next = String(input.value || "").trim();
        if (next) tab.title = next.slice(0, TAB_TITLE_MAX);
      }
      renderTabs();
      persist();
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        commit(false);
      }
    });
    input.addEventListener("blur", () => commit(true));
  };

  // --- drag & drop reordering -------------------------------------------------

  const reorder = (fromId, beforeId) => {
    const fromIdx = tabs.findIndex((t) => t.id === fromId);
    if (fromIdx === -1) return;
    const [moved] = tabs.splice(fromIdx, 1);

    if (beforeId == null) {
      tabs.push(moved);
    } else {
      const toIdx = tabs.findIndex((t) => t.id === beforeId);
      tabs.splice(toIdx === -1 ? tabs.length : toIdx, 0, moved);
    }
    renderTabs();
    persist();
  };

  // Element the dragged tab should be inserted before (null => append at end).
  const dropTargetId = (clientX) => {
    const list = dom.queryTabsList;
    if (!list) return null;
    const els = Array.from(list.querySelectorAll(".queryTab"));
    for (const el of els) {
      if (el.dataset.tabId === dragId) continue;
      const rect = el.getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) return el.dataset.tabId;
    }
    return null;
  };

  // --- event wiring -----------------------------------------------------------

  const onListClick = (e) => {
    const closeBtn = e.target.closest(".queryTab__close");
    if (closeBtn) {
      const tabEl = closeBtn.closest(".queryTab");
      if (tabEl) closeTab(tabEl.dataset.tabId);
      e.stopPropagation();
      return;
    }
    const tabEl = e.target.closest(".queryTab");
    if (tabEl) activate(tabEl.dataset.tabId);
  };

  const onListDblClick = (e) => {
    if (e.target.closest(".queryTab__close")) return;
    const tabEl = e.target.closest(".queryTab");
    if (!tabEl) return;
    const tab = tabs.find((t) => t.id === tabEl.dataset.tabId);
    if (tab) renameTab(tab, tabEl);
  };

  const onListKeyDown = (e) => {
    const tabEl = e.target.closest(".queryTab");
    if (!tabEl) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      activate(tabEl.dataset.tabId);
    }
  };

  const onDragStart = (e) => {
    const tabEl = e.target.closest(".queryTab");
    if (!tabEl || isBusy()) {
      e.preventDefault();
      return;
    }
    dragId = tabEl.dataset.tabId;
    tabEl.classList.add("is-dragging");
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      try {
        e.dataTransfer.setData("text/plain", dragId);
      } catch {
        /* ignore */
      }
    }
  };

  const clearDropMarkers = () => {
    const list = dom.queryTabsList;
    if (!list) return;
    for (const el of list.querySelectorAll(".queryTab")) {
      el.classList.remove("is-dropBefore");
    }
  };

  const onDragOver = (e) => {
    if (dragId == null) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    clearDropMarkers();
    const beforeId = dropTargetId(e.clientX);
    if (beforeId) {
      const el = dom.queryTabsList.querySelector(`.queryTab[data-tab-id="${beforeId}"]`);
      if (el) el.classList.add("is-dropBefore");
    }
  };

  const onDrop = (e) => {
    if (dragId == null) return;
    e.preventDefault();
    const beforeId = dropTargetId(e.clientX);
    reorder(dragId, beforeId);
  };

  const onDragEnd = () => {
    dragId = null;
    clearDropMarkers();
    const list = dom.queryTabsList;
    if (list) {
      for (const el of list.querySelectorAll(".queryTab.is-dragging")) el.classList.remove("is-dragging");
    }
  };

  // Enable/disable the multi-tab UI (called from the editor options menu).
  // Disabling collapses to a single editor: the active tab's query stays in the
  // editor and the bar is hidden; other tabs are preserved so re-enabling
  // restores them.
  function setEnabled(on) {
    on = on !== false;
    try {
      localStorage.setItem(ENABLED_KEY, on ? "true" : "false");
    } catch {
      /* ignore */
    }
    if (on === enabled) {
      applyEnabledVisibility();
      return;
    }
    if (!on) snapshotActive();
    enabled = on;
    applyEnabledVisibility();
    if (on) renderTabs();
  }

  const isEnabled = () => enabled;

  // Keep the busy-state class in sync so tabs visibly lock during a run.
  // run.js owns isRunning and exposes no event, so a light poll is enough.
  const watchBusy = () => {
    let last = isBusy();
    setInterval(() => {
      const now = isBusy();
      if (now !== last) {
        last = now;
        if (dom.queryTabs) dom.queryTabs.classList.toggle("is-busy", now);
      }
    }, 200);
  };

  // --- init -------------------------------------------------------------------

  function init() {
    if (!dom.queryTabs || !dom.queryTabsList) return;

    const persisted = loadPersisted();
    if (persisted) {
      tabs = persisted.tabs;
      activeId = persisted.activeId;
      // The editor still shows the previous session draft; align it with the
      // active tab's stored SQL (results are not persisted, so start blank).
      const active = getActive();
      setEditorValue(active ? active.sql : "");
      if (results && typeof results.restoreState === "function") results.restoreState(null);
      if (run && typeof run.restoreMetrics === "function") run.restoreMetrics(null);
    } else {
      // First run: adopt whatever is already in the editor as the first tab.
      tabs = [{ id: nextId(), title: "Query 1", sql: editorValue(), resultsState: null, metricsState: null }];
      activeId = tabs[0].id;
    }

    renderTabs();
    persist();
    applyEnabledVisibility();

    dom.queryTabsList.addEventListener("click", onListClick);
    dom.queryTabsList.addEventListener("dblclick", onListDblClick);
    dom.queryTabsList.addEventListener("keydown", onListKeyDown);
    dom.queryTabsList.addEventListener("dragstart", onDragStart);
    dom.queryTabsList.addEventListener("dragover", onDragOver);
    dom.queryTabsList.addEventListener("drop", onDrop);
    dom.queryTabsList.addEventListener("dragend", onDragEnd);
    if (dom.queryTabsAdd) dom.queryTabsAdd.addEventListener("click", addTab);

    // Persist editor edits against the active tab as the user types.
    if (dom.queryTextArea) {
      let saveTimer = 0;
      dom.queryTextArea.addEventListener("input", () => {
        const active = getActive();
        if (!active) return;
        active.sql = editorValue();
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
          saveTimer = 0;
          persist();
        }, 400);
      });
    }

    watchBusy();
  }

  ns.tabs = { init, addTab, closeTab, activate, setEnabled, isEnabled };
})();
