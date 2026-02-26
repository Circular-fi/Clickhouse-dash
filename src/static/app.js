(() => {
  "use strict";

  const queryTextAreaElement = document.getElementById("queryTextArea");
  const runButtonElement = document.getElementById("runButton");
  const formatButtonElement = document.getElementById("formatButton");
  const cancelButtonElement = document.getElementById("cancelButton");
  const historyButtonElement = document.getElementById("historyButton");
  const historyPanelElement = document.getElementById("historyPanel");

  const versionBadgeElement = document.getElementById("versionBadge");

  // Pretty host picker (header)
  const hostPickerRootElement = document.getElementById("hostPicker");
  const hostPickerButtonElement = document.getElementById("hostPickerButton");
  const hostPickerMenuElement = document.getElementById("hostPickerMenu");
  const hostPickerTextElement = document.getElementById("hostPickerText");
  const hostPickerDotElement = document.getElementById("hostPickerDot");
  const hostPickerPingElement = document.getElementById("hostPickerPing");
  const themeSelectRootElement = document.getElementById("themeSelect");
  const themeSelectButtonElement = document.getElementById("themeSelectButton");
  const themeSelectTextElement = document.getElementById("themeSelectText");
  const themeSelectMenuElement = document.getElementById("themeSelectMenu");

  const queryIdentifierTextElement = document.getElementById("queryIdentifierText");
  const queryStatusTextElement = document.getElementById("queryStatusText");
  const resultColumnsTextElement = document.getElementById("resultColumnsText");
  const errorBannerElement = document.getElementById("errorBanner");

  const elapsedSecondsTextElement = document.getElementById("elapsedSecondsText");
  const progressPercentTextElement = document.getElementById("progressPercentText");

  const progressCardElement = document.getElementById("progressCard");
  const progressBarElement = document.getElementById("progressBar");
  const progressBarFillElement = document.getElementById("progressBarFill");

  const readRowsRateTextElement = document.getElementById("readRowsRateText");
  const readRowsTotalTextElement = document.getElementById("readRowsTotalText");

  const readBytesRateTextElement = document.getElementById("readBytesRateText");
  const readBytesTotalTextElement = document.getElementById("readBytesTotalText");

  const readRowsChartCanvas = document.getElementById("readRowsChart");
  const readBytesChartCanvas = document.getElementById("readBytesChart");

  const copyJsonButtonElement = document.getElementById("copyJsonButton");
  const copyJsonToastElement = document.getElementById("copyJsonToast");


  const cpuTextElement = document.getElementById("cpuText");
  const cpuMaxTextElement = document.getElementById("cpuMaxText");
  const memoryTextElement = document.getElementById("memoryText");
  const memoryMaxTextElement = document.getElementById("memoryMaxText");
  const threadTextElement = document.getElementById("threadText");
  const threadMaxTextElement = document.getElementById("threadMaxText");

  const resultTableHeadElement = document.getElementById("resultTableHead");
  const resultTableBodyElement = document.getElementById("resultTableBody");

  
  const cpuChartCanvas = document.getElementById("cpuChart");
  const memoryChartCanvas = document.getElementById("memoryChart");
  const threadChartCanvas = document.getElementById("threadChart");

  const resultsPanelElement =
  document.getElementById("resultsPanel") || document.querySelector(".panel--results");



  const THEME_STORAGE_KEY = "chdash.theme";
  const HOST_STORAGE_KEY = "chdash.selectedHost";
  const HISTORY_STORAGE_KEY = "chdash.queryHistory.v1";
  const HISTORY_MAX_ENTRIES = 100;

  let hostsSnapshot = null;
  let selectedHostId = null;
  let lastCancelToken = null;
  

  function setResultsVisible(visible) {
    if (!resultsPanelElement) return;
    resultsPanelElement.classList.toggle("is-hidden", !visible);
  }

  function setText(el, value) {
    if (el) el.textContent = value;
  }

  function setMetricPlain(el, value) {
    if (!el) return;
    el.classList.remove("metricAligned");
    el.removeAttribute("data-kind");
    el.textContent = value;
  }

  function setMetricAligned(el, { prefix = "", num = "", unit = "", suffix = "", kind = "" } = {}) {
    if (!el) return;

    el.classList.add("metricAligned");
    if (kind) el.setAttribute("data-kind", kind);
    else el.removeAttribute("data-kind");

    const nodes = [];

    if (prefix) {
      const p = document.createElement("span");
      p.className = "metricAligned__prefix";
      p.textContent = prefix;
      nodes.push(p);
    }

    const n = document.createElement("span");
    n.className = "metricAligned__num";
    n.textContent = num;
    nodes.push(n);

    const u = document.createElement("span");
    u.className = "metricAligned__unit";
    u.textContent = unit;
    nodes.push(u);

    if (suffix) {
      const s = document.createElement("span");
      s.className = "metricAligned__suffix";
      s.textContent = suffix;
      nodes.push(s);
    }

    el.replaceChildren(...nodes);
  }

  function asFiniteNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function safelyParseJson(text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  async function loadMeta() {
    if (!versionBadgeElement) return;
    try {
      const resp = await fetch("/api/meta", { cache: "no-store" });
      if (!resp.ok) {
        setText(versionBadgeElement, "meta: error");
        return;
      }
      const data = await resp.json();
      const verObj = data && data.version ? data.version : null;
      const ver = verObj && typeof verObj === "object" ? String(verObj.semver || "dev") : String(data.version || "dev");
      const sha = verObj && typeof verObj === "object" ? String(verObj.git_sha || "") : String(data.git_sha || "");
      const build = verObj && typeof verObj === "object" ? String(verObj.build_time || "") : String(data.build_time || "");
      const text = sha && sha !== "unknown" ? `${ver} (${sha})` : ver;
      setText(versionBadgeElement, text);
      if (build) versionBadgeElement.title = `Backend version\nBuild: ${build}`;
    } catch {
      setText(versionBadgeElement, "meta: offline");
    }
  }


  function getStoredHostId() {
    try {
      return localStorage.getItem(HOST_STORAGE_KEY);
    } catch {
      return null;
    }
  }

  function storeHostId(hostId) {
    try {
      localStorage.setItem(HOST_STORAGE_KEY, String(hostId || ""));
    } catch {
      
    }
  }

  function setSelectedHostId(hostId) {
    selectedHostId = hostId ? String(hostId) : null;
    if (selectedHostId) storeHostId(selectedHostId);
    applyHostPickerUi();
  }

  function pickDefaultHostId(snapshot) {
    const hosts = snapshot && Array.isArray(snapshot.hosts) ? snapshot.hosts : [];
    const ids = hosts.map((h) => String(h.id));
    const stored = getStoredHostId();
    if (stored && ids.includes(String(stored))) return String(stored);
    return ids.length ? ids[0] : null;
  }

  function formatPingMsLabel(pingMs) {
    const ms = Number(pingMs);
    if (!Number.isFinite(ms)) return null;
    if (ms > 0 && ms < 1) return "<1ms";
    const rounded = Math.round(ms);
    if (rounded < 1) return "<1ms";
    return `${rounded} ms`;
  }

  function applyHostPickerUi() {
    if (!hostsSnapshot) return;
    const hosts = Array.isArray(hostsSnapshot.hosts) ? hostsSnapshot.hosts : [];
    const h = hosts.find((x) => x && String(x.id) === String(selectedHostId));
    const healthy = !!(h && h.healthy);
    const pingMs = h && h.ping_ms != null ? Number(h.ping_ms) : null;
    const label = h ? String(h.label || h.id) : (selectedHostId || "Host");

    if (hostPickerTextElement) hostPickerTextElement.textContent = label;

    if (hostPickerDotElement) {
      hostPickerDotElement.classList.toggle("hostDot--good", healthy);
      hostPickerDotElement.classList.toggle("hostDot--bad", !healthy);
    }

    if (hostPickerPingElement) {
      if (healthy && pingMs != null && Number.isFinite(pingMs)) {
        hostPickerPingElement.textContent = formatPingMsLabel(pingMs) || "-";
      } else {
        hostPickerPingElement.textContent = healthy ? "-" : "down";
      }
    }
  }

  function closeHostMenu() {
    if (!hostPickerMenuElement || !hostPickerButtonElement) return;
    hostPickerMenuElement.hidden = true;
    hostPickerButtonElement.setAttribute("aria-expanded", "false");
  }

  function openHostMenu() {
    if (!hostPickerMenuElement || !hostPickerButtonElement) return;
    hostPickerMenuElement.hidden = false;
    hostPickerButtonElement.setAttribute("aria-expanded", "true");
    hostPickerMenuElement.focus({ preventScroll: true });
  }

  function toggleHostMenu() {
    if (!hostPickerMenuElement) return;
    if (hostPickerRootElement?.classList.contains("is-static")) return;
    if (hostPickerMenuElement.hidden) openHostMenu();
    else closeHostMenu();
  }

  function renderHostPicker(snapshot) {
    if (!hostPickerMenuElement) return;
    const hosts = snapshot && Array.isArray(snapshot.hosts) ? snapshot.hosts : [];

    if (!selectedHostId) {
      selectedHostId = pickDefaultHostId(snapshot);
      if (selectedHostId) storeHostId(selectedHostId);
    } else {
      // if selected host disappeared, fallback to first
      const ids = hosts.map((x) => String(x.id));
      if (!ids.includes(String(selectedHostId))) {
        selectedHostId = ids.length ? ids[0] : null;
        if (selectedHostId) storeHostId(selectedHostId);
      }
    }

    const staticPicker = hosts.length <= 1;

    if (hostPickerRootElement) {
      hostPickerRootElement.classList.toggle("is-static", staticPicker);
    }

    if (hostPickerButtonElement) {
      // Keep the visual style unchanged (no :disabled styling) but make it non-interactive
      hostPickerButtonElement.disabled = false;
      hostPickerButtonElement.setAttribute("aria-disabled", String(staticPicker));
      if (staticPicker) closeHostMenu();
    }

    hostPickerMenuElement.innerHTML = "";

    for (const h of hosts) {
      if (!h || !h.id) continue;
      const id = String(h.id);
      if (selectedHostId && id === String(selectedHostId)) continue;
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
      meta.textContent = healthy && pingMs != null && Number.isFinite(pingMs) ? (formatPingMsLabel(pingMs) || "-") : (healthy ? "-" : "down");

      btn.appendChild(dot);
      btn.appendChild(text);
      btn.appendChild(meta);

      btn.addEventListener("click", () => {
        setSelectedHostId(id);
        renderHostPicker(hostsSnapshot || snapshot);
        closeHostMenu();
      });

      hostPickerMenuElement.appendChild(btn);
    }

    applyHostPickerUi();
  }

  function startHostsSse() {
    if (!hostPickerRootElement) return;
    try {
      const es = new EventSource("api/hosts/stream");
      es.addEventListener("hosts", (ev) => {
        const data = safelyParseJson(ev.data);
        if (!data) return;
        hostsSnapshot = data;
        renderHostPicker(data);
      });
      es.onerror = () => {
        // keep UI, but if SSE is blocked we'll fallback to a one-shot fetch
        // (no polling here to keep server quiet; SSE is the preferred path)
        es.close();
        fetch("api/hosts", { cache: "no-store" })
          .then((r) => (r.ok ? r.json() : null))
          .then((data) => {
            if (!data) return;
            hostsSnapshot = data;
            renderHostPicker(data);
          })
          .catch(() => {});
      };
    } catch {
      // ignore
    }
  }

  // ---- Local history (localStorage, 100 entries) ----

  function loadHistory() {
    try {
      const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      return arr
        .filter((x) => x && typeof x === "object" && typeof x.ts_ms === "number" && typeof x.sql_raw === "string")
        .slice(0, HISTORY_MAX_ENTRIES);
    } catch {
      return [];
    }
  }

  function saveHistory(items) {
    try {
      const trimmed = Array.isArray(items) ? items.slice(0, HISTORY_MAX_ENTRIES) : [];
      localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(trimmed));
    } catch {
      // ignore
    }
  }

  function addHistoryEntry(entry) {
    const items = loadHistory();
    items.unshift(entry);
    // Dedup by host + sql_raw
    const seen = new Set();
    const deduped = [];
    for (const it of items) {
      const key = `${it.host_id || ""}::${it.sql_raw || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(it);
      if (deduped.length >= HISTORY_MAX_ENTRIES) break;
    }
    saveHistory(deduped);
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
    if (!historyPanelElement) return;
    const items = loadHistory();
    historyPanelElement.innerHTML = "";

    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "historyEmpty";
      empty.textContent = "No history yet";
      historyPanelElement.appendChild(empty);
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
        if (queryTextAreaElement) queryTextAreaElement.value = String(it.sql_formatted || it.sql_raw || "");
        historyPanelElement.hidden = true;
      });

      historyPanelElement.appendChild(btn);
    }
  }

  function toggleHistory() {
    if (!historyPanelElement) return;
    const willShow = historyPanelElement.hidden;
    if (willShow) renderHistoryPanel();
    historyPanelElement.hidden = !willShow;
  }

  async function copyTextToClipboard(text) {
    const value = String(text ?? "");
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return;
    }
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.left = "-1000px";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  }

  function flashCopyUi() {
    if (copyJsonToastElement) {
      copyJsonToastElement.hidden = false;
      setTimeout(() => { copyJsonToastElement.hidden = true; }, 1200);
    }
    if (copyJsonButtonElement) {
      const prev = copyJsonButtonElement.textContent;
      copyJsonButtonElement.textContent = "Copied";
      setTimeout(() => { copyJsonButtonElement.textContent = prev; }, 1200);
    }
  }

  function updateCopyButtonState() {
    if (!copyJsonButtonElement) return;

    const err = String(lastErrorMessage || "").trim();
    const hasError = err.length > 0;

    const hasRows = Array.isArray(allResultRows) && allResultRows.length > 0;

    const st = String(currentStatusValue || "").toLowerCase();
    const finishedLike = ["finished", "done", "error", "canceled", "cancelled"].includes(st);

    copyJsonButtonElement.disabled = !(hasError || hasRows || finishedLike);
  }

  const NUMERIC_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

  function coerceNumberLike(v) {
    if (typeof v !== "string") return v;

    const s = v.trim();
    if (!s) return v;

    if (!NUMERIC_RE.test(s)) return v;

    const n = Number(s);
    if (!Number.isFinite(n)) return v;

    // If it's an integer, keep string when > MAX_SAFE_INTEGER
    const isIntegerLike = /^[+-]?\d+$/.test(s);
    if (isIntegerLike) {
      // BigInt parse can throw on huge or weird strings, so guard
      try {
        const bi = BigInt(s);
        const abs = bi < 0n ? -bi : bi;
        if (abs > BigInt(Number.MAX_SAFE_INTEGER)) return v; // keep as string
      } catch {
        return v;
      }
    }

    return n;
  }

  function coerceDeep(v) {
    v = parseJsonStringIfLikely(v);
    if (Array.isArray(v)) return v.map(coerceDeep);
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, val] of Object.entries(v)) out[k] = coerceDeep(val);
      return out;
    }
    return coerceNumberLike(v);
  }

  function rowToObject(row) {
    const obj = {};
    for (let i = 0; i < resultColumns.length; i++) {
      const key = String(resultColumns[i] ?? "");
      const rawVal = Array.isArray(row) ? row[i] : (i === 0 ? row : null);
      obj[key] = coerceDeep(rawVal);
    }
    return obj;
  }

  function buildCopyContent() {
    const statusLower = String(currentStatusValue || "").toLowerCase();
    const err = String(lastErrorMessage || "").trim();

    if (err && statusLower === "error") {
      return {
        mode: "value",
        value: err,
      };
    }

    if (Array.isArray(allResultRows) && allResultRows.length > 0) {
      const rowCount = allResultRows.length;
      const colCount = Array.isArray(resultColumns) ? resultColumns.length : 0;

      if (colCount === 0) {
        if (rowCount === 1) {
          const only = allResultRows[0];
          if (Array.isArray(only) && only.length === 1) return { mode: "value", value: only[0] };
          return { mode: "json", value: only };
        }
        return { mode: "json", value: allResultRows };
      }

      if (rowCount === 1) {
        const row = allResultRows[0];

        if (colCount === 1) {
          const v = Array.isArray(row) ? row[0] : row;
          return { mode: "value", value: coerceDeep(v) };
        }

        return { mode: "json", value: rowToObject(row) };
      }

      if (colCount === 1) {
        const arr = allResultRows.map(r => coerceDeep(Array.isArray(r) ? r[0] : r));
        return { mode: "json", value: arr };
      }

      return { mode: "json", value: allResultRows.map(rowToObject) };
    }

    if (lastDonePayload) {
      const out = {
        status: lastDonePayload.status ?? currentStatusValue ?? "finished",
        query_id: activeQueryIdentifier ?? lastDonePayload.query_id ?? null,
        elapsed_seconds: lastDonePayload.elapsed_seconds ?? latestElapsedSeconds ?? null,
      };
      if (lastDonePayload.message) out.message = lastDonePayload.message;
      return { mode: "json", value: out };
    }

    if (err) {
      return {
        mode: "json",
        value: {
          status: currentStatusValue || "unknown",
          query_id: activeQueryIdentifier ?? null,
          message: err,
        },
      };
    }

    return {
      mode: "json",
      value: {
        status: currentStatusValue || "idle",
        query_id: activeQueryIdentifier ?? null,
      },
    };
  }

  async function handleCopyJson() {
    try {
      const built = buildCopyContent();
      const text = built.mode === "value"
        ? String(built.value ?? "")
        : JSON.stringify(built.value, null, 2);

      await copyTextToClipboard(text);
      flashCopyUi();
    } catch (e) {
      setError(e && e.message ? e.message : String(e));
    }
  }


  function formatCompactNumber(value) {
    if (value === null || value === undefined) return "-";
    if (!Number.isFinite(value)) return "-";

    const abs = Math.abs(value);
    const sign = value < 0 ? "-" : "";
    const units = ["", "k", "M", "B", "T", "P"];

    let unitIndex = 0;
    let scaled = abs;
    while (scaled >= 1000 && unitIndex < units.length - 1) {
      scaled /= 1000;
      unitIndex++;
    }

    const formatted = unitIndex === 0 ? scaled.toFixed(0) : scaled.toFixed(2).replace(/\.0$/, "");
    return `${sign}${formatted} ${units[unitIndex]}`.trim();
  }

  const FIGURE_SPACE = "\u2007";

  function formatScaledParts(value, base, units) {
    if (value === null || value === undefined) return null;
    if (!Number.isFinite(value)) return null;

    const sign = value < 0 ? "-" : "";
    let abs = Math.abs(value);

    let unitIndex = 0;
    let scaled = abs;
    while (scaled >= base && unitIndex < units.length - 1) {
      scaled /= base;
      unitIndex++;
    }

    // Guard against rounding pushing us over the threshold (e.g. 999.995 -> 1000.00)
    let fixed = scaled.toFixed(2);
    if (fixed.startsWith("1000") && unitIndex < units.length - 1) {
      scaled /= base;
      unitIndex++;
      fixed = scaled.toFixed(2);
    }

    const [intPartRaw, fracPart = "00"] = fixed.split(".");
    const intPart = String(intPartRaw).padStart(3, FIGURE_SPACE);

    return {
      num: `${sign}${intPart}.${fracPart}`,
      unit: String(units[unitIndex] || ""),
    };
  }

  function formatCompactParts(value) {
    return formatScaledParts(value, 1000, ["", "k", "M", "B", "T", "P"]);
  }

  function formatBytesParts(value) {
    return formatScaledParts(value, 1024, ["B", "KiB", "MiB", "GiB", "TiB", "PiB"]);
  }

  function formatNumber(value) {
    if (value === null || value === undefined) return "-";
    if (!Number.isFinite(value)) return "-";
    return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  function formatFixed2(value) {
    if (value === null || value === undefined) return "-";
    if (!Number.isFinite(value)) return "-";
    return Number(value).toFixed(2);
  }


  function formatSeconds(value) {
    if (value === null || value === undefined) return "-";
    if (!Number.isFinite(value)) return "-";
    return `${value.toFixed(3)} s`;
  }

  function formatBytes(value) {
    if (value === null || value === undefined) return "-";
    if (!Number.isFinite(value)) return "-";
    const absoluteValue = Math.max(0, value);
    const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];

    let unitIndex = 0;
    let scaledValue = absoluteValue;
    while (scaledValue >= 1024 && unitIndex < units.length - 1) {
      scaledValue /= 1024;
      unitIndex++;
    }

    if (unitIndex === 0) return `${scaledValue.toFixed(0)} ${units[unitIndex]}`;
    return `${scaledValue.toFixed(2)} ${units[unitIndex]}`;
  }

  function getCssVar(name, fallback = "") {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name);
    return v && v.trim() ? v.trim() : fallback;
  }

  function applyTheme(mode) {
    const root = document.documentElement;
    if (mode === "light" || mode === "dark") root.setAttribute("data-theme", mode);
    else root.removeAttribute("data-theme");
  }

  function getSavedThemeMode() {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
    return "system";
  }

  function setSavedThemeMode(mode) {
    localStorage.setItem(THEME_STORAGE_KEY, mode);
  }

  let currentThemeMode = getSavedThemeMode();
  applyTheme(currentThemeMode);

  const THEME_LABELS = { system: "System", dark: "Dark", light: "Light" };
  let themeOptionButtons = [];
  let themeMenuCloseTimer = 0;

  function syncThemeDropdownUi() {
    if (!themeSelectTextElement) return;

    const label = THEME_LABELS[currentThemeMode] || "System";
    themeSelectTextElement.textContent = label;

    if (Array.isArray(themeOptionButtons)) {
      for (const btn of themeOptionButtons) {
        const v = btn?.dataset?.value;
        btn.setAttribute("aria-selected", String(v === currentThemeMode));
      }
    }
  }

  function closeThemeMenu({ focusButton = false } = {}) {
    if (!themeSelectMenuElement || !themeSelectButtonElement || !themeSelectRootElement) return;

    // add closing state so selected stays hidden during the close animation
    themeSelectRootElement.classList.add("themeSelect--closing");
    themeSelectRootElement.classList.remove("themeSelect--open");
    themeSelectButtonElement.setAttribute("aria-expanded", "false");

    if (focusButton) themeSelectButtonElement.focus();

    if (themeMenuCloseTimer) clearTimeout(themeMenuCloseTimer);
    themeMenuCloseTimer = setTimeout(() => {
      themeMenuCloseTimer = 0;

      requestAnimationFrame(() => {
        themeSelectMenuElement.hidden = true;
        themeSelectRootElement.classList.remove("themeSelect--closing");
      });
    }, 150);
  }

  function openThemeMenu() {
    if (!themeSelectMenuElement || !themeSelectButtonElement || !themeSelectRootElement) return;

    if (themeMenuCloseTimer) {
      clearTimeout(themeMenuCloseTimer);
      themeMenuCloseTimer = 0;
    }

    themeSelectRootElement.classList.remove("themeSelect--closing");
    themeSelectMenuElement.hidden = false;
    themeSelectButtonElement.setAttribute("aria-expanded", "true");

    requestAnimationFrame(() => {
      themeSelectRootElement.classList.add("themeSelect--open");

      // focus first non-selected option (selected is hidden)
      const first = themeOptionButtons.find(b => b?.dataset?.value !== currentThemeMode) || themeOptionButtons[0];
      first?.focus();
    });
  }


  function toggleThemeMenu() {
    if (!themeSelectRootElement) return;
    const isOpen = themeSelectRootElement.classList.contains("themeSelect--open");
    if (isOpen) closeThemeMenu({ focusButton: true });
    else openThemeMenu();
  }

  function setThemeMode(mode, { persist = true } = {}) {
    const m = String(mode || "").toLowerCase();
    if (!THEME_LABELS[m]) return;

    currentThemeMode = m;
    if (persist) setSavedThemeMode(currentThemeMode);
    applyTheme(currentThemeMode);
    syncThemeDropdownUi();
  }

  function moveThemeFocus(delta) {
    const items = themeOptionButtons;
    if (!items.length) return;

    const active = document.activeElement;
    let idx = items.findIndex(x => x === active);
    if (idx < 0) idx = items.findIndex(b => b?.dataset?.value === currentThemeMode);
    if (idx < 0) idx = 0;

    idx = (idx + delta + items.length) % items.length;
    items[idx]?.focus();
  }

  function initThemeDropdown() {
    if (!themeSelectRootElement || !themeSelectButtonElement || !themeSelectMenuElement) return;

    themeOptionButtons = Array.from(themeSelectMenuElement.querySelectorAll(".themeSelect__option"));

    syncThemeDropdownUi();
    closeThemeMenu();

    themeSelectButtonElement.addEventListener("click", toggleThemeMenu);

    themeSelectButtonElement.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleThemeMenu();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        openThemeMenu();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        openThemeMenu();
        requestAnimationFrame(() => moveThemeFocus(-1));
        return;
      }
    });

    themeSelectMenuElement.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeThemeMenu({ focusButton: true });
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        moveThemeFocus(+1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        moveThemeFocus(-1);
        return;
      }
      if (e.key === "Enter" || e.key === " ") {
        const active = document.activeElement;
        if (active && active.classList && active.classList.contains("themeSelect__option")) {
          e.preventDefault();
          const v = active.dataset.value;
          setThemeMode(v);
          closeThemeMenu({ focusButton: true });
        }
        return;
      }
      if (e.key === "Tab") {
        closeThemeMenu();
      }
    });

    for (const btn of themeOptionButtons) {
      btn.addEventListener("click", () => {
        const v = btn.dataset.value;
        setThemeMode(v);
        closeThemeMenu({ focusButton: true });
      });
    }

    document.addEventListener("pointerdown", (e) => {
      if (!themeSelectRootElement.contains(e.target)) closeThemeMenu();
    });
  }

  initThemeDropdown();


  const themeMedia = window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;
  if (themeMedia && typeof themeMedia.addEventListener === "function") {
    themeMedia.addEventListener("change", () => {
      if (currentThemeMode === "system") {
        applyTheme("system");
        syncThemeDropdownUi();
      }
    });
  } else if (themeMedia && typeof themeMedia.addListener === "function") {
    themeMedia.addListener(() => {
      if (currentThemeMode === "system") applyTheme("system");
    });
  }

  function setProgressVisual(percentKnown, percent) {
    if (progressCardElement) {
      if (!percentKnown) {
        progressCardElement.classList.add("is-indeterminate");
        progressCardElement.style.removeProperty("--p");
      } else {
        progressCardElement.classList.remove("is-indeterminate");
        const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
        progressCardElement.style.setProperty("--p", String(clamped / 100));
      }
    }

    if (progressBarElement && progressBarFillElement) {
      if (!percentKnown) {
        progressBarElement.classList.add("progressBar--indeterminate");
        progressBarFillElement.style.width = "0%";
      } else {
        progressBarElement.classList.remove("progressBar--indeterminate");
        const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
        progressBarFillElement.style.width = `${clamped}%`;
      }
    }
  }

  const series = {
    readRowsPerSec: [],
    readBytesPerSec: [],
    cpu: [],
    memBytes: [],
    threads: [],
  };


  const MAX_STORE_POINTS = 120000;
  const EPS_T = 1e-9;

  function pushPointMonotone(arr, t, v) {
    if (!Number.isFinite(t) || !Number.isFinite(v)) return;
    const n = arr.length;
    if (n === 0) {
      arr.push({ t, v });
      return;
    }
    const last = arr[n - 1];
    if (t < last.t - EPS_T) return;

    if (Math.abs(t - last.t) <= EPS_T) {
      last.v = v;
      return;
    }
    arr.push({ t, v });

    if (arr.length > MAX_STORE_POINTS) {
      arr.splice(0, arr.length - MAX_STORE_POINTS);
    }
  }

  function prepareCanvas(canvas) {
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));

    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return { ctx, w, h };
  }

  function quantile(values, q) {
    if (!Array.isArray(values) || values.length === 0) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q)));
    return sorted[idx];
  }

  function computeAutoMax(points, opts) {
    const q = opts.autoMaxQuantile;
    if (!q || !Array.isArray(points) || points.length < 2) return null;
    const vals = [];
    for (const p of points) if (Number.isFinite(p.v)) vals.push(p.v);
    if (vals.length === 0) return null;
    const qv = quantile(vals, q);
    if (qv == null) return null;
    return qv * (opts.autoMaxPadFactor ?? 1.10);
  }

  function decimate(points, maxPoints) {
    if (!Array.isArray(points) || points.length <= maxPoints) return points;
    const step = Math.ceil(points.length / maxPoints);
    const out = [];
    for (let i = 0; i < points.length; i += step) out.push(points[i]);
    if (out[out.length - 1] !== points[points.length - 1]) out.push(points[points.length - 1]);
    return out;
  }

  function parseJsonStringIfLikely(v) {
    if (typeof v !== "string") return v;
    const s = v.trim();
    if (!s) return v;

    const first = s[0];
    const last = s[s.length - 1];

    const looksLikeJson =
      (first === "[" && last === "]") ||
      (first === "{" && last === "}") ||
      (first === "\"" && last === "\"");

    if (!looksLikeJson) return v;

    const parsed = safelyParseJson(s);
    return parsed === null ? v : parsed;
  }


  function drawSparkline(canvas, points, opts = {}) {
    const prepared = prepareCanvas(canvas);
    if (!prepared) return;
    const { ctx, w, h } = prepared;

    ctx.clearRect(0, 0, w, h);

    const pad = Math.round(h * 0.10);
    const topReserved = Math.round(h * 0.46);
    const x0 = pad;
    const y0 = topReserved;
    const x1 = w - pad;
    const y1 = h - pad;

    const border = getCssVar("--border", "rgba(148,163,184,0.14)");
    ctx.globalAlpha = 1;
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.floor(x0) + 0.5, Math.floor(y0) + 0.5, Math.floor(x1 - x0), Math.floor(y1 - y0));

    if (!Array.isArray(points) || points.length < 2) return;

    const drawable = decimate(points, Math.max(80, Math.floor(w * 1.2)));

    const tMin = drawable[0].t;
    const tMax = drawable[drawable.length - 1].t;
    const tSpan = Math.max(1e-12, tMax - tMin);

    const vMin = opts.min ?? 0;

    let vMax = null;
    if (opts.max != null && Number.isFinite(opts.max)) {
      vMax = opts.max;
    } else {
      const auto = computeAutoMax(drawable, opts);
      if (auto != null && Number.isFinite(auto)) vMax = auto;
      else {
        let m = -Infinity;
        for (const p of drawable) if (Number.isFinite(p.v)) m = Math.max(m, p.v);
        vMax = Number.isFinite(m) ? m : (vMin + 1);
      }
    }

    const minMax = opts.minMax ?? null;
    if (minMax != null && Number.isFinite(minMax)) vMax = Math.max(vMax, minMax);
    if (!Number.isFinite(vMax) || vMax <= vMin) vMax = vMin + 1;

    const line = opts.lineColor || getCssVar("--accentBorder", "#2563eb");
    const fillAlpha = opts.fillAlpha ?? 0.12;

    function X(t) { return x0 + ((t - tMin) / tSpan) * (x1 - x0); }
    function Y(v) {
      const vv = opts.clampMax ? Math.min(v, vMax) : v;
      return y1 - ((vv - vMin) / (vMax - vMin)) * (y1 - y0);
    }

    ctx.beginPath();
    ctx.moveTo(X(drawable[0].t), y1);
    for (const p of drawable) ctx.lineTo(X(p.t), Y(p.v));
    ctx.lineTo(X(drawable[drawable.length - 1].t), y1);
    ctx.closePath();
    ctx.globalAlpha = fillAlpha;
    ctx.fillStyle = line;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(X(drawable[0].t), Y(drawable[0].v));
    for (let i = 1; i < drawable.length; i++) ctx.lineTo(X(drawable[i].t), Y(drawable[i].v));
    ctx.globalAlpha = 0.90;
    ctx.strokeStyle = line;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();

    ctx.globalAlpha = 0.16;
    ctx.lineWidth = 6;
    ctx.stroke();
  }

  let chartsScheduled = false;
  function scheduleChartsRender() {
    if (chartsScheduled) return;
    chartsScheduled = true;
    requestAnimationFrame(() => {
      chartsScheduled = false;
      renderCharts();
    });
  }

  function renderCharts() {
    drawSparkline(readRowsChartCanvas, series.readRowsPerSec, { min: 0 });
    drawSparkline(readBytesChartCanvas, series.readBytesPerSec, { min: 0 });


    drawSparkline(cpuChartCanvas, series.cpu, {
      min: 0,
      autoMaxQuantile: 0.98,
      autoMaxPadFactor: 1.10,
      minMax: 100,
      clampMax: true,
    });

    drawSparkline(memoryChartCanvas, series.memBytes, { min: 0 });
    drawSparkline(threadChartCanvas, series.threads, { min: 0 });
  }

  window.addEventListener("resize", scheduleChartsRender);
  const themeObserver = new MutationObserver(() => scheduleChartsRender());
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  let activeQueryIdentifier = null;
  let activeEventSource = null;

  let resultColumns = [];
  let pendingRows = [];
  let allResultRows = [];
  let lastDonePayload = null;
  let currentStatusValue = "idle";
  let lastErrorMessage = "";
  let isFormatting = false;
  let scheduledFlush = false;
  const flushBatchSize = 400;  
  let isVerticalResults = false;
  let flushRafId = 0;


  let latestElapsedSeconds = 0;

  let hasSamplesStream = false;
  let lastSampleT = -Infinity;

  let lastEstimatedReadRows = null;
  let lastEstimatedReadRowsT = null;
  let lastSampleReadBytes = null;
  let lastSampleReadBytesT = null;


  let prevTickT = null;
  let prevTickReadRows = null;

  let hasNonZeroResourceFrame = false;

  function closeActiveStream() {
    if (activeEventSource) {
      activeEventSource.close();
      activeEventSource = null;
    }
  }

  function isQueryRunning() {
    const st = String(currentStatusValue || "").toLowerCase();
    return st === "starting" || st === "connecting" || st === "running" || st === "canceling";
  }

  function updateRunAndFormatButtonState() {
    const running = isQueryRunning();
    if (runButtonElement) runButtonElement.disabled = running;
    if (formatButtonElement) formatButtonElement.disabled = running || isFormatting;
  }

  function updateActionButtonState() {
    if (!cancelButtonElement) return;

    const st = String(currentStatusValue || "").toLowerCase();
    const running = isQueryRunning();

    if (running) {
      cancelButtonElement.textContent = "Cancel";
      cancelButtonElement.classList.add("button--danger");
      cancelButtonElement.classList.remove("button--primary");
      cancelButtonElement.disabled = st === "canceling" || !activeQueryIdentifier;
      return;
    }

    cancelButtonElement.textContent = "Clear";
    cancelButtonElement.classList.remove("button--primary");
    cancelButtonElement.classList.remove("button--danger");
    const hasText = String(queryTextAreaElement?.value || "").trim().length > 0;
    cancelButtonElement.disabled = !hasText;
  }

  function handleActionButton() {
    if (isQueryRunning()) {
      handleCancel();
      return;
    }
    handleClear();
  }

  function setStatus(text) {
    currentStatusValue = text;
    setText(queryStatusTextElement, text);
    updateCopyButtonState();
    updateActionButtonState();
    updateRunAndFormatButtonState();
  }

  function setQueryIdentifier(text) {
    setText(queryIdentifierTextElement, text || "-");
  }

  function setError(message) {
    lastErrorMessage = message || "";
    if (!errorBannerElement) return;
    if (!message) {
      errorBannerElement.hidden = true;
      errorBannerElement.textContent = "";
      updateCopyButtonState();
      return;
    }
    errorBannerElement.hidden = false;
    errorBannerElement.textContent = message;
    updateCopyButtonState();
  }


  function clearCharts() {
    series.readBytesPerSec.length = 0;
    series.readRowsPerSec.length = 0;
    series.cpu.length = 0;
    series.memBytes.length = 0;
    series.threads.length = 0;

    hasSamplesStream = false;
    lastSampleT = -Infinity;
    lastEstimatedReadRows = null;
    lastEstimatedReadRowsT = null;
    lastSampleReadBytes = null;
    lastSampleReadBytesT = null;


    prevTickT = null;
    prevTickReadRows = null;

    hasNonZeroResourceFrame = false;

    setProgressVisual(true, 0);
    scheduleChartsRender();
  }

  function clearMetrics() {
    setText(elapsedSecondsTextElement, "-");
    setText(progressPercentTextElement, "-");
    setMetricPlain(readRowsRateTextElement, "-");
    setMetricPlain(readRowsTotalTextElement, "-");
    setMetricPlain(readBytesRateTextElement, "-");
    setMetricPlain(readBytesTotalTextElement, "-");

    setText(cpuTextElement, "-");
    setText(cpuMaxTextElement, "-");
    setMetricPlain(memoryTextElement, "-");
    setMetricPlain(memoryMaxTextElement, "-");
    setText(threadTextElement, "-");
    setText(threadMaxTextElement, "-");

    setError("");
    clearCharts();

    latestElapsedSeconds = 0;
  }

  function clearResults() {
    resultColumns = [];
    pendingRows = [];
    allResultRows = [];
    updateCopyButtonState();

    scheduledFlush = false;
    if (flushRafId) {
      cancelAnimationFrame(flushRafId);
      flushRafId = 0;
    }

    isVerticalResults = false;
    const tableEl = resultTableHeadElement?.closest("table");
    if (tableEl) tableEl.classList.remove("resultTable--vertical");

    if (resultTableHeadElement) resultTableHeadElement.innerHTML = "";
    if (resultTableBodyElement) resultTableBodyElement.innerHTML = "";
    setText(resultColumnsTextElement, "-");
    setResultsVisible(false);
  }



  function setResultMeta(columns) {
    resultColumns = Array.isArray(columns) ? columns : [];

    const tableEl = resultTableHeadElement?.closest("table");
    if (tableEl) tableEl.classList.remove("resultTable--vertical");

    const headRow = document.createElement("tr");
    for (const columnName of resultColumns) {
      const th = document.createElement("th");
      th.textContent = String(columnName ?? "");
      headRow.appendChild(th);
    }
    if (resultTableHeadElement) {
      resultTableHeadElement.innerHTML = "";
      resultTableHeadElement.appendChild(headRow);
    }
    setText(resultColumnsTextElement, `${resultColumns.length} column(s)`);
  }

  function renderVerticalSingleRow(row) {
    if (!resultTableHeadElement || !resultTableBodyElement) return;

    isVerticalResults = true;
    pendingRows.length = 0;
    scheduledFlush = false;

    if (flushRafId) {
      cancelAnimationFrame(flushRafId);
      flushRafId = 0;
    }

    const tableEl = resultTableHeadElement.closest("table");
    if (tableEl) tableEl.classList.add("resultTable--vertical");

    // Header: Column | Value
    const headRow = document.createElement("tr");
    const th1 = document.createElement("th");
    th1.textContent = "Column";
    const th2 = document.createElement("th");
    th2.textContent = "Value";
    headRow.appendChild(th1);
    headRow.appendChild(th2);

    resultTableHeadElement.innerHTML = "";
    resultTableHeadElement.appendChild(headRow);

    // Body: one row per column
    resultTableBodyElement.innerHTML = "";
    const fragment = document.createDocumentFragment();

    for (let i = 0; i < resultColumns.length; i++) {
      const tr = document.createElement("tr");

      const th = document.createElement("th");
      const colName = String(resultColumns[i] ?? "");
      th.textContent = colName;
      th.title = colName; // hover to see full name if ellipsized

      const td = document.createElement("td");
      const raw = Array.isArray(row) ? row[i] : null;
      const cleaned = coerceDeep(raw);
      td.textContent = (cleaned === null || cleaned === undefined)
        ? ""
        : (typeof cleaned === "string" ? cleaned : JSON.stringify(cleaned));

      tr.appendChild(th);
      tr.appendChild(td);
      fragment.appendChild(tr);
    }

    resultTableBodyElement.appendChild(fragment);
  }

  function maybeSwitchToVerticalSingleRow() {
    if (!Array.isArray(resultColumns) || resultColumns.length < 2) return;
    if (!Array.isArray(allResultRows) || allResultRows.length !== 1) return;

    renderVerticalSingleRow(allResultRows[0]);
  }



  function enqueueRowForRender(row) {
    pendingRows.push(row);
    scheduleFlush();
  }

  function scheduleFlush() {
      if (scheduledFlush) return;
      scheduledFlush = true;
      flushRafId = requestAnimationFrame(flushPendingRows);
    }

    function flushPendingRows() {
    scheduledFlush = false;

    if (isVerticalResults) {
      pendingRows.length = 0;
      return;
    }

    if (pendingRows.length === 0) return;
    if (!resultTableBodyElement) return;

    const fragment = document.createDocumentFragment();
    const toRender = Math.min(flushBatchSize, pendingRows.length);

    for (let i = 0; i < toRender; i++) {
      const row = pendingRows.shift();
      const tr = document.createElement("tr");

      if (Array.isArray(row)) {
        for (let columnIndex = 0; columnIndex < resultColumns.length; columnIndex++) {
          const td = document.createElement("td");
          const value = row[columnIndex] === undefined || row[columnIndex] === null ? "" : String(row[columnIndex]);
          td.textContent = value;
          tr.appendChild(td);
        }
      } else {
        const td = document.createElement("td");
        td.textContent = String(row);
        tr.appendChild(td);
      }

      fragment.appendChild(tr);
    }

    resultTableBodyElement.appendChild(fragment);
    if (pendingRows.length > 0) scheduleFlush();
  }


  async function createQuery(queryText) {
    const hostId = selectedHostId || getStoredHostId();
    if (!hostId) {
      throw new Error("No host selected.");
    }

    // Prefer the new endpoint; keep old one as fallback for older backends.
    let response = await fetch("/api/query/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql: queryText, host_id: hostId })
    });

    if (response.status === 404) {
      response = await fetch("/api/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: queryText, host_id: hostId })
      });
    }

    const responseBody = await response.json().catch(() => ({}));
    if (!response.ok) {
      const messageText = responseBody && responseBody.message
        ? responseBody.message
        : `Request failed with status ${response.status}`;
      throw new Error(messageText);
    }
    // Optional: auto-replace textarea with formatted sql
    if (queryTextAreaElement && responseBody && typeof responseBody.formatted_sql === "string") {
      queryTextAreaElement.value = responseBody.formatted_sql;
    }

    // Keep cancel token if provided by backend
    lastCancelToken = responseBody && responseBody.cancel_token ? String(responseBody.cancel_token) : null;

    return responseBody;
  }

  async function formatQuery(queryText) {
    const hostId = selectedHostId || getStoredHostId();
    if (!hostId) {
      throw new Error("No host selected.");
    }

    const response = await fetch("/api/format", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql: queryText, host_id: hostId })
    });

    const responseBody = await response.json().catch(() => ({}));
    if (!response.ok) {
      const messageText = responseBody && responseBody.message
        ? responseBody.message
        : `Request failed with status ${response.status}`;
      throw new Error(messageText);
    }

    if (responseBody && typeof responseBody.formatted_sql === "string") {
      return responseBody.formatted_sql;
    }
    throw new Error("No formatted SQL returned.");
  }

  async function requestCancellation(queryIdentifier) {
    const payload = lastCancelToken
      ? { cancel_token: lastCancelToken }
      : { query_id: queryIdentifier };

    const response = await fetch("/api/query/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const responseBody = await response.json().catch(() => ({}));
    if (!response.ok) {
      const messageText = responseBody && responseBody.message
        ? responseBody.message
        : `Cancel failed with status ${response.status}`;
      throw new Error(messageText);
    }
    if (!Array.isArray(allResultRows) || allResultRows.length == 0) {
      clearResults();
    }
    return responseBody;
  }

  function normalizeTick(raw) {
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return { kind: "object", v: raw };
    }

    if (!Array.isArray(raw)) return null;

    const tMs = asFiniteNumber(raw[0]) ?? 0;
    const tSec = tMs / 1000.0;

    const percent = asFiniteNumber(raw[1]);
    const percentKnown = !!raw[2];

    const readRows = asFiniteNumber(raw[3]);
    const readBytes = asFiniteNumber(raw[4]);
    const totalRows = asFiniteNumber(raw[5]);

    const rowsPerSec = asFiniteNumber(raw[6]);
    const bytesPerSec = asFiniteNumber(raw[7]);

    const cpuInst = (asFiniteNumber(raw[8]) ?? 0) / 100.0;
    const cpuMax = raw[9] == null ? null : (asFiniteNumber(raw[9]) / 100.0);

    const memInst = raw[10] == null ? null : asFiniteNumber(raw[10]);
    const memMax = raw[11] == null ? null : asFiniteNumber(raw[11]);

    const thrInst = asFiniteNumber(raw[12]);
    const thrMax = asFiniteNumber(raw[13]);

    const samples = Array.isArray(raw[14]) ? raw[14] : null;

    return {
      kind: "array",
      tSec,
      percent,
      percentKnown,
      readRows,
      readBytes,
      totalRows,
      rowsPerSec,
      bytesPerSec,
      cpuInst,
      cpuMax,
      memInst,
      memMax,
      thrInst,
      thrMax,
      samples,
    };
  }

  function updateProgressFromParts(tSec, percent, percentKnown, readRows, readBytes, totalRows) {
    latestElapsedSeconds = Math.max(latestElapsedSeconds, tSec);

    setText(elapsedSecondsTextElement, formatSeconds(tSec));
    percent = percent / 100;
    if (percentKnown) {
      setText(progressPercentTextElement, `${formatNumber(percent)} %`);
      setProgressVisual(true, percent);
    } else {
      setText(progressPercentTextElement, "-");
      setProgressVisual(false, 0);
    }

    {
      const rowsParts = formatCompactParts(readRows);
      if (!rowsParts) setMetricPlain(readRowsTotalTextElement, "-");
      else setMetricAligned(readRowsTotalTextElement, { ...rowsParts, suffix: "rows" });
    }

    {
      const bytesParts = formatBytesParts(readBytes);
      if (!bytesParts) setMetricPlain(readBytesTotalTextElement, "-");
      else setMetricAligned(readBytesTotalTextElement, { ...bytesParts, kind: "bytes" });
    }
  }

  function updateResourceFromParts(rowsPerSec, bytesPerSec, cpuInst, cpuMax, memInst, memMax, thrInst, thrMax) {
    const rps = asFiniteNumber(rowsPerSec) ?? 0;
    const bps = asFiniteNumber(bytesPerSec) ?? 0;

    const cpu = asFiniteNumber(cpuInst) ?? 0;
    const cpuM = cpuMax == null ? null : asFiniteNumber(cpuMax);

    const mem = memInst == null ? null : asFiniteNumber(memInst);
    const memM = memMax == null ? null : asFiniteNumber(memMax);

    const th = asFiniteNumber(thrInst) ?? 0;
    const thM = thrMax == null ? null : asFiniteNumber(thrMax);

    const zeroFrame =
      rps === 0 &&
      bps === 0 &&
      cpu === 0 &&
      th === 0 &&
      (mem === null || mem === 0);

    if (zeroFrame && hasNonZeroResourceFrame) return;
    if (!zeroFrame) hasNonZeroResourceFrame = true;

    {
      const rowsParts = formatCompactParts(rps);
      if (!rowsParts) setMetricPlain(readRowsRateTextElement, "-");
      else setMetricAligned(readRowsRateTextElement, { ...rowsParts, suffix: "rows/s" });
    }

    {
      const bytesParts = formatBytesParts(bps);
      if (!bytesParts) setMetricPlain(readBytesRateTextElement, "-");
      else setMetricAligned(readBytesRateTextElement, { ...bytesParts, kind: "bytes", suffix: "/s" });
    }

    setText(cpuTextElement, `${formatFixed2(cpu)}%`);
    setText(cpuMaxTextElement, `max: ${cpuM == null ? "-" : formatFixed2(cpuM)}%`);

    {
      const bytesParts = mem === null ? null : formatBytesParts(mem);
      if (!bytesParts) setMetricPlain(memoryTextElement, "-");
      else setMetricAligned(memoryTextElement, { ...bytesParts, kind: "bytes" });
    }

    {
      const bytesParts = memM === null ? null : formatBytesParts(memM);
      if (!bytesParts) setMetricPlain(memoryMaxTextElement, "max: -");
      else setMetricAligned(memoryMaxTextElement, { prefix: "max:", ...bytesParts, kind: "bytes" });
    }

    setText(threadTextElement, `${formatNumber(th)}`);
    setText(threadMaxTextElement, `max: ${thM == null ? "-" : formatNumber(thM)}`);
  }

  function appendSamplesAndDeriveRates(samplesPacked, tickT, tickReadRows) {
    if (!Array.isArray(samplesPacked) || samplesPacked.length === 0) return;

    const canInterpolateRows =
      Number.isFinite(prevTickT) &&
      Number.isFinite(prevTickReadRows) &&
      Number.isFinite(tickT) &&
      Number.isFinite(tickReadRows) &&
      tickT > prevTickT + 1e-12;

    const t0 = prevTickT;
    const t1 = tickT;
    const rr0 = prevTickReadRows;
    const rr1 = tickReadRows;

    const sorted = samplesPacked
      .map(a => ({
        t: asFiniteNumber(a?.[0]) != null ? asFiniteNumber(a?.[0]) / 1000.0 : null,
        rb: asFiniteNumber(a?.[1]),
        cpu: asFiniteNumber(a?.[2]) != null ? asFiniteNumber(a?.[2]) / 100.0 : null,
        mem: a?.[3] === null || a?.[3] === undefined ? null : asFiniteNumber(a?.[3]),
        thr: asFiniteNumber(a?.[4]),
      }))
      .filter(x => x.t != null)
      .sort((a, b) => a.t - b.t);

    if (!hasSamplesStream) {
      hasSamplesStream = true;
      lastSampleT = -Infinity;

      lastEstimatedReadRows = null;
      lastEstimatedReadRowsT = null;

      lastSampleReadBytes = null;
      lastSampleReadBytesT = null;
    }

    for (const s of sorted) {
      if (s.t <= lastSampleT + EPS_T) continue;

      if (s.cpu != null) pushPointMonotone(series.cpu, s.t, s.cpu);
      if (s.mem != null) pushPointMonotone(series.memBytes, s.t, s.mem);
      if (s.thr != null) pushPointMonotone(series.threads, s.t, s.thr);

      if (s.rb != null && lastSampleReadBytes != null && lastSampleReadBytesT != null) {
        const dtB = s.t - lastSampleReadBytesT;
        if (dtB > 1e-9) {
          const bps = (s.rb - lastSampleReadBytes) / dtB;
          if (Number.isFinite(bps) && bps >= 0) {
            pushPointMonotone(series.readBytesPerSec, s.t, bps);
          }
        }
      }
      if (s.rb != null) {
        lastSampleReadBytes = s.rb;
        lastSampleReadBytesT = s.t;
      }

      let estReadRows = null;
      if (canInterpolateRows) {
        const alpha = Math.max(0, Math.min(1, (s.t - t0) / (t1 - t0)));
        estReadRows = rr0 + alpha * (rr1 - rr0);
      }

      if (estReadRows != null && lastEstimatedReadRows != null && lastEstimatedReadRowsT != null) {
        const dtR = s.t - lastEstimatedReadRowsT;
        if (dtR > 1e-9) {
          const rps = (estReadRows - lastEstimatedReadRows) / dtR;
          if (Number.isFinite(rps) && rps >= 0) {
            pushPointMonotone(series.readRowsPerSec, s.t, rps);
          }
        }
      }

      if (estReadRows != null) {
        lastEstimatedReadRows = estReadRows;
        lastEstimatedReadRowsT = s.t;
      }

      lastSampleT = s.t;
      latestElapsedSeconds = Math.max(latestElapsedSeconds, s.t);
    }

    scheduleChartsRender();
  }


  function updateFromTick(rawTick) {
    const t = normalizeTick(rawTick);
    if (!t) return;

    if (t.kind === "object") {
      const tick = t.v;

      const tt = asFiniteNumber(tick.t);
      if (tt != null) latestElapsedSeconds = Math.max(latestElapsedSeconds, tt);

      if (tick.p) {
        updateProgressFromParts(
          asFiniteNumber(tt ?? tick.p.elapsed_seconds) ?? 0,
          asFiniteNumber(tick.p.percent) ?? 0,
          !!tick.p.percent_known,
          asFiniteNumber(tick.p.read_rows) ?? 0,
          asFiniteNumber(tick.p.read_bytes) ?? 0,
          asFiniteNumber(tick.p.total_rows_to_read) ?? 0
        );
      }

      if (tick.r) {
        updateResourceFromParts(
          tick.r.rows_per_second_inst,
          tick.r.bytes_per_second_inst,
          tick.r.cpu_percent_inst,
          tick.r.cpu_percent_inst_max,
          tick.r.memory_bytes_inst,
          tick.r.memory_bytes_inst_max,
          tick.r.thread_count_inst,
          tick.r.thread_count_inst_max
        );
      }

      if (Array.isArray(tick.s) && tick.s.length > 0) {
        appendSamplesAndDeriveRates(tick.s, tt ?? 0, tick.p?.read_rows ?? null);
      }
      return;
    }

    const tickT = t.tSec;

    updateProgressFromParts(
      tickT,
      t.percent ?? 0,
      !!t.percentKnown,
      t.readRows ?? 0,
      t.readBytes ?? 0,
      t.totalRows ?? 0
    );

    updateResourceFromParts(
      t.rowsPerSec,
      t.bytesPerSec,
      t.cpuInst,
      t.cpuMax,
      t.memInst,
      t.memMax,
      t.thrInst,
      t.thrMax
    );

    if (Array.isArray(t.samples) && t.samples.length > 0) {
      appendSamplesAndDeriveRates(t.samples, tickT, t.readRows);
    }

    prevTickT = tickT;
    prevTickReadRows = t.readRows;
  }

  function startStream(streamUrl) {
    closeActiveStream();

    clearMetrics();
    clearResults();

    const eventSource = new EventSource(streamUrl);
    activeEventSource = eventSource;

    eventSource.addEventListener("meta", (event) => {
      const payload = safelyParseJson(event.data);
      if (!payload) return;
      setStatus("running");
      setError("");
    });

    eventSource.addEventListener("tick", (event) => {
      const payload = safelyParseJson(event.data);
      if (payload == null) return;
      updateFromTick(payload);
    });

    eventSource.addEventListener("result_meta", (event) => {
      const payload = safelyParseJson(event.data);
      if (!payload) return;
      clearResults();
      setResultMeta(payload.columns);
      setResultsVisible(true);
    });

    eventSource.addEventListener("result_rows", (event) => {
      const payload = safelyParseJson(event.data);
      setResultsVisible(true);
      if (!payload) return;
      const rows = Array.isArray(payload.rows) ? payload.rows : [];
      for (const row of rows) {
        allResultRows.push(row);
        enqueueRowForRender(row);
      }
      updateCopyButtonState();
    });

    eventSource.addEventListener("error", (event) => {
      const payload = event && event.data ? safelyParseJson(event.data) : null;
      if (payload && payload.message) {
        setError(payload.message);
        setStatus("error");
        setResultsVisible(true)
      }
    });

    eventSource.addEventListener("done", (event) => {
      const payload = safelyParseJson(event.data);
      if (payload) {
        lastDonePayload = payload;
        let status = String(payload.status || "finished")
        setStatus(status);
        if (status == "finished") {
          setText(progressPercentTextElement, `${formatNumber(100)} %`);
          setProgressVisual(true, 100);
        }
        setText(elapsedSecondsTextElement, formatSeconds(asFiniteNumber(payload.elapsed_seconds) ?? latestElapsedSeconds));
        if (payload.message) setError(payload.message);
        if (payload.percent_known === false) setProgressVisual(true, 100);
      } else {
        setStatus("done");
      }

      maybeSwitchToVerticalSingleRow();
      setMetricPlain(readRowsRateTextElement, "-");
      setMetricPlain(readBytesRateTextElement, "-");
      setText(cpuTextElement, "-");
      setMetricPlain(memoryTextElement, "-");
      setText(threadTextElement, "-");
      progressCardElement.classList.remove("is-indeterminate");
      const hasRows = Array.isArray(allResultRows) && allResultRows.length > 0;
      const hasError = String(lastErrorMessage || "").trim().length > 0;

      if (!hasRows && !hasError) {
        setResultsVisible(false);
      }

      closeActiveStream();
      updateActionButtonState();
      updateCopyButtonState();
    });

    eventSource.addEventListener("keepalive", () => {});
    eventSource.onerror = () => {};
  }

  async function handleFormat() {
    if (isQueryRunning()) return;
    const queryText = (queryTextAreaElement?.value || "").trim();
    if (!queryText) {
      setError("Please write a query first.");
      return;
    }

    setError("");
    isFormatting = true;
    updateRunAndFormatButtonState();

    try {
      const formatted = await formatQuery(queryText);
      if (queryTextAreaElement) queryTextAreaElement.value = formatted;
      updateActionButtonState();
    } catch (error) {
      setError(error && error.message ? error.message : String(error));
    } finally {
      isFormatting = false;
      updateRunAndFormatButtonState();
    }
  }

  async function handleRun() {
    if (isQueryRunning()) return;
    const queryText = (queryTextAreaElement?.value || "").trim();
    if (!queryText) {
      setError("Please write a query first.");
      return;
    }

    setError("");
    clearMetrics();
    clearResults();

    setStatus("starting");

    try {
      const responsePayload = await createQuery(queryText);
      activeQueryIdentifier = responsePayload.query_id;
      setQueryIdentifier(activeQueryIdentifier);

      addHistoryEntry({
        ts_ms: Date.now(),
        host_id: selectedHostId || getStoredHostId() || "",
        sql_raw: queryText,
        sql_formatted: typeof responsePayload.formatted_sql === "string" ? responsePayload.formatted_sql : null,
      });

      setStatus("connecting");
      startStream(responsePayload.stream_url);
    } catch (error) {
      setStatus("error");
      setError(error && error.message ? error.message : String(error));
      closeActiveStream();
    } finally {
      updateRunAndFormatButtonState();
    }
  }

  async function handleCancel() {
    if (!activeQueryIdentifier) return;
    setStatus("canceling");
    
    try {
      await requestCancellation(activeQueryIdentifier);
    } catch (error) {
      setError(error && error.message ? error.message : String(error));
      setStatus("running");
    }
  }

  function handleClear() {
    closeActiveStream();
    activeQueryIdentifier = null;
    lastDonePayload = null;
    lastErrorMessage = "";
    currentStatusValue = "idle";
    allResultRows = [];
    updateCopyButtonState();

    setQueryIdentifier("");
    setStatus("idle");

    if (queryTextAreaElement) queryTextAreaElement.value = "";
    updateActionButtonState();

    clearMetrics();
    clearResults();
    updateRunAndFormatButtonState();
    setError("");
  }

  function loadDefaultQueryIfEmpty() {
    if ((queryTextAreaElement?.value || "").trim() !== "") return;
    queryTextAreaElement.value =
      "SELECT number % 10 AS index, count() FROM numbers(10000000000) GROUP BY index";
  }

    // --- IDE-like TAB behavior in textarea (undo-friendly + tab-stops) ---
  const TAB_SIZE = 4;

  function getLineStartIndex(text, index) {
    const i = text.lastIndexOf("\n", index - 1);
    return i === -1 ? 0 : i + 1;
  }

  function getLineEndIndex(text, index) {
    const i = text.indexOf("\n", index);
    return i === -1 ? text.length : i;
  }

  function leadingWsLen(line) {
    let i = 0;
    while (i < line.length) {
      const c = line[i];
      if (c !== " " && c !== "\t") break;
      i++;
    }
    return i;
  }

  // visual columns for a whitespace prefix (tabs expand to tab stops)
  function wsToCols(ws) {
    let col = 0;
    for (const ch of ws) {
      if (ch === "\t") col += TAB_SIZE - (col % TAB_SIZE);
      else if (ch === " ") col += 1;
    }
    return col;
  }

  // visual columns in the line up to a given offset (handles tabs)
  function lineColsUpTo(line, offset) {
    let col = 0;
    for (let i = 0; i < Math.min(offset, line.length); i++) {
      const ch = line[i];
      if (ch === "\t") col += TAB_SIZE - (col % TAB_SIZE);
      else col += 1; // ok for normal ASCII; good enough for SQL
    }
    return col;
  }

  function nextTabStopCols(col) {
    const rem = col % TAB_SIZE;
    return col + (rem === 0 ? TAB_SIZE : (TAB_SIZE - rem));
  }

  function prevTabStopCols(col) {
    if (col <= 0) return 0;
    const rem = col % TAB_SIZE;
    return Math.max(0, col - (rem === 0 ? TAB_SIZE : rem));
  }

  // map selection positions so it feels IDE-ish after indent/outdent
  function mapRelPos(relPos, oldLines, oldPrefixLens, oldPrefixCols, newPrefixCols) {
    let oldCursor = 0;
    let newCursor = 0;

    for (let i = 0; i < oldLines.length; i++) {
      const oldLine = oldLines[i];
      const oldLineLen = oldLine.length;

      const opLen = oldPrefixLens[i];
      const opCols = oldPrefixCols[i];
      const npCols = newPrefixCols[i];

      const oldContentLen = oldLineLen - opLen;
      const newLineLen = npCols + oldContentLen; // we normalize indent to spaces

      const oldLineStart = oldCursor;
      const newLineStart = newCursor;
      const oldLineEnd = oldLineStart + oldLineLen;

      if (relPos <= oldLineEnd) {
        const within = relPos - oldLineStart;

        if (within <= opLen) {
          // if cursor was inside old indent, keep it inside new indent (clamped)
          // approximate mapping: proportion of cols in old indent -> cols in new indent
          const withinCols = wsToCols(oldLine.slice(0, within));
          const clamped = Math.min(npCols, withinCols); // don't go past new indent
          return newLineStart + clamped;
        } else {
          // cursor is in content => keep same content offset
          const withinContent = within - opLen;
          return newLineStart + npCols + withinContent;
        }
      }

      oldCursor += oldLineLen;
      newCursor += newLineLen;

      if (i < oldLines.length - 1) {
        // newline char
        if (relPos === oldCursor) return newCursor;
        oldCursor += 1;
        newCursor += 1;
      }
    }

    return newCursor;
  }

  queryTextAreaElement?.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;

    const ta = e.currentTarget;
    const value = ta.value;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;

    e.preventDefault(); // stop focus change
    ta.focus();

    // --- No selection: behave like IDE tab at caret (next tab stop) ---
    if (start === end && !e.shiftKey) {
      const lineStart = getLineStartIndex(value, start);
      const lineEnd = getLineEndIndex(value, start);
      const line = value.slice(lineStart, lineEnd);
      const offsetInLine = start - lineStart;

      const col = lineColsUpTo(line, offsetInLine);
      const target = nextTabStopCols(col);
      const add = target - col;

      const spaces = " ".repeat(add);
      ta.setRangeText(spaces, start, end, "end"); // undo-friendly
      return;
    }

    // --- No selection + Shift+Tab: outdent current line (if in leading whitespace) ---
    if (start === end && e.shiftKey) {
      const lineStart = getLineStartIndex(value, start);
      const lineEnd = getLineEndIndex(value, start);
      const line = value.slice(lineStart, lineEnd);

      const wsLen = leadingWsLen(line);
      const caretOffset = start - lineStart;

      // Only outdent if caret is inside indentation; otherwise do nothing
      if (caretOffset > wsLen) return;

      const oldWs = line.slice(0, wsLen);
      const oldCols = wsToCols(oldWs);
      const newCols = prevTabStopCols(oldCols);

      const content = line.slice(wsLen);
      const newLine = " ".repeat(newCols) + content;

      ta.setRangeText(newLine, lineStart, lineEnd, "preserve");

      // place caret in same visual column (clamped)
      const newCaret = lineStart + Math.min(newCols, newCols); // inside indent
      ta.selectionStart = ta.selectionEnd = newCaret;
      return;
    }

    // --- Selection: indent/outdent touched lines to tab stops ---
    let endAdj = end;
    if (endAdj > start && value[endAdj - 1] === "\n") endAdj -= 1;

    const blockStart = getLineStartIndex(value, start);
    const blockEnd = getLineEndIndex(value, endAdj);

    const block = value.slice(blockStart, blockEnd);
    const oldLines = block.split("\n");

    const oldPrefixLens = oldLines.map(leadingWsLen);
    const oldPrefixCols = oldLines.map((ln, i) => wsToCols(ln.slice(0, oldPrefixLens[i])));

    const newPrefixCols = oldPrefixCols.map((cols) => {
      return e.shiftKey ? prevTabStopCols(cols) : nextTabStopCols(cols);
    });

    const newLines = oldLines.map((ln, i) => {
      const content = ln.slice(oldPrefixLens[i]);
      return " ".repeat(newPrefixCols[i]) + content;
    });

    const newBlock = newLines.join("\n");

    // Map selection endpoints for a nice feel
    const relStart = start - blockStart;
    const relEnd = end - blockStart;

    const newRelStart = mapRelPos(relStart, oldLines, oldPrefixLens, oldPrefixCols, newPrefixCols);
    const newRelEnd = mapRelPos(relEnd, oldLines, oldPrefixLens, oldPrefixCols, newPrefixCols);

    ta.setRangeText(newBlock, blockStart, blockEnd, "preserve"); // undo-friendly

    ta.selectionStart = blockStart + newRelStart;
    ta.selectionEnd = blockStart + newRelEnd;
  });


  runButtonElement?.addEventListener("click", handleRun);
  formatButtonElement?.addEventListener("click", handleFormat);
  cancelButtonElement?.addEventListener("click", handleActionButton);
  copyJsonButtonElement?.addEventListener("click", handleCopyJson);

  queryTextAreaElement?.addEventListener("input", updateActionButtonState);

  // Host picker interactions
  hostPickerButtonElement?.addEventListener("click", (e) => {
    if (hostPickerRootElement?.classList.contains("is-static")) return;
    e.preventDefault();
    toggleHostMenu();
  });

  document.addEventListener("click", (e) => {
    if (!hostPickerRootElement || !hostPickerMenuElement) return;
    if (hostPickerMenuElement.hidden) return;
    const t = e.target;
    if (!(t instanceof Node)) return;
    if (!hostPickerRootElement.contains(t)) closeHostMenu();
  });

  historyButtonElement?.addEventListener("click", (e) => {
    e.preventDefault();
    toggleHistory();
  });

  document.addEventListener("click", (e) => {
    if (!historyPanelElement || historyPanelElement.hidden) return;
    const t = e.target;
    if (!(t instanceof Node)) return;
    const inMenu = historyPanelElement.contains(t);
    const inBtn = historyButtonElement ? historyButtonElement.contains(t) : false;
    if (!inMenu && !inBtn) historyPanelElement.hidden = true;
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeHostMenu();
    }
  });

  setResultsVisible(false);
  loadMeta();
  startHostsSse();
  loadDefaultQueryIfEmpty();
  updateActionButtonState();
  scheduleChartsRender();
  updateCopyButtonState();
})();


