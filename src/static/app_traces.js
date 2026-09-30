(() => {
  "use strict";
  const ns = window.ChDash;
  if (!ns) return;
  const { dom, state, api, util, ui } = ns;

  // Service colours: Jaeger UI's span palette (its --span-color-1..20, the
  // IBM Carbon categorical sequence, light and dark variants) without its two
  // reds (6 and 16), since red marks errors. They are the
  // --trace-span-color-1..18 custom properties of style.css.
  const SPAN_COLOR_COUNT = 18;
  const SERVICE_COLOR_STORE_KEY = "chdash.traces.serviceColors";
  const TRACES_PAGE_TITLE = document.title;

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
    criticalPathShown: true,
    searchSeq: 0,
    analyticsSeq: 0,
    prefillSeq: 0,
    detailSeq: 0,
    timeRange: { from: "now-1h", to: "now" },
    timeRangeTouched: false,
    searched: false,
    searchLatencyMs: NaN,
    lastSearchRange: null,
    resultsView: "list",
    tableSort: null,
    startDisplay: "absolute",
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

  // Jaeger's ['auto', 'auto'] duration domain: the data range padded by 5 %
  // on each side (a flat series by 10 % of its value), snapped to whole
  // steps, so close percentiles do not flatten against a zero baseline. The
  // step is the finest one whose labels all differ.
  function durationAxis(minNsValue, maxNsValue, targetIntervals = 7) {
    let lo = Math.max(0, Number(minNsValue) || 0);
    let hi = Math.max(lo, Number(maxNsValue) || 0);
    if (!(hi > 0)) hi = 1;
    const pad = hi > lo ? (hi - lo) * 0.05 : Math.max(1, hi * 0.1);
    lo = Math.max(0, lo - pad);
    hi += pad;
    const last = DURATION_AXIS_STEPS_NS[DURATION_AXIS_STEPS_NS.length - 1];
    const first = DURATION_AXIS_STEPS_NS.findIndex((candidate) => (hi - lo) / candidate <= targetIntervals);
    for (let index = first < 0 ? DURATION_AXIS_STEPS_NS.length - 1 : first; index < DURATION_AXIS_STEPS_NS.length; index += 1) {
      const step = DURATION_AXIS_STEPS_NS[index];
      const axisMin = Math.floor(lo / step) * step;
      const axisMax = Math.max(axisMin + step, Math.ceil(hi / step) * step);
      const values = [];
      for (let i = 0; axisMin + i * step <= axisMax + step * 1e-6; i += 1) {
        const value = axisMin + i * step;
        values.push({ value, label: value ? formatDuration(value) : "0" });
      }
      const distinct = new Set(values.map((tick) => tick.label)).size === values.length;
      if (distinct || step === last) return { axisMin, axisMax, values };
    }
    return { axisMin: 0, axisMax: last, values: [{ value: 0, label: "0" }, { value: last, label: formatDuration(last) }] };
  }

  // Evenly spaced ticks over a window of `durationNs` that starts `offsetNs`
  // after the trace start (a zoomed waterfall): labels are offsets from the
  // trace start, like Jaeger's, never restarting at 0.
  function durationTicks(durationNs, count = 5, offsetNs = 0) {
    const duration = Math.max(1, Number(durationNs || 0));
    const offset = Math.max(0, Number(offsetNs || 0));
    const n = Math.max(2, Number(count || 5));
    const step = duration / (n - 1);
    return Array.from({ length: n }, (_, index) => {
      const ratio = index / (n - 1);
      const ns = offset + duration * ratio;
      return { ratio, ns, label: offset ? tickDurationLabel(ns, step) : formatDuration(ns) };
    });
  }

  // formatDuration, with the extra decimals a deep zoom needs so adjacent
  // ticks never read the same ("50.003 ms", "50.005 ms").
  function tickDurationLabel(ns, stepNs) {
    const text = formatDuration(ns);
    const match = /^(\d+(?:\.(\d+))?) (µs|ms|s)$/.exec(text);
    if (!match || !(stepNs > 0)) return text;
    const factor = match[3] === "s" ? 1e9 : match[3] === "ms" ? 1e6 : 1e3;
    // One decimal below the step's leading digit: a 0.25 ms step reads 74.75.
    const needed = Math.min(6, Math.max(0, Math.ceil(-Math.log10(stepNs / factor)) + 1));
    return needed > (match[2] || "").length ? `${(ns / factor).toFixed(needed)} ${match[3]}` : text;
  }

  // Wall-clock time `offsetNs` after the epoch-ns instant `startNs`,
  // browser-local: 10:59:59.312, with microseconds when the tick step is
  // below a millisecond. The offset is added to the start's sub-millisecond
  // remainder, not to the epoch value, which a double only holds to ~256 ns.
  function wallClockLabel(startNs, offsetNs = 0, stepNs = Infinity) {
    if (!Number.isFinite(startNs) || !Number.isFinite(offsetNs)) return "";
    const startMs = Math.floor(startNs / 1e6);
    // Whole nanoseconds: a view fraction like 0.49999999999999994 must not
    // read one millisecond early.
    const withinNs = Math.round(Math.max(0, startNs - startMs * 1e6) + offsetNs);
    const ms = startMs + Math.floor(withinNs / 1e6);
    const d = new Date(ms);
    const base = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
    if (!(stepNs < 1e6)) return base;
    const micros = Math.max(0, Math.min(999, Math.floor((withinNs % 1e6) / 1e3)));
    return `${base}${String(micros).padStart(3, "0")}`;
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
    // An open trace names the tab after itself (renderTraceHeader).
    if (!detail) document.title = TRACES_PAGE_TITLE;
  }

  // Like Jaeger's ColorGenerator: a service takes the next palette colour the
  // first time it is seen and keeps it. One assignment for the browser session
  // (sessionStorage), so the result list, its charts and every opened trace
  // agree; a search registers its services in name order first.
  const serviceColorSlots = (() => {
    const slots = new Map();
    try {
      const saved = JSON.parse(window.sessionStorage.getItem(SERVICE_COLOR_STORE_KEY) || "null");
      if (saved && typeof saved === "object" && !Array.isArray(saved)) {
        for (const [service, slot] of Object.entries(saved)) {
          if (Number.isInteger(slot) && slot >= 0 && slot < SPAN_COLOR_COUNT) slots.set(service, slot);
        }
      }
    } catch (_) { /* no session storage: the colours last for this page */ }
    return slots;
  })();

  function saveServiceColors() {
    try {
      window.sessionStorage.setItem(SERVICE_COLOR_STORE_KEY, JSON.stringify(Object.fromEntries(serviceColorSlots)));
    } catch (_) { /* best effort */ }
  }

  function serviceColorSlot(service, save = true) {
    const key = String(service || "unknown");
    let slot = serviceColorSlots.get(key);
    if (slot == null) {
      slot = serviceColorSlots.size % SPAN_COLOR_COUNT;
      serviceColorSlots.set(key, slot);
      if (save) saveServiceColors();
    }
    return slot;
  }

  function registerServiceColors(services) {
    const names = [...new Set((services || []).map((service) => String(service || "unknown")))]
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const before = serviceColorSlots.size;
    for (const name of names) serviceColorSlot(name, false);
    if (serviceColorSlots.size !== before) saveServiceColors();
  }

  // A var() reference, so the colour follows the light / dark theme.
  function serviceColor(service) {
    return `var(--trace-span-color-${serviceColorSlot(service) + 1})`;
  }

  // The resolved colour, for canvas drawing.
  function serviceColorValue(service) {
    const name = `--trace-span-color-${serviceColorSlot(service) + 1}`;
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#8d8d8d";
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

  function unpackSearch(payload) {
    const services = Array.isArray(payload?.services) ? payload.services : [];
    registerServiceColors(services);
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
      // Parent span ids no listed span carries (0 from older servers).
      missing_parents: Number(row?.[8] || 0),
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
  // pick(x, y) may return a nearer 2-D target (a scatter dot) that wins over
  // the x snap; onPick(point) runs when such a target is clicked.
  function attachChartTooltips(container, points, htmlFor, onHover = null, pick = null, onPick = null) {
    if (!container) return;
    const svg = container.querySelector("svg");
    const surface = container.querySelector(".traceChartHit");
    if (!svg || !surface || (!points.length && !pick)) return;
    let tooltip = container.querySelector(".traceChartTooltip");
    if (!tooltip) {
      tooltip = document.createElement("div");
      tooltip.className = "traceChartTooltip";
      tooltip.hidden = true;
      container.appendChild(tooltip);
    }
    const viewWidth = Number(svg.viewBox?.baseVal?.width || 0);
    const viewHeight = Number(svg.viewBox?.baseVal?.height || 0);
    // Pointer position in SVG units, or null before the chart is laid out.
    const svgPoint = (event) => {
      const box = svg.getBoundingClientRect();
      if (!box.width || !box.height) return null;
      return [(event.clientX - box.left) * ((viewWidth || box.width) / box.width), (event.clientY - box.top) * ((viewHeight || box.height) / box.height)];
    };
    const xs = points.map((point) => point.x);
    const nearest = (x) => {
      if (!xs.length) return null;
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
      const at = svgPoint(event);
      if (!at) return;
      const point = pick?.(at[0], at[1]) || nearest(at[0]);
      surface.classList.toggle("is-pickable", !!point?.pickable);
      if (!point) { hide(); return; }
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
    surface.addEventListener("pointerleave", () => { surface.classList.remove("is-pickable"); hide(); });
    if (pick && onPick) {
      surface.addEventListener("click", (event) => {
        const at = svgPoint(event);
        const target = at && pick(at[0], at[1]);
        if (target) onPick(target);
      });
    }
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
    // Jaeger's scatter plot: one dot per listed trace (x = start, y =
    // duration, radius by span count, red with errors), over the percentiles.
    const listed = (model.traces || []).filter((trace) => Number(trace.start_ms) > 0 && Number.isFinite(Number(trace.duration_ns)));
    let yMin = Infinity, yMax = 0;
    for (const q of qs) for (let i = 1; i <= 4; i += 1) { const v = Number(q[i]); if (Number.isFinite(v)) { yMin = Math.min(yMin, v); yMax = Math.max(yMax, v); } }
    for (const trace of listed) { const v = Number(trace.duration_ns); yMin = Math.min(yMin, v); yMax = Math.max(yMax, v); }
    if (!Number.isFinite(yMin)) yMin = 0;
    const durationScaleAxis = durationAxis(yMin, yMax, 7);
    const W = chartWidth(container), H = CHART_HEIGHT, top = 10, bottom = 30, right = 12;
    const left = Math.ceil(10 + Math.max(...durationScaleAxis.values.map((tick) => labelWidthPx(tick.label))));
    const plotW = W - left - right, plotH = H - top - bottom;
    const qBucketMs = Math.max(1000, Number(a.quantile_bucket_ms || a.bucket_ms || 60000));
    const xOf = (ms) => Math.min(left + plotW, Math.max(left, left + ((Number(ms) - xMin) / (xMax - xMin)) * plotW));
    const ySpan = Math.max(1, durationScaleAxis.axisMax - durationScaleAxis.axisMin);
    const yOf = (ns) => top + plotH - ((Number(ns || 0) - durationScaleAxis.axisMin) / ySpan) * plotH;
    const yTicks = durationScaleAxis.values.map((tick) => { const y = yOf(tick.value); return `<line x1="${left}" y1="${y.toFixed(1)}" x2="${W - right}" y2="${y.toFixed(1)}" class="traceChart__grid"/><text x="${left - 6}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" class="traceChart__tick">${esc(tick.label)}</text>`; }).join("");
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
    const spanCounts = listed.map((trace) => Number(trace.span_count || 0));
    const spanMin = Math.min(...spanCounts), spanMax = Math.max(...spanCounts);
    const dots = listed.map((trace) => {
      const spans = Number(trace.span_count || 0);
      const r = spanMax > spanMin ? 2.5 + 6.5 * ((spans - spanMin) / (spanMax - spanMin)) : 3.5;
      return { trace, x: xOf(trace.start_ms), y: yOf(trace.duration_ns), r, pickable: true };
    }).sort((p, q) => q.r - p.r);
    const dotsSvg = dots.map((dot, index) => {
      dot.key = index;
      const errors = Number(dot.trace.error_count || 0) > 0;
      return `<circle cx="${dot.x.toFixed(2)}" cy="${dot.y.toFixed(2)}" r="${dot.r.toFixed(2)}" class="traceScatterDot${errors ? " is-error" : ""}" data-trace-dot="${esc(dot.trace.trace_id)}" data-dot-key="${index}" data-spans="${Number(dot.trace.span_count || 0)}"/>`;
    }).join("");
    // The dot under the pointer (within 3 px of its edge); among overlapping
    // dots the closer and smaller one wins, so a small dot on a big one stays
    // reachable.
    const pickDot = (x, y) => {
      let best = null, bestScore = Infinity;
      for (const dot of dots) {
        const d = Math.hypot(dot.x - x, dot.y - y);
        if (d > dot.r + 3) continue;
        const score = d / (dot.r + 3) + dot.r / 100;
        if (score < bestScore) { best = dot; bestScore = score; }
      }
      return best;
    };
    container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="traceChart__svg" data-y-min="${durationScaleAxis.axisMin}" data-y-max="${durationScaleAxis.axisMax}">${yTicks}${xTicks}<g class="traceScatter">${dotsSvg}</g>${lines}${hoverPoints}<rect x="0" y="0" width="${W}" height="${H}" class="traceChartHit"/></svg><div class="traceChartLegend traceChartLegend--quantiles">${dots.length ? '<span class="traces" title="One dot per listed trace; size by span count, red with errors. Click a dot to open its trace.">Listed traces</span>' : ""}<span class="p50">P50</span><span class="p90">P90</span><span class="p95">P95</span><span class="p99">P99</span></div>`;
    const dotTooltip = (dot) => {
      const trace = dot.trace;
      const ms = parseStartMs(trace.start_ms);
      const errors = Number(trace.error_count || 0);
      const services = (trace.service_stats || []).length;
      return `<strong>${esc(traceName(trace))}</strong><span>Spans <b>${Number(trace.span_count || 0)}</b></span><span>Services <b>${services}</b></span>${errors ? `<span class="is-error">Errors <b>${errors}</b></span>` : ""}<span>Duration <b>${esc(formatDuration(trace.duration_ns))}</b></span><span>Start <b>${esc(Number.isFinite(ms) ? `${dayLabel(ms)}, ${clockLabel(ms, true)}` : "")}</b></span>`;
    };
    attachChartTooltips(container, hover, (point) => {
      if (point.trace) return dotTooltip(point);
      const [bucket, p50, p90, p95, p99] = point.q;
      return `<strong>${esc(bucketRangeLabel(bucket, qBucketMs))}</strong><span>P50 <b>${esc(formatDuration(p50))}</b></span><span>P90 <b>${esc(formatDuration(p90))}</b></span><span>P95 <b>${esc(formatDuration(p95))}</b></span><span>P99 <b>${esc(formatDuration(p99))}</b></span>`;
    }, (point, active) => {
      if (point.trace) container.querySelector(`[data-dot-key="${point.key}"]`)?.classList.toggle("is-hovered", active);
      else container.querySelector(`[data-q-hover="${point.key}"]`)?.classList.toggle("is-active", active);
    }, dots.length ? pickDot : null, (dot) => loadTrace(dot.trace.trace_id, { push: true }));
    if (dom.traceDurationChartMeta) dom.traceDurationChartMeta.textContent = `${dots.length ? `${dots.length} listed trace${dots.length === 1 ? "" : "s"} + ` : ""}P50 / P90 / P95 / P99 · ${formatDuration(qBucketMs * 1e6)} buckets`;
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

  // --- Search results: Jaeger-style list and sortable table ---------------
  const RESULTS_VIEW_KEY = "chdash.traceResultsView.v1";
  const START_DISPLAY_KEY = "chdash.traceStartDisplay.v1";

  function readStored(key, allowed, fallback) {
    try {
      const value = localStorage.getItem(key);
      return allowed.includes(value) ? value : fallback;
    } catch { return fallback; }
  }

  function writeStored(key, value) {
    try { localStorage.setItem(key, value); } catch { /* storage may be unavailable */ }
  }

  // The list follows the sort picker; the table sorts by its column headers
  // (both directions), starting from the picker's order.
  const LIST_SORTS = {
    recent: { key: "start", dir: "desc" },
    longest: { key: "duration", dir: "desc" },
    shortest: { key: "duration", dir: "asc" },
    spans: { key: "spans", dir: "desc" },
  };
  const TABLE_COLUMNS = [
    { key: "name", label: "Name", numeric: false },
    { key: "services", label: "Services", numeric: true },
    { key: "spans", label: "Spans", numeric: true },
    { key: "errors", label: "Errors", numeric: true },
    { key: "duration", label: "Duration", numeric: true },
    { key: "start", label: "Start", numeric: true },
  ];

  function traceName(trace) {
    return `${trace.root_service || "unknown"}: ${trace.root_operation || "trace"}`;
  }

  function compareText(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
  }

  function traceSortValue(trace, key) {
    if (key === "name") return traceName(trace).toLowerCase();
    if (key === "services") return (trace.service_stats || []).length;
    if (key === "spans") return Number(trace.span_count || 0);
    if (key === "errors") return Number(trace.error_count || 0);
    if (key === "duration") return Number(trace.duration_ns || 0);
    return Number(trace.start_ms || 0);
  }

  function sortTraces(rows, { key, dir }) {
    const sign = dir === "asc" ? 1 : -1;
    // Ties keep the newest trace first, then the trace id, in both directions.
    return rows.sort((a, b) => {
      const av = traceSortValue(a, key), bv = traceSortValue(b, key);
      const cmp = typeof av === "string" ? compareText(av, bv) : av - bv;
      return (cmp * sign) || (Number(b.start_ms || 0) - Number(a.start_ms || 0)) || compareText(a.trace_id, b.trace_id);
    });
  }

  function listSort() {
    return LIST_SORTS[String(dom.tracesSort?.value || "recent")] || LIST_SORTS.recent;
  }

  function sortedResults() {
    const rows = [...(model.traces || [])];
    return sortTraces(rows, model.resultsView === "table" ? (model.tableSort || listSort()) : listSort());
  }

  function incompleteTooltip(count) {
    const noun = count === 1 ? "span" : "spans";
    return `This trace may be incomplete: its spans reference ${count} parent ${noun} missing from the searched range. `
      + "This happens when the trace crosses the range, when a parent span belongs to a service you cannot see, "
      + "or while the trace is still being collected.";
  }

  function errorTagHtml(errors) {
    const label = `${errors} Error${errors === 1 ? "" : "s"}`;
    return `<span class="traceErrorCount traceErrorCount--title traceTag traceTag--error" title="${errors} error span${errors === 1 ? "" : "s"}" aria-label="${errors} error span${errors === 1 ? "" : "s"}">${label}</span>`;
  }

  function incompleteTagHtml(missing) {
    return `<span class="traceTag traceTag--incomplete" data-missing-parents="${missing}" title="${esc(incompleteTooltip(missing))}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.6 15.2 14.4H.8Z"/><path class="traceTag__glyph" d="M8 6v4M8 11.6v.9"/></svg>Incomplete</span>`;
  }

  function servicePillHtml(stat) {
    const errors = Number(stat.errors || 0);
    const errorTitle = errors ? ` · ${errors} error span${errors === 1 ? "" : "s"}` : "";
    return `<span class="traceSvcPill${errors ? " has-errors" : ""}" data-service="${esc(stat.service)}" data-spans="${stat.spans}" data-errors="${errors}" style="--trace-service-color:${serviceColor(stat.service)}" title="${esc(stat.service)} · ${stat.spans} span${stat.spans === 1 ? "" : "s"}${errorTitle}">${errors ? '<i class="traceSvcPill__error" aria-label="has errors">!</i>' : ""}<b>${esc(stat.service)}</b> <span class="traceSvcPill__count">(${stat.spans})</span></span>`;
  }

  // One line of service pills; layoutServicePills hides the ones that do not
  // fit and shows them behind a "+N" chip.
  function servicePillsHtml(stats) {
    if (!stats.length) return '<div class="traceSvcPills is-empty">—</div>';
    return `<div class="traceSvcPills">${stats.map(servicePillHtml).join("")}<button type="button" class="traceSvcMore" aria-haspopup="true" aria-expanded="false" hidden>+0</button></div>`;
  }

  function layoutServicePills(scope) {
    const groups = [...(scope?.querySelectorAll?.(".traceSvcPills:not(.is-empty)") || [])];
    if (!groups.length) return;
    // Write, read, then write again: one layout pass for the whole list.
    const prepared = groups.map((group) => {
      const pills = [...group.querySelectorAll(":scope > .traceSvcPill")];
      const more = group.querySelector(":scope > .traceSvcMore");
      for (const pill of pills) pill.hidden = false;
      if (more) { more.hidden = false; more.textContent = `+${pills.length}`; }
      // Natural widths: no pill shrinks while measuring.
      group.classList.add("is-measuring");
      return { group, pills, more };
    });
    const gap = parseFloat(getComputedStyle(groups[0]).columnGap) || 4;
    const measured = prepared.map((item) => ({
      ...item,
      width: item.group.clientWidth,
      widths: item.pills.map((pill) => pill.offsetWidth),
      moreWidth: item.more ? item.more.offsetWidth : 0,
    }));
    for (const { group, pills, more, width, widths, moreWidth } of measured) {
      group.classList.remove("is-measuring");
      if (!width) { if (more) more.hidden = true; continue; }
      let used = 0;
      let shown = 0;
      const total = widths.reduce((sum, w) => sum + w, 0) + gap * Math.max(0, widths.length - 1);
      if (total <= width + 0.5) shown = pills.length;
      else {
        for (let i = 0; i < widths.length; i += 1) {
          const next = used + (i ? gap : 0) + widths[i];
          if (next + gap + moreWidth > width + 0.5) break;
          used = next;
          shown = i + 1;
        }
        // The first pill always shows (ellipsized when it alone is too wide).
        shown = Math.max(1, shown);
      }
      pills.forEach((pill, index) => { pill.hidden = index >= shown; });
      if (more) {
        const rest = pills.length - shown;
        more.hidden = rest <= 0;
        more.textContent = `+${rest}`;
        more.setAttribute("aria-label", `${rest} more service${rest === 1 ? "" : "s"}`);
      }
      group.classList.toggle("is-overflowing", shown < pills.length);
    }
  }

  let servicePopover = null;
  let servicePopoverOwner = null;
  function hideServicePopover() {
    if (servicePopoverOwner) servicePopoverOwner.setAttribute("aria-expanded", "false");
    servicePopoverOwner = null;
    if (servicePopover) servicePopover.hidden = true;
  }

  // The hidden pills of a row, in a floating card under its "+N" chip.
  function showServicePopover(more) {
    if (!more || more.hidden) return;
    if (!servicePopover) {
      servicePopover = document.createElement("div");
      servicePopover.className = "traceSvcPopover";
      servicePopover.setAttribute("role", "tooltip");
      servicePopover.hidden = true;
      document.body.appendChild(servicePopover);
    }
    const group = more.parentElement;
    const hidden = [...group.querySelectorAll(":scope > .traceSvcPill[hidden]")];
    if (!hidden.length) { hideServicePopover(); return; }
    if (servicePopoverOwner && servicePopoverOwner !== more) servicePopoverOwner.setAttribute("aria-expanded", "false");
    servicePopoverOwner = more;
    more.setAttribute("aria-expanded", "true");
    servicePopover.replaceChildren(...hidden.map((pill) => { const copy = pill.cloneNode(true); copy.hidden = false; return copy; }));
    servicePopover.hidden = false;
    const anchor = more.getBoundingClientRect();
    const size = servicePopover.getBoundingClientRect();
    const left = Math.max(8, Math.min(window.innerWidth - size.width - 8, anchor.left + anchor.width / 2 - size.width / 2));
    const below = anchor.bottom + 6;
    const top = below + size.height > window.innerHeight - 8 ? Math.max(8, anchor.top - size.height - 6) : below;
    servicePopover.style.left = `${Math.round(left)}px`;
    servicePopover.style.top = `${Math.round(top)}px`;
  }

  function startTooltip(trace) {
    const ms = parseStartMs(trace.start_ms);
    if (!Number.isFinite(ms)) return "";
    const exact = ns.timeRange ? ns.timeRange.formatDateTime(ms) : new Date(ms).toISOString();
    return `${exact} · ${formatAgo(trace.start_ms)}`;
  }

  function resultItemHtml(trace, maxDurationNs) {
    const errors = Number(trace.error_count || 0);
    const missing = Number(trace.missing_parents || 0);
    const title = traceName(trace);
    const spans = Number(trace.span_count || 0);
    const services = Array.isArray(trace.service_stats) ? trace.service_stats : [];
    const percent = maxDurationNs > 0 ? Math.max(0, Math.min(100, (Number(trace.duration_ns || 0) / maxDurationNs) * 100)) : 0;
    return `<div class="traceResult traceResult--wide traceResultItem" data-trace-id="${esc(trace.trace_id)}" role="button" tabindex="0">
        <div class="traceResult__line traceResult__line--main traceResultItem__title">
          <span class="traceResultItem__durationBar" style="width:${percent.toFixed(2)}%" data-duration-percent="${percent.toFixed(2)}" aria-hidden="true"></span>
          <strong title="${esc(title)}" class="traceResult__wideTitle">${esc(title)}</strong>${errors ? errorTagHtml(errors) : ""}${missing ? incompleteTagHtml(missing) : ""}
          <code class="traceResult__fullId">${esc(trace.trace_id)}</code>
          <button type="button" class="traceCopyButton" data-copy-trace="${esc(trace.trace_id)}" title="Copy Trace ID" aria-label="Copy Trace ID"><span class="editorCopyButton__icon" aria-hidden="true"></span></button>
          <span class="traceResult__right"><b>${esc(formatDuration(trace.duration_ns))}</b></span>
        </div>
        <div class="traceResult__line traceResult__line--stats">
          <span class="traceTag traceTag--spans">${spans} Span${spans === 1 ? "" : "s"}</span>
          ${servicePillsHtml(services)}
          <span class="traceResult__when" title="${esc(startTooltip(trace))}"><time>${esc(formatStart(trace.start_ms))}</time><small>${esc(formatAgo(trace.start_ms))}</small></span>
        </div>
      </div>`;
  }

  function resultTableHtml(rows, maxDurationNs) {
    const sort = model.tableSort || listSort();
    const relative = model.startDisplay === "relative";
    const head = TABLE_COLUMNS.map((column) => {
      const active = sort.key === column.key;
      const aria = active ? (sort.dir === "asc" ? "ascending" : "descending") : "none";
      const toggle = column.key === "start"
        ? `<button type="button" class="traceTable__startToggle" data-start-toggle title="${relative ? "Show absolute time" : "Show relative time"}" aria-label="Toggle start time format"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 5.5h10M10 3l2.5 2.5L10 8M13.5 10.5h-10M6 8l-2.5 2.5L6 13"/></svg></button>`
        : "";
      return `<th class="resultTable__thSortable traceTable__th traceTable__th--${column.key}" data-table-sort="${column.key}"${active ? ` data-sort="${sort.dir}"` : ""} aria-sort="${aria}" tabindex="0" scope="col"><span>${column.label}</span>${toggle}</th>`;
    }).join("");
    const body = rows.map((trace) => {
      const errors = Number(trace.error_count || 0);
      const missing = Number(trace.missing_parents || 0);
      const name = traceName(trace);
      const services = Array.isArray(trace.service_stats) ? trace.service_stats : [];
      const percent = maxDurationNs > 0 ? Math.max(0, Math.min(100, (Number(trace.duration_ns || 0) / maxDurationNs) * 100)) : 0;
      const absolute = formatStart(trace.start_ms);
      const ago = formatAgo(trace.start_ms);
      return `<tr class="traceTable__row" data-trace-id="${esc(trace.trace_id)}" tabindex="0">
        <td class="traceTable__name" data-cell="name"><span class="traceTable__nameText" title="${esc(name)}"><b>${esc(trace.root_service || "unknown")}:</b> ${esc(trace.root_operation || "trace")}</span>${missing ? incompleteTagHtml(missing) : ""}</td>
        <td class="traceTable__services" data-cell="services">${servicePillsHtml(services)}</td>
        <td class="resultTable__numeric" data-cell="spans">${Number(trace.span_count || 0)}</td>
        <td class="resultTable__numeric" data-cell="errors">${errors ? `<span class="traceTag traceTag--error">${errors}</span>` : "0"}</td>
        <td class="traceTable__duration" data-cell="duration" title="${esc(formatDuration(trace.duration_ns))}"><span class="traceTable__bar" aria-hidden="true"><i style="width:${percent.toFixed(2)}%" data-duration-percent="${percent.toFixed(2)}"></i></span><span class="traceTable__durationText">${esc(formatDuration(trace.duration_ns))}</span></td>
        <td class="traceTable__start" data-cell="start" title="${esc(relative ? absolute : ago)}">${esc(relative ? ago : absolute)}</td>
      </tr>`;
    }).join("");
    return `<div class="tableWrap traceTableWrap"><table class="resultTable traceTable"><colgroup><col class="traceTable__col--name"><col class="traceTable__col--services"><col class="traceTable__col--spans"><col class="traceTable__col--errors"><col class="traceTable__col--duration"><col class="traceTable__col--start"></colgroup><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  function syncResultsViewControls() {
    const table = model.resultsView === "table";
    for (const button of document.querySelectorAll("[data-results-view]")) {
      const active = button.getAttribute("data-results-view") === model.resultsView;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    }
    // Like Jaeger, the sort picker drives the list; the table sorts by its headers.
    const sortLabel = document.querySelector(".traceResultsSort");
    if (sortLabel) sortLabel.hidden = table;
    dom.tracesResults?.classList.toggle("tracesResults--table", table);
  }

  function setResultsView(view) {
    const next = view === "table" ? "table" : "list";
    if (next === model.resultsView) return;
    model.resultsView = next;
    writeStored(RESULTS_VIEW_KEY, next);
    if (next === "table") model.tableSort = { ...listSort() };
    renderResults();
  }

  function sortTableBy(key) {
    const column = TABLE_COLUMNS.find((item) => item.key === key);
    if (!column) return;
    const current = model.tableSort || listSort();
    model.tableSort = current.key === key
      ? { key, dir: current.dir === "asc" ? "desc" : "asc" }
      : { key, dir: column.numeric ? "desc" : "asc" };
    renderResults();
    dom.tracesResults?.querySelector(`[data-table-sort="${key}"]`)?.focus({ preventScroll: true });
  }

  function emptyResultsHtml() {
    if (!model.searched) return '<div class="tracesEmpty">Search to load traces.</div>';
    const range = model.lastSearchRange;
    const tr = ns.timeRange;
    const when = range && tr ? `between ${tr.formatDateTime(range.start_ms)} and ${tr.formatDateTime(range.end_ms)}` : "in this range";
    const zoom = dom.tracesRangeZoomOut;
    const canZoom = !!zoom && !zoom.disabled;
    return `<div class="tracesEmpty tracesEmpty--search" data-empty-results>
        <strong>No traces found</strong>
        <span>No traces match these filters ${esc(when)}.</span>
        ${canZoom ? '<button type="button" class="button button--small tracesEmpty__zoom" data-results-zoom-out><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.25"/><path d="M5 7h4M10.2 10.2 13.5 13.5"/></svg><span>Zoom out</span></button>' : ""}
      </div>`;
  }

  function renderResultCount(rows) {
    const count = document.getElementById("tracesResultCount");
    if (!count) return;
    const withErrors = rows.filter((trace) => Number(trace.error_count || 0) > 0).length;
    const latency = model.searched && Number.isFinite(model.searchLatencyMs)
      ? ` <span class="tracesResultCount__latency" title="Search request time, measured in the browser">(in ${esc(formatDuration(model.searchLatencyMs * 1e6))})</span>`
      : "";
    count.innerHTML = `${rows.length} Trace${rows.length === 1 ? "" : "s"}${latency}${withErrors ? ` <span class="tracesResultCount__errors" title="${withErrors} of the listed traces have error spans">· ${withErrors} with error${withErrors === 1 ? "" : "s"}</span>` : ""}`;
  }

  let resultsResizeObserver = null;
  let resultsResizeFrame = 0;
  function watchResultsWidth() {
    if (resultsResizeObserver || typeof ResizeObserver !== "function" || !dom.tracesResults) return;
    let lastWidth = -1;
    resultsResizeObserver = new ResizeObserver((entries) => {
      const width = Math.round(entries[entries.length - 1]?.contentRect?.width || 0);
      if (width === lastWidth || resultsResizeFrame) return;
      lastWidth = width;
      resultsResizeFrame = requestAnimationFrame(() => {
        resultsResizeFrame = 0;
        hideServicePopover();
        layoutServicePills(dom.tracesResults);
      });
    });
    resultsResizeObserver.observe(dom.tracesResults);
  }

  let resultEventsBound = false;
  function bindResultEvents() {
    const root = dom.tracesResults;
    if (resultEventsBound || !root) return;
    resultEventsBound = true;
    const openRow = (row) => { const id = row?.getAttribute("data-trace-id"); if (id) loadTrace(id, { push: true }); };
    root.addEventListener("click", (event) => {
      const target = event.target;
      const copy = target.closest("[data-copy-trace]");
      if (copy) { event.stopPropagation(); copyText(copy.getAttribute("data-copy-trace") || "", copy); return; }
      const more = target.closest(".traceSvcMore");
      if (more) {
        event.stopPropagation();
        if (servicePopoverOwner === more) hideServicePopover(); else showServicePopover(more);
        return;
      }
      if (target.closest("[data-results-zoom-out]")) { dom.tracesRangeZoomOut?.click(); return; }
      if (target.closest("[data-start-toggle]")) {
        event.stopPropagation();
        model.startDisplay = model.startDisplay === "relative" ? "absolute" : "relative";
        writeStored(START_DISPLAY_KEY, model.startDisplay);
        renderResults();
        dom.tracesResults?.querySelector("[data-start-toggle]")?.focus({ preventScroll: true });
        return;
      }
      const th = target.closest("[data-table-sort]");
      if (th) { sortTableBy(th.getAttribute("data-table-sort")); return; }
      const row = target.closest("[data-trace-id]");
      if (row && root.contains(row)) openRow(row);
    });
    root.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const target = event.target;
      if (target.closest("button")) return;
      const th = target.closest("[data-table-sort]");
      if (th) { event.preventDefault(); sortTableBy(th.getAttribute("data-table-sort")); return; }
      const row = target.closest("[data-trace-id]");
      if (row === target) { event.preventDefault(); openRow(row); }
    });
    root.addEventListener("pointerover", (event) => {
      const more = event.target.closest?.(".traceSvcMore");
      if (more && more !== servicePopoverOwner) showServicePopover(more);
    });
    root.addEventListener("pointerout", (event) => {
      const more = event.target.closest?.(".traceSvcMore");
      if (more && !more.contains(event.relatedTarget)) hideServicePopover();
    });
    root.addEventListener("focusin", (event) => { const more = event.target.closest?.(".traceSvcMore"); if (more) showServicePopover(more); });
    root.addEventListener("focusout", (event) => { if (event.target.closest?.(".traceSvcMore")) hideServicePopover(); });
    window.addEventListener("scroll", hideServicePopover, { passive: true });
    for (const button of document.querySelectorAll("[data-results-view]")) {
      button.addEventListener("click", () => setResultsView(button.getAttribute("data-results-view")));
    }
  }

  function renderResults() {
    if (!dom.tracesResults) return;
    bindResultEvents();
    watchResultsWidth();
    hideServicePopover();
    syncResultsViewControls();
    const rows = sortedResults();
    renderResultCount(rows);
    renderAnalytics();
    if (!rows.length) {
      dom.tracesResults.innerHTML = emptyResultsHtml();
      return;
    }
    const maxDurationNs = Math.max(0, ...rows.map((trace) => Number(trace.duration_ns || 0)));
    dom.tracesResults.innerHTML = model.resultsView === "table"
      ? resultTableHtml(rows, maxDurationNs)
      : rows.map((trace) => resultItemHtml(trace, maxDurationNs)).join("");
    layoutServicePills(dom.tracesResults);
  }

  // An all-zero parent id is how some exporters write "no parent".
  function parentSpanId(span) {
    const id = String(span?.parent_span_id || "");
    return /^0*$/.test(id) ? "" : id;
  }

  function buildTree(spans) {
    const nodes = (Array.isArray(spans) ? spans : []).map((span) => ({ span, children: [], depth: 0 }));
    const byId = new Map(nodes.map((node) => [String(node.span.span_id || ""), node]));
    const roots = [];
    for (const node of nodes) {
      const parentId = parentSpanId(node.span);
      const parent = parentId ? byId.get(parentId) : null;
      if (parent && parent !== node) parent.children.push(node);
      else roots.push(node);
    }
    const cmp = (a, b) => Number(a.span.start_ns || 0) - Number(b.span.start_ns || 0) || String(a.span.span_id || "").localeCompare(String(b.span.span_id || ""));
    // Iterative: a long parent chain must not exhaust the call stack.
    roots.sort(cmp);
    const stack = roots.map((root) => [root, 0]);
    while (stack.length) {
      const [node, depth] = stack.pop();
      node.depth = Math.min(32, depth);
      node.children.sort(cmp);
      for (const child of node.children) stack.push([child, depth + 1]);
    }
    return { nodes, roots };
  }

  // Tree order, without the descendants of collapsed spans.
  function visibleNodes(cache) {
    const rows = [];
    let hiddenBelow = -1;
    for (const node of cache.order) {
      if (hiddenBelow >= 0) {
        if (node.level > hiddenBelow) continue;
        hiddenBelow = -1;
      }
      rows.push(node);
      if (node.children.length && model.collapsed.has(spanKey(node))) hiddenBelow = node.level;
    }
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

  function isErrorSpan(span) {
    return String(span?.status_code || "").toLowerCase() === "error";
  }

  function spanKey(node) {
    return String(node?.span?.span_id || "");
  }

  // Everything derived from the loaded trace alone (tree, tree order, bounds,
  // per-service stats, parsed event markers and attribute decorations, the
  // critical path) is computed once per trace. The waterfall re-renders on
  // every toggle, service filter and range change; rebuilding the tree and
  // re-parsing each span's JSON on every render dominated those interactions.
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
      node.children.forEach((child, index) => {
        parentOf.set(child, node);
        child.isLast = index === node.children.length - 1;
      });
    }
    // Tree (waterfall) order with uncapped levels, like Jaeger's span list.
    const order = [];
    const stack = tree.roots.slice().reverse().map((node) => [node, 0]);
    while (stack.length) {
      const [node, level] = stack.pop();
      node.level = level;
      node.orderIndex = order.length;
      order.push(node);
      for (let i = node.children.length - 1; i >= 0; i -= 1) stack.push([node.children[i], level + 1]);
    }
    // Spans with an error span somewhere below them.
    const errorBelow = new Set();
    let maxLevel = 0;
    for (let i = order.length - 1; i >= 0; i -= 1) {
      const node = order[i];
      if (node.level > maxLevel) maxLevel = node.level;
      const parent = parentOf.get(node);
      if (parent && (isErrorSpan(node.span) || errorBelow.has(node))) errorBelow.add(parent);
    }
    traceCache = {
      trace,
      spans,
      tree,
      nodeById,
      duplicateIds,
      parentOf,
      order,
      errorBelow,
      maxLevel,
      // Spans whose parent is not in the trace (Jaeger's orphan spans).
      orphanCount: tree.roots.filter((node) => parentSpanId(node.span)).length,
      errorCount: spans.filter(isErrorSpan).length,
      serviceCount: new Set(spans.map((span) => String(span.service_name || "unknown"))).size,
      extent: spanExtent(spans),
      bounds: traceBounds(spans),
      serviceStats: null,
      events: new Map(),
      decorations: new Map(),
      criticalPath: null,
    };
    return traceCache;
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

  // --- Span decorations (Jaeger's spanDecorations.ts) ------------------------
  // A namespace icon (db, http, messaging, rpc: the first attribute namespace
  // present) and value pills from well-known attributes, both in the name
  // column. An http status of 5xx makes its pill red.
  const DECORATION_ICONS = {
    db: '<svg viewBox="0 0 16 16" aria-hidden="true"><ellipse cx="8" cy="3.8" rx="5" ry="2"/><path d="M3 3.8v8.4c0 1.1 2.2 2 5 2s5-.9 5-2V3.8M3 8c0 1.1 2.2 2 5 2s5-.9 5-2"/></svg>',
    http: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.8"/><path d="M2.2 8h11.6M8 2.2c2 2.2 2 9.4 0 11.6M8 2.2c-2 2.2-2 9.4 0 11.6"/></svg>',
    messaging: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11v7.2H7.2L4.3 13v-2.3H2.5z"/></svg>',
    rpc: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 5.5h10.5L10.5 3M13.5 10.5H3L5.5 13"/></svg>',
  };
  const is5xx = (value) => {
    const code = Number(String(value).trim());
    return code >= 500 && code < 600;
  };
  const SPAN_DECORATIONS = [
    { namespace: "db", label: "Database span", pills: [{ label: "db.system", keys: ["db.system.name", "db.system"] }] },
    {
      namespace: "http",
      label: "HTTP span",
      pills: [
        { label: "http.status_code", keys: ["http.status_code", "http.response.status_code"], isError: is5xx },
        { label: "http.method", keys: ["http.method", "http.request.method"] },
      ],
    },
    { namespace: "messaging", label: "Messaging span", pills: [{ label: "messaging.system", keys: ["messaging.system"] }] },
    { namespace: "rpc", label: "RPC span", pills: [{ label: "rpc.system", keys: ["rpc.system.name", "rpc.system"] }] },
  ];

  function spanDecorations(cache, span) {
    let found = cache.decorations.get(span);
    if (found) return found;
    const parsed = parseStructuredValue(span.span_attributes);
    const attrs = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    const namespaces = new Set();
    for (const key of Object.keys(attrs)) {
      const dot = key.indexOf(".");
      if (dot > 0) namespaces.add(key.slice(0, dot));
    }
    const decoration = SPAN_DECORATIONS.find((entry) => namespaces.has(entry.namespace));
    const pills = [];
    for (const entry of SPAN_DECORATIONS) {
      for (const source of entry.pills) {
        for (const key of source.keys) {
          const raw = attrs[key];
          if (raw == null) continue;
          const value = (typeof raw === "object" ? JSON.stringify(raw) : String(raw)).trim();
          if (!value) continue;
          pills.push({ label: source.label, value, isError: !!source.isError?.(value) });
          break;
        }
      }
    }
    found = {
      iconHtml: decoration ? `<span class="traceSpanRow__decoration" data-span-decoration="${decoration.namespace}" title="${esc(decoration.label)}">${DECORATION_ICONS[decoration.namespace]}</span>` : "",
      pillsHtml: pills.map((pill) => `<span class="traceSpanPill${pill.isError ? " is-error" : ""}" data-span-pill="${esc(pill.label)}" title="${esc(`${pill.label}: ${pill.value}`)}" aria-label="${esc(`${pill.label}: ${pill.value}`)}">${esc(pill.value)}</span>`).join(""),
    };
    cache.decorations.set(span, found);
    return found;
  }

  // --- Critical path (Jaeger's CriticalPath/index.ts) ------------------------
  // From each root, follow the last finishing child; on the way back, the child
  // that finished last before the returning child started. A consumer child
  // of a producer does not block it, and children are first clipped to their
  // parent (sanitizeOverFlowingChildren). Iterative, so deep traces are safe.
  function criticalPathSections(cache) {
    if (cache.criticalPath) return cache.criticalPath;
    const byNode = new Map();
    const kind = (node) => String(node?.span?.span_kind || "").toLowerCase();
    const blocking = (child, parent) => !(kind(parent).includes("producer") && kind(child).includes("consumer"));
    const add = (node, start, end) => {
      if (start === end) return;
      const list = byNode.get(node);
      if (list) list.push({ start, end });
      else byNode.set(node, [{ start, end }]);
    };
    for (const root of cache.tree.roots) {
      // Like Jaeger, a span whose parent is missing (an orphan) and its
      // subtree get no critical path.
      if (parentSpanId(root.span)) continue;
      // Pre-order over blocking descendants: parents are clipped first.
      const list = [];
      const stack = [[root, null]];
      while (stack.length) {
        const [node, parent] = stack.pop();
        const start = Number(node.span.start_ns || 0);
        const cp = { node, parent, start, end: start + Number(node.span.duration_ns || 0), children: [], removed: false };
        if (parent) parent.children.push(cp);
        list.push(cp);
        for (let i = node.children.length - 1; i >= 0; i -= 1) {
          if (blocking(node.children[i], node)) stack.push([node.children[i], cp]);
        }
      }
      for (const cp of list) {
        const parent = cp.parent;
        if (!parent) continue;
        const drop = () => { cp.removed = true; parent.children = parent.children.filter((child) => child !== cp); };
        if (parent.removed) { cp.removed = true; continue; }
        if (cp.start >= parent.start) {
          if (cp.start >= parent.end) drop();
          else if (cp.end > parent.end) cp.end = parent.end;
        } else if (cp.end <= parent.start) {
          drop();
        } else {
          cp.start = parent.start;
          if (cp.end > parent.end) cp.end = parent.end;
        }
      }
      const lastFinishingChild = (cp, before) => {
        let best = null;
        for (const child of cp.children) {
          if (before != null && !(child.end < before)) continue;
          if (!best || child.end > best.end) best = child;
        }
        return best;
      };
      let current = list[0];
      let returning = null;
      for (let guard = list.length * 4 + 8; current && guard > 0; guard -= 1) {
        const child = lastFinishingChild(current, returning);
        const end = returning == null ? current.end : returning;
        if (child) {
          add(current.node, child.end, end);
          current = child;
          returning = null;
        } else {
          add(current.node, current.start, end);
          returning = current.start;
          current = current.parent;
        }
      }
    }
    cache.criticalPath = byNode;
    return byNode;
  }

  // A span's sections; a collapsed span shows those of its whole hidden subtree.
  function criticalSectionsFor(cache, node, collapsed) {
    const byNode = criticalPathSections(cache);
    if (!collapsed) return byNode.get(node) || [];
    const merged = [];
    const order = cache.order;
    for (let i = node.orderIndex; i < order.length && (i === node.orderIndex || order[i].level > node.level); i += 1) {
      for (const section of byNode.get(order[i]) || []) merged.push({ ...section });
    }
    merged.sort((a, b) => a.start - b.start);
    const out = [];
    for (const section of merged) {
      const last = out[out.length - 1];
      if (last && section.start <= last.end) last.end = Math.max(last.end, section.end);
      else out.push(section);
    }
    return out;
  }

  // --- Trace overview (Jaeger's SpanGraph) -----------------------------------
  // One row per span in tree order (the waterfall with every branch open),
  // Jaeger's geometry: 60..200 px high, rows H/N apart and 1..6 px tall. A
  // canvas above OVERVIEW_CANVAS_ABOVE spans, elements (with tooltips) below.
  const OVERVIEW_CANVAS_ABOVE = 1000;

  function overviewGeometry(count) {
    const n = Math.max(1, count);
    const height = count < 60 ? 60 : Math.min(count, 200);
    return { height, step: height / n, item: Math.min(6, Math.max(1, height / n)) };
  }

  function drawOverviewCanvas(canvas, nodes, bounds, geometry) {
    const width = Math.max(1, canvas.parentElement?.clientWidth || 0);
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(geometry.height * ratio);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    ctx.clearRect(0, 0, width, geometry.height);
    ctx.globalAlpha = 0.8;
    const fills = new Map();
    nodes.forEach((node, index) => {
      const span = node.span;
      const x = ((Number(span.start_ns || 0) - bounds.start) / bounds.duration) * width;
      const w = Math.max(1.5, (Number(span.duration_ns || 0) / bounds.duration) * width);
      const service = String(span.service_name || "unknown");
      let fill = fills.get(service);
      if (!fill) { fill = serviceColorValue(service); fills.set(service, fill); }
      ctx.fillStyle = fill;
      ctx.fillRect(x, index * geometry.step, w, geometry.item);
    });
  }

  function viewRangeOf(range = model.traceViewRange) {
    const r = Array.isArray(range) ? range : [0, 1];
    const lo = Math.max(0, Math.min(1, Number(r[0] || 0)));
    const hi = Math.max(lo + 1e-6, Math.min(1, Number(r[1] == null ? 1 : r[1])));
    return [lo, hi];
  }

  function syncOverviewSelection() {
    const selection = dom.traceOverview?.querySelector?.("[data-trace-overview-selection]");
    if (!selection) return;
    const [lo, hi] = viewRangeOf();
    selection.style.left = `${(lo * 100).toFixed(3)}%`;
    selection.style.width = `${((hi - lo) * 100).toFixed(3)}%`;
  }

  // Zoom / pan of the waterfall (overview selection, timeline drag, keys).
  let waterfallFrame = 0;
  function setTraceViewRange(range, { deferred = false } = {}) {
    const [lo, hi] = viewRangeOf(range);
    model.traceViewRange = [lo, Math.min(1, hi)];
    syncOverviewSelection();
    if (!deferred) { renderWaterfall(); return; }
    if (waterfallFrame) return;
    waterfallFrame = requestAnimationFrame(() => { waterfallFrame = 0; renderWaterfall(); });
  }

  function renderTraceOverview(spans, bounds) {
    if (!dom.traceOverview) return;
    if (!spans.length) { dom.traceOverview.innerHTML = ""; return; }
    const range = Array.isArray(model.traceViewRange) ? model.traceViewRange : [0, 1];
    const lo = Math.max(0, Math.min(1, Number(range[0] || 0)));
    const hi = Math.max(lo + 0.005, Math.min(1, Number(range[1] == null ? 1 : range[1])));
    const ticks = durationTicks(bounds.duration, 5).map((tick) => `<span style="left:${tick.ratio * 100}%">${esc(tick.label)}</span>`).join("");
    const cache = activeTraceCache();
    const nodes = cache.order.filter((node) => serviceEnabled(node.span.service_name));
    const geometry = overviewGeometry(nodes.length);
    const canvasMode = nodes.length > OVERVIEW_CANVAS_ABOVE;
    const bars = canvasMode
      ? '<canvas class="traceOverview__canvas" data-trace-overview-canvas aria-hidden="true"></canvas>'
      : nodes.map((node, index) => {
        const span = node.span;
        const left = Math.max(0, Math.min(100, ((Number(span.start_ns || 0) - bounds.start) / bounds.duration) * 100));
        const width = Math.max(.08, Math.min(100 - left, (Number(span.duration_ns || 0) / bounds.duration) * 100));
        const isError = isErrorSpan(span);
        return `<i class="traceOverview__span${isError ? " is-error" : ""}" data-span-id="${esc(spanKey(node))}" title="${esc(`${span.service_name || "unknown"}: ${span.span_name || "span"} · ${formatDuration(span.duration_ns)}${isError ? " · ERROR" : ""}`)}" style="left:${left.toFixed(4)}%;width:${width.toFixed(4)}%;top:${(index * geometry.step).toFixed(2)}px;height:${geometry.item.toFixed(2)}px;--trace-service-color:${serviceColor(span.service_name)}"></i>`;
      }).join("");
    dom.traceOverview.innerHTML = `<div class="traceOverview__ticks">${ticks}</div><div class="traceOverview__graph" data-trace-overview-graph data-overview-rows="${nodes.length}" data-overview-mode="${canvasMode ? "canvas" : "dom"}" style="height:${geometry.height}px">${bars}<div class="traceOverview__selection" data-trace-overview-selection style="left:${(lo * 100).toFixed(3)}%;width:${((hi-lo)*100).toFixed(3)}%"><button type="button" class="traceOverview__handle traceOverview__handle--start" data-overview-handle="start" aria-label="Resize trace range start"></button><button type="button" class="traceOverview__handle traceOverview__handle--end" data-overview-handle="end" aria-label="Resize trace range end"></button></div></div>`;

    const graph = dom.traceOverview.querySelector("[data-trace-overview-graph]");
    const selection = dom.traceOverview.querySelector("[data-trace-overview-selection]");
    if (!graph || !selection) return;
    if (canvasMode) drawOverviewCanvas(graph.querySelector("[data-trace-overview-canvas]"), nodes, bounds, geometry);
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

  // Jaeger's "MMM D YYYY, HH:mm:ss" plus the milliseconds, browser-local.
  function traceStartParts(ns) {
    const ms = Math.floor(Number(ns) / 1e6);
    if (!Number.isFinite(ms)) return null;
    const d = new Date(ms);
    const month = d.toLocaleDateString("en-US", { month: "short" });
    return {
      main: `${month} ${d.getDate()} ${d.getFullYear()}, ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`,
      fraction: `.${String(d.getMilliseconds()).padStart(3, "0")}`,
    };
  }

  const WARNING_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8 15 14H1z"/><path d="M8 6.2v3.6M8 11.4v.4"/></svg>';

  // Jaeger's TracePageHeader items: Trace Start, Duration, Services, Depth,
  // Total Spans (plus Errors), and an Incomplete tag when spans reference a
  // parent missing from the trace.
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
      document.title = TRACES_PAGE_TITLE;
      return;
    }
    const cache = activeTraceCache();
    const bounds = cache.bounds;
    const root = spans.find((s) => !parentSpanId(s)) || spans.slice().sort((a, b) => Number(a.start_ns || 0) - Number(b.start_ns || 0))[0];
    document.title = `${String(trace.trace_id || "").slice(0, 7)}: ${root?.service_name || "trace"} ${root?.span_name || ""}`.trim();
    if (dom.traceDetailTitle) {
      dom.traceDetailTitle.innerHTML = `<strong><span>${esc(root?.service_name || "trace")}:</span> ${esc(root?.span_name || "trace")}</strong><span class="tracePageHeader__traceId"><code title="${esc(trace.trace_id)}">${esc(shortId(trace.trace_id, 10))}</code><button type="button" class="traceCopyButton traceCopyButton--header" data-copy-active-trace="${esc(trace.trace_id)}" aria-label="Copy Trace ID" title="Copy full Trace ID"><span class="editorCopyButton__icon" aria-hidden="true"></span></button></span>`;
      dom.traceDetailTitle.querySelector("[data-copy-active-trace]")?.addEventListener("click", (event) => {
        event.stopPropagation();
        copyText(trace.trace_id, event.currentTarget);
      });
    }
    if (dom.traceDetailStats) {
      const start = traceStartParts(bounds.start);
      const items = [
        ["Trace Start", { html: start ? `${esc(start.main)}<small class="tracePageOverviewItem__detail">${esc(start.fraction)}</small>` : "—" }, "is-start"],
        ["Duration", formatDuration(bounds.duration)],
        ["Services", String(cache.serviceCount)],
        ["Depth", String(cache.maxLevel + 1)],
        ["Total Spans", String(spans.length)],
        ["Errors", String(cache.errorCount), cache.errorCount ? "is-error" : ""],
      ];
      const itemsHtml = items.map(([label, value, cls]) => `<div class="tracePageOverviewItem${cls ? ` ${cls}` : ""}" data-trace-header-item="${esc(label)}"><span>${esc(label)}</span><strong>${typeof value === "object" ? value.html : esc(value)}</strong></div>`).join('<i class="tracePageOverviewDivider" aria-hidden="true"></i>');
      const orphans = cache.orphanCount;
      const incomplete = orphans
        ? `<span class="tracePageHeader__incomplete" data-trace-incomplete title="${esc(`${orphans} span${orphans === 1 ? "" : "s"} reference${orphans === 1 ? "s" : ""} a parent span missing from this trace: the trace is incomplete.`)}">${WARNING_ICON}Incomplete</span>`
        : "";
      dom.traceDetailStats.innerHTML = itemsHtml + incomplete;
    }
    renderTraceServiceFilters(spans);
    renderTraceOverview(spans, bounds);
  }

  function spanRowClass(active, error, clipLeft = false, clipRight = false) {
    return `traceSpanRow${active ? " is-active" : ""}${error ? " is-error" : ""}${clipLeft ? " clipping-left" : ""}${clipRight ? " clipping-right" : ""}`;
  }

  // Tree indentation per level (Jaeger's SpanTreeOffset); a level's guide
  // line runs through the middle of its toggle box.
  const TREE_INDENT_PX = 18;
  const TREE_LINE_X = 13;

  function spanRowGuides(depth) {
    return Array.from({ length: depth }, (_, index) => `<i style="left:${TREE_LINE_X + index * TREE_INDENT_PX}px"></i>`).join("");
  }

  function spanInspectorRowHtml(node, cache) {
    const span = node.span;
    const depth = Math.min(node.level ?? node.depth, 40);
    const serviceLineX = TREE_LINE_X - 1 + depth * TREE_INDENT_PX;
    return `<div class="traceSpanInspectorRow" style="--trace-service-color:${serviceColor(span.service_name)};--trace-depth-x:${serviceLineX}px"><div class="traceSpanInspectorRow__spacer"><span class="traceSpanRow__guides" aria-hidden="true">${spanRowGuides(depth)}</span></div><div class="traceSpanInspectorRow__panel">${renderSpanInspectorCard(span, cache.spans, cache.bounds)}</div></div>`;
  }

  // Guides of every ancestor in its service colour, an elbow from the parent
  // into this span, then a toggle box with the child count (tinted when
  // collapsed) or a dot for a leaf. A guide stops after the ancestor's last
  // child. Hovering a guide or a box highlights that span's subtree guides.
  function treeOffsetHtml(node, cache) {
    const ancestors = [];
    for (let parent = cache.parentOf.get(node); parent; parent = cache.parentOf.get(parent)) ancestors.push(parent);
    ancestors.reverse();
    let html = "";
    for (let i = 0; i < ancestors.length; i += 1) {
      const ancestor = ancestors[i];
      const lastAncestor = i === ancestors.length - 1;
      const cls = lastAncestor ? (node.isLast ? " is-last" : "") : (ancestors[i + 1].isLast ? " is-terminated" : "");
      html += `<span class="traceTreeOffset__guide${cls}" data-ancestor-id="${esc(spanKey(ancestor))}" style="color:${serviceColor(ancestor.span.service_name)}">${lastAncestor ? '<i class="traceTreeOffset__elbow"></i>' : ""}</span>`;
    }
    const id = spanKey(node);
    const count = node.children.length;
    if (count) {
      const collapsed = model.collapsed.has(id);
      const label = `${collapsed ? "Expand" : "Collapse"} ${count} child span${count === 1 ? "" : "s"}`;
      html += `<button type="button" class="traceTreeOffset__box${collapsed ? " is-collapsed" : ""}" data-toggle-span="${esc(id)}" data-ancestor-id="${esc(id)}" aria-expanded="${collapsed ? "false" : "true"}" aria-label="${label}" title="${label}">${count}</button>`;
    } else {
      html += '<span class="traceTreeOffset__leaf" aria-hidden="true"><i class="traceTreeOffset__dot"></i></span>';
    }
    return `<span class="traceTreeOffset${count ? " is-parent" : ""}">${html}</span>`;
  }

  // View window shared by the full render and in-place row updates.
  function waterfallContext(cache) {
    const { start: fullStart, end: fullEnd } = cache.extent;
    const fullTotal = Math.max(1, fullEnd - fullStart);
    const [viewLo, viewHi] = viewRangeOf();
    const start = fullStart + fullTotal * viewLo;
    const end = fullStart + fullTotal * viewHi;
    // Offset and width of the window straight from the fractions: differences
    // of epoch-ns doubles are only good to ~256 ns.
    return { cache, fullStart, start, end, offset: fullTotal * viewLo, total: Math.max(1, fullTotal * (viewHi - viewLo)), zoomed: viewLo > 0 || viewHi < 1 };
  }

  function waterfallRowShown(node, ctx) {
    const { start, end } = ctx;
    const spanStart = Number(node.span.start_ns || 0);
    const spanEnd = spanStart + Number(node.span.duration_ns || 0);
    return serviceEnabled(node.span.service_name) && spanEnd > start && spanStart < end;
  }

  const WATERFALL_ICONS = {
    expandOne: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>',
    collapseOne: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>',
    expandAll: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 3.5l4 4 4-4M4 8.5l4 4 4-4"/></svg>',
    collapseAll: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 4l4 4-4 4M8.5 4l4 4-4 4"/></svg>',
    criticalPath: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="4.5" width="13" height="7" rx="1.5"/><path d="M1.5 8h13" class="is-strip"/></svg>',
    resetZoom: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="M10.4 10.4 14 14M5 7h4"/></svg>',
  };

  // Jaeger's Ticks: 5 ticks, labels at least 130 px apart (every 2nd, 4th…
  // label when narrower), the first and last always labelled. Each label is
  // the offset from the trace start with the wall-clock time below it.
  const TIMELINE_TICKS = 5;
  const MIN_TICK_LABEL_SPACING_PX = 130;

  function waterfallHeadHtml(ctx) {
    const { cache, fullStart, offset, total, zoomed } = ctx;
    const ticks = durationTicks(total, TIMELINE_TICKS, offset);
    const rootWidth = Number(dom.traceWaterfall?.clientWidth || 0);
    const timelineWidth = rootWidth * (1 - model.waterfallLabelPct / 100);
    let labelStep = 1;
    if (timelineWidth > 0) {
      const spacing = timelineWidth / (TIMELINE_TICKS - 1);
      while (spacing * labelStep < MIN_TICK_LABEL_SPACING_PX && labelStep < TIMELINE_TICKS) labelStep *= 2;
    }
    const tickStep = total / (TIMELINE_TICKS - 1);
    const tickLabels = ticks.map((tick, index) => {
      const last = index === ticks.length - 1;
      if (!(index === 0 || last || index % labelStep === 0)) return "";
      const clock = wallClockLabel(fullStart, tick.ns, tickStep);
      return `<span class="traceTick${last ? " is-end" : ""}" data-trace-tick style="left:${tick.ratio * 100}%" title="${esc(`${tick.label} after the trace start · ${clock}`)}"><i></i><b>${esc(tick.label)}</b><small>${esc(clock)}</small></span>`;
    }).join("");
    const shown = model.criticalPathShown;
    const hasParents = cache.order.some((node) => node.children.length);
    const control = (key, label, icon, extra = "") => `<button type="button" class="traceWaterfallControl" ${key} title="${esc(label)}" aria-label="${esc(label)}"${extra}>${icon}</button>`;
    const controls = [
      control("data-trace-expand-one", "Expand +1 (o)", WATERFALL_ICONS.expandOne, ` aria-keyshortcuts="o"${hasParents ? "" : " disabled"}`),
      control("data-trace-collapse-one", "Collapse +1 (p)", WATERFALL_ICONS.collapseOne, ` aria-keyshortcuts="p"${hasParents ? "" : " disabled"}`),
      control("data-trace-expand-all", "Expand all ([)", WATERFALL_ICONS.expandAll, ` aria-keyshortcuts="["${hasParents ? "" : " disabled"}`),
      control("data-trace-collapse-all", "Collapse all (])", WATERFALL_ICONS.collapseAll, ` aria-keyshortcuts="]"${hasParents ? "" : " disabled"}`),
      '<i class="traceWaterfallHead__sep" aria-hidden="true"></i>',
      control("data-trace-critical-path", shown ? "Hide the critical path" : "Show the critical path", WATERFALL_ICONS.criticalPath, ` aria-pressed="${shown ? "true" : "false"}"`),
      control("data-trace-reset-zoom", "Reset zoom", WATERFALL_ICONS.resetZoom, zoomed ? "" : " hidden"),
    ].join("");
    return `<div class="traceWaterfallHead"><div class="traceWaterfallHead__operation"><span class="traceWaterfallHead__title">Service &amp; Operation</span><span class="traceWaterfallHead__controls">${controls}</span></div><div class="traceWaterfallHead__timeline" data-trace-timeline-header aria-label="Timeline: drag to zoom, a / d or arrows to pan and zoom">${tickLabels}<div class="traceTimelineCursor" data-trace-timeline-cursor hidden></div><div class="traceTimelineDrag" data-trace-timeline-drag hidden></div></div><div class="traceWaterfallResizer" data-trace-waterfall-resizer role="separator" aria-orientation="vertical" aria-label="Resize Service & Operation column" tabindex="0"></div></div>`;
  }

  function renderWaterfall() {
    if (!dom.traceWaterfall) return;
    const cache = activeTraceCache();
    const spans = cache.spans;
    if (!spans.length) { dom.traceWaterfall.innerHTML = '<div class="tracesEmpty">No spans.</div>'; return; }
    const ctx = waterfallContext(cache);
    const rows = visibleNodes(cache).filter((node) => waterfallRowShown(node, ctx));
    dom.traceWaterfall.style.setProperty("--trace-label-width", `${model.waterfallLabelPct}%`);
    dom.traceWaterfall.classList.toggle("is-critical-path-hidden", !model.criticalPathShown);
    hoveredAncestor = null;
    if (rows.length > VIRTUAL_ROWS_ABOVE) { renderVirtualWaterfall(ctx, rows); return; }
    virtualWaterfall = null;
    const body = rows.map((node) => waterfallRowHtml(node, ctx)).join("");
    dom.traceWaterfall.innerHTML = `${waterfallHeadHtml(ctx)}<div class="traceWaterfallBody">${body}</div>`;
  }

  // --- Virtualised waterfall (Jaeger's ListView) -----------------------------
  // Above VIRTUAL_ROWS_ABOVE rows only the rows in and around the viewport are
  // in the DOM, between two spacers; an open span's inspector counts with its
  // measured height (an estimate until it has been drawn once).
  const VIRTUAL_ROWS_ABOVE = 1000;
  const VIRTUAL_OVERSCAN = 40;
  const SPAN_ROW_PX = 24;
  const INSPECTOR_ESTIMATE_PX = 260;
  const inspectorHeights = new Map();
  let virtualWaterfall = null;
  let virtualFrame = 0;
  let inspectorObserver = null;

  function virtualItemHeight(node) {
    const id = spanKey(node);
    return SPAN_ROW_PX + (model.openSpanIds.has(id) ? (inspectorHeights.get(id) || INSPECTOR_ESTIMATE_PX) : 0);
  }

  function virtualOffsets(nodes) {
    const offsets = new Float64Array(nodes.length + 1);
    for (let i = 0; i < nodes.length; i += 1) offsets[i + 1] = offsets[i] + virtualItemHeight(nodes[i]);
    return offsets;
  }

  // Index of the item at `y` px into the body.
  function virtualIndexAt(offsets, y) {
    let lo = 0;
    let hi = offsets.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (offsets[mid] <= y) lo = mid; else hi = mid - 1;
    }
    return Math.max(0, lo);
  }

  function renderVirtualWaterfall(ctx, nodes) {
    const root = dom.traceWaterfall;
    // Read before the body is replaced: an emptied body would clamp it.
    const scrollTop = root.scrollTop;
    const offsets = virtualOffsets(nodes);
    virtualWaterfall = { ctx, nodes, offsets, first: 0, last: 0 };
    root.innerHTML = `${waterfallHeadHtml(ctx)}<div class="traceWaterfallBody" data-virtual-rows="${nodes.length}" style="height:${offsets[nodes.length]}px"></div>`;
    root.scrollTop = scrollTop;
    updateVirtualWindow(true, scrollTop);
    const body = root.querySelector(".traceWaterfallBody");
    if (body) body.style.height = "";
  }

  function updateVirtualWindow(force = false, knownScrollTop = null) {
    const state = virtualWaterfall;
    const root = dom.traceWaterfall;
    const body = root?.querySelector(".traceWaterfallBody");
    if (!state || !body) return;
    const { nodes, offsets, ctx } = state;
    const top = Math.max(0, (knownScrollTop ?? root.scrollTop) - body.offsetTop);
    const bottom = top + Math.max(root.clientHeight, 400);
    const visibleFirst = virtualIndexAt(offsets, top);
    const visibleLast = Math.min(nodes.length, virtualIndexAt(offsets, bottom) + 1);
    if (!force && visibleFirst >= state.first && visibleLast <= state.last) return;
    state.first = Math.max(0, visibleFirst - VIRTUAL_OVERSCAN);
    state.last = Math.min(nodes.length, visibleLast + VIRTUAL_OVERSCAN);
    const focusedId = document.activeElement?.closest?.("#traceWaterfall [data-span-id]")?.getAttribute("data-span-id");
    const rowsHtml = nodes.slice(state.first, state.last).map((node) => waterfallRowHtml(node, ctx)).join("");
    body.innerHTML = `<div class="traceWaterfallSpacer" data-virtual-before style="height:${offsets[state.first]}px"></div>${rowsHtml}<div class="traceWaterfallSpacer" data-virtual-after style="height:${offsets[nodes.length] - offsets[state.last]}px"></div>`;
    if (focusedId) body.querySelector(`[data-span-id="${window.CSS?.escape ? CSS.escape(focusedId) : focusedId}"]`)?.focus({ preventScroll: true });
    hoveredAncestor = null;
    watchInspectorHeights(body);
  }

  // Keep the spacers true to the inspectors' drawn heights (they change when
  // a section inside is opened).
  function watchInspectorHeights(body) {
    if (typeof ResizeObserver === "undefined") return;
    if (!inspectorObserver) {
      inspectorObserver = new ResizeObserver((entries) => {
        const state = virtualWaterfall;
        if (!state) return;
        let changed = false;
        for (const entry of entries) {
          const id = entry.target.previousElementSibling?.getAttribute?.("data-span-id");
          const height = entry.target.getBoundingClientRect().height;
          if (id && height && Math.abs((inspectorHeights.get(id) || 0) - height) > 0.5) {
            inspectorHeights.set(id, height);
            changed = true;
          }
        }
        if (!changed) return;
        state.offsets = virtualOffsets(state.nodes);
        const before = dom.traceWaterfall?.querySelector("[data-virtual-before]");
        const after = dom.traceWaterfall?.querySelector("[data-virtual-after]");
        if (before) before.style.height = `${state.offsets[state.first]}px`;
        if (after) after.style.height = `${state.offsets[state.nodes.length] - state.offsets[state.last]}px`;
      });
    }
    inspectorObserver.disconnect();
    for (const el of body.querySelectorAll(".traceSpanInspectorRow")) inspectorObserver.observe(el);
  }

  function scheduleVirtualWindow() {
    if (!virtualWaterfall || virtualFrame) return;
    virtualFrame = requestAnimationFrame(() => { virtualFrame = 0; updateVirtualWindow(); });
  }

  function criticalPathHtml(cache, node, collapsed, ctx) {
    const { start, end, total } = ctx;
    return criticalSectionsFor(cache, node, collapsed).map((section) => {
      const a = Math.max(start, section.start);
      const b = Math.min(end, section.end);
      if (!(b > a)) return "";
      const left = ((a - start) / total) * 100;
      const width = ((b - a) / total) * 100;
      return `<i class="traceSpanBar__critical" style="left:${left.toFixed(4)}%;width:${width.toFixed(4)}%" title="A segment on the critical path of the trace"></i>`;
    }).join("");
  }

  function spanRowHtml(node, ctx) {
    const { cache, start, end, total } = ctx;
    const span = node.span;
    const id = String(span.span_id || "");
    const spanStart = Number(span.start_ns || 0);
    const spanEnd = spanStart + Number(span.duration_ns || 0);
    const clippedStart = Math.max(start, spanStart);
    const clippedEnd = Math.min(end, spanEnd);
    const inView = clippedEnd > clippedStart;
    const left = inView ? Math.max(0, Math.min(100, ((clippedStart - start) / total) * 100)) : 0;
    const width = inView ? Math.max(0.24, Math.min(100 - left, ((clippedEnd - clippedStart) / total) * 100)) : 0;
    const error = isErrorSpan(span);
    const collapsed = node.children.length > 0 && model.collapsed.has(id);
    // Jaeger's hasChildError: a collapsed span hiding an error span.
    const childError = !error && collapsed && cache.errorBelow.has(node);
    const active = model.openSpanIds.has(id);
    const color = serviceColor(span.service_name);
    const labelLeft = left + (width / 2) >= 62;
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
    const critical = inView ? criticalPathHtml(cache, node, collapsed, ctx) : "";
    const decorations = spanDecorations(cache, span);
    const errorIcon = error
      ? '<span class="traceSpanRow__errorBadge" title="Span status: Error" aria-label="Error span">!</span>'
      : childError ? '<span class="traceSpanRow__errorBadge traceSpanRow__errorBadge--hollow" title="An error span is inside this collapsed branch" aria-label="Error span in this collapsed branch">!</span>' : "";
    return `<div class="${spanRowClass(active, error, inView && spanStart < start, inView && spanEnd > end)}" data-span-id="${esc(id)}" role="button" tabindex="0" aria-expanded="${active ? "true" : "false"}">
        <div class="traceSpanRow__label" style="--trace-service-color:${color}"><div class="traceSpanRow__labelContent">${treeOffsetHtml(node, cache)}<span class="traceSpanRow__serviceDot"></span>${decorations.iconHtml}${errorIcon}<span class="traceSpanRow__service${collapsed ? " is-children-collapsed" : ""}">${esc(span.service_name || "unknown")}</span><span class="traceSpanRow__name">${esc(span.span_name || "span")}</span>${decorations.pillsHtml}</div></div>
        <div class="traceSpanRow__timeline">${bar}${critical}${eventMarkers}</div>
      </div>`;
  }

  function waterfallRowHtml(node, ctx) {
    const rowHtml = spanRowHtml(node, ctx);
    return model.openSpanIds.has(String(node.span.span_id || "")) ? rowHtml + spanInspectorRowHtml(node, ctx.cache) : rowHtml;
  }

  // Folding or unfolding one branch only removes or inserts that branch's
  // descendant rows (contiguous after it in tree order) and redraws its own
  // row; the rest of the waterfall is unchanged, so patch the DOM instead of
  // re-rendering it.
  function toggleSpanCollapse(toggle) {
    const id = String(toggle.getAttribute("data-toggle-span") || "");
    const collapsing = !model.collapsed.has(id);
    if (collapsing) model.collapsed.add(id); else model.collapsed.delete(id);
    const cache = activeTraceCache();
    const node = cache.nodeById.get(id);
    const row = toggle.closest("[data-span-id]");
    const ctx = waterfallContext(cache);
    const refocus = toggle === document.activeElement;
    if (!node || cache.duplicateIds.size || !row?.isConnected || virtualWaterfall) {
      // A virtualised list redraws its window (and may leave that mode).
      renderWaterfall();
      if (refocus) dom.traceWaterfall.querySelector(`[data-toggle-span="${window.CSS?.escape ? CSS.escape(id) : id}"]`)?.focus({ preventScroll: true });
      return;
    }
    const template = document.createElement("template");
    template.innerHTML = spanRowHtml(node, ctx).trim();
    const fresh = template.content.firstElementChild;
    row.replaceWith(fresh);
    if (refocus) fresh.querySelector("[data-toggle-span]")?.focus({ preventScroll: true });
    const own = fresh.nextElementSibling?.classList.contains("traceSpanInspectorRow") ? fresh.nextElementSibling : fresh;
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

  // Jaeger's TimelineCollapser actions, over the spans in tree order.
  function parentNodeIds(cache) {
    return cache.order.filter((node) => node.children.length).map(spanKey);
  }

  function expandAllSpans() {
    model.collapsed.clear();
    renderWaterfall();
  }

  function collapseAllSpans() {
    model.collapsed = new Set(parentNodeIds(activeTraceCache()));
    renderWaterfall();
  }

  // Expand +1: open the shallowest collapsed span of each branch.
  function expandOneLevel() {
    if (!model.collapsed.size) return;
    const next = new Set(model.collapsed);
    let expandedLevel = -1;
    let expandNext = true;
    for (const node of activeTraceCache().order) {
      if (node.level <= expandedLevel) expandNext = true;
      const id = spanKey(node);
      if (expandNext && next.has(id)) {
        next.delete(id);
        expandNext = false;
        expandedLevel = node.level;
      }
    }
    model.collapsed = next;
    renderWaterfall();
  }

  // Collapse +1: collapse the deepest open parents of each branch.
  function collapseOneLevel() {
    const cache = activeTraceCache();
    const parents = parentNodeIds(cache);
    if (parents.every((id) => model.collapsed.has(id))) return;
    const next = new Set(model.collapsed);
    let nearest = null;
    for (const node of cache.order) {
      if (nearest && node.level <= nearest.level) {
        next.add(spanKey(nearest));
        if (node.children.length) nearest = node;
      } else if (node.children.length && !next.has(spanKey(node))) {
        nearest = node;
      }
    }
    if (nearest) next.add(spanKey(nearest));
    model.collapsed = next;
    renderWaterfall();
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
    if (!node || cache.duplicateIds.has(id) || !row.isConnected || virtualWaterfall) { renderWaterfall(); return; }
    row.classList.toggle("is-active", opening);
    row.setAttribute("aria-expanded", opening ? "true" : "false");
    const next = row.nextElementSibling;
    if (next?.classList.contains("traceSpanInspectorRow")) next.remove();
    if (opening) row.insertAdjacentHTML("afterend", spanInspectorRowHtml(node, cache));
  }

  function setWaterfallLabelWidth(pct) {
    model.waterfallLabelPct = Math.max(18, Math.min(60, pct));
    dom.traceWaterfall.style.setProperty("--trace-label-width", `${model.waterfallLabelPct}%`);
  }

  // Jaeger's keyboard pan / zoom steps (fractions of the trace per key press).
  const VIEW_MIN_RANGE = 0.01;
  const VIEW_CHANGE_BASE = 0.005;
  const VIEW_CHANGE_LARGE = 0.05;

  function adjustedViewRange(startChange, endChange) {
    const [viewStart, viewEnd] = viewRangeOf();
    // A pan keeps the window width at the trace edges (Jaeger shrinks it).
    if (startChange === endChange) {
      const shift = Math.max(-viewStart, Math.min(1 - viewEnd, startChange));
      return [viewStart + shift, viewEnd + shift];
    }
    let start = Math.max(0, Math.min(0.99, viewStart + startChange));
    let end = Math.max(0.01, Math.min(1, viewEnd + endChange));
    if (end - start < VIEW_MIN_RANGE) {
      if ((startChange < 0 && endChange < 0) || (startChange > 0 && endChange > 0)) {
        end = start + VIEW_MIN_RANGE;
      } else {
        const center = viewStart + (viewEnd - viewStart) / 2;
        start = center - VIEW_MIN_RANGE / 2;
        end = center + VIEW_MIN_RANGE / 2;
      }
    }
    return [start, end];
  }

  // Jaeger's keyboard-mappings.ts: [ ] expand / collapse all, o / p one
  // level, a d or arrows pan, up / down zoom, shift for large steps.
  function onTraceKeydown(event) {
    if (!model.activeTrace || dom.traceDetail?.hidden) return;
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="menu"], [role="listbox"], [role="tab"], [data-trace-waterfall-resizer]')) return;
    const step = event.shiftKey ? VIEW_CHANGE_LARGE : VIEW_CHANGE_BASE;
    const key = String(event.key || "");
    const actions = {
      "[": expandAllSpans,
      "]": collapseAllSpans,
      o: expandOneLevel,
      p: collapseOneLevel,
    };
    const action = actions[key.length === 1 ? key.toLowerCase() : key];
    if (action) {
      event.preventDefault();
      action();
      return;
    }
    const changes = {
      a: [-step, -step],
      arrowleft: [-step, -step],
      d: [step, step],
      arrowright: [step, step],
      arrowup: [step, -step],
      arrowdown: [-step, step],
    };
    const change = changes[key.toLowerCase()];
    if (!change) return;
    event.preventDefault();
    setTraceViewRange(adjustedViewRange(change[0], change[1]), { deferred: true });
  }

  let hoveredAncestor = null;
  function setHoveredAncestor(id) {
    if (id === hoveredAncestor) return;
    const root = dom.traceWaterfall;
    for (const el of root.querySelectorAll(".is-guide-hovered")) el.classList.remove("is-guide-hovered");
    hoveredAncestor = id;
    if (id == null) return;
    const selector = `[data-ancestor-id="${window.CSS?.escape ? CSS.escape(id) : id.replace(/["\\]/g, "\\$&")}"]`;
    for (const el of root.querySelectorAll(selector)) el.classList.add("is-guide-hovered");
  }

  // Jaeger's TimelineViewingLayer: drag across the timeline header to zoom
  // into that part of the current view.
  function startTimelineDrag(header, event) {
    const rect = header.getBoundingClientRect();
    if (!rect.width) return;
    const at = (clientX) => Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const from = at(event.clientX);
    let to = from;
    const overlay = header.querySelector("[data-trace-timeline-drag]");
    header.setPointerCapture?.(event.pointerId);
    const draw = () => {
      if (!overlay) return;
      overlay.hidden = false;
      overlay.style.left = `${(Math.min(from, to) * 100).toFixed(3)}%`;
      overlay.style.width = `${(Math.abs(to - from) * 100).toFixed(3)}%`;
    };
    const finish = (commit, clientX) => {
      header.removeEventListener("pointermove", move);
      header.removeEventListener("pointerup", up);
      header.removeEventListener("pointercancel", cancel);
      if (header.hasPointerCapture?.(event.pointerId)) header.releasePointerCapture?.(event.pointerId);
      if (overlay) overlay.hidden = true;
      if (!commit) return;
      to = at(clientX);
      if (Math.abs(to - from) * rect.width < 4) return;
      const [lo, hi] = viewRangeOf();
      const span = hi - lo;
      setTraceViewRange([lo + Math.min(from, to) * span, lo + Math.max(from, to) * span]);
    };
    const move = (moveEvent) => { to = at(moveEvent.clientX); draw(); };
    const up = (upEvent) => finish(true, upEvent.clientX);
    const cancel = () => finish(false, 0);
    header.addEventListener("pointermove", move);
    header.addEventListener("pointerup", up);
    header.addEventListener("pointercancel", cancel);
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
      if (target.closest("[data-trace-collapse-all]")) { collapseAllSpans(); return; }
      if (target.closest("[data-trace-expand-all]")) { expandAllSpans(); return; }
      if (target.closest("[data-trace-collapse-one]")) { collapseOneLevel(); return; }
      if (target.closest("[data-trace-expand-one]")) { expandOneLevel(); return; }
      if (target.closest("[data-trace-critical-path]")) {
        model.criticalPathShown = !model.criticalPathShown;
        renderWaterfall();
        return;
      }
      if (target.closest("[data-trace-reset-zoom]")) { setTraceViewRange([0, 1]); return; }
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
      // Enter / Space on a toggle box is its own click.
      if (target.closest("[data-toggle-span], button, a")) return;
      const row = target.closest("[data-span-id]");
      if (row && root.contains(row) && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        toggleSpanInspector(row);
      }
    });
    root.addEventListener("mouseover", (event) => {
      const guide = event.target instanceof Element ? event.target.closest("[data-ancestor-id]") : null;
      setHoveredAncestor(guide ? String(guide.getAttribute("data-ancestor-id") || "") : null);
    });
    root.addEventListener("mouseleave", () => setHoveredAncestor(null));
    root.addEventListener("scroll", scheduleVirtualWindow, { passive: true });
    root.addEventListener("pointermove", (event) => {
      const header = event.target instanceof Element ? event.target.closest("[data-trace-timeline-header]") : null;
      const cursor = root.querySelector("[data-trace-timeline-cursor]");
      if (!cursor) return;
      if (!header) { cursor.hidden = true; return; }
      const rect = header.getBoundingClientRect();
      cursor.hidden = false;
      cursor.style.left = `${Math.max(0, Math.min(rect.width, event.clientX - rect.left)).toFixed(1)}px`;
    });
    root.addEventListener("pointerleave", () => {
      const cursor = root.querySelector("[data-trace-timeline-cursor]");
      if (cursor) cursor.hidden = true;
    });
    const setWidthFromClient = (clientX) => {
      const rect = root.getBoundingClientRect();
      if (!rect.width) return;
      setWaterfallLabelWidth(((clientX - rect.left) / rect.width) * 100);
    };
    root.addEventListener("pointerdown", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const header = target?.closest("[data-trace-timeline-header]");
      if (header && (event.button == null || event.button === 0)) {
        event.preventDefault();
        startTimelineDrag(header, event);
        return;
      }
      const resizer = target?.closest("[data-trace-waterfall-resizer]");
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
      const requested = performance.now();
      const payload = await api.searchTraces(currentHost(), filters);
      if (seq !== model.searchSeq) return;
      model.searchLatencyMs = performance.now() - requested;
      model.searched = true;
      model.lastSearchRange = { start_ms: Number(filters.start_ms), end_ms: Number(filters.end_ms) };
      unpackSearch(payload);
      renderResults();
      // Search results are intentionally delivered first. Heavy graph analytics
      // starts only after the trace list has rendered, on its own API route.
      void loadAnalytics(filters);
    } catch (error) {
      if (seq !== model.searchSeq) return;
      model.traces = [];
      model.searched = false;
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
      registerServiceColors((trace?.spans || []).map((span) => span.service_name));
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
    setView(false);
    if (!model.traces.length) search();
  }

  async function reloadForHost() {
    model.meta = null;
    model.traces = [];
    model.searched = false;
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
    model.resultsView = readStored(RESULTS_VIEW_KEY, ["list", "table"], "list");
    model.startDisplay = readStored(START_DISPLAY_KEY, ["absolute", "relative"], "absolute");
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
    document.addEventListener("keydown", onTraceKeydown);
    // The canvas overview holds resolved colours: redraw it for a new theme.
    const redrawOverview = () => {
      const graph = dom.traceOverview?.querySelector?.('[data-overview-mode="canvas"]');
      if (graph && model.activeTrace) renderTraceOverview(activeTraceCache().spans, activeTraceCache().bounds);
    };
    new MutationObserver(redrawOverview).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    window.matchMedia?.("(prefers-color-scheme: light)")?.addEventListener?.("change", redrawOverview);
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
    setView(!!id);
    if (currentHost()) reloadForHost();
  }

  ns.traces = { init, search, loadTrace };
})();
