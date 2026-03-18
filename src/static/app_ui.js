(() => {
  "use strict";

  const ns = window.ChDash;
  if (!ns) return;

  const { dom, state, storage, util } = ns;

  (() => {
    const mode = storage && typeof storage.getSavedThemeMode === "function" ? storage.getSavedThemeMode() : null;
    if (mode === "dark" || mode === "light") dom.root.dataset.theme = mode;
    else if (mode === "system") delete dom.root.dataset.theme;
  })();

  function safelyParseJson(text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  async function loadMeta() {
    if (!dom.versionBadge) return;
    try {
      const resp = await fetch("api/version", { cache: "no-store" });
      if (!resp.ok) {
        dom.versionBadge.textContent = "meta: error";
        return;
      }
      const data = await resp.json();
      const verObj = data && data.version ? data.version : null;
      const ver = verObj && typeof verObj === "object" ? String(verObj.semver || "dev") : String(data.version || "dev");
      const sha = verObj && typeof verObj === "object" ? String(verObj.git_sha || "") : String(data.git_sha || "");
      const build = verObj && typeof verObj === "object" ? String(verObj.build_time || "") : String(data.build_time || "");
      const text = sha && sha !== "unknown" ? `${ver} (${sha})` : ver;
      dom.versionBadge.textContent = text;
      if (build) dom.versionBadge.title = `Backend version\nBuild: ${build}`;
    } catch {
      dom.versionBadge.textContent = "meta: offline";
    }
  }

  function formatPingMsLabel(pingMs) {
    const ms = Number(pingMs);
    if (!Number.isFinite(ms)) return "-";
    if (ms > 0 && ms < 1) return "<1ms";
    const rounded = Math.round(ms);
    if (rounded < 1) return "<1ms";
    return `${rounded} ms`;
  }

  function pickDefaultHostId(snapshot) {
    const hosts = snapshot && Array.isArray(snapshot.hosts) ? snapshot.hosts : [];
    const ids = hosts.map((h) => String(h.id));
    const stored = storage.getStoredHostId();
    if (stored && ids.includes(String(stored))) return String(stored);
    return ids.length ? ids[0] : null;
  }

  function setSelectedHostId(hostId) {
    state.selectedHostId = hostId ? String(hostId) : null;
    if (state.selectedHostId) storage.setStoredHostId(state.selectedHostId);
    applyHostPickerUi();

    if (ns.meta && typeof ns.meta.hydrateFromStorage === "function" && state.selectedHostId) {
      ns.meta.hydrateFromStorage(state.selectedHostId);
    }
    if (ns.meta && typeof ns.meta.maybeRefreshOnLoad === "function") {
      ns.meta.maybeRefreshOnLoad();
    }
    if (state.highlightCtrl && typeof state.highlightCtrl.refresh === "function") {
      state.highlightCtrl.refresh();
    }
    if (state.editorSizeCtrl && typeof state.editorSizeCtrl.apply === "function") {
      state.editorSizeCtrl.apply(state.selectedHostId);
    }
  }

  function applyHostPickerUi() {
    const snap = state.hostsSnapshot;
    const apiOnline = state.apiOnline !== false;

    const hosts = snap && Array.isArray(snap.hosts) ? snap.hosts : [];
    const selected = state.selectedHostId ? hosts.find((h) => h && String(h.id) === String(state.selectedHostId)) : null;

    const healthy = !!(selected && selected.healthy);
    const pingMs = selected && selected.ping_ms != null ? Number(selected.ping_ms) : null;
    const label = selected ? String(selected.label || selected.id) : (state.selectedHostId || "Host");
    const hostVersion = selected && selected.clickhouse_version != null ? String(selected.clickhouse_version) : "";

    if (dom.hostPickerText) dom.hostPickerText.textContent = apiOnline ? label : `${label} (API offline)`;
    if (dom.hostPickerVersion) dom.hostPickerVersion.textContent = hostVersion || "";

    if (dom.hostPickerDot) {
      const good = apiOnline && healthy;
      dom.hostPickerDot.classList.toggle("hostDot--good", good);
      dom.hostPickerDot.classList.toggle("hostDot--bad", !good);
    }

    if (dom.hostPickerPing) {
      if (!apiOnline) {
        dom.hostPickerPing.textContent = "-";
      } else if (healthy && pingMs != null && Number.isFinite(pingMs)) {
        dom.hostPickerPing.textContent = formatPingMsLabel(pingMs);
      } else {
        dom.hostPickerPing.textContent = healthy ? "-" : "down";
      }
    }

    if (dom.hostPickerButton) {
      dom.hostPickerButton.disabled = !apiOnline;
      dom.hostPickerButton.title = hostVersion ? `${label}\nClickHouse ${hostVersion}` : label;
      if (!apiOnline) closeHostMenu();
    }
  }


  function closeHostMenu() {
    if (!dom.hostPickerMenu || !dom.hostPickerButton) return;
    dom.hostPickerMenu.hidden = true;
    dom.hostPickerButton.setAttribute("aria-expanded", "false");
  }

  function openHostMenu() {
    if (!dom.hostPickerMenu || !dom.hostPickerButton) return;
    dom.hostPickerMenu.hidden = false;
    dom.hostPickerButton.setAttribute("aria-expanded", "true");
    dom.hostPickerMenu.focus({ preventScroll: true });
  }

  function toggleHostMenu() {
    if (!dom.hostPickerMenu) return;
    if (dom.hostPicker?.classList.contains("is-static")) return;
    if (dom.hostPickerMenu.hidden) openHostMenu();
    else closeHostMenu();
  }

  function renderHostPicker(snapshot) {
    if (!dom.hostPickerMenu) return;
    const hosts = snapshot && Array.isArray(snapshot.hosts) ? snapshot.hosts : [];

    if (!state.selectedHostId) {
      setSelectedHostId(pickDefaultHostId(snapshot));
    } else {
      const ids = hosts.map((x) => String(x.id));
      if (!ids.includes(String(state.selectedHostId))) setSelectedHostId(ids.length ? ids[0] : null);
    }

    const staticPicker = hosts.length <= 1;

    if (dom.hostPicker) dom.hostPicker.classList.toggle("is-static", staticPicker);

    if (dom.hostPickerButton) {
      dom.hostPickerButton.disabled = false;
      dom.hostPickerButton.setAttribute("aria-disabled", String(staticPicker));
      if (staticPicker) closeHostMenu();
    }

    dom.hostPickerMenu.innerHTML = "";

    for (const h of hosts) {
      if (!h || !h.id) continue;
      const id = String(h.id);
      const isSelected = state.selectedHostId && id === String(state.selectedHostId);
      if (isSelected) continue;

      const label = String(h.label || h.id);
      const healthy = !!h.healthy;
      const pingMs = h.ping_ms != null ? Number(h.ping_ms) : null;

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pickerOption";
      btn.setAttribute("role", "option");
      btn.setAttribute("data-id", id);
      btn.setAttribute("aria-selected", String(!!isSelected));

      const dot = document.createElement("span");
      dot.className = `hostDot ${healthy ? "hostDot--good" : "hostDot--bad"}`;
      dot.setAttribute("aria-hidden", "true");

      const text = document.createElement("span");
      text.className = "pickerOption__label";
      text.textContent = label;

      const version = document.createElement("span");
      version.className = "pickerOption__version";
      version.textContent = h.clickhouse_version != null ? String(h.clickhouse_version) : "";

      const meta = document.createElement("span");
      meta.className = "pickerOption__meta";
      meta.textContent = healthy && pingMs != null && Number.isFinite(pingMs) ? formatPingMsLabel(pingMs) : (healthy ? "-" : "down");

      btn.appendChild(dot);
      btn.appendChild(text);
      btn.appendChild(version);
      btn.appendChild(meta);

      btn.addEventListener("click", () => {
        if (!isSelected) setSelectedHostId(id);
        renderHostPicker(state.hostsSnapshot || snapshot);
        closeHostMenu();
      });

      dom.hostPickerMenu.appendChild(btn);
    }

    applyHostPickerUi();
  }

  function setApiOnline(online) {
    const next = online !== false;
    if (state.apiOnline === next) return;
    state.apiOnline = next;
    applyHostPickerUi();
    const run = ns.run;
    if (run && typeof run.updateActionButtons === "function") run.updateActionButtons();
  }

  function startHostsSse() {
    if (!dom.hostPicker) return;

    const pollMs = 5000;
    let es = null;
    let pollTimer = 0;
    let reconnectTimer = 0;
    let hasSnapshot = false;

    const useSnapshot = (snap) => {
      if (!snap || !Array.isArray(snap.hosts)) return;
      hasSnapshot = true;
      state.hostsSnapshot = snap;
      renderHostPicker(snap);
      setApiOnline(true);
    };

    const closeStream = () => {
      if (!es) return;
      try {
        es.close();
      } catch {
        return;
      } finally {
        es = null;
      }
    };

    const stopPoll = () => {
      if (!pollTimer) return;
      clearTimeout(pollTimer);
      pollTimer = 0;
    };

    const stopReconnect = () => {
      if (!reconnectTimer) return;
      clearTimeout(reconnectTimer);
      reconnectTimer = 0;
    };

    const fetchHostsOnce = async () => {
      try {
        const r = await fetch("api/hosts", { cache: "no-store" });
        if (!r.ok) return false;
        const data = await r.json();
        useSnapshot(data);
        return true;
      } catch {
        return false;
      }
    };

    const schedulePoll = () => {
      if (pollTimer) return;
      pollTimer = setTimeout(async () => {
        pollTimer = 0;
        const ok = await fetchHostsOnce();
        if (!ok) setApiOnline(false);
        if (ok) ensureStream();
        if (!es) schedulePoll();
      }, pollMs);
    };

    const scheduleReconnect = () => {
      if (reconnectTimer || !hasSnapshot || es) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = 0;
        ensureStream();
      }, pollMs);
    };

    const ensureStream = () => {
      if (es || !hasSnapshot) return;
      stopReconnect();

      let next = null;
      try {
        next = new EventSource("api/hosts/stream");
      } catch {
        schedulePoll();
        scheduleReconnect();
        return;
      }

      es = next;

      es.addEventListener("hosts", (ev) => {
        const data = safelyParseJson(ev.data);
        if (!data) return;
        useSnapshot(data);
      });

      es.onopen = () => {
        setApiOnline(true);
        stopPoll();
      };

      es.onerror = () => {
        closeStream();
        schedulePoll();
        scheduleReconnect();
      };
    };

    const boot = async () => {
      const ok = await fetchHostsOnce();
      if (!ok) {
        setApiOnline(false);
        schedulePoll();
        return;
      }
      ensureStream();
    };

    boot();
  }


  function getResolvedTheme(mode) {
    if (mode === "dark" || mode === "light") return mode;
    try {
      const mql = window.matchMedia("(prefers-color-scheme: dark)");
      return mql && mql.matches ? "dark" : "light";
    } catch {
      return "dark";
    }
  }

  function applyTheme(mode) {
    const resolved = getResolvedTheme(mode);
    if (mode === "system") delete dom.root.dataset.theme;
    else dom.root.dataset.theme = resolved;

    if (dom.themeSelectText) dom.themeSelectText.textContent = mode === "system" ? "System" : (resolved[0].toUpperCase() + resolved.slice(1));

    if (dom.themeSelectMenu) {
      const btns = dom.themeSelectMenu.querySelectorAll(".themeSelect__option[data-value]");
      for (const b of btns) {
        const m = b.getAttribute("data-value");
        b.setAttribute("aria-selected", String(m === mode));
      }
    }
  }

  function isThemeMenuOpen() {
    return !!(dom.themeSelect && dom.themeSelect.classList.contains("themeSelect--open"));
  }

  function openThemeMenu() {
    if (!dom.themeSelectMenu || !dom.themeSelect || !dom.themeSelectButton) return;
    dom.themeSelectMenu.hidden = false;
    dom.themeSelectButton.setAttribute("aria-expanded", "true");
    dom.themeSelect.classList.remove("themeSelect--closing");
    requestAnimationFrame(() => {
      dom.themeSelect.classList.add("themeSelect--open");
    });
    dom.themeSelectMenu.focus({ preventScroll: true });
  }

  function closeThemeMenu({ immediate = false } = {}) {
    if (!dom.themeSelectMenu || !dom.themeSelect || !dom.themeSelectButton) return;
    dom.themeSelectButton.setAttribute("aria-expanded", "false");
    dom.themeSelect.classList.remove("themeSelect--open");
    if (immediate) {
      dom.themeSelect.classList.remove("themeSelect--closing");
      dom.themeSelectMenu.hidden = true;
      return;
    }
    dom.themeSelect.classList.add("themeSelect--closing");
    setTimeout(() => {
      if (!isThemeMenuOpen()) dom.themeSelectMenu.hidden = true;
      dom.themeSelect.classList.remove("themeSelect--closing");
    }, 160);
  }

  function toggleThemeMenu() {
    if (!dom.themeSelectMenu) return;
    if (isThemeMenuOpen()) closeThemeMenu();
    else openThemeMenu();
  }

  function isCopyMenuOpen() {
    return !!(dom.copySplit && dom.copySplit.classList.contains("is-open"));
  }

  function openCopyMenu() {
    if (!dom.copyMenu || !dom.copyMenuButton || !dom.copySplit) return;
    dom.copyMenu.hidden = false;
    dom.copyMenuButton.setAttribute("aria-expanded", "true");
    requestAnimationFrame(() => {
      dom.copySplit.classList.add("is-open");
    });
    dom.copyMenu.focus({ preventScroll: true });
  }

  function closeCopyMenu({ immediate = false } = {}) {
    if (!dom.copyMenu || !dom.copyMenuButton || !dom.copySplit) return;
    dom.copyMenuButton.setAttribute("aria-expanded", "false");
    dom.copySplit.classList.remove("is-open");
    if (immediate) {
      dom.copyMenu.hidden = true;
      return;
    }
    setTimeout(() => {
      if (!isCopyMenuOpen()) dom.copyMenu.hidden = true;
    }, 160);
  }

  function toggleCopyMenu() {
    if (!dom.copyMenu) return;
    if (dom.copyMenu.hidden) openCopyMenu();
    else closeCopyMenu();
  }

  function openRunMenu() {
    if (!dom.runMenu || !dom.runMenuButton || !dom.runSplit) return;
    dom.runMenu.hidden = false;
    dom.runMenuButton.setAttribute("aria-expanded", "true");
    requestAnimationFrame(() => {
      dom.runSplit.classList.add("is-open");
    });
    dom.runMenu.focus({ preventScroll: true });
  }

  function closeRunMenu({ immediate = false } = {}) {
    if (!dom.runMenu || !dom.runMenuButton || !dom.runSplit) return;
    dom.runMenuButton.setAttribute("aria-expanded", "false");
    dom.runSplit.classList.remove("is-open");
    if (immediate) {
      dom.runMenu.hidden = true;
      return;
    }
    setTimeout(() => {
      if (!dom.runSplit.classList.contains("is-open")) dom.runMenu.hidden = true;
    }, 160);
  }

  function toggleRunMenu() {
    if (!dom.runMenu) return;
    if (dom.runMenu.hidden) openRunMenu();
    else closeRunMenu();
  }

  function applyRunOptionsUi() {
    if (dom.runOptAutoFormat) {
      dom.runOptAutoFormat.setAttribute("aria-checked", String(!!state.runOptAutoFormat));
    }
    if (dom.runOptMultiQuery) {
      dom.runOptMultiQuery.setAttribute("aria-checked", String(!!state.runOptMultiQuery));
    }
  }

  function toggleRunOption(key) {
    if (key === "autoFormat") state.runOptAutoFormat = !state.runOptAutoFormat;
    if (key === "multiQuery") state.runOptMultiQuery = !state.runOptMultiQuery;
    storage.saveRunOptions({ autoFormat: state.runOptAutoFormat, multiQuery: state.runOptMultiQuery });
    applyRunOptionsUi();
  }

  function formatDateTime(tsMs) {
    try {
      const d = new Date(tsMs);
      const yyyy = d.getFullYear();
      const mo = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      const ss = String(d.getSeconds()).padStart(2, "0");
      return `${yyyy}-${mo}-${dd} ${hh}:${mm}:${ss}`;
    } catch {
      return "";
    }
  }

  function formatShortDateTime(tsMs) {
    try {
      const d = new Date(tsMs);
      const yyyy = d.getFullYear();
      const mo = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      return `${yyyy}-${mo}-${dd} ${hh}:${mm}`;
    } catch {
      return "";
    }
  }

  function formatInlineSqlPreview(sql, maxLen = 220) {
    const text = String(sql || "").replace(/\s+/g, " ").trim();
    if (!text) return "";
    if (text.length <= maxLen) return text;
    return `${text.slice(0, Math.max(0, maxLen - 1)).trimEnd()}…`;
  }

  function trimLabel(text, maxLen) {
    const value = String(text || "").trim();
    if (!value) return "";
    if (value.length <= maxLen) return value;
    return `${value.slice(0, Math.max(0, maxLen - 1)).trimEnd()}…`;
  }

  function activateQueryLibraryItem(item) {
    if (item.host_id) setSelectedHostId(String(item.host_id));
    if (dom.queryTextArea) util.replaceTextAreaValue(dom.queryTextArea, String(item.sql_formatted || item.sql_raw || ""));
    closeQueryLibraryMenu({ immediate: true });
  }

  function createQueryLibraryMeta(hostId, tsMs) {
    const meta = document.createElement("div");
    meta.className = "queryLibraryItem__meta";

    if (hostId) {
      const host = document.createElement("span");
      host.className = "queryLibraryItem__host";
      host.textContent = String(hostId);
      meta.appendChild(host);
    }

    const date = document.createElement("span");
    date.className = "queryLibraryItem__date";
    date.textContent = formatShortDateTime(tsMs);
    meta.appendChild(date);

    return meta;
  }

  function createQueryLibraryItem({ title, titleMaxLen = 44, hostId, tsMs, sql, sqlPreview, onActivate, onDelete, deleteLabel }) {
    const row = document.createElement("div");
    row.className = "queryLibraryItem";

    const main = document.createElement("div");
    main.className = "queryLibraryItem__main";
    main.tabIndex = 0;
    main.setAttribute("role", "button");

    const header = document.createElement("div");
    header.className = "queryLibraryItem__header";

    const titleEl = document.createElement("div");
    titleEl.className = "queryLibraryItem__title";
    titleEl.textContent = trimLabel(title, titleMaxLen);

    const right = document.createElement("div");
    right.className = "queryLibraryItem__right";
    right.appendChild(createQueryLibraryMeta(hostId, tsMs));

    if (typeof onDelete === "function") {
      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "queryLibraryItem__delete";
      deleteBtn.title = "Delete saved query";
      deleteBtn.setAttribute("aria-label", deleteLabel || "Delete saved query");
      deleteBtn.textContent = "×";
      deleteBtn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        onDelete();
      });
      right.appendChild(deleteBtn);
    } else {
      const spacer = document.createElement("span");
      spacer.className = "queryLibraryItem__deleteSpacer";
      spacer.setAttribute("aria-hidden", "true");
      spacer.textContent = "×";
      right.appendChild(spacer);
    }

    const inlinePreview = String(sqlPreview || "").trim();

    main.addEventListener("click", onActivate);
    main.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      ev.preventDefault();
      onActivate();
    });

    header.appendChild(titleEl);
    header.appendChild(right);
    main.appendChild(header);
    if (inlinePreview) {
      const sqlEl = document.createElement("div");
      sqlEl.className = "queryLibraryItem__sql";
      sqlEl.textContent = inlinePreview;
      main.appendChild(sqlEl);
    }
    row.appendChild(main);

    return row;
  }

  let queryLibraryMode = "saved";

  function isQueryLibraryOpen() {
    return !!(dom.queryLibrary && dom.queryLibrary.classList.contains("is-open"));
  }

  function focusQueryLibrarySaveInput() {
    const input = dom.queryLibraryContent?.querySelector(".savePanel__input");
    if (!input) return;
    input.focus({ preventScroll: true });
    if (typeof input.select === "function") input.select();
  }

  function closeQueryLibraryMenu({ immediate = false } = {}) {
    if (!dom.queryLibrary || !dom.queryLibraryMenu || !dom.queryLibraryButton) return;
    dom.queryLibraryButton.setAttribute("aria-expanded", "false");
    dom.queryLibrary.classList.remove("is-open");
    if (immediate) {
      dom.queryLibraryMenu.hidden = true;
      return;
    }
    setTimeout(() => {
      if (!isQueryLibraryOpen()) dom.queryLibraryMenu.hidden = true;
    }, 160);
  }

  function renderHistoryContent(target) {
    const items = storage.loadHistory();
    target.innerHTML = "";

    const wrap = document.createElement("div");
    wrap.className = "queryLibraryPanel";

    const list = document.createElement("div");
    list.className = "queryLibraryList";

    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "queryLibraryEmpty";
      empty.textContent = "No history yet";
      list.appendChild(empty);
      wrap.appendChild(list);
      target.appendChild(wrap);
      return;
    }

    for (const it of items) {
      const sqlText = String(it.sql_formatted || it.sql_raw || "");
      list.appendChild(createQueryLibraryItem({
        title: formatInlineSqlPreview(sqlText, 108) || "Query",
        titleMaxLen: 108,
        hostId: it.host_id || "",
        tsMs: it.ts_ms,
        sql: sqlText,
        sqlPreview: "",
        onActivate: () => activateQueryLibraryItem(it),
      }));
    }

    wrap.appendChild(list);
    target.appendChild(wrap);
  }

  function renderSavedContent(target) {
    target.innerHTML = "";

    const wrap = document.createElement("div");
    wrap.className = "queryLibraryPanel";

    const form = document.createElement("div");
    form.className = "savePanel";

    const input = document.createElement("input");
    input.className = "savePanel__input";
    input.type = "text";
    input.placeholder = "Query name…";
    input.autocomplete = "off";
    input.spellcheck = false;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "button button--primary";
    button.textContent = "Save";

    const list = document.createElement("div");
    list.className = "queryLibraryList";

    const renderSavedList = () => {
      const savedItems = storage.loadSavedQueries();
      list.innerHTML = "";

      if (!savedItems.length) {
        const empty = document.createElement("div");
        empty.className = "queryLibraryEmpty";
        empty.textContent = "No saved queries yet";
        list.appendChild(empty);
        return;
      }

      for (const it of savedItems) {
        const sqlText = String(it.sql_formatted || it.sql_raw || "");
        list.appendChild(createQueryLibraryItem({
          title: String(it.name || "Untitled query"),
          titleMaxLen: 34,
          hostId: it.host_id || "",
          tsMs: it.created_at_ms,
          sql: sqlText,
          sqlPreview: formatInlineSqlPreview(sqlText, 168),
          onActivate: () => activateQueryLibraryItem(it),
          onDelete: () => {
            storage.deleteSavedQuery(it.name);
            renderSavedList();
          },
          deleteLabel: `Delete ${it.name}`,
        }));
      }
    };

    const updateSaveState = () => {
      const currentSql = String(dom.queryTextArea?.value || "").trim();
      const name = String(input.value || "").trim();
      button.disabled = !currentSql || !name;
    };

    const commitSave = () => {
      const currentSql = String(dom.queryTextArea?.value || "").trim();
      const name = String(input.value || "").trim();
      if (!currentSql || !name) return;
      storage.addSavedQuery({
        name,
        created_at_ms: Date.now(),
        host_id: state.selectedHostId || "",
        sql_raw: currentSql,
        sql_formatted: currentSql,
      });
      input.value = "";
      updateSaveState();
      renderSavedList();
      requestAnimationFrame(focusQueryLibrarySaveInput);
    };

    input.addEventListener("input", updateSaveState);
    input.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      commitSave();
    });
    button.addEventListener("click", commitSave);

    form.appendChild(input);
    form.appendChild(button);
    wrap.appendChild(form);
    wrap.appendChild(list);
    target.appendChild(wrap);

    updateSaveState();
    renderSavedList();
    requestAnimationFrame(focusQueryLibrarySaveInput);
  }

  function renderQueryLibraryMenu() {
    if (!dom.queryLibraryContent) return;

    const tabs = [dom.queryLibraryTabSaved, dom.queryLibraryTabHistory];
    for (const tab of tabs) {
      if (!tab) continue;
      const mode = tab.getAttribute("data-mode");
      tab.setAttribute("aria-selected", String(mode === queryLibraryMode));
    }

    if (queryLibraryMode === "saved") {
      renderSavedContent(dom.queryLibraryContent);
      return;
    }

    renderHistoryContent(dom.queryLibraryContent);
  }

  function openQueryLibraryMenu(mode = queryLibraryMode) {
    if (!dom.queryLibrary || !dom.queryLibraryMenu || !dom.queryLibraryButton) return;
    queryLibraryMode = mode === "history" ? "history" : "saved";
    renderQueryLibraryMenu();
    dom.queryLibraryMenu.hidden = false;
    dom.queryLibraryButton.setAttribute("aria-expanded", "true");
    requestAnimationFrame(() => {
      dom.queryLibrary.classList.add("is-open");
    });
    dom.queryLibraryMenu.focus({ preventScroll: true });
  }

  function setQueryLibraryMode(mode) {
    const next = mode === "history" ? "history" : "saved";
    if (queryLibraryMode === next) return;
    queryLibraryMode = next;
    renderQueryLibraryMenu();
  }

  function toggleQueryLibraryMenu(mode = queryLibraryMode) {
    const next = mode === "history" ? "history" : "saved";
    if (!dom.queryLibraryMenu) return;
    if (dom.queryLibraryMenu.hidden) {
      openQueryLibraryMenu(next);
      return;
    }
    if (queryLibraryMode !== next) {
      setQueryLibraryMode(next);
      return;
    }
    closeQueryLibraryMenu();
  }

  function initEditor() {
    if (!dom.queryTextArea) return;

    const editorDraftKey = "chdash.editor.draft.v2";

    const loadEditorDraft = () => {
      try {
        return sessionStorage.getItem(editorDraftKey);
      } catch {
        return null;
      }
    };

    const saveEditorDraft = (text) => {
      try {
        sessionStorage.setItem(editorDraftKey, String(text || ""));
      } catch {
        null;
      }
    };

    const dispatchInputEvent = (el) => {
      if (!el || typeof el.dispatchEvent !== "function") return;
      try {
        el.dispatchEvent(new Event("input", { bubbles: true }));
      } catch {
        try {
          el.dispatchEvent(new Event("input"));
        } catch {
          null;
        }
      }
    };

    const current = String(dom.queryTextArea.value || "");
    if (!current.trim()) {
      const saved = String(loadEditorDraft() || "");
      if (saved.trim()) {
        if (util && typeof util.replaceTextAreaValue === "function") {
          util.replaceTextAreaValue(dom.queryTextArea, saved);
        } else {
          dom.queryTextArea.value = saved;
        }
        requestAnimationFrame(() => {
          const ctrl = ns.state && ns.state.highlightCtrl;
          if (ctrl && typeof ctrl.refresh === "function") ctrl.refresh();
        });
      }
    }

    let draftSaveTimer = 0;
    dom.queryTextArea.addEventListener("input", () => {
      if (draftSaveTimer) clearTimeout(draftSaveTimer);
      draftSaveTimer = setTimeout(() => {
        draftSaveTimer = 0;
        saveEditorDraft(dom.queryTextArea.value);
      }, 200);
    });

    const replaceSelectionText = (ta, nextText) => {
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      try {
        const before = String(ta.value || "");
        ta.focus();
        ta.setSelectionRange(start, end);
        const ok = document.execCommand && document.execCommand("insertText", false, nextText);
        if (ok || String(ta.value || "") !== before) return { start, end };
      } catch {
        null;
      }
      try {
        ta.setRangeText(nextText, start, end, "end");
        dispatchInputEvent(ta);
        return { start, end };
      } catch {
        null;
      }
      const value = String(ta.value || "");
      ta.value = value.slice(0, start) + nextText + value.slice(end);
      const pos = start + nextText.length;
      ta.selectionStart = pos;
      ta.selectionEnd = pos;
      dispatchInputEvent(ta);
      return { start, end };
    };

    dom.queryTextArea.addEventListener("keydown", (e) => {
      const key = e.key;
      if (e.isComposing) return;
      if ((e.ctrlKey || e.metaKey) && key === "Enter") {
        e.preventDefault();
        const run = ns.run;
        if (run && typeof run.handleRun === "function") run.handleRun();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (key === "`" || key === "\"" || key === "'") {
        const ta = dom.queryTextArea;
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        if (start == null || end == null || start === end) return;
        e.preventDefault();
        const value = String(ta.value || "");
        const selected = value.slice(start, end);
        replaceSelectionText(ta, key + selected + key);
        ta.selectionStart = start + 1;
        ta.selectionEnd = end + 1;
        return;
      }

      if (key === "Enter") {
        const ta = dom.queryTextArea;
        const start = ta.selectionStart;
        if (start == null) return;
        const value = String(ta.value || "");
        const lineStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
        let i = lineStart;
        while (i < value.length) {
          const c = value[i];
          if (c !== " " && c !== "\t") break;
          i++;
        }
        const indent = value.slice(lineStart, i);
        e.preventDefault();
        const inserted = "\n" + indent;
        const prev = replaceSelectionText(ta, inserted);
        const pos = prev.start + inserted.length;
        ta.selectionStart = pos;
        ta.selectionEnd = pos;
        return;
      }

      if (key !== "Tab") return;

      const ta = dom.queryTextArea;
      const value = String(ta.value || "");
      const start = ta.selectionStart;
      const end = ta.selectionEnd;

      e.preventDefault();

      const lineStartIndex = (text, idx) => {
        const i = text.lastIndexOf("\n", idx - 1);
        return i === -1 ? 0 : i + 1;
      };

      const lineEndIndex = (text, idx) => {
        const i = text.indexOf("\n", idx);
        return i === -1 ? text.length : i;
      };

      const outdentLine = (line) => {
        if (line.startsWith("\t")) return { line: line.slice(1), removed: 1 };
        if (line.startsWith("    ")) return { line: line.slice(4), removed: 4 };
        if (line.startsWith("  ")) return { line: line.slice(2), removed: 2 };
        if (line.startsWith(" ")) return { line: line.slice(1), removed: 1 };
        return { line, removed: 0 };
      };

      if (start === end) {
        if (!e.shiftKey) {
          replaceSelectionText(ta, "\t");
          return;
        }

        const ls = lineStartIndex(value, start);
        const le = lineEndIndex(value, start);
        const line = value.slice(ls, le);
        const rel = start - ls;
        const prefix = line.slice(0, rel);
        if (!/^[\t ]*$/.test(prefix)) return;

        const od = outdentLine(line);
        if (od.removed === 0) return;
        ta.selectionStart = ls;
        ta.selectionEnd = le;
        replaceSelectionText(ta, od.line);
        const nextPos = Math.max(ls, start - od.removed);
        ta.selectionStart = nextPos;
        ta.selectionEnd = nextPos;
        return;
      }

      let endAdj = end;
      if (endAdj > start && value[endAdj - 1] === "\n") endAdj -= 1;

      const blockStart = lineStartIndex(value, start);
      const blockEnd = lineEndIndex(value, endAdj);
      const block = value.slice(blockStart, blockEnd);
      const oldLines = block.split("\n");

      const deltas = [];
      const newLines = [];

      for (const ln of oldLines) {
        if (e.shiftKey) {
          const od = outdentLine(ln);
          newLines.push(od.line);
          deltas.push(-od.removed);
        } else {
          newLines.push("\t" + ln);
          deltas.push(1);
        }
      }

      const newBlock = newLines.join("\n");

      const lineStarts = [];
      let acc = 0;
      for (let i = 0; i < oldLines.length; i++) {
        lineStarts.push(acc);
        acc += oldLines[i].length + 1;
      }

      const shiftFor = (posRel, includeEquals) => {
        let shift = 0;
        for (let i = 0; i < lineStarts.length; i++) {
          const ls = lineStarts[i];
          if (includeEquals ? posRel >= ls : posRel > ls) shift += deltas[i];
        }
        return shift;
      };

      const startRel = start - blockStart;
      const endRel = end - blockStart;
      const includeEquals = !e.shiftKey;
      const newStart = start + shiftFor(startRel, includeEquals);
      const newEnd = end + shiftFor(endRel, includeEquals);

      ta.selectionStart = blockStart;
      ta.selectionEnd = blockEnd;
      replaceSelectionText(ta, newBlock);
      ta.selectionStart = Math.max(blockStart, newStart);
      ta.selectionEnd = Math.max(blockStart, newEnd);
    });

    // Convert 4 leading spaces into a tab while typing (indentation only).
    dom.queryTextArea.addEventListener("beforeinput", (e) => {
      if (e.inputType !== "insertText" || e.data !== " ") return;

      const ta = dom.queryTextArea;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      if (start == null || end == null || start !== end) return;

      const value = String(ta.value || "");
      const lineStart = value.lastIndexOf("\n", start - 1) + 1; // 0 if not found
      const prefix = value.slice(lineStart, start);

      // Only within indentation region (tabs/spaces only before cursor)
      if (!/^[\t ]*$/.test(prefix)) return;

      // Count consecutive spaces immediately before cursor in indentation prefix
      let run = 0;
      for (let i = prefix.length - 1; i >= 0; i--) {
        if (prefix[i] === " ") run++;
        else break;
        if (run >= 4) break;
      }

      // If this keystroke would complete 4 spaces, replace them with a tab
      if (run === 3) {
        e.preventDefault();
        const deleteFrom = start - 3;
        try {
          ta.focus();
          ta.setSelectionRange(deleteFrom, start);
          const ok = document.execCommand && document.execCommand("insertText", false, "\t");
          if (ok) return;
        } catch {
          null;
        }
        // Fallback if execCommand isn't available
        ta.setRangeText("\t", deleteFrom, start, "end");
        dispatchInputEvent(ta);
      }
    });

    // Copy: convert tabs to 4 spaces in clipboard to keep alignment when pasting elsewhere.
    dom.queryTextArea.addEventListener("copy", (e) => {
      const ta = dom.queryTextArea;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      if (start == null || end == null || start === end) return;
      const selected = String(ta.value || "").slice(start, end);
      if (!selected.includes("\t")) return;

      const text = selected.replace(/\t/g, "    ");
      if (e.clipboardData) {
        e.preventDefault();
        e.clipboardData.setData("text/plain", text);
      }
    });

    if (ns.highlight && typeof ns.highlight.attach === "function") {
      const ctrl = ns.highlight.attach(dom.queryTextArea);
      if (ns.state) ns.state.highlightCtrl = ctrl || null;
    }

    if (storage && typeof storage.loadEditorHeight === "function" && typeof storage.saveEditorHeight === "function") {
      const getTarget = () => {
        const ta = dom.queryTextArea;
        if (!ta) return null;
        if (ta.closest) return ta.closest(".editorWrap") || ta;
        const p = ta.parentNode;
        if (p && p.classList && p.classList.contains("editorWrap")) return p;
        return ta;
      };

      let lastSaved = null;
      let scheduled = 0;

      const apply = (hostId) => {
        const target = getTarget();
        if (!target) return;
        const h = storage.loadEditorHeight(hostId);
        if (h && Number.isFinite(h)) {
          const v = Math.round(h);
          target.style.height = `${v}px`;
          lastSaved = v;
        }
      };

      const save = () => {
        scheduled = 0;
        const target = getTarget();
        if (!target || !target.style || !target.style.height) return;
        const v = Math.round(target.getBoundingClientRect().height);
        if (!Number.isFinite(v) || v <= 0) return;
        if (lastSaved === v) return;
        lastSaved = v;
        storage.saveEditorHeight(state.selectedHostId, v);
      };

      apply(state.selectedHostId);

      if (typeof ResizeObserver === "function") {
        try {
          const ro = new ResizeObserver(() => {
            if (scheduled) return;
            scheduled = requestAnimationFrame(save);
          });
          const t = getTarget();
          if (t) ro.observe(t);
        } catch {
          null;
        }
      }

      state.editorSizeCtrl = { apply };
    }

    dom.queryTextArea.addEventListener("focus", () => {
      if (ns.meta && typeof ns.meta.maybeRefreshOnUserAction === "function") {
        ns.meta.maybeRefreshOnUserAction();
      }
    });
  }

  function init() {
    applyRunOptionsUi();

    loadMeta();
    initEditor();

    if (ns.meta && typeof ns.meta.hydrateFromStorage === "function" && state.selectedHostId) {
      ns.meta.hydrateFromStorage(state.selectedHostId);
    }
    if (ns.meta && typeof ns.meta.maybeRefreshOnLoad === "function") {
      ns.meta.maybeRefreshOnLoad();
    }

    if (dom.runMenuButton) dom.runMenuButton.addEventListener("click", toggleRunMenu);

    if (dom.runOptAutoFormat) dom.runOptAutoFormat.addEventListener("click", () => toggleRunOption("autoFormat"));
    if (dom.runOptMultiQuery) dom.runOptMultiQuery.addEventListener("click", () => toggleRunOption("multiQuery"));

    if (dom.hostPickerButton) dom.hostPickerButton.addEventListener("click", toggleHostMenu);

    document.addEventListener("click", (ev) => {
      const t = ev.target;
      if (dom.runSplit && dom.runMenu && !dom.runMenu.hidden) {
        if (t instanceof Node && !dom.runSplit.contains(t)) closeRunMenu();
      }
      if (dom.hostPicker && dom.hostPickerMenu && !dom.hostPickerMenu.hidden) {
        if (t instanceof Node && !dom.hostPicker.contains(t)) closeHostMenu();
      }
      if (dom.themeSelect && dom.themeSelectMenu && isThemeMenuOpen()) {
        if (t instanceof Node && !dom.themeSelect.contains(t)) closeThemeMenu();
      }
      if (dom.copySplit && dom.copyMenu && !dom.copyMenu.hidden) {
        if (t instanceof Node && !dom.copySplit.contains(t)) closeCopyMenu();
      }
      if (dom.queryLibrary && dom.queryLibraryMenu && !dom.queryLibraryMenu.hidden) {
        if (t instanceof Node && !dom.queryLibrary.contains(t)) closeQueryLibraryMenu();
      }
    });

    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        closeRunMenu({ immediate: true });
        closeHostMenu();
        closeThemeMenu({ immediate: true });
        closeCopyMenu({ immediate: true });
        closeQueryLibraryMenu({ immediate: true });
      }
    });

    dom.queryLibraryButton?.addEventListener("click", () => toggleQueryLibraryMenu());
    dom.queryLibraryTabSaved?.addEventListener("click", () => {
      if (dom.queryLibraryMenu?.hidden) openQueryLibraryMenu("saved");
      else setQueryLibraryMode("saved");
    });
    dom.queryLibraryTabHistory?.addEventListener("click", () => {
      if (dom.queryLibraryMenu?.hidden) openQueryLibraryMenu("history");
      else setQueryLibraryMode("history");
    });

    if (dom.themeSelectButton) dom.themeSelectButton.addEventListener("click", toggleThemeMenu);
    if (dom.themeSelectMenu) {
      const buttons = dom.themeSelectMenu.querySelectorAll(".themeSelect__option[data-value]");
      for (const b of buttons) {
        b.addEventListener("click", () => {
          const mode = b.getAttribute("data-value");
          if (mode !== "system" && mode !== "dark" && mode !== "light") return;
          storage.setSavedThemeMode(mode);
          applyTheme(mode);
          closeThemeMenu();
        });
      }
    }

    if (dom.copyMenuButton) dom.copyMenuButton.addEventListener("click", toggleCopyMenu);
    if (dom.copyCsvButton) dom.copyCsvButton.addEventListener("click", () => closeCopyMenu({ immediate: true }));

    const themeMode = storage.getSavedThemeMode();
    applyTheme(themeMode);

    try {
      const mql = window.matchMedia("(prefers-color-scheme: dark)");
      if (mql && mql.addEventListener) {
        mql.addEventListener("change", () => {
          if (storage.getSavedThemeMode() === "system") applyTheme("system");
        });
      }
    } catch {
      return;
    }

    if (dom.root && dom.root.classList) dom.root.classList.add("is-ready");

    startHostsSse();
  }

  function setEditorError(loc) {
    const ctrl = state && state.highlightCtrl;
    if (!ctrl || typeof ctrl.setError !== "function") return;
    ctrl.setError(loc);
  }

  function clearEditorError() {
    const ctrl = state && state.highlightCtrl;
    if (!ctrl || typeof ctrl.clearError !== "function") return;
    ctrl.clearError();
  }

  ns.ui = { init, setSelectedHostId, setApiOnline, closeRunMenu, closeHostMenu, closeThemeMenu, applyRunOptionsUi, setEditorError, clearEditorError };
})();
