(() => {
  "use strict";
  const ns = window.ChDash;
  if (!ns) return;
  const { dom, state, api, util, ui } = ns;

  const SERVICE_COLORS = [
    "#4c78a8", "#f58518", "#54a24b", "#e45756", "#72b7b2", "#b279a2",
    "#ff9da6", "#9d755d", "#bab0ac", "#59a14f", "#edc949", "#af7aa1",
  ];

  const model = {
    meta: null,
    traces: [],
    analytics: null,
    analyticsLoading: false,
    analyticsError: "",
    durationsError: "",
    prefillPairs: [],
    prefillPromise: null,
    activeTrace: null,
    activeSpanId: null,
    openSpanIds: new Set(),
    waterfallLabelPct: 34,
    traceViewRange: [0, 1],
    disabledServices: new Set(),
    collapsed: new Set(),
    searchSeq: 0,
    analyticsSeq: 0,
    prefillSeq: 0,
    detailSeq: 0,
    timeRange: { from: "now-1h", to: "now" },
    timeRangeTouched: false,
  };

  const esc = (value) => util.escapeHtml(String(value == null ? "" : value));
  const route = (path) => api.resolveUrl(String(path || "").replace(/^\/+/, ""));

  // Up to three significant digits, trailing zeros dropped: 182, 18.2, 1.82, 12.
  function significant(value) {
    const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
    const fixed = value.toFixed(digits);
    return digits ? fixed.replace(/\.?0+$/, "") : fixed;
  }

  // One convention everywhere (axis ticks, tooltips, result list, trace
  // detail): decimal ns / µs / ms / s below a minute, then whole units two at
  // a time ("8 min 30 s", "2 h 5 min", "3 d 4 h"), never "8.5 min".
  function formatDuration(nsValue) {
    const n = Number(nsValue);
    if (!Number.isFinite(n) || n < 0) return "—";
    const decimal = [[1e9, "s"], [1e6, "ms"], [1e3, "µs"]];
    if (n < 1e3) return `${Math.round(n)} ns`;
    if (n < 59.95e9) {
      for (const [factor, unit] of decimal) {
        if (n < factor) continue;
        const text = significant(n / factor);
        // 999.7 ms rounds to "1000 ms": say "1 s" instead.
        if (Number(text) >= 1000 && unit !== "s") return `${significant(n / (factor * 1000))} ${unit === "ms" ? "s" : "ms"}`;
        return `${text} ${unit}`;
      }
    }
    const pairs = [[86400, "d", 3600, "h"], [3600, "h", 60, "min"], [60, "min", 1, "s"]];
    for (const [bigS, big, smallS, small] of pairs) {
      if (n < bigS * 1e9 && big !== "min") continue;
      const total = Math.round(n / (smallS * 1e9));
      const ratio = bigS / smallS;
      const whole = Math.floor(total / ratio);
      const rest = total % ratio;
      // 59 min 59.6 s rounds to "60 min": move up to hours.
      if (whole >= (big === "min" ? 60 : big === "h" ? 24 : Infinity)) continue;
      return rest ? `${whole} ${big} ${rest} ${small}` : `${whole} ${big}`;
    }
    return `${Math.round(n / 3600e9)} h`;
  }

  // Duration axis steps: 1-2-5 below a second, then clock-friendly steps
  // (seconds, minutes, hours, days), so minute axes read 2 min, 5 min, 15 min.
  const DURATION_AXIS_STEPS_NS = (() => {
    const steps = [];
    for (let decade = 1; decade < 1e9; decade *= 10) for (const m of [1, 2, 5]) steps.push(m * decade);
    for (const s of [1, 2, 5, 10, 15, 30]) steps.push(s * 1e9);
    for (const m of [1, 2, 5, 10, 15, 30]) steps.push(m * 60e9);
    for (const h of [1, 2, 3, 6, 12]) steps.push(h * 3600e9);
    for (const d of [1, 2, 5, 10, 30]) steps.push(d * 86400e9);
    return steps;
  })();

  function niceStep(maxValue, targetIntervals = 6, integerOnly = false) {
    const max = Math.max(0, Number(maxValue || 0));
    if (!max) return integerOnly ? 1 : 1;
    const raw = max / Math.max(1, Number(targetIntervals || 6));
    const magnitude = 10 ** Math.floor(Math.log10(raw));
    const normalized = raw / magnitude;
    let nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
    let step = nice * magnitude;
    if (integerOnly) step = Math.max(1, Math.ceil(step));
    return step;
  }

  function countAxis(maxValue, targetIntervals = 7) {
    const max = Math.max(0, Number(maxValue || 0));
    const step = niceStep(max, targetIntervals, true);
    const axisMax = Math.max(step, Math.ceil(max / step) * step);
    const values = [];
    for (let value = 0; value <= axisMax + step * .001; value += step) values.push(Math.round(value));
    return { axisMax, values };
  }

  function durationAxis(maxNsValue, targetIntervals = 7) {
    const maxNs = Math.max(1, Number(maxNsValue || 0));
    const step = DURATION_AXIS_STEPS_NS.find((candidate) => maxNs / candidate <= targetIntervals) || DURATION_AXIS_STEPS_NS[DURATION_AXIS_STEPS_NS.length - 1];
    const axisMax = Math.max(step, Math.ceil(maxNs / step) * step);
    const values = [];
    for (let i = 0; i * step <= axisMax * 1.000001; i += 1) values.push({ value: i * step, label: i ? formatDuration(i * step) : "0" });
    return { axisMax, values };
  }

  function durationTicks(durationNs, count = 5) {
    const duration = Math.max(1, Number(durationNs || 0));
    const n = Math.max(2, Number(count || 5));
    return Array.from({ length: n }, (_, index) => {
      const ratio = index / (n - 1);
      return { ratio, label: formatDuration(duration * ratio) };
    });
  }

  // --- Chart time axis (browser-local time, like the range picker) ---------
  const SECOND_MS = 1000, MINUTE_MS = 60000, HOUR_MS = 3600000, DAY_MS = 86400000;
  const TIME_AXIS_STEPS_MS = [
    SECOND_MS, 2 * SECOND_MS, 5 * SECOND_MS, 10 * SECOND_MS, 15 * SECOND_MS, 30 * SECOND_MS,
    MINUTE_MS, 2 * MINUTE_MS, 5 * MINUTE_MS, 10 * MINUTE_MS, 15 * MINUTE_MS, 30 * MINUTE_MS,
    HOUR_MS, 2 * HOUR_MS, 3 * HOUR_MS, 6 * HOUR_MS, 12 * HOUR_MS,
    DAY_MS, 2 * DAY_MS, 7 * DAY_MS, 14 * DAY_MS,
  ];
  const pad2 = (value) => String(value).padStart(2, "0");
  // Rough width of a 10 px tick label; only used to keep labels apart.
  const labelWidthPx = (text) => String(text).length * 5.9 + 4;

  function localMidnight(ms) {
    const d = new Date(Number(ms));
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function clockLabel(ms, withSeconds = false) {
    const d = new Date(ms);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}${withSeconds ? `:${pad2(d.getSeconds())}` : ""}`;
  }

  function dayLabel(ms) {
    return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
  }

  // Midnight ticks name the day ("Sep 13"); within a day ticks read the clock
  // ("14:30", with seconds for sub-minute steps); a multi-day axis never
  // shows a bare hour: mid-day ticks read "Sep 13 12:00".
  function timeTickLabel(ms, stepMs, multiDay) {
    if (stepMs >= DAY_MS || localMidnight(ms) === ms) return dayLabel(ms);
    if (multiDay) return `${dayLabel(ms)} ${clockLabel(ms)}`;
    return clockLabel(ms, stepMs < MINUTE_MS);
  }

  // Tick instants in [startMs, endMs] on local wall-clock boundaries: day
  // steps on local midnights (every n-th calendar day), shorter steps restart
  // at each local midnight so DST days keep round labels.
  function timeTicksBetween(startMs, endMs, stepMs) {
    const ticks = [];
    const day = new Date(localMidnight(startMs));
    if (stepMs >= DAY_MS) {
      const everyDays = Math.round(stepMs / DAY_MS);
      for (let guard = 0; day.getTime() <= endMs && guard < 400; guard += 1, day.setDate(day.getDate() + 1)) {
        const t = day.getTime();
        const dayNumber = Math.round(Date.UTC(day.getFullYear(), day.getMonth(), day.getDate()) / DAY_MS);
        if (t >= startMs && dayNumber % everyDays === 0) ticks.push(t);
      }
      return ticks;
    }
    if (stepMs >= HOUR_MS) {
      // Wall-clock hours (00:00, 06:00, 12:00…) even on 23 h / 25 h DST days.
      const everyHours = Math.round(stepMs / HOUR_MS);
      const seen = new Set();
      for (let guard = 0; day.getTime() <= endMs && guard < 400; guard += 1, day.setDate(day.getDate() + 1)) {
        for (let hour = 0; hour < 24; hour += everyHours) {
          const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour).getTime();
          if (t >= startMs && t <= endMs && !seen.has(t)) { seen.add(t); ticks.push(t); }
        }
      }
      return ticks;
    }
    for (let guard = 0; day.getTime() <= endMs && guard < 400; guard += 1) {
      const midnight = day.getTime();
      day.setDate(day.getDate() + 1);
      const next = day.getTime();
      const first = midnight + Math.ceil(Math.max(0, startMs - midnight) / stepMs) * stepMs;
      for (let t = first; t < next && t <= endMs; t += stepMs) ticks.push(t);
    }
    return ticks;
  }

  // The smallest step whose labels keep at least 18 px apart at this width.
  function timeAxisTicks(startMs, endMs, plotWidthPx) {
    const span = Math.max(1, Number(endMs) - Number(startMs));
    const multiDay = span > DAY_MS;
    const width = Math.max(80, Number(plotWidthPx || 0));
    let chosen = TIME_AXIS_STEPS_MS[TIME_AXIS_STEPS_MS.length - 1];
    for (const step of TIME_AXIS_STEPS_MS) {
      if (span / step > 60) continue;
      const sample = step >= DAY_MS ? "Sep 30" : multiDay ? "Sep 30 12:00" : step < MINUTE_MS ? "00:00:00" : "00:00";
      if (width * step / span >= labelWidthPx(sample) + 18) { chosen = step; break; }
    }
    return timeTicksBetween(startMs, endMs, chosen).map((t) => ({ t, label: timeTickLabel(t, chosen, multiDay) }));
  }

  // Tooltip span of a bucket: "Sep 13, 14:00 → 15:00" (or both dates when
  // it crosses midnight).
  function bucketRangeLabel(startMs, sizeMs) {
    const end = startMs + sizeMs;
    const withSeconds = sizeMs < MINUTE_MS || new Date(startMs).getSeconds() !== 0;
    const from = `${dayLabel(startMs)}, ${clockLabel(startMs, withSeconds)}`;
    const sameDay = localMidnight(startMs) === localMidnight(end - 1);
    const to = sameDay ? clockLabel(end, withSeconds) : `${dayLabel(end)}, ${clockLabel(end, withSeconds)}`;
    return `${from} → ${to}`;
  }

  function timestampToNs(value) {
    if (value == null || value === "") return NaN;
    const direct = Number(value);
    if (Number.isFinite(direct)) {
      const abs = Math.abs(direct);
      if (abs >= 1e17) return direct;
      if (abs >= 1e14) return direct * 1e3;
      if (abs >= 1e11) return direct * 1e6;
      if (abs >= 1e9) return direct * 1e9;
    }
    const raw = String(value).trim();
    if (!raw) return NaN;
    const match = raw.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(?:Z|[+-]\d\d(?::?\d\d)?)?$/);
    if (match) {
      const millis = (match[3] || "").slice(0, 3).padEnd(3, "0");
      const parsed = Date.parse(`${match[1]}T${match[2]}.${millis}Z`);
      if (Number.isFinite(parsed)) return parsed * 1e6;
    }
    const parsed = Date.parse(raw.includes("T") ? raw : raw.replace(" ", "T") + "Z");
    return Number.isFinite(parsed) ? parsed * 1e6 : NaN;
  }

  function serviceEnabled(service) {
    return !model.disabledServices.has(String(service || "unknown"));
  }

  function shortId(value, size = 7) {
    const s = String(value || "");
    return s.length <= size * 2 + 1 ? s : `${s.slice(0, size)}…${s.slice(-size)}`;
  }

  function parseStartMs(value) {
    const direct = Number(value);
    if (Number.isFinite(direct) && direct > 10000000000) return direct;
    const raw = String(value || "").trim();
    if (!raw) return NaN;
    const normalized = raw.includes("T") ? raw : raw.replace(" ", "T");
    const withZone = /(?:Z|[+-]\d\d(?::?\d\d)?)$/i.test(normalized) ? normalized : `${normalized}Z`;
    const ms = Date.parse(withZone);
    return Number.isFinite(ms) ? ms : NaN;
  }

  function formatStart(value) {
    const ms = parseStartMs(value);
    if (!Number.isFinite(ms)) return String(value || "");
    const d = new Date(ms);
    return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function formatAgo(value) {
    const ms = parseStartMs(value);
    if (!Number.isFinite(ms)) return "";
    const delta = Math.max(0, Date.now() - ms);
    const units = [[31536000000, "year"], [2592000000, "month"], [604800000, "week"], [86400000, "day"], [3600000, "hour"], [60000, "minute"], [1000, "second"]];
    for (const [size, label] of units) {
      if (delta >= size || label === "second") {
        const count = Math.max(0, Math.floor(delta / size));
        return `${count} ${label}${count === 1 ? "" : "s"} ago`;
      }
    }
    return "now";
  }

  function currentHost() { return state.selectedHostId || ""; }

  function showError(message) {
    if (!dom.tracesError) return;
    dom.tracesError.hidden = !message;
    dom.tracesError.textContent = message || "";
  }

  function traceIdFromPath() {
    const pathname = decodeURIComponent(String(window.location.pathname || ""));
    const match = pathname.match(/\/traces\/([^/]+)\/?$/);
    return match ? match[1] : "";
  }

  function setView(detail) {
    if (dom.tracesSearchView) dom.tracesSearchView.hidden = !!detail;
    if (dom.traceDetail) dom.traceDetail.hidden = !detail;
    document.body.classList.toggle("is-trace-detail", !!detail);
  }

  function serviceColor(service) {
    const s = String(service || "unknown");
    let hash = 2166136261;
    for (let i = 0; i < s.length; i += 1) {
      hash ^= s.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return SERVICE_COLORS[Math.abs(hash) % SERVICE_COLORS.length];
  }

  function setButtonLoading(button, loading) {
    if (!button) return;
    button.classList.toggle("is-loading", !!loading);
    button.disabled = !!loading;
  }

  const tracePickers = new Set();

  function closeTracePicker(root, { immediate = false } = {}) {
    if (!root) return;
    const button = root.querySelector(".tracePicker__button");
    const menu = root.querySelector(".tracePicker__menu");
    if (root._tracePickerCloseTimer) {
      clearTimeout(root._tracePickerCloseTimer);
      root._tracePickerCloseTimer = null;
    }
    button?.setAttribute("aria-expanded", "false");
    if (immediate) {
      root.classList.remove("themeSelect--open", "themeSelect--closing");
      if (menu) menu.hidden = true;
      return;
    }
    if (menu?.hidden) {
      root.classList.remove("themeSelect--open", "themeSelect--closing");
      return;
    }
    // Enter the closing state before dropping --open so the button stays
    // visually connected to the menu for the whole collapse animation.
    root.classList.add("themeSelect--closing");
    requestAnimationFrame(() => root.classList.remove("themeSelect--open"));
    root._tracePickerCloseTimer = setTimeout(() => {
      if (!root.classList.contains("themeSelect--open")) {
        if (menu) menu.hidden = true;
        root.classList.remove("themeSelect--closing");
      }
      root._tracePickerCloseTimer = null;
    }, 160);
  }

  function closeTracePickers(except = null, { immediate = false } = {}) {
    for (const root of tracePickers) {
      if (root === except) continue;
      closeTracePicker(root, { immediate });
    }
  }

  function openTracePicker(root) {
    if (!root) return;
    const button = root.querySelector(".tracePicker__button");
    const menu = root.querySelector(".tracePicker__menu");
    if (!button || !menu || button.disabled) return;
    closeTracePickers(root);
    if (root._tracePickerCloseTimer) {
      clearTimeout(root._tracePickerCloseTimer);
      root._tracePickerCloseTimer = null;
    }
    root.classList.remove("themeSelect--closing");
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    requestAnimationFrame(() => {
      if (button.getAttribute("aria-expanded") !== "true") return;
      root.classList.add("themeSelect--open");
      menu.focus({ preventScroll: true });
    });
  }

  function enhanceTraceSelect(select) {
    if (!select || select.dataset.tracePickerReady === "1") return;
    select.dataset.tracePickerReady = "1";
    // traces.html ships every picker already built (root, native select,
    // button, menu) so the first paint has the final look; adopt that markup
    // and only build the picker for a select that arrives without it.
    const shipped = select.parentElement?.classList.contains("tracePicker") ? select.parentElement : null;
    const root = shipped || document.createElement("div");
    let button = shipped?.querySelector(":scope > .tracePicker__button") || null;
    let menu = shipped?.querySelector(":scope > .tracePicker__menu") || null;
    if (!shipped) {
      root.className = "themeSelect tracePicker";
      if (select === dom.tracesRangeUnit) root.classList.add("tracePicker--range");
      select.parentNode.insertBefore(root, select);
      root.appendChild(select);
    }
    select.classList.add("tracePicker__native");

    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "button themeSelect__button tracePicker__button";
      button.setAttribute("aria-haspopup", "listbox");
      button.setAttribute("aria-expanded", "false");
      root.appendChild(button);
    }
    if (!menu) {
      menu = document.createElement("div");
      menu.className = "themeSelect__menu tracePicker__menu";
      menu.setAttribute("role", "listbox");
      menu.tabIndex = -1;
      menu.hidden = true;
      root.appendChild(menu);
    }
    tracePickers.add(root);

    const refresh = () => {
      const selected = select.options[select.selectedIndex] || select.options[0] || null;
      const fieldLabel = String(select.dataset.fieldLabel || "").trim();
      const selectedText = selected?.textContent || "Select";
      const disableWhenEmpty = select.dataset.disableWhenEmpty === "1";
      const hasValues = Array.from(select.options).some((option) => !option.hidden && String(option.value || "").length > 0);
      const unavailable = !!select.disabled || (disableWhenEmpty && !hasValues);
      button.textContent = fieldLabel ? `${fieldLabel} · ${selectedText}` : selectedText;
      button.disabled = unavailable;
      button.setAttribute("aria-disabled", unavailable ? "true" : "false");
      root.classList.toggle("is-disabled", unavailable);
      root.classList.toggle("is-empty", disableWhenEmpty && !hasValues);
      if (unavailable) closeTracePicker(root, { immediate: true });
      menu.innerHTML = "";
      Array.from(select.options).forEach((option) => {
        if (option.hidden) return;
        const item = document.createElement("button");
        item.type = "button";
        item.className = "themeSelect__option tracePicker__option";
        item.setAttribute("role", "option");
        item.dataset.value = option.value;
        item.textContent = option.textContent || option.value || "—";
        item.disabled = !!option.disabled;
        item.setAttribute("aria-selected", option.value === select.value ? "true" : "false");
        item.addEventListener("click", () => {
          if (item.disabled) return;
          select.value = option.value;
          select.dispatchEvent(new Event("change", { bubbles: true }));
          refresh();
          closeTracePicker(root);
        });
        menu.appendChild(item);
      });
    };

    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (button.disabled) return;
      if (root.classList.contains("themeSelect--open") || button.getAttribute("aria-expanded") === "true") {
        closeTracePicker(root);
      } else {
        openTracePicker(root);
      }
    });
    menu.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeTracePicker(root);
        button.focus({ preventScroll: true });
      }
    });
    select.addEventListener("change", refresh);
    select.addEventListener("tracepicker-refresh", refresh);
    new MutationObserver(refresh).observe(select, { attributes: true, childList: true, subtree: true, characterData: true });
    refresh();
  }

  function initTracePickers() {
    initTimeRangePicker();
    document.querySelectorAll(".traceSearchBar select, .traceResultsSort select").forEach((select) => {
      if (select !== dom.tracesRangeUnit || !timePicker) enhanceTraceSelect(select);
    });
    document.addEventListener("click", (event) => {
      // The dispatch path, not only contains(): a click can re-render the
      // element it landed on (calendar days, quick range lists).
      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      if (![...tracePickers].some((root) => root.contains(event.target) || path.includes(root))) closeTracePickers();
    });
  }

  function maxRangeMinutes() { return Math.max(1, Number(model.meta?.max_lookback_minutes || 10080)); }

  let timePicker = null;

  // The Grafana-style time range panel replaces the dropdown list of the
  // shipped range picker (same root, button and menu, same open/close motion).
  function initTimeRangePicker() {
    const select = dom.tracesRangeUnit;
    const root = select?.parentElement;
    const button = root?.querySelector(":scope > .tracePicker__button");
    const menu = root?.querySelector(":scope > .tracePicker__menu");
    if (!ns.timeRange || !root || !button || !menu || !dom.tracesRangeStart || !dom.tracesRangeEnd) return;
    select.dataset.tracePickerReady = "1";
    tracePickers.add(root);
    timePicker = ns.timeRange.mountPicker({
      button, menu, select,
      fromInput: dom.tracesRangeStart,
      toInput: dom.tracesRangeEnd,
      fromError: dom.tracesRangeStartError,
      toError: dom.tracesRangeEndError,
      rangeError: dom.tracesRangeError,
      calendar: dom.tracesTimeCalendar,
      hint: dom.tracesTimeCalendarHint,
      applyButton: dom.tracesCustomRangeApply,
      quickSearch: dom.tracesQuickRangeSearch,
      lists: dom.tracesQuickRanges,
      timeZone: dom.tracesTimeZone,
      shiftBack: dom.tracesRangeShiftBack,
      shiftForward: dom.tracesRangeShiftForward,
      zoomOut: dom.tracesRangeZoomOut,
    }, {
      getValue: () => model.timeRange,
      getMaxMinutes: maxRangeMinutes,
      onApply: (raw, source) => { void applyCustomRange(raw, source); },
      open: () => openTracePicker(root),
      close: () => closeTracePicker(root),
    });
  }

  // Meta decides the default window (until the user picks one) and the widest
  // one: an applied range wider than the server accepts falls back to the
  // widest quick range that fits.
  function syncRangeControls() {
    const tr = ns.timeRange;
    if (!tr) return;
    const max = maxRangeMinutes();
    const fallbackMinutes = Math.min(max, Math.max(1, Number(model.meta?.default_lookback_minutes || 60)));
    if (!model.timeRangeTouched && model.meta) model.timeRange = { from: `now-${tr.minutesToSpan(fallbackMinutes)}`, to: "now" };
    const now = Date.now();
    const { startMs, endMs } = tr.resolveRange(model.timeRange, now);
    if (!(endMs > startMs) || endMs - startMs > max * 60000) {
      const fitting = tr.QUICK_RANGES.filter((option) => option.to === "now" && /^now-\d+[smhdwMy]$/.test(option.from))
        .filter((option) => { const r = tr.resolveRange(option, now); return r.endMs - r.startMs <= max * 60000; });
      model.timeRange = fitting.length ? { from: fitting[fitting.length - 1].from, to: "now" } : { from: `now-${tr.minutesToSpan(fallbackMinutes)}`, to: "now" };
    }
    refreshCustomRangeLabel();
  }

  // Relative ranges ("now-1h") are resolved again for every request.
  function selectedRange() {
    const tr = ns.timeRange;
    const { startMs, endMs } = tr.resolveRange(model.timeRange, Date.now());
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) throw new Error("Select a valid time range.");
    if (endMs - startMs > maxRangeMinutes() * 60000) throw new Error(`Max range is ${tr.formatMinutes(maxRangeMinutes())} (server setting traces.max_lookback_minutes).`);
    return { start_ms: Math.round(startMs), end_ms: Math.round(endMs), align_buckets: tr.isRelative(model.timeRange) ? "1" : "0" };
  }

  function replaceSelectOptions(select, values, allLabel) {
    if (!select) return;
    const previous = String(select.value || "");
    const unique = [...new Set((values || []).map((value) => String(value || "")).filter(Boolean))].sort();
    select.innerHTML = `<option value="">${esc(allLabel || "ALL")}</option>` + unique.map((value) => `<option value="${esc(value)}">${esc(value)}</option>`).join("");
    select.value = unique.includes(previous) ? previous : "";
    select.dispatchEvent(new Event("tracepicker-refresh"));
  }

  function updateServiceOptions() {
    const operation = String(dom.tracesOperation?.value || "").trim();
    const services = model.prefillPairs
      .filter((pair) => !operation || String(pair?.[1] || "") === operation)
      .map((pair) => pair?.[0]);
    replaceSelectOptions(dom.tracesService, services, "ALL");
  }

  function updateOperationOptions() {
    const service = String(dom.tracesService?.value || "").trim();
    const operations = model.prefillPairs
      .filter((pair) => !service || String(pair?.[0] || "") === service)
      .map((pair) => pair?.[1]);
    replaceSelectOptions(dom.tracesOperation, operations, "ALL");
  }

  function serviceOperationPairExists(service, operation) {
    if (!service || !operation) return true;
    return model.prefillPairs.some((pair) => String(pair?.[0] || "") === service && String(pair?.[1] || "") === operation);
  }

  function syncServiceOperationPair(preferred = "service") {
    let service = String(dom.tracesService?.value || "").trim();
    let operation = String(dom.tracesOperation?.value || "").trim();
    if (service && operation && !serviceOperationPairExists(service, operation)) {
      if (preferred === "operation") {
        dom.tracesService.value = "";
        service = "";
      } else {
        dom.tracesOperation.value = "";
        operation = "";
      }
    }
    updateServiceOptions();
    updateOperationOptions();
  }

  function resolvedServiceValues() {
    const value = String(dom.tracesService?.value || "").trim();
    return value ? [value] : [];
  }

  function resolvedOperationValues() {
    const value = String(dom.tracesOperation?.value || "").trim();
    return value ? [value] : [];
  }

  function syncFilterFeatures() {
    const f = model.meta?.features || {};
    const bindings = [[dom.tracesService, f.service_filter !== false], [dom.tracesOperation, f.operation_filter !== false], [dom.tracesStatus, f.status_filter !== false]];
    for (const [input, enabled] of bindings) {
      const field = input?.closest?.(".traceSearchField") || input?.closest?.("label");
      if (field) field.hidden = !enabled;
      if (input) input.disabled = !enabled;
    }
    syncRangeControls();
    if (dom.tracesLimit && model.meta) {
      const max = Math.max(1, Number(model.meta.search_limit || 100));
      for (const option of dom.tracesLimit.options) {
        const unavailable = Number(option.value) > max;
        option.disabled = unavailable;
        option.hidden = unavailable;
      }
      const enabled = Array.from(dom.tracesLimit.options).filter((option) => !option.disabled && !option.hidden);
      if (!enabled.some((option) => option.value === dom.tracesLimit.value) && enabled.length) {
        dom.tracesLimit.value = enabled[enabled.length - 1].value;
      }
      dom.tracesLimit.dispatchEvent(new Event("tracepicker-refresh"));
    }
    const tagEnabled = model.meta?.tag_search_supported !== false;
    if (dom.tracesTagKey) dom.tracesTagKey.disabled = !tagEnabled;
    if (dom.tracesTagValue) dom.tracesTagValue.disabled = !tagEnabled;
    renderAnalytics();
  }

  function renderSource() {}

  function sortedResults() {
    const rows = [...(model.traces || [])];
    const mode = String(dom.tracesSort?.value || "recent");
    if (mode === "longest") rows.sort((a, b) => Number(b.duration_ns || 0) - Number(a.duration_ns || 0));
    else if (mode === "shortest") rows.sort((a, b) => Number(a.duration_ns || 0) - Number(b.duration_ns || 0));
    else if (mode === "spans") rows.sort((a, b) => Number(b.span_count || 0) - Number(a.span_count || 0));
    else rows.sort((a, b) => Number(b.start_ms || 0) - Number(a.start_ms || 0));
    return rows;
  }

  function unpackSearch(payload) {
    const services = Array.isArray(payload?.services) ? payload.services : [];
    const rows = Array.isArray(payload?.rows) ? payload.rows : [];
    model.traces = rows.map((row) => ({
      trace_id: String(row?.[0] || ""),
      start_ms: Number(row?.[1] || 0),
      root_operation: String(row?.[2] || ""),
      root_service: services[Number(row?.[3] || 0)] || "unknown",
      duration_ns: Number(row?.[4] || 0),
      span_count: Number(row?.[5] || 0),
      error_count: Number(row?.[6] || 0),
      service_stats: orderByFirstSpan((Array.isArray(row?.[7]) ? row[7] : []).map((stat) => ({ service: services[Number(stat?.[0] || 0)] || "unknown", spans: Number(stat?.[1] || 0), errors: Number(stat?.[2] || 0), first_span_ns: Number(stat?.[3] || 0) }))),
    }));
  }

  // A trace's services read in the order they joined it: by their earliest
  // span start (offset from the trace start), then by name.
  function orderByFirstSpan(stats) {
    return stats.sort((a, b) => (a.first_span_ns - b.first_span_ns) || (a.service < b.service ? -1 : a.service > b.service ? 1 : 0));
  }

  function unpackAnalytics(payload, previous = null) {
    const charts = Array.isArray(payload?.charts) ? payload.charts.map(String) : ["counts", "durations"];
    const hasDurations = charts.includes("durations");
    return {
      range: Array.isArray(payload?.range) ? payload.range.map(Number) : [0, 1],
      bucket_ms: Number(payload?.bucket_ms || 60000),
      quantile_bucket_ms: Number(payload?.quantile_bucket_ms || payload?.bucket_ms || 60000),
      trace_count_chart: Array.isArray(payload?.trace_count_chart) ? payload.trace_count_chart : [],
      trace_count_source: String(payload?.trace_count_source || "span_bounds"),
      has_durations: hasDurations,
      duration_quantiles: hasDurations
        ? (Array.isArray(payload?.duration_quantiles) ? payload.duration_quantiles : [])
        : (previous?.duration_quantiles || []),
    };
  }

  // Chart geometry in CSS pixels: the SVG viewBox is the element's own size,
  // so text, markers and hit-testing are never stretched.
  const CHART_HEIGHT = 196;
  function chartWidth(container) {
    // A hidden card has no width yet: draw at a typical size, the resize
    // observer redraws once it is laid out.
    const width = Number(container?.clientWidth || 0);
    return width > 12 ? Math.max(240, Math.round(width - 12)) : 640;
  }

  function timeAxisSvg(startMs, endMs, left, plotW, H, W) {
    const xOf = (ms) => left + ((ms - startMs) / Math.max(1, endMs - startMs)) * plotW;
    return timeAxisTicks(startMs, endMs, plotW).map(({ t, label }) => {
      const x = xOf(t);
      const half = labelWidthPx(label) / 2;
      const anchor = x - half < 2 ? "start" : x + half > W - 2 ? "end" : "middle";
      const tx = anchor === "start" ? Math.max(2, x) : anchor === "end" ? Math.min(W - 2, x) : x;
      return `<line x1="${x.toFixed(1)}" y1="${H - 26}" x2="${x.toFixed(1)}" y2="${H - 22}" class="traceChart__grid"/><text x="${tx.toFixed(1)}" y="${H - 9}" text-anchor="${anchor}" class="traceChart__tick" data-time-tick="${t}">${esc(label)}</text>`;
    }).join("");
  }

  // Grafana-like hover: the whole chart area is one hit surface; the pointer
  // snaps to the nearest plotted point (points: [{ x, key }] sorted by x, in
  // SVG units), so there are no dead zones between buckets.
  function attachChartTooltips(container, points, htmlFor, onHover = null) {
    if (!container) return;
    const svg = container.querySelector("svg");
    const surface = container.querySelector(".traceChartHit");
    if (!svg || !surface || !points.length) return;
    let tooltip = container.querySelector(".traceChartTooltip");
    if (!tooltip) {
      tooltip = document.createElement("div");
      tooltip.className = "traceChartTooltip";
      tooltip.hidden = true;
      container.appendChild(tooltip);
    }
    const viewWidth = Number(svg.viewBox?.baseVal?.width || 0);
    const xs = points.map((point) => point.x);
    const nearest = (x) => {
      let lo = 0, hi = xs.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (xs[mid] <= x) lo = mid; else hi = mid;
      }
      return Math.abs(xs[hi] - x) < Math.abs(xs[lo] - x) ? points[hi] : points[lo];
    };
    let current = null;
    let tipWidth = 0;
    let tipHeight = 0;
    const hide = () => {
      if (current) onHover?.(current, false);
      tooltip.hidden = true;
      current = null;
    };
    const move = (event) => {
      const box = svg.getBoundingClientRect();
      if (!box.width) return;
      const x = (event.clientX - box.left) * ((viewWidth || box.width) / box.width);
      const point = nearest(x);
      if (current !== point) {
        if (current) onHover?.(current, false);
        const html = htmlFor(point);
        if (!html) { current = null; tooltip.hidden = true; return; }
        onHover?.(point, true);
        tooltip.innerHTML = html;
        tooltip.hidden = false;
        // Measure at the origin so the natural size does not depend on where
        // the previous point left the tooltip.
        tooltip.style.left = "0px";
        tooltip.style.top = "0px";
        const size = tooltip.getBoundingClientRect();
        tipWidth = size.width;
        tipHeight = size.height;
        current = point;
      }
      const rect = container.getBoundingClientRect();
      let left = event.clientX - rect.left + 12;
      let top = event.clientY - rect.top + 12;
      if (left + tipWidth > rect.width - 4) left = event.clientX - rect.left - tipWidth - 12;
      if (top + tipHeight > rect.height - 4) top = event.clientY - rect.top - tipHeight - 12;
      tooltip.style.left = `${Math.max(4, left)}px`;
      tooltip.style.top = `${Math.max(4, top)}px`;
    };
    surface.addEventListener("pointerenter", move);
    surface.addEventListener("pointermove", move);
    surface.addEventListener("pointerleave", hide);
  }

  function chartMessage(container, text, isError = false) {
    if (!container) return;
    container.innerHTML = `<div class="tracesEmpty${isError ? " traceChartError" : ""}"${isError ? ' role="alert"' : ""}>${esc(text)}</div>`;
  }

  function renderServiceChart() {
    const container = dom.traceServiceChart;
    if (!container) return;
    const a = model.analytics;
    const points = a?.trace_count_chart || [];
    const range = a?.range || [0, 1];
    const bucketMs = Math.max(1000, Number(a?.bucket_ms || 60000));
    const start = Number(range[0] || 0), end = Math.max(start + 1000, Number(range[1] || start + bucketMs));
    // Buckets are keyed by their start on the server's grid (anchored at the
    // local midnight sent as bucket_origin_ms) and placed by time, so a range
    // that does not start on the grid still shows every bucket.
    const buckets = points
      .map((point) => [Number(point?.[0] || 0), Number(point?.[1] || 0)])
      .filter(([bucket, count]) => count > 0 && bucket + bucketMs > start && bucket <= end)
      .sort((x, y) => x[0] - y[0]);
    if (!buckets.length) { chartMessage(container, "No matching traces in this range."); return; }
    const W = chartWidth(container), H = CHART_HEIGHT, top = 10, bottom = 30, right = 10;
    const maxTotal = Math.max(1, ...buckets.map((bucket) => bucket[1]));
    const countScale = countAxis(maxTotal, 7);
    const tickText = (value) => Number(value).toLocaleString();
    const left = Math.ceil(10 + Math.max(...countScale.values.map((value) => labelWidthPx(tickText(value)))));
    const plotW = W - left - right, plotH = H - top - bottom;
    const xOf = (ms) => left + ((ms - start) / (end - start)) * plotW;
    const slotW = (bucketMs / (end - start)) * plotW;
    const inset = slotW > 4 ? slotW * 0.14 : 0;
    const hover = [];
    const bars = buckets.map(([bucket, count], i) => {
      const x1 = Math.max(left, xOf(bucket) + inset);
      const x2 = Math.min(left + plotW, xOf(bucket + bucketMs) - inset);
      const w = Math.max(1, x2 - x1);
      const h = Math.max(1, (count / countScale.axisMax) * plotH);
      hover.push({ x: x1 + w / 2, key: i, bucket, count });
      return `<rect x="${x1.toFixed(2)}" y="${(top + plotH - h).toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" rx="1" class="traceCountBar" data-count-bar="${i}" data-count-ts="${bucket}" data-count="${count}"/>`;
    }).join("");
    const yTicks = countScale.values.map((value) => { const y = top + plotH - (value / countScale.axisMax) * plotH; return `<line x1="${left}" y1="${y.toFixed(1)}" x2="${W - right}" y2="${y.toFixed(1)}" class="traceChart__grid"/><text x="${left - 6}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" class="traceChart__tick">${esc(tickText(value))}</text>`; }).join("");
    const xTicks = timeAxisSvg(start, end, left, plotW, H, W);
    container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="traceChart__svg">${yTicks}${bars}${xTicks}<rect x="0" y="0" width="${W}" height="${H}" class="traceChartHit"/></svg>`;
    attachChartTooltips(container, hover, (point) => `<strong>${point.count.toLocaleString()} matching trace${point.count === 1 ? "" : "s"}</strong><span>${esc(bucketRangeLabel(point.bucket, bucketMs))}</span>`, (point, active) => {
      container.querySelector(`[data-count-bar="${point.key}"]`)?.classList.toggle("is-hovered", active);
    });
    if (dom.traceServiceChartMeta) {
      const fromIndex = a.trace_count_source === "trace_index";
      dom.traceServiceChartMeta.textContent = `${formatDuration(bucketMs * 1e6)} buckets · ${fromIndex ? "trace index" : "spans"}`;
      dom.traceServiceChartMeta.title = fromIndex
        ? "Counted from the trace index (each trace at its first span start). Exact span counts replace it once the duration percentiles are computed."
        : "Traces with at least one matching span in the range, each counted at its first span start.";
    }
  }

  function renderDurationChart() {
    const container = dom.traceDurationChart;
    if (!container) return;
    const a = model.analytics;
    if (a && !a.has_durations) {
      if (model.durationsError) chartMessage(container, model.durationsError, true);
      else chartMessage(container, "Computing duration percentiles…");
      if (dom.traceDurationChartMeta) dom.traceDurationChartMeta.textContent = "P50 / P90 / P95 / P99";
      return;
    }
    const qs = (a?.duration_quantiles || []).map((q) => q.map(Number)).sort((x, y) => x[0] - y[0]);
    if (!qs.length) { chartMessage(container, "No trace durations in this range."); return; }
    const range = a?.range || [qs[0][0], qs[qs.length - 1][0]];
    const xMin = Number(range[0] || 0), xMax = Math.max(xMin + 1000, Number(range[1] || xMin + 1000));
    let yMax = 1;
    for (const q of qs) for (let i = 1; i <= 4; i += 1) yMax = Math.max(yMax, q[i] || 0);
    const durationScaleAxis = durationAxis(yMax, 7);
    const W = chartWidth(container), H = CHART_HEIGHT, top = 10, bottom = 30, right = 12;
    const left = Math.ceil(10 + Math.max(...durationScaleAxis.values.map((tick) => labelWidthPx(tick.label))));
    const plotW = W - left - right, plotH = H - top - bottom;
    const qBucketMs = Math.max(1000, Number(a.quantile_bucket_ms || a.bucket_ms || 60000));
    const xOf = (ms) => Math.min(left + plotW, Math.max(left, left + ((Number(ms) - xMin) / (xMax - xMin)) * plotW));
    const yOf = (ns) => top + plotH - (Number(ns || 0) / durationScaleAxis.axisMax) * plotH;
    const yTicks = durationScaleAxis.values.map((tick) => { const y = top + plotH - (tick.value / durationScaleAxis.axisMax) * plotH; return `<line x1="${left}" y1="${y.toFixed(1)}" x2="${W - right}" y2="${y.toFixed(1)}" class="traceChart__grid"/><text x="${left - 6}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" class="traceChart__tick">${esc(tick.label)}</text>`; }).join("");
    const xTicks = timeAxisSvg(xMin, xMax, left, plotW, H, W);
    const qDefs = [[1, "p50"], [2, "p90"], [3, "p95"], [4, "p99"]];
    // Lines break where buckets have no traces instead of bridging the gap,
    // and a lone bucket gets a dot, so every drawn stretch holds real points.
    const runs = [];
    for (const q of qs) {
      const last = runs[runs.length - 1];
      if (last && q[0] - last[last.length - 1][0] <= qBucketMs * 1.5) last.push(q); else runs.push([q]);
    }
    const lines = qDefs.map(([col, cls]) => runs.map((run) => {
      if (run.length === 1) return `<circle cx="${xOf(run[0][0] + qBucketMs / 2).toFixed(2)}" cy="${yOf(run[0][col]).toFixed(2)}" r="1.8" class="traceDurationDot traceDurationDot--${cls}"/>`;
      const pts = run.map((q) => `${xOf(q[0] + qBucketMs / 2).toFixed(2)},${yOf(q[col]).toFixed(2)}`).join(" ");
      return `<polyline points="${pts}" class="traceDurationLine traceDurationLine--${cls}" fill="none"/>`;
    }).join("")).join("");
    const hover = [];
    const hoverPoints = qs.map((q, i) => {
      const x = xOf(q[0] + qBucketMs / 2);
      hover.push({ x, key: q[0], q });
      const xs = x.toFixed(2);
      return `<g class="traceQuantileHover" data-q-hover="${q[0]}" data-q-ts="${q[0]}"><line x1="${xs}" x2="${xs}" y1="${top}" y2="${top + plotH}"/>${qDefs.map(([col, cls]) => `<circle class="${cls}" cx="${xs}" cy="${yOf(q[col]).toFixed(2)}" r="3.5"/>`).join("")}</g>`;
    }).join("");
    container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="traceChart__svg">${yTicks}${xTicks}${lines}${hoverPoints}<rect x="0" y="0" width="${W}" height="${H}" class="traceChartHit"/></svg><div class="traceChartLegend traceChartLegend--quantiles"><span class="p50">P50</span><span class="p90">P90</span><span class="p95">P95</span><span class="p99">P99</span></div>`;
    attachChartTooltips(container, hover, (point) => {
      const [bucket, p50, p90, p95, p99] = point.q;
      return `<strong>${esc(bucketRangeLabel(bucket, qBucketMs))}</strong><span>P50 <b>${esc(formatDuration(p50))}</b></span><span>P90 <b>${esc(formatDuration(p90))}</b></span><span>P95 <b>${esc(formatDuration(p95))}</b></span><span>P99 <b>${esc(formatDuration(p99))}</b></span>`;
    }, (point, active) => {
      container.querySelector(`[data-q-hover="${point.key}"]`)?.classList.toggle("is-active", active);
    });
    if (dom.traceDurationChartMeta) dom.traceDurationChartMeta.textContent = `P50 / P90 / P95 / P99 · ${formatDuration(qBucketMs * 1e6)} buckets`;
  }

  // Remembers whether meta enables analytics for the head script of the next
  // page load (see traces.html), and drops the early class once meta is known.
  function rememberAnalyticsEnabled(enabled) {
    try { localStorage.setItem("chdash.traceAnalytics.v1", enabled ? "1" : "0"); } catch { /* storage may be unavailable */ }
    document.documentElement.classList.remove("chdash-trace-analytics");
  }

  // Charts are drawn at their pixel width: redraw when a card changes width.
  let chartResizeObserver = null;
  let chartResizeFrame = 0;
  const chartWidths = new WeakMap();
  function watchChartWidths() {
    if (chartResizeObserver || typeof ResizeObserver !== "function") return;
    chartResizeObserver = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const width = Math.round(entry.contentRect.width);
        if (chartWidths.get(entry.target) !== width) { chartWidths.set(entry.target, width); changed = true; }
      }
      if (!changed || chartResizeFrame) return;
      chartResizeFrame = requestAnimationFrame(() => {
        chartResizeFrame = 0;
        if (model.analytics && !dom.traceAnalyticsGrid?.hidden) { renderServiceChart(); renderDurationChart(); }
      });
    });
    for (const chart of [dom.traceServiceChart, dom.traceDurationChart]) if (chart) chartResizeObserver.observe(chart);
  }

  function renderAnalytics() {
    const enabled = model.meta?.analytics_enabled === true;
    if (model.meta) rememberAnalyticsEnabled(enabled);
    if (dom.traceAnalyticsGrid) dom.traceAnalyticsGrid.hidden = !enabled;
    if (!enabled) return;
    watchChartWidths();
    if (model.analyticsLoading && !model.analytics) {
      chartMessage(dom.traceServiceChart, "Loading trace activity…");
      chartMessage(dom.traceDurationChart, "Loading duration distribution…");
      return;
    }
    if (model.analyticsError && !model.analytics) {
      chartMessage(dom.traceServiceChart, model.analyticsError, true);
      chartMessage(dom.traceDurationChart, model.analyticsError, true);
      return;
    }
    if (!model.analytics) {
      chartMessage(dom.traceServiceChart, "Search to load matching trace activity.");
      chartMessage(dom.traceDurationChart, "Search to load duration distribution.");
      return;
    }
    renderServiceChart();
    renderDurationChart();
  }

  // Through the shared helper: navigator.clipboard alone is missing outside
  // secure contexts (plain-http deployments), where it falls back to a
  // hidden textarea copy.
  function copyText(text, button) {
    util.copyTextToClipboard(text).then(() => {
      if (!button) return;
      button.classList.add("is-copied");
      setTimeout(() => { button.classList.remove("is-copied"); }, 900);
    }).catch(() => {});
  }

  function renderResults() {
    if (!dom.tracesResults) return;
    const rows = sortedResults();
    const count = document.getElementById("tracesResultCount");
    if (count) {
      const withErrors = rows.filter((trace) => Number(trace.error_count || 0) > 0).length;
      count.innerHTML = `${rows.length} Trace${rows.length === 1 ? "" : "s"}${withErrors ? ` <span class="tracesResultCount__errors" title="${withErrors} of the listed traces have error spans">· ${withErrors} with error${withErrors === 1 ? "" : "s"}</span>` : ""}`;
    }
    renderAnalytics();
    if (!rows.length) {
      dom.tracesResults.innerHTML = '<div class="tracesEmpty">No traces match these filters.</div>';
      return;
    }
    dom.tracesResults.innerHTML = rows.map((trace) => {
      const errors = Number(trace.error_count || 0);
      const title = trace.root_operation || "trace";
      const services = Array.isArray(trace.service_stats) ? trace.service_stats : [];
      const stats = services.map((stat) => `<span class="traceServiceStat${stat.errors ? " is-error" : ""}" style="--trace-service-color:${serviceColor(stat.service)}"><i></i><b>${esc(stat.service)}</b><span>${stat.spans}</span>${stat.errors ? `<em class="traceErrorCount" title="${stat.errors} error span${stat.errors === 1 ? "" : "s"}">${stat.errors}</em>` : ""}</span>`).join("");
      return `<div class="traceResult traceResult--wide" data-trace-id="${esc(trace.trace_id)}" role="button" tabindex="0">
        <div class="traceResult__line traceResult__line--main">
          <strong class="traceResult__wideTitle">${esc(title)}</strong>${errors ? `<span class="traceErrorCount traceErrorCount--title" title="${errors} error span${errors === 1 ? "" : "s"}" aria-label="${errors} error span${errors === 1 ? "" : "s"}">${errors}</span>` : ""}
          <code class="traceResult__fullId">${esc(trace.trace_id)}</code>
          <button type="button" class="traceCopyButton" data-copy-trace="${esc(trace.trace_id)}" title="Copy Trace ID" aria-label="Copy Trace ID"><span class="editorCopyButton__icon" aria-hidden="true"></span></button>
          <span class="traceResult__right"><span class="traceResult__when"><time>${esc(formatStart(trace.start_ms))}</time><small>${esc(formatAgo(trace.start_ms))}</small></span><b>${esc(formatDuration(trace.duration_ns))}</b></span>
        </div>
        <div class="traceResult__line traceResult__line--stats">
          <span class="traceResult__count">${trace.span_count}</span>
          <div class="traceServiceStats">${stats}</div>
        </div>
      </div>`;
    }).join("");
    for (const row of dom.tracesResults.querySelectorAll("[data-trace-id]")) {
      const open = () => loadTrace(row.getAttribute("data-trace-id"), { push: true });
      row.addEventListener("click", (event) => { if (!event.target.closest("[data-copy-trace]")) open(); });
      row.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } });
    }
    for (const button of dom.tracesResults.querySelectorAll("[data-copy-trace]")) {
      button.addEventListener("click", (event) => { event.stopPropagation(); copyText(button.getAttribute("data-copy-trace") || "", button); });
    }
  }

  function buildTree(spans) {
    const nodes = (Array.isArray(spans) ? spans : []).map((span) => ({ span, children: [], depth: 0 }));
    const byId = new Map(nodes.map((node) => [String(node.span.span_id || ""), node]));
    const roots = [];
    for (const node of nodes) {
      const parentId = String(node.span.parent_span_id || "");
      const parent = parentId ? byId.get(parentId) : null;
      if (parent && parent !== node) parent.children.push(node);
      else roots.push(node);
    }
    const cmp = (a, b) => Number(a.span.start_ns || 0) - Number(b.span.start_ns || 0) || String(a.span.span_id || "").localeCompare(String(b.span.span_id || ""));
    const setDepth = (node, depth) => {
      node.depth = Math.min(32, depth);
      node.children.sort(cmp);
      for (const child of node.children) setDepth(child, depth + 1);
    };
    roots.sort(cmp);
    for (const root of roots) setDepth(root, 0);
    return { nodes, roots };
  }

  function visibleNodes(tree) {
    const rows = [];
    const visit = (node) => {
      rows.push(node);
      if (model.collapsed.has(String(node.span.span_id || ""))) return;
      for (const child of node.children) visit(child);
    };
    for (const root of tree.roots) visit(root);
    return rows;
  }

  // Single pass, no argument spreading: Math.min(...list) throws RangeError
  // once a trace approaches ~100k spans and allocates two temporary arrays.
  function spanExtent(spans) {
    let start = Infinity;
    let end = -Infinity;
    for (const s of spans) {
      const spanStart = Number(s.start_ns || 0);
      const spanEnd = spanStart + Number(s.duration_ns || 0);
      if (Number.isFinite(spanStart) && spanStart < start) start = spanStart;
      if (spanEnd > end) end = spanEnd;
    }
    return { start, end };
  }

  function traceBounds(spans) {
    const { start, end } = spanExtent(spans);
    if (!Number.isFinite(start)) return { start: 0, end: 1, duration: 1 };
    return { start, end, duration: Math.max(1, end - start) };
  }

  // Everything derived from the loaded trace alone (tree, bounds, per-service
  // stats, start-ordered spans, parsed event markers, search text) is computed
  // once per trace. The waterfall re-renders on every toggle, service filter,
  // range change and search keystroke; rebuilding the tree and re-parsing each
  // span's events JSON on every render dominated those interactions.
  let traceCache = null;

  function activeTraceCache() {
    const trace = model.activeTrace;
    if (traceCache && traceCache.trace === trace) return traceCache;
    const spans = trace?.spans || [];
    const tree = buildTree(spans);
    const nodeById = new Map();
    const duplicateIds = new Set();
    const parentOf = new Map();
    for (const node of tree.nodes) {
      const id = String(node.span.span_id || "");
      if (nodeById.has(id)) duplicateIds.add(id);
      else nodeById.set(id, node);
      for (const child of node.children) parentOf.set(child, node);
    }
    traceCache = {
      trace,
      spans,
      tree,
      nodeById,
      duplicateIds,
      parentOf,
      extent: spanExtent(spans),
      bounds: traceBounds(spans),
      byStart: null,
      serviceStats: null,
      overviewBars: new Map(),
      events: new Map(),
      searchText: new Map(),
    };
    return traceCache;
  }

  function spanSearchText(cache, span) {
    let text = cache.searchText.get(span);
    if (text == null) {
      text = `${span.service_name || ""} ${span.span_name || ""} ${span.span_id || ""}`.toLowerCase();
      cache.searchText.set(span, text);
    }
    return text;
  }

  // Event markers only need each event's time and label; parse the JSON arrays once.
  function spanEventMarkers(cache, span) {
    let markers = cache.events.get(span);
    if (!markers) {
      const eventTimes = parseStructuredValue(span.events_timestamp);
      const eventNames = parseStructuredValue(span.events_name);
      const events = Array.isArray(eventTimes) ? eventTimes : [];
      markers = events.map((value, index) => ({
        ns: timestampToNs(value),
        name: Array.isArray(eventNames) && eventNames[index] != null ? String(eventNames[index]) : `Event ${index + 1}`,
      }));
      cache.events.set(span, markers);
    }
    return markers;
  }

  function renderTraceOverview(spans, bounds) {
    if (!dom.traceOverview) return;
    if (!spans.length) { dom.traceOverview.innerHTML = ""; return; }
    const range = Array.isArray(model.traceViewRange) ? model.traceViewRange : [0, 1];
    const lo = Math.max(0, Math.min(1, Number(range[0] || 0)));
    const hi = Math.max(lo + 0.005, Math.min(1, Number(range[1] == null ? 1 : range[1])));
    const ticks = durationTicks(bounds.duration, 5).map((tick) => `<span style="left:${tick.ratio * 100}%">${esc(tick.label)}</span>`).join("");
    const cache = activeTraceCache();
    const cached = cache.spans === spans && cache.bounds === bounds;
    // A stable sort once per trace, then filter: same order as filtering first.
    const byStart = cached
      ? (cache.byStart ||= spans.slice().sort((a, b) => Number(a.start_ns || 0) - Number(b.start_ns || 0)))
      : spans.slice().sort((a, b) => Number(a.start_ns || 0) - Number(b.start_ns || 0));
    const ordered = byStart.filter((span) => serviceEnabled(span.service_name));
    // Only the lane depends on the enabled-service set; the rest of each bar is
    // fixed for the trace, so build it once.
    const barParts = (span) => {
      let parts = cached ? cache.overviewBars.get(span) : null;
      if (!parts) {
        const left = Math.max(0, Math.min(100, ((Number(span.start_ns || 0) - bounds.start) / bounds.duration) * 100));
        const width = Math.max(.08, Math.min(100 - left, (Number(span.duration_ns || 0) / bounds.duration) * 100));
        const isError = String(span.status_code || "").toLowerCase() === "error";
        parts = [
          `<i class="${isError ? "is-error" : ""}" title="${esc(`${span.service_name || "unknown"}: ${span.span_name || "span"} · ${formatDuration(span.duration_ns)}${isError ? " · ERROR" : ""}`)}" style="left:${left.toFixed(4)}%;width:${width.toFixed(4)}%;top:`,
          `px;--trace-service-color:${serviceColor(span.service_name)}"></i>`,
        ];
        if (cached) cache.overviewBars.set(span, parts);
      }
      return parts;
    };
    const bars = ordered.map((span, index) => {
      const lane = index % 9;
      const parts = barParts(span);
      return `${parts[0]}${6 + lane * 4}${parts[1]}`;
    }).join("");
    dom.traceOverview.innerHTML = `<div class="traceOverview__ticks">${ticks}</div><div class="traceOverview__graph" data-trace-overview-graph>${bars}<div class="traceOverview__selection" data-trace-overview-selection style="left:${(lo * 100).toFixed(3)}%;width:${((hi-lo)*100).toFixed(3)}%"><button type="button" class="traceOverview__handle traceOverview__handle--start" data-overview-handle="start" aria-label="Resize trace range start"></button><button type="button" class="traceOverview__handle traceOverview__handle--end" data-overview-handle="end" aria-label="Resize trace range end"></button></div></div>`;

    const graph = dom.traceOverview.querySelector("[data-trace-overview-graph]");
    const selection = dom.traceOverview.querySelector("[data-trace-overview-selection]");
    if (!graph || !selection) return;
    const updateSelection = (next) => {
      const a = Math.max(0, Math.min(.995, Number(next[0] || 0)));
      const b = Math.max(a + .005, Math.min(1, Number(next[1] == null ? 1 : next[1])));
      selection.style.left = `${(a*100).toFixed(3)}%`;
      selection.style.width = `${((b-a)*100).toFixed(3)}%`;
      return [a, b];
    };
    // A range change only moves the selection box; the bars are unchanged, so
    // update the box in place instead of rebuilding one element per span.
    graph.addEventListener("dblclick", (event) => {
      event.preventDefault();
      model.traceViewRange = updateSelection([0, 1]);
      renderWaterfall();
    });
    graph.addEventListener("pointerdown", (event) => {
      if (event.button != null && event.button !== 0) return;
      const rect = graph.getBoundingClientRect();
      if (!rect.width) return;
      const pos = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      const handle = event.target.closest?.("[data-overview-handle]")?.dataset?.overviewHandle || "range";
      const initial = [...model.traceViewRange];
      let next = initial;
      let moved = false;
      graph.setPointerCapture?.(event.pointerId);
      const apply = (clientX) => {
        const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        moved = true;
        if (handle === "start") next = updateSelection([Math.min(x, initial[1] - .005), initial[1]]);
        else if (handle === "end") next = updateSelection([initial[0], Math.max(x, initial[0] + .005)]);
        else next = updateSelection([Math.min(pos, x), Math.max(pos + .005, x)]);
      };
      const move = (moveEvent) => { if (graph.hasPointerCapture?.(event.pointerId)) apply(moveEvent.clientX); };
      const up = (upEvent) => {
        graph.removeEventListener("pointermove", move);
        graph.removeEventListener("pointerup", up);
        graph.removeEventListener("pointercancel", up);
        graph.releasePointerCapture?.(event.pointerId);
        if (!moved && handle === "range") {
          const half = Math.max(.025, (initial[1] - initial[0]) / 4);
          next = updateSelection([Math.max(0, pos-half), Math.min(1, pos+half)]);
        }
        model.traceViewRange = next;
        renderWaterfall();
      };
      graph.addEventListener("pointermove", move);
      graph.addEventListener("pointerup", up);
      graph.addEventListener("pointercancel", up);
      event.preventDefault();
    });
  }

  function renderTraceServiceFilters(spans) {
    if (!dom.traceServiceFilters) return;
    const cache = activeTraceCache();
    let stats = cache.spans === spans ? cache.serviceStats : null;
    if (!stats) {
      stats = new Map();
      for (const span of spans || []) {
        const service = String(span.service_name || "unknown");
        const row = stats.get(service) || { spans: 0, errors: 0 };
        row.spans += 1;
        if (String(span.status_code || "").toLowerCase() === "error") row.errors += 1;
        stats.set(service, row);
      }
      if (cache.spans === spans) cache.serviceStats = stats;
    }
    const services = [...stats.keys()].sort((a, b) => a.localeCompare(b));
    const allSelected = services.every((service) => !model.disabledServices.has(service));
    const toggleLabel = allSelected ? "Deselect all" : "Select all";
    dom.traceServiceFilters.innerHTML = `<button type="button" class="traceServiceFilterReset" data-trace-toggle-all title="${toggleLabel} services">${toggleLabel}</button>` + services.map((service) => {
      const row = stats.get(service);
      const disabled = model.disabledServices.has(service);
      return `<button type="button" class="traceServiceStat traceServiceFilter${disabled ? " is-disabled" : ""}${row.errors ? " has-errors" : ""}" data-trace-service-filter="${esc(service)}" aria-pressed="${disabled ? "false" : "true"}" title="${esc(`${service} · ${row.spans} spans${row.errors ? ` · ${row.errors} errors` : ""}`)}"><i style="--trace-service-color:${serviceColor(service)}"></i><b>${esc(service)}</b><span>${row.spans}</span>${row.errors ? `<em title="${row.errors} error${row.errors === 1 ? "" : "s"}">${row.errors}</em>` : ""}</button>`;
    }).join("");
    dom.traceServiceFilters.querySelector("[data-trace-toggle-all]")?.addEventListener("click", () => {
      model.disabledServices = allSelected ? new Set(services) : new Set();
      renderTraceServiceFilters(spans);
      renderTraceOverview(spans, activeTraceCache().bounds);
      renderWaterfall();
    });
    for (const button of dom.traceServiceFilters.querySelectorAll("[data-trace-service-filter]")) {
      button.addEventListener("click", () => {
        const service = String(button.getAttribute("data-trace-service-filter") || "");
        if (model.disabledServices.has(service)) model.disabledServices.delete(service);
        else model.disabledServices.add(service);
        renderTraceServiceFilters(spans);
        renderTraceOverview(spans, activeTraceCache().bounds);
        renderWaterfall();
      });
    }
  }

  function renderTraceHeader() {
    const trace = model.activeTrace;
    const spans = trace?.spans || [];
    if (dom.traceCopyJsonButton) dom.traceCopyJsonButton.disabled = !spans.length;
    if (dom.traceCopyMenuButton) dom.traceCopyMenuButton.disabled = !spans.length;
    if (!spans.length) closeTraceCopyMenu({ immediate: true });
    if (!spans.length) {
      if (dom.traceDetailTitle) dom.traceDetailTitle.innerHTML = '<strong>Trace</strong><span>Select a trace to inspect its spans.</span>';
      if (dom.traceDetailStats) dom.traceDetailStats.innerHTML = "";
      if (dom.traceServiceFilters) dom.traceServiceFilters.innerHTML = "";
      if (dom.traceOverview) dom.traceOverview.innerHTML = "";
      return;
    }
    const bounds = activeTraceCache().bounds;
    const root = spans.find((s) => !s.parent_span_id) || spans.slice().sort((a, b) => Number(a.start_ns || 0) - Number(b.start_ns || 0))[0];
    if (dom.traceDetailTitle) {
      dom.traceDetailTitle.innerHTML = `<strong><span>${esc(root?.service_name || "trace")}:</span> ${esc(root?.span_name || "trace")}</strong><span class="tracePageHeader__traceId"><code title="${esc(trace.trace_id)}">${esc(shortId(trace.trace_id, 10))}</code><button type="button" class="traceCopyButton traceCopyButton--header" data-copy-active-trace="${esc(trace.trace_id)}" aria-label="Copy Trace ID" title="Copy full Trace ID"><span class="editorCopyButton__icon" aria-hidden="true"></span></button></span>`;
      dom.traceDetailTitle.querySelector("[data-copy-active-trace]")?.addEventListener("click", (event) => {
        event.stopPropagation();
        copyText(trace.trace_id, event.currentTarget);
      });
    }
    if (dom.traceDetailStats) {
      const items = [
        ["Trace Start", formatStart(Number(bounds.start) / 1e6)],
        ["Duration", formatDuration(bounds.duration)],
      ];
      dom.traceDetailStats.innerHTML = items.map(([label, value, cls]) => `<div class="tracePageOverviewItem${cls ? ` ${cls}` : ""}"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join('<i class="tracePageOverviewDivider" aria-hidden="true"></i>');
    }
    renderTraceServiceFilters(spans);
    renderTraceOverview(spans, bounds);
  }

  function spanRowClass(active, searchMatch, error) {
    return `traceSpanRow${active ? " is-active" : ""}${searchMatch ? " is-search-match" : ""}${error ? " is-error" : ""}`;
  }

  function spanRowGuides(depth) {
    return Array.from({ length: depth }, (_, index) => `<i style="left:${18 + index * 12}px"></i>`).join("");
  }

  function spanInspectorRowHtml(node, cache) {
    const span = node.span;
    const depth = Math.min(node.depth, 20);
    const serviceLineX = 27 + depth * 12;
    return `<div class="traceSpanInspectorRow" style="--trace-service-color:${serviceColor(span.service_name)};--trace-depth-x:${serviceLineX}px"><div class="traceSpanInspectorRow__spacer"><span class="traceSpanRow__guides" aria-hidden="true">${spanRowGuides(depth)}</span></div><div class="traceSpanInspectorRow__panel">${renderSpanInspectorCard(span, cache.spans, cache.bounds)}</div></div>`;
  }

  // View window and search shared by the full render and in-place row updates.
  function waterfallContext(cache) {
    const { start: fullStart, end: fullEnd } = cache.extent;
    const fullTotal = Math.max(1, fullEnd - fullStart);
    const viewRange = Array.isArray(model.traceViewRange) ? model.traceViewRange : [0, 1];
    const viewLo = Math.max(0, Math.min(1, Number(viewRange[0] || 0)));
    const viewHi = Math.max(viewLo + .005, Math.min(1, Number(viewRange[1] == null ? 1 : viewRange[1])));
    const start = fullStart + fullTotal * viewLo;
    const end = fullStart + fullTotal * viewHi;
    return { cache, start, end, total: Math.max(1, end - start), search: String(dom.traceSpanSearch?.value || "").trim().toLowerCase() };
  }

  function waterfallRowShown(node, ctx) {
    const { start, end } = ctx;
    const spanStart = Number(node.span.start_ns || 0);
    const spanEnd = spanStart + Number(node.span.duration_ns || 0);
    return serviceEnabled(node.span.service_name) && spanEnd > start && spanStart < end;
  }

  function renderWaterfall() {
    if (!dom.traceWaterfall) return;
    const cache = activeTraceCache();
    const spans = cache.spans;
    if (!spans.length) { dom.traceWaterfall.innerHTML = '<div class="tracesEmpty">No spans.</div>'; return; }
    const ctx = waterfallContext(cache);
    const { total, search } = ctx;
    const rows = visibleNodes(cache.tree).filter((node) => waterfallRowShown(node, ctx));
    const matching = search ? rows.filter((node) => spanSearchText(cache, node.span).includes(search)) : [];
    if (dom.traceSpanSearchCount) dom.traceSpanSearchCount.textContent = search ? `${matching.length} match${matching.length === 1 ? "" : "es"}` : "";
    dom.traceWaterfall.style.setProperty("--trace-label-width", `${model.waterfallLabelPct}%`);
    const tickLabels = durationTicks(total, 5).map((tick) => `<span style="left:${tick.ratio * 100}%"><i></i><b>${esc(tick.label)}</b></span>`).join("");
    const head = `<div class="traceWaterfallHead"><div class="traceWaterfallHead__operation"><span>Service &amp; Operation</span><span class="traceWaterfallHead__controls"><button type="button" data-trace-collapse-all title="Collapse all">‹‹</button><button type="button" data-trace-expand-all title="Expand all">››</button></span></div><div class="traceWaterfallHead__timeline">${tickLabels}</div><div class="traceWaterfallResizer" data-trace-waterfall-resizer role="separator" aria-orientation="vertical" aria-label="Resize Service & Operation column" tabindex="0"></div></div>`;
    const body = rows.map((node) => waterfallRowHtml(node, ctx)).join("");
    dom.traceWaterfall.innerHTML = `${head}<div class="traceWaterfallBody">${body}</div>`;
  }

  function waterfallRowHtml(node, ctx) {
    const { cache, start, end, total, search } = ctx;
    const span = node.span;
    const id = String(span.span_id || "");
    const spanStart = Number(span.start_ns || 0);
    const spanEnd = spanStart + Number(span.duration_ns || 0);
    const clippedStart = Math.max(start, spanStart);
    const clippedEnd = Math.min(end, spanEnd);
    const inView = clippedEnd > clippedStart;
    const left = inView ? Math.max(0, Math.min(100, ((clippedStart - start) / total) * 100)) : 0;
    const width = inView ? Math.max(0.24, Math.min(100 - left, ((clippedEnd - clippedStart) / total) * 100)) : 0;
    const error = String(span.status_code || "").toLowerCase() === "error";
    const active = model.openSpanIds.has(id);
    const searchMatch = !!search && spanSearchText(cache, span).includes(search);
    const color = serviceColor(span.service_name);
    const toggle = node.children.length ? `<button type="button" class="traceSpanRow__toggle" data-toggle-span="${esc(id)}" aria-label="${model.collapsed.has(id) ? "Expand" : "Collapse"} children">${model.collapsed.has(id) ? "›" : "⌄"}</button>` : '<span class="traceSpanRow__toggle traceSpanRow__toggle--blank"></span>';
    const labelLeft = left + (width / 2) >= 62;
    const depth = Math.min(node.depth, 20);
    const guides = spanRowGuides(depth);
    const spanRef = `${span.service_name || "unknown"}::${span.span_name || "span"}`;
    const durationText = formatDuration(span.duration_ns);
    const barLabel = labelLeft
      ? `<span class="traceSpanBar__label"><i class="traceSpanBar__ref">${esc(spanRef)}</i><span class="traceSpanBar__sep">|</span><b>${esc(durationText)}</b></span>`
      : `<span class="traceSpanBar__label"><b>${esc(durationText)}</b><span class="traceSpanBar__sep">|</span><i class="traceSpanBar__ref">${esc(spanRef)}</i></span>`;
    const eventMarkers = spanEventMarkers(cache, span).map((event) => {
      const eventNs = event.ns;
      if (!Number.isFinite(eventNs) || eventNs < clippedStart || eventNs > clippedEnd) return "";
      const eventLeft = Math.max(0, Math.min(100, ((eventNs - start) / total) * 100));
      return `<i class="traceSpanEventMarker" style="left:${eventLeft.toFixed(4)}%" title="${esc(event.name)}"></i>`;
    }).join("");
    const bar = inView ? `<i class="traceSpanBar${error ? " traceSpanBar--error" : ""}${labelLeft ? " traceSpanBar--labelLeft" : ""}" style="left:${left.toFixed(4)}%;width:${width.toFixed(4)}%;--trace-service-color:${color}">${barLabel}</i>` : "";
    const rowHtml = `<div class="${spanRowClass(active, searchMatch, error)}" data-span-id="${esc(id)}" role="button" tabindex="0">
        <div class="traceSpanRow__label" style="--trace-service-color:${color}"><span class="traceSpanRow__guides" aria-hidden="true">${guides}</span><div class="traceSpanRow__labelContent" style="padding-left:${8 + depth * 12}px">${toggle}<span class="traceSpanRow__serviceDot"></span><span class="traceSpanRow__service">${esc(span.service_name || "unknown")}</span><span class="traceSpanRow__name">${esc(span.span_name || "span")}</span>${error ? '<span class="traceSpanRow__errorBadge" title="Span status: Error">!</span>' : ""}</div></div>
        <div class="traceSpanRow__timeline">${bar}${eventMarkers}</div>
      </div>`;
    return active ? rowHtml + spanInspectorRowHtml(node, cache) : rowHtml;
  }

  // Folding or unfolding one branch only removes or inserts that branch's
  // descendant rows (contiguous after it in tree order); the rest of the
  // waterfall is unchanged, so patch the DOM instead of re-rendering it.
  function toggleSpanCollapse(toggle) {
    const id = String(toggle.getAttribute("data-toggle-span") || "");
    const collapsing = !model.collapsed.has(id);
    if (collapsing) model.collapsed.add(id); else model.collapsed.delete(id);
    const cache = activeTraceCache();
    const node = cache.nodeById.get(id);
    const row = toggle.closest("[data-span-id]");
    const ctx = waterfallContext(cache);
    // A span search also maintains a match count over the visible rows.
    if (!node || cache.duplicateIds.size || ctx.search || !row?.isConnected) { renderWaterfall(); return; }
    toggle.setAttribute("aria-label", `${collapsing ? "Expand" : "Collapse"} children`);
    toggle.textContent = collapsing ? "›" : "⌄";
    const own = row.nextElementSibling?.classList.contains("traceSpanInspectorRow") ? row.nextElementSibling : row;
    if (collapsing) {
      const isDescendant = (candidate) => {
        for (let parent = cache.parentOf.get(candidate); parent; parent = cache.parentOf.get(parent)) {
          if (parent === node) return true;
        }
        return false;
      };
      let el = own.nextElementSibling;
      while (el) {
        if (!el.classList.contains("traceSpanInspectorRow")) {
          const other = cache.nodeById.get(String(el.getAttribute("data-span-id") || ""));
          if (!other || !isDescendant(other)) break;
        }
        const next = el.nextElementSibling;
        el.remove();
        el = next;
      }
      return;
    }
    const html = [];
    const visit = (parent) => {
      for (const child of parent.children) {
        if (waterfallRowShown(child, ctx)) html.push(waterfallRowHtml(child, ctx));
        if (!model.collapsed.has(String(child.span.span_id || ""))) visit(child);
      }
    };
    visit(node);
    if (html.length) own.insertAdjacentHTML("afterend", html.join(""));
  }

  // Opening or closing one span's inspector only changes that row: patch it in
  // place instead of re-rendering (and re-parsing) every row of the trace.
  function toggleSpanInspector(row) {
    const id = String(row.getAttribute("data-span-id") || "");
    model.activeSpanId = id;
    const opening = !model.openSpanIds.has(id);
    if (opening) model.openSpanIds.add(id); else model.openSpanIds.delete(id);
    const cache = activeTraceCache();
    const node = cache.nodeById.get(id);
    if (!node || cache.duplicateIds.has(id) || !row.isConnected) { renderWaterfall(); return; }
    const span = node.span;
    const search = String(dom.traceSpanSearch?.value || "").trim().toLowerCase();
    const error = String(span.status_code || "").toLowerCase() === "error";
    row.className = spanRowClass(opening, !!search && spanSearchText(cache, span).includes(search), error);
    const next = row.nextElementSibling;
    if (next?.classList.contains("traceSpanInspectorRow")) next.remove();
    if (opening) row.insertAdjacentHTML("afterend", spanInspectorRowHtml(node, cache));
  }

  function setWaterfallLabelWidth(pct) {
    model.waterfallLabelPct = Math.max(18, Math.min(60, pct));
    dom.traceWaterfall.style.setProperty("--trace-label-width", `${model.waterfallLabelPct}%`);
  }

  // The waterfall body is rebuilt on every render, so its controls are handled
  // by delegation on the persistent container instead of re-binding listeners
  // to every row, toggle and link after each render.
  function initWaterfallEvents() {
    const root = dom.traceWaterfall;
    if (!root) return;
    root.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      if (target.closest("[data-trace-collapse-all]")) {
        model.collapsed = new Set(activeTraceCache().tree.nodes.filter((node) => node.children.length).map((node) => String(node.span.span_id || "")));
        renderWaterfall();
        return;
      }
      if (target.closest("[data-trace-expand-all]")) { model.collapsed.clear(); renderWaterfall(); return; }
      const toggle = target.closest("[data-toggle-span]");
      if (toggle) {
        event.stopPropagation();
        toggleSpanCollapse(toggle);
        return;
      }
      const link = target.closest("[data-linked-trace]");
      if (link) {
        event.preventDefault();
        event.stopPropagation();
        const traceId = String(link.getAttribute("data-linked-trace") || "");
        if (traceId) loadTrace(traceId, { push: true });
        return;
      }
      const row = target.closest("[data-span-id]");
      if (row && root.contains(row)) toggleSpanInspector(row);
    });
    root.addEventListener("keydown", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      if (target.closest("[data-trace-waterfall-resizer]")) {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        setWaterfallLabelWidth(model.waterfallLabelPct + (event.key === "ArrowRight" ? 2 : -2));
        return;
      }
      const row = target.closest("[data-span-id]");
      if (row && root.contains(row) && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        toggleSpanInspector(row);
      }
    });
    const setWidthFromClient = (clientX) => {
      const rect = root.getBoundingClientRect();
      if (!rect.width) return;
      setWaterfallLabelWidth(((clientX - rect.left) / rect.width) * 100);
    };
    root.addEventListener("pointerdown", (event) => {
      const resizer = event.target instanceof Element ? event.target.closest("[data-trace-waterfall-resizer]") : null;
      if (!resizer) return;
      event.preventDefault();
      resizer.setPointerCapture?.(event.pointerId);
      resizer.classList.add("is-dragging");
      setWidthFromClient(event.clientX);
    });
    root.addEventListener("pointermove", (event) => {
      const resizer = event.target instanceof Element ? event.target.closest("[data-trace-waterfall-resizer]") : null;
      if (!resizer?.hasPointerCapture?.(event.pointerId)) return;
      setWidthFromClient(event.clientX);
    });
    const stopResize = (event) => {
      const resizer = event.target instanceof Element ? event.target.closest("[data-trace-waterfall-resizer]") : null;
      if (!resizer) return;
      if (resizer.hasPointerCapture?.(event.pointerId)) resizer.releasePointerCapture?.(event.pointerId);
      resizer.classList.remove("is-dragging");
    };
    root.addEventListener("pointerup", stopResize);
    root.addEventListener("pointercancel", stopResize);
  }

  function parseStructuredValue(raw) {
    if (raw == null) return null;
    if (typeof raw !== "string") return raw;
    const text = raw.trim();
    if (!text) return null;
    try { return JSON.parse(text); } catch (_) {}
    return null;
  }

  // "Copy trace JSON" document: what /api/traces/trace returned for the open
  // trace, spans ordered by start time (then span id), 2-space indented:
  //   { trace_id, truncated, span_count, spans: [{ trace_id, span_id,
  //     parent_span_id, service_name, span_name, span_kind, timestamp,
  //     start_ns, duration_ns, status_code, status_message,
  //     span_attributes?, resource_attributes?,
  //     events?: [{ timestamp, name, attributes }],
  //     links?: [{ trace_id, span_id, attributes }] }] }
  // The endpoint ships attributes, events and links as JSON-encoded columns;
  // they are decoded here, events and links zipped into one object each. Keys
  // marked ? exist only when the endpoint returns them (per-feature columns).
  // start_ns keeps the endpoint's exact integer (see traceJsonExactStartNs).
  const TRACE_JSON_SPAN_KEYS = ["trace_id", "span_id", "parent_span_id", "service_name", "span_name", "span_kind",
    "timestamp", "start_ns", "duration_ns", "status_code", "status_message"];
  const TRACE_JSON_EXACT_NS = "\u0000exact-ns:";

  // start_ns is an epoch in nanoseconds, past 2^53: the parsed JSON number
  // lost its last digits. The span's `timestamp` string ends with the exact
  // nanoseconds of its second, which restore the integer the endpoint sent.
  function traceJsonExactStartNs(span) {
    const rounded = Number(span.start_ns);
    const fraction = /\.(\d{9})$/.exec(String(span.timestamp || ""));
    if (!Number.isFinite(rounded) || Number.isSafeInteger(rounded) || !fraction) return null;
    const fractionNs = Number(fraction[1]);
    const exact = BigInt(Math.round((rounded - fractionNs) / 1e9)) * 1000000000n + BigInt(fractionNs);
    return Math.abs(Number(exact) - rounded) < 1e6 ? exact.toString() : null;
  }

  function traceJsonColumns(columns) {
    const lists = Object.entries(columns).map(([key, raw]) => {
      const value = parseStructuredValue(raw);
      return [key, Array.isArray(value) ? value : []];
    });
    const count = Math.max(0, ...lists.map(([, list]) => list.length));
    return Array.from({ length: count }, (_, index) => Object.fromEntries(lists.map(([key, list]) => [key, list[index] ?? null])));
  }

  function traceJsonSpan(span) {
    const out = {};
    for (const key of TRACE_JSON_SPAN_KEYS) if (key in span) out[key] = span[key];
    const exactStart = "start_ns" in span ? traceJsonExactStartNs(span) : null;
    if (exactStart) out.start_ns = TRACE_JSON_EXACT_NS + exactStart;
    for (const key of ["span_attributes", "resource_attributes"]) {
      if (!(key in span)) continue;
      const value = parseStructuredValue(span[key]);
      out[key] = value == null ? span[key] : value;
    }
    if ("events_name" in span) {
      out.events = traceJsonColumns({ timestamp: span.events_timestamp, name: span.events_name, attributes: span.events_attributes });
    }
    if ("links_trace_id" in span) {
      out.links = traceJsonColumns({ trace_id: span.links_trace_id, span_id: span.links_span_id, attributes: span.links_attributes });
    }
    return out;
  }

  function traceJsonText(trace) {
    const text = (value) => String(value == null ? "" : value);
    const spans = (trace?.spans || []).slice().sort((a, b) => (Number(a.start_ns || 0) - Number(b.start_ns || 0))
      || text(a.timestamp).localeCompare(text(b.timestamp)) || text(a.span_id).localeCompare(text(b.span_id)));
    return JSON.stringify({
      trace_id: trace?.trace_id || "",
      truncated: trace?.truncated === true,
      span_count: spans.length,
      spans: spans.map(traceJsonSpan),
    }, null, 2).replace(/"start_ns": "\\u0000exact-ns:(\d+)"/g, '"start_ns": $1');
  }

  // Copy JSON / Download JSON, the same split control as a query's results.
  async function copyTraceJson() {
    const button = dom.traceCopyJsonButton;
    const trace = model.activeTrace;
    if (!button || !trace?.spans?.length) return;
    util.flashButtonText(button, { copiedText: "Copied" });
    try {
      await util.copyTextToClipboard(traceJsonText(trace));
    } catch {
      util.flashButtonText(button, { copiedText: "Copy failed", durationMs: 1500 });
    }
  }

  function downloadTraceJson() {
    const trace = model.activeTrace;
    if (!trace?.spans?.length) return;
    const blob = new Blob([traceJsonText(trace)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `trace-${String(trace.trace_id || "trace").replace(/[^0-9A-Za-z_-]/g, "")}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  let traceCopyMenuCleanup = null;
  function closeTraceCopyMenu({ immediate = false } = {}) {
    const split = dom.traceCopySplit;
    const menu = dom.traceCopyMenu;
    if (!split || !menu) return;
    dom.traceCopyMenuButton?.setAttribute("aria-expanded", "false");
    split.classList.remove("is-open");
    const finish = () => {
      if (split.classList.contains("is-open")) return;
      menu.hidden = true;
      if (traceCopyMenuCleanup) traceCopyMenuCleanup();
      traceCopyMenuCleanup = null;
    };
    if (immediate) finish();
    else setTimeout(finish, 160);
  }

  function openTraceCopyMenu() {
    const split = dom.traceCopySplit;
    const menu = dom.traceCopyMenu;
    if (!split || !menu || !menu.hidden) return;
    menu.hidden = false;
    dom.traceCopyMenuButton?.setAttribute("aria-expanded", "true");
    requestAnimationFrame(() => split.classList.add("is-open"));
    try { menu.focus({ preventScroll: true }); } catch { /* focus is best effort */ }
    const onDocClick = (ev) => { if (ev.target instanceof Node && !split.contains(ev.target)) closeTraceCopyMenu(); };
    const onKey = (ev) => { if (ev.key === "Escape") closeTraceCopyMenu({ immediate: true }); };
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKey);
    traceCopyMenuCleanup = () => {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }

  function attributeEntries(raw) {
    const value = parseStructuredValue(raw);
    if (!value || Array.isArray(value) || typeof value !== "object") return [];
    return Object.entries(value).sort(([a], [b]) => String(a).localeCompare(String(b)));
  }

  function renderJaegerAttributes(raw, emptyText = "No attributes") {
    const entries = attributeEntries(raw);
    if (!entries.length) {
      const fallback = String(raw || "").trim();
      return fallback && fallback !== "{}"
        ? `<pre class="traceJaegerRaw">${esc(fallback)}</pre>`
        : `<span class="traceJaegerEmpty">${esc(emptyText)}</span>`;
    }
    return `<div class="traceJaegerTags">${entries.map(([key, value]) => `<span class="traceJaegerTag"><b>${esc(key)}</b><i>=</i><code title="${esc(value)}">${esc(value)}</code></span>`).join('<i class="traceJaegerTagSep" aria-hidden="true"></i>')}</div>`;
  }

  function attributeValueText(value) {
    if (value == null) return "null";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    try { return JSON.stringify(value); } catch (_) { return String(value); }
  }

  function renderAttributePreview(raw, emptyText = "none") {
    const entries = attributeEntries(raw);
    if (!entries.length) return `<span class="traceJaegerSummaryPreview is-empty">${esc(emptyText)}</span>`;
    return `<span class="traceJaegerSummaryPreview">${entries.map(([key, value]) => `<span><b>${esc(key)}</b>=${esc(attributeValueText(value))}</span>`).join(" ")}</span>`;
  }

  function renderAttributeTable(raw, emptyText = "No attributes") {
    const entries = attributeEntries(raw);
    if (!entries.length) return `<span class="traceJaegerEmpty">${esc(emptyText)}</span>`;
    return `<div class="traceAttributeTable">${entries.map(([key, value]) => `<div class="traceAttributeTable__row"><span>${esc(key)}</span><code>${esc(attributeValueText(value))}</code></div>`).join("")}</div>`;
  }

  function renderJaegerEvents(span) {
    const timestamps = parseStructuredValue(span.events_timestamp);
    const names = parseStructuredValue(span.events_name);
    const attributes = parseStructuredValue(span.events_attributes);
    const ts = Array.isArray(timestamps) ? timestamps : [];
    const ns = Array.isArray(names) ? names : [];
    const attrs = Array.isArray(attributes) ? attributes : [];
    const count = Math.max(ts.length, ns.length, attrs.length);
    if (!count) return "";
    const rows = Array.from({ length: count }, (_, index) => {
      const name = ns[index] == null ? `Event ${index + 1}` : String(ns[index]);
      const time = ts[index] == null ? "" : String(ts[index]);
      const body = attrs[index] == null ? null : attrs[index];
      const bodyText = body && typeof body === "object" && !Array.isArray(body)
        ? `<div class="traceJaegerLogAttrs">${Object.entries(body).map(([key, value]) => `<div><b>${esc(key)}</b><code>${esc(value)}</code></div>`).join("")}</div>`
        : (body == null ? "" : `<pre class="traceJaegerRaw">${esc(typeof body === "string" ? body : JSON.stringify(body, null, 2))}</pre>`);
      return `<article class="traceJaegerLog"><header><strong>${esc(name)}</strong>${time ? `<time>${esc(time)}</time>` : ""}</header>${bodyText}</article>`;
    }).join("");
    return `<details class="traceJaegerGroup"><summary>Logs / Events <span>${count}</span></summary><div class="traceJaegerLogs">${rows}</div></details>`;
  }

  function renderJaegerLinks(span) {
    const traceIds = parseStructuredValue(span.links_trace_id);
    const spanIds = parseStructuredValue(span.links_span_id);
    const attrs = parseStructuredValue(span.links_attributes);
    const tids = Array.isArray(traceIds) ? traceIds : [];
    const sids = Array.isArray(spanIds) ? spanIds : [];
    const aa = Array.isArray(attrs) ? attrs : [];
    const count = Math.max(tids.length, sids.length, aa.length);
    if (!count) return "";
    const rows = Array.from({ length: count }, (_, index) => {
      const traceId = String(tids[index] || "");
      const traceCell = traceId ? `<a class="traceJaegerLink__trace" href="${esc(route(`traces/${encodeURIComponent(traceId)}`))}" data-linked-trace="${esc(traceId)}" title="Open linked trace">${esc(traceId)}</a>` : `<code></code>`;
      return `<div class="traceJaegerLink">${traceCell}<code>${esc(sids[index] || "")}</code>${aa[index] ? renderJaegerAttributes(JSON.stringify(aa[index]), "") : ""}</div>`;
    }).join("");
    return `<details class="traceJaegerGroup"><summary>Links <span>${count}</span></summary><div class="traceJaegerLinks">${rows}</div></details>`;
  }

  function renderSpanInspectorCard(span, spans, knownBounds = null) {
    const status = span.status_code || "Unset";
    const bounds = knownBounds || traceBounds(spans || []);
    const startOffset = Math.max(0, Number(span.start_ns || 0) - bounds.start);
    const statusClass = esc(String(status).toLowerCase());
    const statusBadge = String(status).toLowerCase() === "unset" ? "" : `<span class="traceStatus traceStatus--${statusClass}">${esc(status)}</span>`;
    const statusMessage = String(span.status_message || "").trim();
    const color = serviceColor(span.service_name);
    return `<section class="traceInspector traceInspector--jaeger traceInspector--inline" style="--trace-service-color:${color}">
      <div class="traceInspectorHead traceInspectorHead--jaeger">
        <strong title="${esc(span.span_name || "span")}">${esc(span.span_name || "span")}</strong>
        <div class="traceInspectorHead__meta"><span>Service: <b>${esc(span.service_name || "unknown")}</b></span><i></i><span>Duration: <b>${esc(formatDuration(span.duration_ns))}</b></span><i></i><span>Start Time: <b>${esc(formatDuration(startOffset))}</b></span>${statusBadge}</div>
      </div>
      ${statusMessage ? `<div class="traceInspectorStatusMessage"><b>Status message</b><span>${esc(statusMessage)}</span></div>` : ""}
      <details class="traceJaegerGroup traceJaegerGroup--summary"><summary><b>Tags:</b>${renderAttributePreview(span.span_attributes)}</summary><div class="traceJaegerGroup__body">${renderAttributeTable(span.span_attributes)}</div></details>
      <details class="traceJaegerGroup traceJaegerGroup--summary"><summary><b>Process:</b>${renderAttributePreview(span.resource_attributes)}</summary><div class="traceJaegerGroup__body">${renderAttributeTable(span.resource_attributes)}</div></details>
      ${renderJaegerEvents(span)}
      ${renderJaegerLinks(span)}
      <div class="traceInspectorIdentity"><span>SpanID: <code>${esc(span.span_id)}</code></span><span>Parent: <code>${esc(span.parent_span_id || "root")}</code></span><span>Kind: <code>${esc(span.span_kind || "—")}</code></span></div>
    </section>`;
  }

  function renderInspector() {
    if (!dom.traceInspector) return;
    dom.traceInspector.hidden = true;
    dom.traceInspector.innerHTML = "";
  }

  function renderTrace() {
    renderTraceHeader();
    renderWaterfall();
    renderInspector();
  }

  async function loadMeta() {
    try {
      const meta = await api.getTracesMeta(currentHost());
      model.meta = meta;
      if (meta && meta.schema_ok === false) showError(`Trace table ${meta.database}.${meta.table} is missing one or more required OpenTelemetry columns.`);
      else showError("");
      renderSource();
      syncFilterFeatures();
      return meta;
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error));
      renderSource();
      throw error;
    }
  }

  function currentTag() {
    const key = String(dom.tracesTagKey?.value || "").trim();
    const value = String(dom.tracesTagValue?.value || "");
    return { scope: key ? "any" : "", key, value };
  }

  function searchFilters({ includeTag = true } = {}) {
    const range = selectedRange();
    const services = resolvedServiceValues();
    const operations = resolvedOperationValues();
    if (services.length && operations.length && !serviceOperationPairExists(services[0], operations[0])) {
      throw new Error("Selected service / operation combination does not exist in this time range.");
    }
    const filters = {
      ...range,
      service: services,
      operation: operations,
      status: String(dom.tracesStatus?.value || ""),
      limit: String(dom.tracesLimit?.value || Math.min(50, Number(model.meta?.search_limit || 50))),
    };
    if (includeTag) {
      const tag = currentTag();
      const hasKey = !!tag.key;
      const hasValue = tag.value !== "";
      if (hasKey !== hasValue) throw new Error("Tag and value must both be provided.");
      if (hasKey && hasValue) Object.assign(filters, { tag_scope: "any", tag_key: tag.key, tag_value: tag.value });
    }
    return filters;
  }

  function invalidateDiscovery({ pairs = true } = {}) {
    if (pairs) {
      model.prefillPairs = [];
      replaceSelectOptions(dom.tracesService, [], "ALL");
      replaceSelectOptions(dom.tracesOperation, [], "ALL");
    }
  }

  async function prefill({ force = false } = {}) {
    if (!model.meta) await loadMeta().catch(() => null);
    if (!force && model.prefillPromise) return model.prefillPromise;
    const seq = ++model.prefillSeq;
    const run = (async () => {
      showError("");
      try {
        const range = selectedRange();
        const payload = await api.prefillTraces(currentHost(), range);
        if (seq !== model.prefillSeq) return;
        model.prefillPairs = Array.isArray(payload?.pairs) ? payload.pairs : [];
        updateServiceOptions();
        updateOperationOptions();
        if (payload?.truncated) showError("Service / operation prefill reached its 20,000-combination safety limit. Use a narrower service / operation filter if the desired value is outside the discovered combinations.");
      } catch (error) {
        if (seq === model.prefillSeq) showError(error instanceof Error ? error.message : String(error));
      }
    })();
    model.prefillPromise = run;
    try {
      await run;
    } finally {
      if (model.prefillPromise === run) model.prefillPromise = null;
    }
  }

  async function prefillForSelectedRange() {
    invalidateDiscovery();
    try { selectedRange(); } catch (_) { return; }
    await prefill({ force: true });
  }

  async function ensurePrefillForFilters() {
    if (!model.prefillPairs.length) await prefill();
  }

  function formatCustomRangeLabel() {
    return ns.timeRange ? ns.timeRange.describeRange(model.timeRange).text : "Last 1 hour";
  }

  // The hidden native select mirrors the applied range for assistive tech;
  // the picker writes the button label.
  function refreshCustomRangeLabel() {
    const option = dom.tracesRangeUnit?.options?.[0];
    if (option) option.textContent = formatCustomRangeLabel();
    timePicker?.refresh();
  }

  function closeCustomRangeEditor() {
    timePicker?.close();
  }

  // Applying a range (form, calendar, quick or recent range, shift / zoom)
  // reloads the service / operation choices, then searches that window.
  // Shift and zoom keep the panel open so they can be repeated.
  async function applyCustomRange(raw, source = "form") {
    model.timeRange = { from: String(raw?.from || ""), to: String(raw?.to || "") };
    model.timeRangeTouched = true;
    refreshCustomRangeLabel();
    if (source !== "shift" && source !== "zoom") closeCustomRangeEditor();
    try {
      await prefillForSelectedRange();
      await search();
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error));
    }
  }

  async function loadAnalytics(filters) {
    if (model.meta?.analytics_enabled !== true) {
      model.analytics = null;
      model.analyticsLoading = false;
      model.analyticsError = "";
      model.durationsError = "";
      renderAnalytics();
      return;
    }
    const seq = ++model.analyticsSeq;
    model.analytics = null;
    model.analyticsLoading = true;
    model.analyticsError = "";
    model.durationsError = "";
    renderAnalytics();
    // Buckets start at local midnight (3 h buckets at 00:00, 03:00… local).
    const analyticsFilters = { ...filters, bucket_origin_ms: String(localMidnight(Number(filters.start_ms))) };
    delete analyticsFilters.limit;
    const message = (error) => (error instanceof Error ? error.message : String(error));
    // Counts first: without filters the server reads them from the trace
    // index (well under a second for 7 days), while the duration percentiles
    // need the span aggregation, which takes seconds on multi-day windows.
    // With filters the first answer already carries both charts.
    let countsError = "";
    try {
      const counted = await api.getTraceAnalytics(currentHost(), { ...analyticsFilters, charts: "counts" });
      if (seq !== model.analyticsSeq) return;
      model.analytics = unpackAnalytics(counted);
      if (!model.analytics.has_durations) renderAnalytics();
    } catch (error) {
      if (seq !== model.analyticsSeq) return;
      // The durations answer below carries the counts too.
      countsError = message(error);
    }
    try {
      if (model.analytics?.has_durations) return;
      const full = await api.getTraceAnalytics(currentHost(), { ...analyticsFilters, charts: "durations" });
      if (seq !== model.analyticsSeq) return;
      // Span counts replace the index counts: both charts then describe
      // exactly the same traces.
      model.analytics = unpackAnalytics(full, model.analytics);
    } catch (error) {
      if (seq !== model.analyticsSeq) return;
      if (model.analytics) model.durationsError = message(error);
      else model.analyticsError = countsError || message(error);
    } finally {
      if (seq === model.analyticsSeq) {
        model.analyticsLoading = false;
        renderAnalytics();
      }
    }
  }

  async function search() {
    if (!model.meta) await loadMeta().catch(() => null);
    await ensurePrefillForFilters();
    const seq = ++model.searchSeq;
    ++model.analyticsSeq;
    const filters = searchFilters();
    if (/\/traces\/[^/]+\/?$/.test(String(window.location.pathname || ""))) window.history.pushState({ workspace: "traces" }, "", route("traces"));
    setView(false);
    setButtonLoading(dom.tracesSearchButton, true);
    showError("");
    // The charts load right after the list: say so instead of going blank.
    model.analytics = null;
    model.analyticsLoading = model.meta?.analytics_enabled === true;
    model.analyticsError = "";
    model.durationsError = "";
    renderAnalytics();
    try {
      const payload = await api.searchTraces(currentHost(), filters);
      if (seq !== model.searchSeq) return;
      unpackSearch(payload);
      renderResults();
      // Search results are intentionally delivered first. Heavy graph analytics
      // starts only after the trace list has rendered, on its own API route.
      void loadAnalytics(filters);
    } catch (error) {
      if (seq !== model.searchSeq) return;
      model.traces = [];
      model.analytics = null;
      model.analyticsLoading = false;
      renderResults();
      showError(error instanceof Error ? error.message : String(error));
    } finally {
      if (seq === model.searchSeq) setButtonLoading(dom.tracesSearchButton, false);
    }
  }

  async function loadTrace(traceId, { push = false } = {}) {
    const id = String(traceId || "").trim();
    if (!id) return;
    const seq = ++model.detailSeq;
    showError("");
    setView(true);
    if (dom.traceIdLookupInput) dom.traceIdLookupInput.value = id;
    if (dom.traceWaterfall) dom.traceWaterfall.innerHTML = '<div class="tracesEmpty">Loading trace…</div>';
    if (dom.traceInspector) { dom.traceInspector.hidden = true; dom.traceInspector.innerHTML = ""; }
    try {
      const trace = await api.getTrace(currentHost(), id);
      if (seq !== model.detailSeq) return;
      model.activeTrace = trace;
      model.activeSpanId = null;
      model.openSpanIds.clear();
      model.traceViewRange = [0, 1];
      model.disabledServices.clear();
      model.collapsed.clear();
      if (dom.traceSpanSearch) dom.traceSpanSearch.value = "";
      if (dom.traceSpanSearchCount) dom.traceSpanSearchCount.textContent = "";
      if (push) window.history.pushState({ traceId: id }, "", route(`traces/${encodeURIComponent(id)}`));
      renderTrace();
    } catch (error) {
      if (seq !== model.detailSeq) return;
      model.activeTrace = null;
      model.activeSpanId = null;
      model.openSpanIds.clear();
      model.traceViewRange = [0, 1];
      model.disabledServices.clear();
      model.collapsed.clear();
      renderTrace();
      showError(error instanceof Error ? error.message : String(error));
    }
  }

  function backToSearch({ push = true } = {}) {
    model.activeTrace = null;
    model.activeSpanId = null;
    model.openSpanIds.clear();
    model.traceViewRange = [0, 1];
    model.disabledServices.clear();
    model.collapsed.clear();
    if (push) window.history.pushState({ workspace: "traces" }, "", route("traces"));
    if (dom.traceIdLookupInput) dom.traceIdLookupInput.value = "";
    setView(false);
    if (!model.traces.length) search();
  }

  async function reloadForHost() {
    model.meta = null;
    model.traces = [];
    model.analytics = null;
    model.analyticsLoading = false;
    model.analyticsError = "";
    model.prefillPairs = [];
    model.prefillPromise = null;
    ++model.prefillSeq;
    ++model.analyticsSeq;
    model.activeTrace = null;
    model.activeSpanId = null;
    model.openSpanIds.clear();
    model.traceViewRange = [0, 1];
    model.disabledServices.clear();
    model.collapsed.clear();
    renderResults();
    renderSource();
    try {
      await loadMeta();
      const id = traceIdFromPath();
      if (id) await loadTrace(id, { push: false });
      else {
        await prefill();
        await search();
      }
    } catch (_) {}
  }

  function init() {
    ui?.setPageSelectorValue?.("traces");
    initTracePickers();
    initWaterfallEvents();
    dom.navQueryButton?.addEventListener("click", () => window.location.assign(route("query")));
    dom.navExplorerButton?.addEventListener("click", () => window.location.assign(route("explorer")));
    dom.navTracesButton?.addEventListener("click", () => ui?.closePageMenu?.());
    dom.tracesForm?.addEventListener("submit", (event) => { event.preventDefault(); search(); });
    dom.tracesSort?.addEventListener("change", renderResults);
    dom.tracesService?.addEventListener("change", () => { syncServiceOperationPair("service"); });
    dom.tracesOperation?.addEventListener("change", () => { syncServiceOperationPair("operation"); });
    dom.traceBackButton?.addEventListener("click", () => backToSearch({ push: true }));
    dom.traceCopyJsonButton?.addEventListener("click", () => { void copyTraceJson(); });
    dom.traceCopyMenuButton?.addEventListener("click", () => {
      if (dom.traceCopyMenu?.hidden) openTraceCopyMenu();
      else closeTraceCopyMenu();
    });
    dom.traceDownloadJsonButton?.addEventListener("click", () => {
      closeTraceCopyMenu({ immediate: true });
      downloadTraceJson();
    });
    dom.traceSpanSearch?.addEventListener("input", renderWaterfall);
    dom.traceSpanSearch?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      const first = dom.traceWaterfall?.querySelector?.(".traceSpanRow.is-search-match");
      first?.scrollIntoView?.({ block: "center" });
      first?.focus?.({ preventScroll: true });
    });
    dom.traceSpanSearchClear?.addEventListener("click", () => {
      if (dom.traceSpanSearch) dom.traceSpanSearch.value = "";
      renderWaterfall();
      dom.traceSpanSearch?.focus?.();
    });
    dom.traceIdLookupForm?.addEventListener("submit", (event) => {
      event.preventDefault();
      const id = String(dom.traceIdLookupInput?.value || "").trim();
      if (id) loadTrace(id, { push: true });
    });
    window.addEventListener("popstate", () => {
      const id = traceIdFromPath();
      if (id) loadTrace(id, { push: false });
      else backToSearch({ push: false });
    });
    window.addEventListener("chdash:host-changed", () => { reloadForHost(); });
    window.addEventListener("chdash:features-changed", (event) => {
      if (event?.detail?.traces?.enabled === false) return;
      if (!model.meta && currentHost()) reloadForHost();
    });
    const id = traceIdFromPath();
    if (id && dom.traceIdLookupInput) dom.traceIdLookupInput.value = id;
    setView(!!id);
    if (currentHost()) reloadForHost();
  }

  ns.traces = { init, search, loadTrace };
})();
