(() => {
  "use strict";

  const ns = window.ChDash;
  if (!ns) return;

  const { dom, state, storage, util } = ns;

  function safelyParseJson(text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
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
  }

  function applyHostPickerUi() {
    const snap = state.hostsSnapshot;
    if (!snap) return;

    const hosts = Array.isArray(snap.hosts) ? snap.hosts : [];
    const selected = hosts.find((h) => h && String(h.id) === String(state.selectedHostId));

    const healthy = !!(selected && selected.healthy);
    const pingMs = selected && selected.ping_ms != null ? Number(selected.ping_ms) : null;
    const label = selected ? String(selected.label || selected.id) : (state.selectedHostId || "Host");

    if (dom.hostPickerText) dom.hostPickerText.textContent = label;

    if (dom.hostPickerDot) {
      dom.hostPickerDot.classList.toggle("hostDot--good", healthy);
      dom.hostPickerDot.classList.toggle("hostDot--bad", !healthy);
    }

    if (dom.hostPickerPing) {
      if (healthy && pingMs != null && Number.isFinite(pingMs)) dom.hostPickerPing.textContent = formatPingMsLabel(pingMs);
      else dom.hostPickerPing.textContent = healthy ? "-" : "down";
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
      if (state.selectedHostId && id === String(state.selectedHostId)) continue;

      const label = String(h.label || h.id);
      const healthy = !!h.healthy;
      const pingMs = h.ping_ms != null ? Number(h.ping_ms) : null;

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pickerOption";
      btn.setAttribute("role", "option");
      btn.setAttribute("data-id", id);
      btn.setAttribute("aria-selected", "false");

      const dot = document.createElement("span");
      dot.className = `hostDot ${healthy ? "hostDot--good" : "hostDot--bad"}`;
      dot.setAttribute("aria-hidden", "true");

      const text = document.createElement("span");
      text.className = "pickerOption__label";
      text.textContent = label;

      const meta = document.createElement("span");
      meta.className = "pickerOption__meta";
      meta.textContent = healthy && pingMs != null && Number.isFinite(pingMs) ? formatPingMsLabel(pingMs) : (healthy ? "-" : "down");

      btn.appendChild(dot);
      btn.appendChild(text);
      btn.appendChild(meta);

      btn.addEventListener("click", () => {
        setSelectedHostId(id);
        renderHostPicker(state.hostsSnapshot || snapshot);
        closeHostMenu();
      });

      dom.hostPickerMenu.appendChild(btn);
    }

    applyHostPickerUi();
  }

  function startHostsSse() {
    if (!dom.hostPicker) return;

    const useSnapshot = (snap) => {
      state.hostsSnapshot = snap;
      renderHostPicker(snap);
    };

    try {
      const es = new EventSource("api/hosts/stream");
      es.addEventListener("hosts", (ev) => {
        const data = safelyParseJson(ev.data);
        if (!data) return;
        useSnapshot(data);
      });
      es.onerror = () => {
        es.close();
        fetch("api/hosts", { cache: "no-store" })
          .then((r) => (r.ok ? r.json() : null))
          .then((data) => {
            if (data) useSnapshot(data);
          })
          .catch(() => {});
      };
    } catch {
      fetch("api/hosts", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (data) useSnapshot(data);
        })
        .catch(() => {});
    }
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

  function formatHistoryTime(tsMs) {
    try {
      const d = new Date(tsMs);
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      const ss = String(d.getSeconds()).padStart(2, "0");
      return `${hh}:${mm}:${ss}`;
    } catch {
      return "";
    }
  }

  function renderHistoryPanel() {
    if (!dom.historyPanel) return;
    const items = storage.loadHistory();
    dom.historyPanel.innerHTML = "";

    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "historyEmpty";
      empty.textContent = "No history yet";
      dom.historyPanel.appendChild(empty);
      return;
    }

    for (const it of items) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "historyItem";

      const title = document.createElement("div");
      title.className = "historyItem__title";
      title.textContent = `${formatHistoryTime(it.ts_ms)} · ${it.host_id || ""}`;

      const body = document.createElement("div");
      body.className = "historyItem__sql";
      body.textContent = (it.sql_formatted || it.sql_raw || "").slice(0, 200);

      btn.appendChild(title);
      btn.appendChild(body);

      btn.addEventListener("click", () => {
        if (it.host_id) setSelectedHostId(String(it.host_id));
        if (dom.queryTextArea) util.replaceTextAreaValue(dom.queryTextArea, String(it.sql_formatted || it.sql_raw || ""));
        dom.historyPanel.hidden = true;
      });

      dom.historyPanel.appendChild(btn);
    }
  }

  function toggleHistory() {
    if (!dom.historyPanel) return;
    const willShow = dom.historyPanel.hidden;
    if (willShow) renderHistoryPanel();
    dom.historyPanel.hidden = !willShow;
  }

  function init() {
    applyRunOptionsUi();

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
    });

    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        closeRunMenu({ immediate: true });
        closeHostMenu();
        closeThemeMenu({ immediate: true });
        if (dom.historyPanel) dom.historyPanel.hidden = true;
      }
    });

    if (dom.historyButton) dom.historyButton.addEventListener("click", toggleHistory);

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

    startHostsSse();
  }

  ns.ui = { init, setSelectedHostId, closeRunMenu, closeHostMenu, closeThemeMenu, applyRunOptionsUi };
})();