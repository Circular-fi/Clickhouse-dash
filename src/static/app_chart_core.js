(() => {
  "use strict";

  // Shared canvas chart engine (uPlot-style): columnar Float64Array data,
  // per-pixel min/max decimation, two stacked canvases (the plot, redrawn on
  // data / size / zoom / theme changes, and a cursor overlay redrawn on every
  // pointer move), a DOM tooltip and legend. One engine for every chart of the
  // app: the Query result chart uses it first; the other charts move onto it
  // one by one (see each consumer for its migration notes).
  //
  //   const chart = ns.chartCore.create(hostEl, {
  //     xKind: "time" | "number" | "index" | "category",
  //     xs: Float64Array,                 // ascending; category: 0..n-1
  //     categories: ["a", "b"],          // category axis labels
  //     series: [{ id, label, color, values: Float64Array, nulls: Uint8Array | null, group }],
  //     type: "line" | "area" | "bar" | "points",
  //     stack: false,                     // area / bar: cumulative per group
  //   });
  //   chart.setData({ ... }), chart.update({ type, stack }), chart.setZoom(lo, hi),
  //   chart.resetZoom(), chart.setHidden(ids), chart.destroy().
  //
  // values[i] is NaN when series has no value at xs[i]. nulls[i] = 1 marks a
  // NULL (the line breaks there); a NaN without the flag is a missing row and
  // the line connects across it. nulls === null means every NaN breaks.
  const ns = window.ChDash;
  if (!ns) return;
  const { $ } = ns.dom;

  const DEFAULT_HEIGHT = 300;
  const FONT_SIZE = 11;
  const Y_TICK_SPACE = 34;
  const X_TICK_GAP = 22;
  const PAD_TOP = 10;
  const PAD_RIGHT = 14;
  const TICK_LEN = 4;
  const DRAG_MIN_PX = 4;
  const POINTS_AUTO_SPACING = 12;
  const MAX_CATEGORY_CHARS = 18;
  const LEGEND_STORE_KEY = ns.storage.KEYS.chartLegend;

  // Work counters of every chart on the page (test and profiling hooks:
  // ns.chartCore.counters(), resetCounters()). Increments only.
  const COUNTER_NAMES = ["setData", "draws", "drawMs", "layoutReads", "traces", "decimations", "tracedPoints",
    "extentScans", "stackBuilds", "legendBuilds", "legendUpdates", "allocBytes", "summarised"];
  const counters = {};
  function resetCounters() { for (const name of COUNTER_NAMES) counters[name] = 0; }
  resetCounters();

  // --- Numbers ----------------------------------------------------------------

  const COMPACT_UNITS = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];

  function compactUnitFor(maxAbs) {
    for (const [factor, suffix] of COMPACT_UNITS) if (maxAbs >= (factor === 1e3 ? 1e4 : factor)) return { factor, suffix };
    return { factor: 1, suffix: "" };
  }

  // Decimals that write step exactly: 2.5 -> 1, 0.25 -> 2, 500 -> 0.
  function decimalsFor(step) {
    const abs = Math.abs(step);
    if (!(abs > 0) || !Number.isFinite(abs)) return 0;
    for (let d = 0; d < 10; d++) {
      const scaled = abs * 10 ** d;
      if (Math.abs(scaled - Math.round(scaled)) <= 1e-7 * Math.max(1, scaled)) return d;
    }
    return 10;
  }

  function groupThousands(intText) {
    return intText.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  // Ticks share one unit and one decimal count: 0, 2.5K, 5K, 7.5K.
  function formatTick(value, step, unit) {
    if (value === 0) return "0";
    const scaled = value / unit.factor;
    const text = scaled.toFixed(decimalsFor(step / unit.factor));
    const [whole, frac] = text.split(".");
    const out = `${unit.suffix ? whole : groupThousands(whole)}${frac ? `.${frac}` : ""}`;
    return `${/^-0(?:\.0*)?$/.test(out) ? "0" : out}${unit.suffix}`;
  }

  // Exact value: every digit JavaScript round-trips, grouped (12,345.678901).
  function formatExact(value) {
    if (!Number.isFinite(value)) return "NULL";
    const abs = Math.abs(value);
    if (abs !== 0 && (abs < 1e-6 || abs >= 1e21)) return String(value);
    const text = String(value);
    const neg = text[0] === "-";
    const [whole, frac] = (neg ? text.slice(1) : text).split(".");
    return `${neg ? "-" : ""}${groupThousands(whole)}${frac ? `.${frac}` : ""}`;
  }

  // Readable value: integers grouped, fractions to 12 significant digits.
  function formatValue(value) {
    if (!Number.isFinite(value)) return "NULL";
    if (Number.isInteger(value)) return formatExact(value);
    const abs = Math.abs(value);
    if (abs !== 0 && (abs < 1e-6 || abs >= 1e15)) return value.toPrecision(6);
    return formatExact(Number(value.toPrecision(12)));
  }

  function niceStep(rawStep) {
    if (!(rawStep > 0) || !Number.isFinite(rawStep)) return 1;
    const magnitude = 10 ** Math.floor(Math.log10(rawStep));
    const normalized = rawStep / magnitude;
    const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
    return nice * magnitude;
  }

  // Round tick values inside [lo, hi] (the domain itself is not snapped).
  function linearTicks(lo, hi, targetCount, integer = false) {
    let step = niceStep((hi - lo) / Math.max(1, targetCount));
    if (integer) step = Math.max(1, Math.round(step));
    const values = [];
    const first = Math.ceil(lo / step - 1e-9);
    for (let k = first; k * step <= hi + step * 1e-9 && values.length < 100; k++) {
      const v = k * step;
      values.push(Math.abs(v) < step * 1e-9 ? 0 : Number(v.toPrecision(12)));
    }
    return { step, values };
  }

  // --- Time (browser-local, like every chart of the app) -----------------------

  const SECOND_MS = 1000, MINUTE_MS = 60000, HOUR_MS = 3600000, DAY_MS = 86400000;
  const SUB_DAY_STEPS_MS = [
    1, 2, 5, 10, 20, 50, 100, 200, 500,
    SECOND_MS, 2 * SECOND_MS, 5 * SECOND_MS, 10 * SECOND_MS, 15 * SECOND_MS, 30 * SECOND_MS,
    MINUTE_MS, 2 * MINUTE_MS, 5 * MINUTE_MS, 10 * MINUTE_MS, 15 * MINUTE_MS, 30 * MINUTE_MS,
    HOUR_MS, 2 * HOUR_MS, 3 * HOUR_MS, 6 * HOUR_MS, 12 * HOUR_MS,
  ];
  const DAY_STEPS = [1, 2, 7, 14];
  const MONTH_STEPS = [1, 2, 3, 6];
  const YEAR_STEPS = [1, 2, 5, 10, 20, 50, 100, 1000];
  const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad2 = (v) => String(v).padStart(2, "0");
  const pad3 = (v) => String(v).padStart(3, "0");

  function localMidnight(ms) {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function dateText(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  // 2026-09-30 14:05:00.000; fractionDigits 6 adds the microseconds.
  function formatInstant(ms, fractionDigits = 3) {
    if (!Number.isFinite(ms)) return "\u2014";
    const whole = Math.floor(ms);
    const d = new Date(whole);
    let text = `${dateText(whole)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
    if (fractionDigits > 0) {
      text += `.${pad3(d.getMilliseconds())}`;
      if (fractionDigits > 3) text += String(Math.min(999, Math.round((ms - whole) * 1000))).padStart(3, "0").slice(0, fractionDigits - 3);
    }
    return text;
  }

  function formatDuration(ms) {
    if (!(ms >= 0)) return "";
    if (ms < 1) return `${formatValue(Number((ms * 1000).toPrecision(4)))} \u00b5s`;
    if (ms < SECOND_MS) return `${formatValue(Number(ms.toPrecision(4)))} ms`;
    const parts = [];
    let rest = Math.round(ms);
    const units = [[DAY_MS, "d"], [HOUR_MS, "h"], [MINUTE_MS, "m"], [SECOND_MS, "s"]];
    for (const [size, suffix] of units) {
      if (rest >= size || (suffix === "s" && !parts.length)) {
        const count = suffix === "s" ? rest / size : Math.floor(rest / size);
        parts.push(suffix === "s" && !Number.isInteger(count) && parts.length === 0 ? `${count.toFixed(3).replace(/0+$/, "")}s` : `${Math.floor(count)}${suffix}`);
        rest -= Math.floor(count) * size;
      }
      if (parts.length === 2) break;
    }
    return parts.join(" ");
  }

  function utcOffsetText(ms) {
    const minutes = -new Date(Number.isFinite(ms) ? ms : Date.now()).getTimezoneOffset();
    if (minutes === 0) return "UTC";
    const sign = minutes < 0 ? "-" : "+";
    const abs = Math.abs(minutes);
    return `UTC${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
  }

  function subDayTicks(startMs, endMs, stepMs) {
    const ticks = [];
    const day = new Date(localMidnight(startMs));
    for (let guard = 0; day.getTime() <= endMs && guard < 4000; guard++) {
      const midnight = day.getTime();
      day.setDate(day.getDate() + 1);
      const next = day.getTime();
      if (stepMs >= HOUR_MS) {
        // Wall-clock hours (00:00, 06:00, 12:00...), even on DST days.
        const base = new Date(midnight);
        for (let hour = 0; hour < 24; hour += stepMs / HOUR_MS) {
          const t = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour).getTime();
          if (t >= startMs && t <= endMs && (!ticks.length || ticks[ticks.length - 1] < t)) ticks.push(t);
        }
        continue;
      }
      const first = midnight + Math.ceil(Math.max(0, startMs - midnight) / stepMs) * stepMs;
      for (let t = first; t < next && t <= endMs && ticks.length < 400; t += stepMs) ticks.push(t);
    }
    return ticks;
  }

  function dayTicks(startMs, endMs, everyDays) {
    const ticks = [];
    const day = new Date(localMidnight(startMs));
    for (let guard = 0; day.getTime() <= endMs && guard < 5000; guard++, day.setDate(day.getDate() + 1)) {
      const t = day.getTime();
      const dayNumber = Math.round(Date.UTC(day.getFullYear(), day.getMonth(), day.getDate()) / DAY_MS);
      if (t >= startMs && dayNumber % everyDays === 0) ticks.push(t);
    }
    return ticks;
  }

  function monthTicks(startMs, endMs, everyMonths) {
    const ticks = [];
    const start = new Date(startMs);
    const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
    for (let guard = 0; cursor.getTime() <= endMs && guard < 5000; guard++, cursor.setMonth(cursor.getMonth() + 1)) {
      const t = cursor.getTime();
      if (t >= startMs && (cursor.getFullYear() * 12 + cursor.getMonth()) % everyMonths === 0) ticks.push(t);
    }
    return ticks;
  }

  function yearTicks(startMs, endMs, everyYears) {
    const ticks = [];
    const first = new Date(startMs).getFullYear();
    for (let y = first; y <= first + 100000 && ticks.length < 200; y++) {
      const t = new Date(y, 0, 1).getTime();
      if (t > endMs) break;
      if (t >= startMs && y % everyYears === 0) ticks.push(t);
    }
    return ticks;
  }

  function clockText(ms, unit) {
    const d = new Date(ms);
    const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    if (unit === "minute") return hm;
    const hms = `${hm}:${pad2(d.getSeconds())}`;
    return unit === "second" ? hms : `${hms}.${pad3(d.getMilliseconds())}`;
  }

  const dayLabel = (ms) => {
    const d = new Date(ms);
    return `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`;
  };

  // Calendar-aligned ticks, the smallest step whose labels keep apart, like
  // Grafana: each tick has a label and, where the larger unit changes (and on
  // the first tick), a context line (the date under clock times, the year
  // under days) so every position reads unambiguously.
  function timeTicks(startMs, endMs, plotWidthPx, measure) {
    const span = Math.max(1e-3, endMs - startMs);
    const width = Math.max(60, plotWidthPx);
    const fits = (count, sample) => count <= 80 && width / Math.max(1, count) >= measure(sample) + X_TICK_GAP;
    const withContext = (ticks, labelOf, contextOf) => {
      let lastContext = "";
      return ticks.map((t) => {
        const context = contextOf(t);
        const out = { v: t, label: labelOf(t), context: context !== lastContext ? context : "" };
        lastContext = context;
        return out;
      });
    };
    for (const step of SUB_DAY_STEPS_MS) {
      const unit = step < SECOND_MS ? "milli" : step < MINUTE_MS ? "second" : "minute";
      const sample = unit === "milli" ? "00:00:00.000" : unit === "second" ? "00:00:00" : "00:00";
      if (!fits(span / step, sample)) continue;
      return withContext(subDayTicks(startMs, endMs, step), (t) => clockText(t, unit), (t) => `${dayLabel(t)} ${new Date(t).getFullYear()}`);
    }
    for (const days of DAY_STEPS) {
      if (!fits(span / (days * DAY_MS), "Sep 30")) continue;
      return withContext(dayTicks(startMs, endMs, days), dayLabel, (t) => String(new Date(t).getFullYear()));
    }
    const monthMs = 30.44 * DAY_MS;
    for (const months of MONTH_STEPS) {
      if (!fits(span / (months * monthMs), "Sep")) continue;
      return withContext(monthTicks(startMs, endMs, months), (t) => MONTH_NAMES[new Date(t).getMonth()], (t) => String(new Date(t).getFullYear()));
    }
    for (const years of YEAR_STEPS) {
      if (!fits(span / (years * 365.25 * DAY_MS), "2026") && years !== YEAR_STEPS[YEAR_STEPS.length - 1]) continue;
      return yearTicks(startMs, endMs, years).map((t) => ({ v: t, label: String(new Date(t).getFullYear()), context: "" }));
    }
    return [];
  }

  // --- Colours ----------------------------------------------------------------

  function parseColor(text) {
    const value = String(text || "").trim();
    let m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(value);
    if (m) {
      const a = m[4] == null ? 1 : m[4].endsWith("%") ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
      return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a };
    }
    m = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)$/.exec(value);
    if (m) return { r: Number(m[1]) * 255, g: Number(m[2]) * 255, b: Number(m[3]) * 255, a: m[4] == null ? 1 : Number(m[4]) };
    m = /^#([0-9a-f]{6})$/i.exec(value);
    if (m) {
      const n = parseInt(m[1], 16);
      return { r: n >> 16, g: (n >> 8) & 255, b: n & 255, a: 1 };
    }
    return { r: 128, g: 128, b: 128, a: 1 };
  }

  const rgba = (c, alpha = 1) => `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${+(c.a * alpha).toFixed(3)})`;
  const luminance = (c) => (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;

  // --- Shared state: theme changes and the cursor sync groups -----------------

  const live = new Set();
  const syncGroups = new Map();
  let themeWatch = null;

  function watchTheme() {
    if (themeWatch) return;
    const invalidate = () => { for (const chart of live) chart.themeChanged(); };
    const observer = new MutationObserver(invalidate);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    if (media && media.addEventListener) media.addEventListener("change", invalidate);
    // Axis labels measured before a web font arrived used the fallback face.
    if (document.fonts && document.fonts.addEventListener) document.fonts.addEventListener("loadingdone", invalidate);
    themeWatch = { observer, media, invalidate };
  }

  function lowerBound(xs, value, lo = 0, hi = xs.length) {
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] < value) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  function upperBound(xs, value, lo = 0, hi = xs.length) {
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= value) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  // --- Block summaries of long series --------------------------------------------
  //
  // A series of BLOCK_MIN_POINTS values or more is summarised per BLOCK
  // points: min, max, sum and count of its finite values, and whether all of
  // them are finite. A summary grows with the series when rows are only
  // appended (setData({ append: true })): the blocks already summed stay.
  // Extents, decimation and the legend values read whole blocks where a
  // range covers them, so a draw costs O(n / BLOCK + columns * BLOCK)
  // instead of O(n).
  const BLOCK = 64;
  const BLOCK_SHIFT = 6;
  const BLOCK_MIN_POINTS = 1 << 14;

  function newSummary() {
    return { values: null, n: 0, mins: new Float64Array(0), maxs: new Float64Array(0), sums: new Float64Array(0), counts: new Uint32Array(0), clean: new Uint8Array(0) };
  }

  // Summarise values[from block of sum.n .. n): the last, partial block is summed again.
  function extendSummary(sum, values, n) {
    const blocks = (n + BLOCK - 1) >> BLOCK_SHIFT;
    if (sum.mins.length < blocks) {
      const cap = Math.max(64, blocks * 2);
      const grow = (Type, a) => { const next = new Type(cap); next.set(a); return next; };
      sum.mins = grow(Float64Array, sum.mins);
      sum.maxs = grow(Float64Array, sum.maxs);
      sum.sums = grow(Float64Array, sum.sums);
      sum.counts = grow(Uint32Array, sum.counts);
      sum.clean = grow(Uint8Array, sum.clean);
      counters.allocBytes += cap * 29;
    }
    for (let b = sum.n >> BLOCK_SHIFT; b < blocks; b++) {
      const a = b << BLOCK_SHIFT, e = Math.min(n, a + BLOCK);
      let min = Infinity, max = -Infinity, total = 0, count = 0;
      for (let i = a; i < e; i++) {
        const v = values[i];
        if (v !== v) continue;
        if (v < min) min = v;
        if (v > max) max = v;
        total += v;
        count++;
      }
      sum.mins[b] = min;
      sum.maxs[b] = max;
      sum.sums[b] = total;
      sum.counts[b] = count;
      sum.clean[b] = count === e - a && Number.isFinite(total) ? 1 : 0;
    }
    counters.summarised += Math.max(0, n - ((sum.n >> BLOCK_SHIFT) << BLOCK_SHIFT));
    sum.values = values;
    sum.n = n;
    return sum;
  }

  // Min / max / sum / count of the finite values of [v0, v1).
  function summaryRange(sum, values, v0, v1) {
    let min = Infinity, max = -Infinity, total = 0, count = 0;
    let i = v0;
    const scan = (end) => {
      for (; i < end; i++) {
        const v = values[i];
        if (v !== v) continue;
        if (v < min) min = v;
        if (v > max) max = v;
        total += v;
        count++;
      }
    };
    const firstFull = (v0 + BLOCK - 1) >> BLOCK_SHIFT, lastFull = v1 >> BLOCK_SHIFT;
    if (firstFull >= lastFull) {
      scan(v1);
    } else {
      scan(firstFull << BLOCK_SHIFT);
      for (let b = firstFull; b < lastFull; b++) {
        if (sum.mins[b] < min) min = sum.mins[b];
        if (sum.maxs[b] > max) max = sum.maxs[b];
        total += sum.sums[b];
        count += sum.counts[b];
      }
      i = lastFull << BLOCK_SHIFT;
      scan(v1);
      counters.extentScans += (firstFull << BLOCK_SHIFT) - v0 + v1 - (lastFull << BLOCK_SHIFT) + (lastFull - firstFull);
      return { min, max, total, count };
    }
    counters.extentScans += v1 - v0;
    return { min, max, total, count };
  }

  // util.escapeHtml is the one escaper; null prints as "".
  const esc = (value) => ns.util.escapeHtml(value == null ? "" : value);

  const legendPref = () => ns.storage.pref(LEGEND_STORE_KEY, "list", { allowed: ["list", "table"] });

  function readLegendMode() {
    return legendPref().get();
  }

  function storeLegendMode(mode) {
    legendPref().set(mode);
  }

  // --- Gap bridging (Metrics) --------------------------------------------------

  // A series reported less often than the bucket has regular empty buckets:
  // NaN gaps up to `factor` times its median spacing are bridged, longer ones
  // (missing data) break the line. Returns the `nulls` flags of the series.
  function bridgeGaps(values, factor = 2) {
    const n = values.length;
    const nulls = new Uint8Array(n);
    const gaps = [];
    let prev = -1;
    for (let i = 0; i < n; i++) {
      if (values[i] !== values[i]) continue;
      if (prev >= 0) gaps.push(i - prev);
      prev = i;
    }
    gaps.sort((a, b) => a - b);
    const bridge = Math.max(1, factor * (gaps.length ? gaps[gaps.length >> 1] : 1));
    prev = -1;
    for (let i = 0; i < n; i++) {
      if (values[i] !== values[i]) continue;
      if (prev >= 0 && i - prev > bridge) nulls[prev + 1] = 1;
      prev = i;
    }
    return nulls;
  }

  // --- Extensions (module level) ---------------------------------------------------

  const instances = new WeakMap(); // chart root -> api

  // 1-2-5 ticks per decade inside [lo, hi] (lo > 0); only the powers of ten
  // past 7 ticks, and linear ticks when the range spans less than 8x.
  function logTicks(lo, hi) {
    if (!(lo > 0) || !(hi > lo)) return [];
    if (hi / lo < 8) return linearTicks(lo, hi, 4).values.filter((v) => v > 0);
    const ticks = [];
    for (let k = Math.floor(Math.log10(lo)); k <= Math.ceil(Math.log10(hi)); k++) {
      for (const m of [1, 2, 5]) {
        const v = Number((m * 10 ** k).toPrecision(12));
        if (v >= lo && v <= hi) ticks.push(v);
      }
    }
    return ticks.length > 7 ? ticks.filter((v) => Math.abs(Math.log10(v) - Math.round(Math.log10(v))) < 1e-9) : ticks;
  }

  // --- Chart ------------------------------------------------------------------

  function create(host, initial = {}) {
    const root = document.createElement("div");
    root.className = "chartCore";
    root.innerHTML = `
      <div class="chartCore__plot">
        <canvas class="chartCore__canvas" aria-hidden="true"></canvas>
        <div class="chartCore__cursor" aria-hidden="true">
          <i class="chartCore__select" hidden></i>
          <i class="chartCore__xline" hidden></i>
          <i class="chartCore__yline" hidden></i>
          <span class="chartCore__badge chartCore__selectBadge" hidden></span>
          <span class="chartCore__badge chartCore__xbadge" hidden></span>
          <span class="chartCore__badge chartCore__ybadge" hidden></span>
        </div>
        <div class="chartCore__tooltip" role="tooltip" hidden></div>
        <div class="chartCore__overlay" tabindex="0" aria-label="Chart cursor: Left / Right move it point by point (Shift: 10), Home / End jump to the ends, drag to zoom"></div>
        <i class="chartCore__probe" aria-hidden="true"></i>
      </div>
      <div class="chartCore__legend" role="group" aria-label="Series"></div>`;
    host.appendChild(root);
    const plotEl = $(".chartCore__plot", root);
    // The plot's width as the resize observer reports it (its content box,
    // floored): clientWidth rounds, so a 523.5 px plot drawn at clientWidth
    // (524) would be redrawn at 523 as soon as the observer reports it.
    const plotWidth = () => { counters.layoutReads++; return Math.floor(plotEl.getBoundingClientRect().width); };
    const baseCanvas = $("canvas", root);
    const overCanvas = $(".chartCore__overlay", root);
    const cursorEl = $(".chartCore__cursor", root);
    const selectEl = $(".chartCore__select", cursorEl);
    const xLine = $(".chartCore__xline", cursorEl);
    const yLine = $(".chartCore__yline", cursorEl);
    const selectBadge = $(".chartCore__selectBadge", cursorEl);
    const xBadge = $(".chartCore__xbadge", cursorEl);
    const yBadge = $(".chartCore__ybadge", cursorEl);
    const cursorDots = [];
    const tooltipEl = $(".chartCore__tooltip", root);
    const probe = $(".chartCore__probe", root);
    const legendEl = $(".chartCore__legend", root);
    const baseCtx = baseCanvas.getContext("2d");

    const opts = {
      height: DEFAULT_HEIGHT,
      xKind: "number",
      xs: new Float64Array(0),
      categories: [],
      series: [],
      type: "line",
      stack: false,
      xLabel: "",
      xFractionDigits: 3,
      xDateOnly: false,
      tooltip: "all",
      legend: true,
      syncKey: "",
      onZoom: null,
      onHiddenChange: null,
      tooltipFooter: null,
      ...initial,
    };
    let hidden = new Set(initial.hidden || []);
    let highlight = null;
    let legendMode = readLegendMode();
    let zoom = null; // [lo, hi] in x units
    let theme = null;
    let layout = null;
    let stacks = null; // Map id -> { top, base } for the visible series
    let cursor = null; // { px, py } css px in the plot canvas
    let cursorIndex = -1;
    let syncedX = null;
    let drag = null;
    let sizeW = 0;
    let dpr = window.devicePixelRatio || 1;
    let drawRaf = 0;
    const overlayFrame = ns.util.rafOnce(() => drawOverlay());
    let released = false;
    let pendingDraw = false;
    let destroyed = false;
    let tooltipKey = "";
    let tooltipSize = { w: 0, h: 0 };
    let stats = { points: 0, series: 0, ms: 0 };
    let observedWidth = 0;
    let widthObserved = false;
    let refreshCursor = false;

    plotEl.style.height = `${opts.height}px`;

    // --- theme -------------------------------------------------------------

    function color(value) {
      probe.style.color = "";
      probe.style.color = value;
      return parseColor(getComputedStyle(probe).color);
    }

    function readTheme() {
      const style = getComputedStyle(root);
      const text = color("var(--text)");
      const muted = color("var(--muted)");
      const panel = color("var(--panel, #0f1623)");
      const dark = luminance(panel) < 0.5;
      const family = style.fontFamily || "system-ui, sans-serif";
      const seriesColors = new Map();
      for (const s of opts.series) seriesColors.set(s.id, color(s.color || "var(--qchart-1)"));
      return {
        dark,
        text,
        muted,
        panel,
        font: `500 ${FONT_SIZE}px ${family}`,
        fontBold: `600 ${FONT_SIZE}px ${family}`,
        // Grafana: hairline grids at 9% of the text colour.
        grid: dark ? "rgba(240, 250, 255, 0.09)" : "rgba(0, 10, 23, 0.09)",
        axis: rgba(muted, 0.55),
        label: rgba(muted, 1),
        seriesColors,
      };
    }

    function seriesColor(s) {
      if (!theme.seriesColors.has(s.id)) theme.seriesColors.set(s.id, color(s.color || "var(--qchart-1)"));
      return theme.seriesColors.get(s.id);
    }

    // --- data ----------------------------------------------------------------

    const visibleSeries = () => opts.series.filter((s) => !hidden.has(s.id));
    const isStacked = () => opts.stack && (opts.type === "area" || opts.type === "bar");

    // Cumulative tops / bases of the visible series (NULL counts as 0). Bars
    // stack positive values up and negative ones down; areas just add up.
    function computeStacks() {
      if (!isStacked()) { stacks = null; return; }
      counters.stackBuilds++;
      const n = opts.xs.length;
      const state = new Map();
      stacks = new Map();
      for (const s of visibleSeries()) {
        if (ownMark(s)) continue;
        const key = s.group == null ? "" : String(s.group);
        if (!state.has(key)) state.set(key, { pos: new Float64Array(n), neg: opts.type === "bar" ? new Float64Array(n) : null });
        const st = state.get(key);
        const top = new Float64Array(n);
        const base = new Float64Array(n);
        counters.allocBytes += 16 * n;
        const values = s.values;
        for (let i = 0; i < n; i++) {
          const v = values[i];
          const value = v === v ? v : 0;
          if (st.neg && value < 0) {
            base[i] = st.neg[i];
            top[i] = st.neg[i] + value;
            st.neg[i] = top[i];
          } else {
            base[i] = st.pos[i];
            top[i] = st.pos[i] + value;
            st.pos[i] = top[i];
          }
        }
        stacks.set(s.id, { top, base });
      }
    }

    function fullDomain() {
      const fixed = fixedDomain();
      if (fixed) return fixed;
      const xs = opts.xs;
      const n = xs.length;
      if (opts.xKind === "category") return [-0.5, Math.max(0.5, n - 0.5)];
      let lo = n ? xs[0] : 0;
      let hi = n ? xs[n - 1] : 1;
      if (hi === lo) {
        const pad = opts.xKind === "time" ? MINUTE_MS : Math.max(1, Math.abs(lo) * 0.1);
        lo -= pad;
        hi += pad;
      } else if (opts.type === "bar" && n > 1) {
        // Bars are centred on their x: half a bar fits inside each edge.
        const gap = minGap(0, n);
        const half = Math.max(gap, (hi - lo) / 400) / 2;
        lo -= half;
        hi += half;
      }
      return [lo, hi];
    }

    function minGap(i0, i1) {
      const xs = opts.xs;
      let gap = Infinity;
      for (let i = i0 + 1; i < i1; i++) {
        const g = xs[i] - xs[i - 1];
        if (g > 0 && g < gap) gap = g;
      }
      return Number.isFinite(gap) ? gap : 1;
    }

    // --- layout ----------------------------------------------------------------

    // Label widths at the axis font, cached (tick labels repeat on redraws).
    const widths = new Map();
    function measure(text) {
      let w = widths.get(text);
      if (w === undefined) {
        baseCtx.font = theme.font;
        w = baseCtx.measureText(text).width;
        if (widths.size > 2000) widths.clear();
        widths.set(text, w);
      }
      return w;
    }

    // Block summaries of the long series, by series id (see extendSummary).
    // setData({ append: true }) lets each one grow with its series; any
    // other setData starts them again on their next use.
    const summaries = new Map();
    function summaryOf(s) {
      const values = s.values;
      const n = values ? values.length : 0;
      if (n < BLOCK_MIN_POINTS || s.xs || s.derived) return null;
      let sum = summaries.get(s.id);
      if (sum && sum.values === values) return sum;
      if (!sum || sum.adopt !== values || n < sum.n) {
        sum = newSummary();
        summaries.set(s.id, sum);
      }
      sum.adopt = null;
      return extendSummary(sum, values, n);
    }

    // Min / max of a value array over [v0, v1), kept while the array and the
    // range stay the same (redraws on hover-free changes, resizes, themes).
    const extents = new WeakMap();
    function extent(a, v0, v1) {
      const cached = extents.get(a);
      if (cached && cached.v0 === v0 && cached.v1 === v1) return cached;
      let min = Infinity, max = -Infinity;
      counters.extentScans += Math.max(0, v1 - v0);
      for (let i = v0; i < v1; i++) {
        const v = a[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const out = { v0, v1, min, max };
      extents.set(a, out);
      return out;
    }

    function computeLayout(width) {
      const xs = opts.xs;
      const n = xs.length;
      const [fullLo, fullHi] = fullDomain();
      let [xLo, xHi] = zoom || [fullLo, fullHi];
      if (!(xHi > xLo)) [xLo, xHi] = [fullLo, fullHi];
      // Visible indexes (one point beyond each edge so lines leave the plot).
      let i0 = opts.xKind === "category" ? Math.max(0, Math.ceil(xLo)) : lowerBound(xs, xLo);
      let i1 = opts.xKind === "category" ? Math.min(n, Math.floor(xHi) + 1) : upperBound(xs, xHi);
      const v0 = i0, v1 = i1;
      if (opts.type !== "bar" && opts.xKind !== "category") { i0 = Math.max(0, i0 - 1); i1 = Math.min(n, i1 + 1); }

      // Y domain over the visible points.
      let yMin = Infinity, yMax = -Infinity;
      const vis = visibleSeries();
      for (const s of vis) {
        const st = stacks && stacks.get(s.id);
        const [a0, a1] = s.xs ? ownRange(s, xLo, xHi) : [v0, v1];
        const sum = st ? null : summaryOf(s);
        for (const a of st ? [st.top, st.base] : [s.values]) {
          const e = sum ? summaryRange(sum, a, a0, a1) : extent(a, a0, a1);
          if (e.min < yMin) yMin = e.min;
          if (e.max > yMax) yMax = e.max;
        }
      }
      const included = includedY();
      if (included) { yMin = Math.min(yMin, included[0]); yMax = Math.max(yMax, included[1]); }
      const cellsY = cellsExtent(xLo, xHi);
      if (cellsY) { yMin = Math.min(yMin, cellsY[0]); yMax = Math.max(yMax, cellsY[1]); }
      if (!(yMin <= yMax)) { yMin = 0; yMax = 1; }
      const dataMin = yMin, dataMax = yMax;
      const pinned = isStacked() || opts.type === "bar";
      if (pinned) { yMin = Math.min(0, yMin); yMax = Math.max(0, yMax); }
      else if (yMin >= 0 && yMax - yMin > 0.25 * yMax) yMin = 0;
      else if (yMax <= 0 && yMax - yMin > 0.25 * -yMin) yMax = 0;
      if (yMax === yMin) {
        const pad = yMin === 0 ? 1 : Math.abs(yMin) * 0.1;
        yMin -= pad; yMax += pad;
      } else {
        const pad = (yMax - yMin) * 0.06;
        if (yMax !== 0 || !pinned) yMax += pad;
        if (yMin !== 0) yMin -= pad;
      }

      const xTwoLines = opts.xKind === "time" && !opts.xDateOnly;
      const bottom = xTwoLines ? 34 : 22;
      const plotH = Math.max(40, opts.height - PAD_TOP - bottom);
      const yAx = customYAxis(dataMin, dataMax, plotH);
      if (yAx) { yMin = yAx.min; yMax = yAx.max; }
      const yt = yAx ? { step: yAx.step || 0, values: yAx.ticks.map((t) => t.v) } : linearTicks(yMin, yMax, Math.max(2, Math.floor(plotH / Y_TICK_SPACE)));
      const yUnit = yUnitFor(Math.max(Math.abs(yMin), Math.abs(yMax)));
      const yLabels = yAx ? yAx.ticks.map((t) => t.label) : yt.values.map((v) => yTickLabel(v, yt.step, yUnit));
      let labelW = 0;
      for (const l of yLabels) labelW = Math.max(labelW, measure(l));
      const left = Math.ceil(Math.max(24, labelW) + 12);
      const plotW = Math.max(40, width - left - PAD_RIGHT);
      const ky = plotH / (yMax - yMin);
      const kx = plotW / (xHi - xLo);
      const L = {
        width, height: opts.height, left, top: PAD_TOP, plotW, plotH, bottom,
        xLo, xHi, yMin, yMax, kx, ky, i0, i1, v0, v1,
        yTicks: yt.values.map((v, k) => ({ v, label: yLabels[k] })), yStep: yt.step,
        xOf: (x) => left + (x - xLo) * kx,
        yOf: (y) => PAD_TOP + plotH - (y - yMin) * ky,
        xAt: (px) => xLo + (px - left) / kx,
        yAt: (py) => yMin + (PAD_TOP + plotH - py) / ky,
      };
      if (opts.yScale === "log") applyLogScale(L);
      L.xTicks = xTicks(L);
      return L;
    }

    function xTicks(L) {
      const { xLo, xHi, plotW } = L;
      if (opts.xKind === "time") {
        if (opts.xDateOnly) {
          return timeTicks(xLo, xHi, plotW, measure).filter((t) => localMidnight(t.v) === t.v).map((t) => ({ v: t.v, label: dayLabel(t.v), context: "" }));
        }
        return timeTicks(xLo, xHi, plotW, measure);
      }
      if (opts.xKind === "category") {
        const n = opts.xs.length;
        const labels = [];
        const lo = Math.max(0, Math.ceil(xLo)), hi = Math.min(n - 1, Math.floor(xHi));
        const band = plotW / Math.max(1, xHi - xLo);
        let widest = 0;
        const short = (i) => { const c = String(opts.categories[i] ?? ""); return c.length > MAX_CATEGORY_CHARS ? `${c.slice(0, MAX_CATEGORY_CHARS - 1)}\u2026` : c; };
        for (let i = lo; i <= hi && i - lo < 400; i++) widest = Math.max(widest, measure(short(i)));
        const every = Math.max(1, Math.ceil((widest + 10) / band));
        for (let i = lo; i <= hi; i += every) labels.push({ v: i, label: short(i), context: "" });
        return labels;
      }
      const sample = formatValue(Math.max(Math.abs(xLo), Math.abs(xHi)));
      const count = Math.max(2, Math.min(14, Math.floor(plotW / (measure(sample) + 36))));
      const t = linearTicks(xLo, xHi, count, opts.xKind === "index");
      const unit = compactUnitFor(Math.max(Math.abs(xLo), Math.abs(xHi)));
      return t.values.map((v) => ({ v, label: formatTick(v, t.step, unit), context: "" }));
    }

    // --- canvases --------------------------------------------------------------

    function sizeCanvas(canvas, ctx, w, h) {
      const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // Snap a css coordinate to the device pixel grid so 1px lines stay crisp.
    const crisp = (v) => (Math.round(v * dpr) + 0.5) / dpr;

    // measure: a draw asked for now (flush) measures the plot when the
    // resize observer last saw it hidden (it may just have been shown).
    function draw(measure = false) {
      drawRaf = 0;
      if (destroyed) return;
      // The width the resize observer saw last: measuring would force a
      // layout per chart (several charts redraw in one frame).
      const width = widthObserved && !(measure && !observedWidth) ? observedWidth : (observedWidth = plotWidth());
      if (!width) { pendingDraw = true; return; } // hidden: the resize observer draws on show
      pendingDraw = false;
      const t0 = performance.now();
      counters.draws++;
      released = false;
      sizeW = width;
      dpr = window.devicePixelRatio || 1;
      if (!theme) theme = readTheme();
      if (stacks === undefined || stacks === null) computeStacks();
      layout = computeLayout(width);
      sizeCanvas(baseCanvas, baseCtx, width, opts.height);
      const ctx = baseCtx;
      ctx.clearRect(0, 0, width, opts.height);
      drawAxes(ctx, layout);
      ctx.save();
      ctx.beginPath();
      ctx.rect(layout.left, layout.top - 1, layout.plotW, layout.plotH + 2);
      ctx.clip();
      let points = drawCells(ctx, layout);
      const all = visibleSeries();
      const own = all.filter(ownMark);
      const vis = own.length ? all.filter((s) => !own.includes(s)) : all;
      const perSeries = {};
      if (opts.type === "bar") points = Math.max(points, drawBars(ctx, layout, vis, perSeries));
      else {
        for (const s of vis) {
          const drawn = drawSeries(ctx, layout, s);
          perSeries[s.label] = { points: drawn, runs: runs.length };
          points = Math.max(points, drawn);
        }
      }
      points = Math.max(points, drawOwnMarks(ctx, layout, own, perSeries));
      ctx.restore();
      stats = { points, series: all.length, perSeries, ms: performance.now() - t0 };
      counters.drawMs += stats.ms;
      publish();
      publishExtras();
      drawOverlay();
      renderLegend();
      placeMarkers();
      if (refreshCursor) {
        refreshCursor = false;
        if (cursor) moveCursor(cursor);
      }
    }

    function publish() {
      const L = layout;
      root.dataset.pointsDrawn = String(stats.points);
      root.dataset.seriesDrawn = String(stats.series);
      root.dataset.xMin = String(L.xLo);
      root.dataset.xMax = String(L.xHi);
      root.dataset.yMin = String(L.yMin);
      root.dataset.yMax = String(L.yMax);
      root.dataset.zoomed = String(!!zoom);
      root.dataset.drawMs = stats.ms.toFixed(2);
      root.dataset.type = opts.type;
      // Test and debugging hooks: what each series drew and where the plot is.
      root.dataset.seriesStats = JSON.stringify(stats.perSeries);
      root.dataset.draws = String((Number(root.dataset.draws) || 0) + 1);
      root.dataset.plot = `${L.left} ${L.top} ${L.plotW} ${L.plotH}`;
      if (typeof opts.onDraw === "function") opts.onDraw({ ...stats, xLo: L.xLo, xHi: L.xHi, zoomed: !!zoom });
    }

    function drawAxes(ctx, L) {
      const { left, top, plotW, plotH } = L;
      ctx.lineWidth = 1 / dpr;
      ctx.strokeStyle = theme.grid;
      ctx.beginPath();
      for (const t of L.yTicks) {
        const y = crisp(L.yOf(t.v));
        ctx.moveTo(left, y);
        ctx.lineTo(left + plotW, y);
      }
      for (const t of L.xTicks) {
        const x = crisp(L.xOf(t.v));
        if (x < left - 0.5 || x > left + plotW + 0.5) continue;
        ctx.moveTo(x, top);
        ctx.lineTo(x, top + plotH);
      }
      ctx.stroke();
      // Zero line and baseline.
      ctx.strokeStyle = theme.axis;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const base = crisp(top + plotH);
      ctx.moveTo(left, base);
      ctx.lineTo(left + plotW, base);
      if (L.yMin < 0 && L.yMax > 0) {
        const z = crisp(L.yOf(0));
        ctx.moveTo(left, z);
        ctx.lineTo(left + plotW, z);
      }
      for (const t of L.xTicks) {
        const x = crisp(L.xOf(t.v));
        if (x < left - 0.5 || x > left + plotW + 0.5) continue;
        ctx.moveTo(x, base);
        ctx.lineTo(x, base + TICK_LEN);
      }
      ctx.stroke();

      ctx.font = theme.font;
      ctx.fillStyle = theme.label;
      ctx.textBaseline = "middle";
      ctx.textAlign = "right";
      for (const t of L.yTicks) ctx.fillText(t.label, left - 8, L.yOf(t.v));
      ctx.textBaseline = "top";
      const y1 = top + plotH + TICK_LEN + 3;
      let lastRight = -Infinity;
      let pendingContext = "";
      for (const t of L.xTicks) {
        const x = L.xOf(t.v);
        if (x < left - 0.5 || x > left + plotW + 0.5) continue;
        const w = measure(t.label);
        let cx = Math.max(w / 2 + 1, Math.min(L.width - w / 2 - 1, x));
        if (cx - w / 2 < lastRight + 6) {
          if (t.context) pendingContext = t.context;
          continue;
        }
        ctx.textAlign = "center";
        ctx.fillStyle = theme.label;
        ctx.fillText(t.label, cx, y1);
        (L.xDrawn || (L.xDrawn = [])).push([t.label, t.context || pendingContext, Math.round(cx - w / 2), Math.round(cx + w / 2)]);
        lastRight = cx + w / 2;
        const context = t.context || pendingContext;
        pendingContext = "";
        if (context) {
          const cw = measure(context);
          cx = Math.max(cw / 2 + 1, Math.min(L.width - cw / 2 - 1, x));
          ctx.font = theme.fontBold;
          ctx.fillStyle = rgba(theme.text, 0.8);
          ctx.fillText(context, cx, y1 + 14);
          ctx.font = theme.font;
          lastRight = Math.max(lastRight, cx + cw / 2);
        }
      }
    }

    function alphaFor(s) {
      return highlight && highlight !== s.id ? 0.18 : 1;
    }

    // Vertices of the series being drawn, reused across series and draws:
    // vx / vy the line, vb the stack base under it, runs the index where each
    // unbroken run starts (lines break at NULLs).
    let vx = new Float64Array(4096), vy = new Float64Array(4096), vb = new Float64Array(4096);
    let vCount = 0;
    let decimated = false;
    const runs = [];
    function vertex(x, y, b) {
      if (vCount === vx.length) {
        const grow = (a) => { const next = new Float64Array(a.length * 2); counters.allocBytes += 8 * next.length; next.set(a); return next; };
        vx = grow(vx); vy = grow(vy); vb = grow(vb);
      }
      vx[vCount] = x; vy[vCount] = y; vb[vCount] = b;
      vCount++;
    }

    // One line through the visible points, as vertices. Past two points per
    // device-pixel column, each column keeps its first, lowest, highest and
    // last value (one vertical stroke; base: false) so every peak survives at
    // any zoom, or its highest point and the matching base (base: an array,
    // for stacked areas): drawing costs O(points) arithmetic but only O(width)
    // canvas calls.
    function trace(L, ys, nulls, base, sum = null) {
      const xs = opts.xs;
      const { i0, i1, left, plotW, kx, ky, xLo, yMin } = L;
      const category = opts.xKind === "category";
      const bottom = L.top + L.plotH;
      const breakAll = !nulls;
      vCount = 0;
      runs.length = 0;
      decimated = i1 - i0 > plotW * 2;
      counters.traces++;
      if (decimated) counters.decimations++;
      if (decimated && !base) { traceColumns(L, ys, nulls, sum); return; }
      counters.tracedPoints += Math.max(0, i1 - i0);
      let pen = false;
      const start = () => { if (!pen) { runs.push(vCount); pen = true; } };
      if (!decimated) {
        for (let i = i0; i < i1; i++) {
          const v = ys[i];
          if (v !== v) {
            if (breakAll || nulls[i]) pen = false;
            continue;
          }
          start();
          vertex(left + ((category ? i : xs[i]) - xLo) * kx, bottom - (v - yMin) * ky, base ? bottom - (base[i] - yMin) * ky : 0);
        }
        return;
      }
      let col = -Infinity;
      let fy = 0, lo = 0, hi = 0, ly = 0, cx = 0, by = 0;
      let has = false;
      const flush = () => {
        if (!has) return;
        start();
        if (base) vertex(cx, lo, by);
        else {
          vertex(cx, fy, 0);
          if (lo !== fy) vertex(cx, lo, 0);
          if (hi !== lo) vertex(cx, hi, 0);
          if (ly !== hi) vertex(cx, ly, 0);
        }
        has = false;
      };
      for (let i = i0; i < i1; i++) {
        const v = ys[i];
        if (v !== v) {
          if (breakAll || nulls[i]) { flush(); pen = false; }
          continue;
        }
        const x = left + ((category ? i : xs[i]) - xLo) * kx;
        const c = Math.floor(x * dpr);
        const y = bottom - (v - yMin) * ky;
        if (c !== col) {
          flush();
          col = c;
          cx = (c + 0.5) / dpr;
          fy = lo = hi = ly = y;
          if (base) by = bottom - (base[i] - yMin) * ky;
          has = true;
        } else {
          if (y < lo) { lo = y; if (base) by = bottom - (base[i] - yMin) * ky; }
          if (y > hi) hi = y;
          ly = y;
        }
      }
      flush();
    }

    // A dense line: one entry per device-pixel column (colCount of them),
    // its centre (css px), its first and last value and its extent
    // (highest and lowest value, and the step from the previous column), in
    // plot px; colBrk marks a column after a NULL break (or the first).
    let colCount = 0;
    let colX = new Float64Array(2048), colFy = new Float64Array(2048), colLy = new Float64Array(2048);
    let colTop = new Float64Array(2048), colBot = new Float64Array(2048), colDev = new Float64Array(2048);
    let colBrk = new Uint8Array(2048);
    function column(dev, fy, lo, hi, ly, brk, prevLast) {
      if (colCount === colX.length) {
        const grow = (a) => { const next = new a.constructor(a.length * 2); counters.allocBytes += next.byteLength; next.set(a); return next; };
        colX = grow(colX); colFy = grow(colFy); colLy = grow(colLy); colTop = grow(colTop); colBot = grow(colBot); colDev = grow(colDev); colBrk = grow(colBrk);
      }
      const k = colCount++;
      colDev[k] = dev;
      colX[k] = (dev + 0.5) / dpr;
      colFy[k] = fy;
      colLy[k] = ly;
      colTop[k] = !brk && prevLast < lo ? prevLast : lo;
      colBot[k] = !brk && prevLast > hi ? prevLast : hi;
      colBrk[k] = brk ? 1 : 0;
    }

    // Per-column first / lowest / highest / last value of the visible points.
    // With a block summary (sum), a whole block of finite values that falls in
    // one column is read from the summary: O(n / BLOCK + columns * BLOCK).
    function traceColumns(L, ys, nulls, sum) {
      const xs = opts.xs;
      const { i0, i1, left, plotW, kx, ky, xLo, yMin } = L;
      const category = opts.xKind === "category";
      const bottom = L.top + L.plotH;
      const breakAll = !nulls;
      const xDev = (i) => Math.floor((left + ((category ? i : xs[i]) - xLo) * kx) * dpr);
      const useBlocks = !!sum && i1 - i0 > plotW * dpr * BLOCK * 2;
      colCount = 0;
      let col = -Infinity, fy = 0, lo = 0, hi = 0, ly = 0;
      let has = false;
      let brk = true;
      let prevLast = NaN;
      let read = 0;
      const flush = () => {
        if (!has) return;
        column(col, fy, lo, hi, ly, brk, prevLast);
        brk = false;
        prevLast = ly;
        has = false;
      };
      let i = i0;
      while (i < i1) {
        if (useBlocks && (i & (BLOCK - 1)) === 0 && i + BLOCK <= i1 && sum.clean[i >> BLOCK_SHIFT]) {
          const e = i + BLOCK;
          const c = xDev(i);
          if (c === xDev(e - 1)) {
            const b = i >> BLOCK_SHIFT;
            const top = bottom - (sum.maxs[b] - yMin) * ky;
            const low = bottom - (sum.mins[b] - yMin) * ky;
            if (c !== col || !has) {
              flush();
              col = c;
              fy = bottom - (ys[i] - yMin) * ky;
              lo = top;
              hi = low;
              has = true;
            } else {
              if (top < lo) lo = top;
              if (low > hi) hi = low;
            }
            ly = bottom - (ys[e - 1] - yMin) * ky;
            read += 3;
            i = e;
            continue;
          }
        }
        const v = ys[i];
        read++;
        if (v !== v) {
          if (breakAll || nulls[i]) { flush(); brk = true; }
          i++;
          continue;
        }
        const c = xDev(i);
        const y = bottom - (v - yMin) * ky;
        if (c !== col || !has) {
          flush();
          col = c;
          fy = lo = hi = ly = y;
          has = true;
        } else {
          if (y < lo) lo = y;
          if (y > hi) hi = y;
          ly = y;
        }
        i++;
      }
      flush();
      counters.tracedPoints += read;
    }

    // A column taller than this (css px) is drawn as a rect, flatter ones
    // as a stroked line through their first and last value.
    const TALL_PX = 2;
    const isTall = (k) => colBot[k] - colTop[k] > TALL_PX || (colBrk[k] === 1 && (k + 1 === colCount || colBrk[k + 1] === 1));

    // A dense line, from traceColumns(): each tall column is one filled,
    // pixel-aligned rect from its highest to its lowest value (and the step
    // from the previous column); runs of flat columns are one stroked line.
    // A stroke through every column's first / low / high / last value (a
    // zigzag of thousands of tall segments) took 100 ms and more to
    // rasterise per frame; the rects need no antialiasing pass.
    function drawColumns(ctx, L, s, c, alpha) {
      const n = colCount;
      const lw = 1.5;
      if (opts.fill !== false && visibleSeries().length === 1) {
        // The wash under a single series, along each column's top.
        const baseY = Math.min(L.top + L.plotH, Math.max(L.top, L.yOf(Math.max(L.yMin, Math.min(0, L.yMax)))));
        const grad = ctx.createLinearGradient(0, L.top, 0, L.top + L.plotH);
        grad.addColorStop(0, rgba(c, 0.14 * alpha));
        grad.addColorStop(1, rgba(c, 0));
        ctx.beginPath();
        for (let a = 0; a < n;) {
          let b = a + 1;
          while (b < n && !colBrk[b]) b++;
          if (b - a > 1) {
            ctx.moveTo(colX[a], colTop[a]);
            for (let k = a + 1; k < b; k++) ctx.lineTo(colX[k], colTop[k]);
            ctx.lineTo(colX[b - 1], baseY);
            ctx.lineTo(colX[a], baseY);
            ctx.closePath();
          }
          a = b;
        }
        ctx.fillStyle = grad;
        ctx.fill();
      }
      const color = rgba(c, alpha);
      ctx.fillStyle = color;
      let rects = 0;
      // A rect is the line width wide (in device pixels), cut short where
      // the next column's rect starts (no double blending when dimmed).
      const wide = Math.max(1, Math.round(lw * dpr));
      for (let k = 0; k < n; k++) {
        if (!isTall(k)) continue;
        const y0 = Math.floor((colTop[k] - lw / 2) * dpr) / dpr;
        const y1 = Math.ceil((colBot[k] + lw / 2) * dpr) / dpr;
        const w = k + 1 < n && isTall(k + 1) ? Math.min(wide, colDev[k + 1] - colDev[k]) : wide;
        ctx.fillRect((colDev[k] - ((wide - 1) >> 1)) / dpr, y0, w / dpr, y1 - y0);
        rects++;
      }
      ctx.beginPath();
      runs.length = 0;
      let vertices = 0;
      let pen = false;
      for (let k = 0; k < n; k++) {
        if (colBrk[k]) pen = false;
        if (isTall(k)) { pen = false; continue; }
        if (!pen) {
          runs.push(vertices);
          pen = true;
          if (k > 0 && !colBrk[k]) { ctx.moveTo(colX[k - 1], colLy[k - 1]); ctx.lineTo(colX[k], colFy[k]); vertices += 2; }
          else { ctx.moveTo(colX[k], colFy[k]); vertices++; }
        } else { ctx.lineTo(colX[k], colFy[k]); vertices++; }
        if (colLy[k] !== colFy[k]) { ctx.lineTo(colX[k], colLy[k]); vertices++; }
      }
      if (vertices) {
        ctx.strokeStyle = color;
        ctx.lineWidth = lw;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.stroke();
      }
      return vertices + 2 * rects;
    }

    const runEnd = (r) => (r + 1 < runs.length ? runs[r + 1] : vCount);

    function pathLine(ctx) {
      ctx.beginPath();
      for (let r = 0; r < runs.length; r++) {
        const a = runs[r], b = runEnd(r);
        ctx.moveTo(vx[a], vy[a]);
        for (let k = a + 1; k < b; k++) ctx.lineTo(vx[k], vy[k]);
      }
    }

    // Closed shapes between the line and its base (an array, or one y).
    function pathFill(ctx, baseY) {
      ctx.beginPath();
      for (let r = 0; r < runs.length; r++) {
        const a = runs[r], b = runEnd(r);
        if (b - a < 2) continue;
        ctx.moveTo(vx[a], vy[a]);
        for (let k = a + 1; k < b; k++) ctx.lineTo(vx[k], vy[k]);
        if (baseY == null) for (let k = b - 1; k >= a; k--) ctx.lineTo(vx[k], vb[k]);
        else { ctx.lineTo(vx[b - 1], baseY); ctx.lineTo(vx[a], baseY); }
        ctx.closePath();
      }
    }

    function drawSeries(ctx, L, s) {
      const c = seriesColor(s);
      const alpha = alphaFor(s);
      const type = s.type || opts.type;
      const nulls = s.nulls || null;
      const st = stacks && stacks.get(s.id);
      if (type === "area" && st) {
        // Fill between this series' top and its base, then stroke the top.
        trace(L, st.top, null, st.base);
        pathFill(ctx, null);
        ctx.fillStyle = rgba(c, 0.3 * alpha);
        ctx.fill();
        pathLine(ctx);
        ctx.strokeStyle = rgba(c, alpha);
        ctx.lineWidth = 1.25;
        ctx.lineJoin = "round";
        ctx.stroke();
        return vCount;
      }
      const count = L.v1 - L.v0;
      const showPoints = type === "points" || (type === "line" && count > 0 && count <= L.plotW / POINTS_AUTO_SPACING);
      let drawn = 0;
      if (type === "line") {
        trace(L, s.values, nulls, null, s.derived ? null : summaryOf(s));
        if (decimated) return drawColumns(ctx, L, s, c, alpha);
        drawn = vCount;
        // Grafana's "opacity" gradient: a light wash under each line.
        if (opts.fill !== false && visibleSeries().length === 1) {
          const baseY = Math.min(L.top + L.plotH, Math.max(L.top, L.yOf(Math.max(L.yMin, Math.min(0, L.yMax)))));
          const grad = ctx.createLinearGradient(0, L.top, 0, L.top + L.plotH);
          grad.addColorStop(0, rgba(c, 0.14 * alpha));
          grad.addColorStop(1, rgba(c, 0));
          pathFill(ctx, baseY);
          ctx.fillStyle = grad;
          ctx.fill();
        }
        pathLine(ctx);
        ctx.strokeStyle = rgba(c, alpha);
        ctx.lineWidth = 1.5;
        // Round joins only where angles show: a decimated line is mostly
        // vertical strokes, which rasterise much cheaper with bevels.
        ctx.lineJoin = decimated ? "bevel" : "round";
        ctx.lineCap = decimated ? "butt" : "round";
        strokeDashed(ctx, s);
        // Isolated values (a run of one point between NULLs) still show.
        if (!showPoints) {
          ctx.beginPath();
          let singles = 0;
          for (let r = 0; r < runs.length; r++) {
            const a = runs[r];
            if (runEnd(r) - a !== 1) continue;
            ctx.moveTo(vx[a] + 2.2, vy[a]);
            ctx.arc(vx[a], vy[a], 2.2, 0, Math.PI * 2);
            singles++;
          }
          if (singles) { ctx.fillStyle = rgba(c, alpha); ctx.fill(); }
        }
      }
      if (showPoints) {
        const xs = opts.xs;
        const category = opts.xKind === "category";
        ctx.beginPath();
        let dots = 0;
        for (let i = L.v0; i < L.v1 && dots < 20000; i++) {
          const v = s.values[i];
          if (v !== v) continue;
          const x = L.xOf(category ? i : xs[i]);
          const y = L.yOf(v);
          ctx.moveTo(x + 2.6, y);
          ctx.arc(x, y, 2.6, 0, Math.PI * 2);
          dots++;
        }
        ctx.fillStyle = rgba(c, alpha);
        ctx.fill();
        if (type === "points") drawn = dots;
      }
      return drawn;
    }

    // Bars centred on x; groups side by side, a group's series stacked.
    // Past one bar per 3px, each slot keeps its tallest stack. Bars are 78 %
    // opaque, with a 1 px gap between neighbours.
    const BAR_ALPHA = 0.78;
    const BAR_GAP_PX = 1;
    const barOffsets = new Map();
    function drawBars(ctx, L, vis, perSeries) {
      barOffsets.clear();
      const xs = opts.xs;
      const { v0, v1, plotW } = L;
      const n = v1 - v0;
      if (!n || !vis.length) return 0;
      const groups = [];
      for (const s of vis) {
        const key = isStacked() ? (s.group == null ? "" : String(s.group)) : s.id;
        if (!groups.includes(key)) groups.push(key);
      }
      let slotPx;
      if (opts.xKind === "category") slotPx = L.kx;
      else slotPx = n > 1 ? minGap(v0, v1) * L.kx : plotW / 2;
      const maxBars = Math.max(1, Math.floor(plotW / 3));
      let picks = null;
      if (n > maxBars) {
        picks = [];
        const bucketW = plotW / maxBars;
        let bucket = -1, best = -1, bestTotal = -Infinity;
        for (let i = v0; i < v1; i++) {
          const b = Math.floor((L.xOf(opts.xKind === "category" ? i : xs[i]) - L.left) / bucketW);
          let total = 0;
          for (const s of vis) {
            const st = stacks && stacks.get(s.id);
            const v = st ? st.top[i] - st.base[i] : s.values[i];
            if (v === v) total += Math.abs(v);
          }
          if (b !== bucket) {
            if (best >= 0) picks.push(best);
            bucket = b; best = i; bestTotal = total;
          } else if (total > bestTotal) { best = i; bestTotal = total; }
        }
        if (best >= 0) picks.push(best);
        slotPx = Math.min(slotPx, bucketW);
      }
      // Neighbouring bars keep a 1 px gap at least, however dense.
      const barW = Math.max(1, Math.min(opts.xKind === "category" ? 64 : 56, slotPx * barRatio(), slotPx >= 2 ? slotPx - BAR_GAP_PX : slotPx));
      const clusterW = barW / groups.length;
      const drawW = groups.length > 1 ? Math.max(1, clusterW - Math.min(2, clusterW * 0.15)) : barW;
      let drawnMax = 0;
      for (const s of vis) {
        const c = seriesColor(s);
        const st = stacks && stacks.get(s.id);
        const offset = (groups.indexOf(isStacked() ? (s.group == null ? "" : String(s.group)) : s.id) - (groups.length - 1) / 2) * clusterW;
        ctx.beginPath();
        let count = 0;
        const each = (i) => {
          const top = st ? st.top[i] : s.values[i];
          const bottom = st ? st.base[i] : 0;
          if (!(top === top) || top === bottom) return;
          const x = L.xOf(opts.xKind === "category" ? i : xs[i]) + offset - drawW / 2;
          const yTop = L.yOf(Math.max(top, bottom));
          const yBottom = L.yOf(Math.min(top, bottom));
          ctx.rect(x, yTop, drawW, Math.max(1 / dpr, yBottom - yTop));
          count++;
        };
        if (picks) for (const i of picks) each(i); else for (let i = v0; i < v1; i++) each(i);
        ctx.fillStyle = rgba(c, BAR_ALPHA * alphaFor(s));
        ctx.fill();
        drawnMax = Math.max(drawnMax, count);
        perSeries[s.label] = { points: count, runs: count ? 1 : 0 };
        barOffsets.set(s.id, offset);
      }
      return drawnMax;
    }

    // --- cursor overlay ------------------------------------------------------------

    function nearestIndex(px) {
      const L = layout;
      const xs = opts.xs;
      const n = xs.length;
      if (!n) return -1;
      if (opts.xKind === "category") return Math.max(0, Math.min(n - 1, Math.round(L.xAt(px))));
      const x = L.xAt(px);
      const i = lowerBound(xs, x);
      if (i <= 0) return 0;
      if (i >= n) return n - 1;
      return x - xs[i - 1] <= xs[i] - x ? i - 1 : i;
    }

    // The x readout (tooltip title, x badge). A time axis of buckets
    // (bucketMs) reads the bucket's range (ns.format.range: one format for
    // every chart); bucketAlign "center" when xs are bucket middles.
    function xReadout(i) {
      if (typeof opts.xReadout === "function") return opts.xReadout(i);
      if (opts.xKind === "category") return String(opts.categories[i] ?? "");
      const x = opts.xs[i];
      if (opts.xKind === "time" && Number(opts.bucketMs) > 0 && ns.format?.range) {
        const start = opts.bucketAlign === "center" ? x - Number(opts.bucketMs) / 2 : x;
        return ns.format.range(start, start + Number(opts.bucketMs));
      }
      if (opts.xKind === "time") return opts.xDateOnly ? dateText(x) : formatInstant(x, opts.xFractionDigits);
      if (opts.xKind === "index") return `Row ${formatExact(x)}`;
      return formatExact(x);
    }

    function scheduleOverlay() {
      overlayFrame();
    }

    // The cursor is DOM, like uPlot's: dashed lines, series points and the
    // axis readouts move with compositor-only transforms, so hovering never
    // repaints (or uploads) a canvas, whatever the devicePixelRatio.
    const show = (el, on) => { if (el.hidden === on) el.hidden = !on; };
    const place = (el, x, y) => { el.style.transform = `translate(${Math.round(x * dpr) / dpr}px, ${Math.round(y * dpr) / dpr}px)`; };
    let lastBadgeX = "";
    let lastBadgeY = "";

    // Badge and tooltip sizes come from a ResizeObserver (after the browser's
    // own layout), so a moving cursor never forces a synchronous layout; a
    // changed size re-places them on the next frame. Only the first sight of
    // an element measures it directly.
    const sizes = new WeakMap();
    const sizeObserver = typeof ResizeObserver === "function"
      ? new ResizeObserver((entries) => {
        let changed = false;
        for (const entry of entries) {
          const box = entry.borderBoxSize && entry.borderBoxSize[0];
          const w = box ? box.inlineSize : entry.target.offsetWidth;
          const h = box ? box.blockSize : entry.target.offsetHeight;
          if (!w && !h) continue; // hidden: keep the last size
          const old = sizes.get(entry.target);
          if (old && old.w === w && old.h === h) continue;
          sizes.set(entry.target, { w, h });
          changed = true;
        }
        if (!changed || destroyed) return;
        if (contentTip && !tooltipEl.hidden) placeContentTip();
        else if (cursor && !tooltipEl.hidden && tooltipKey && tooltipKey !== "marker") renderTooltip();
        scheduleOverlay();
      })
      : null;
    if (sizeObserver) for (const el of [tooltipEl, xBadge, yBadge, selectBadge]) sizeObserver.observe(el);

    function measured(el) {
      let size = sizeObserver ? sizes.get(el) : null;
      if (!size) {
        size = { w: el.offsetWidth, h: el.offsetHeight };
        if (sizeObserver && (size.w || size.h)) sizes.set(el, size);
      }
      return size;
    }

    function placeBadge(el, x, y, align, lo, hi) {
      const w = measured(el).w;
      let bx = align === "center" ? x - w / 2 : align === "right" ? x - w : x;
      bx = Math.max(lo, Math.min(hi - w, bx));
      place(el, bx, y);
    }

    function dotFor(k) {
      while (cursorDots.length <= k) {
        const dot = document.createElement("i");
        dot.className = "chartCore__dot";
        dot.hidden = true;
        cursorEl.appendChild(dot);
        cursorDots.push(dot);
      }
      return cursorDots[k];
    }

    function drawOverlay() {
      if (!layout || released) return;
      const L = layout;
      const selecting = !!(drag && drag.active);
      show(selectEl, selecting);
      show(selectBadge, selecting && opts.xKind !== "category");
      if (selecting) {
        const a = Math.max(L.left, Math.min(drag.x0, drag.x1));
        const b = Math.min(L.left + L.plotW, Math.max(drag.x0, drag.x1));
        selectEl.style.width = `${Math.max(0, b - a)}px`;
        selectEl.style.height = `${L.plotH}px`;
        place(selectEl, a, L.top);
        const lo = L.xAt(a), hi = L.xAt(b);
        const fmt = (v) => (opts.xKind === "time" ? formatInstant(v, opts.xFractionDigits).slice(11) : formatValue(Number(v.toPrecision(8))));
        if (opts.xKind !== "category") {
          selectBadge.textContent = `${fmt(lo)} \u2013 ${fmt(hi)}`;
          placeBadge(selectBadge, (a + b) / 2, L.top + 4, "center", L.left, L.left + L.plotW);
        }
      }
      const i = cursorIndex;
      const active = !!(cursor && i >= 0);
      const synced = !active && syncedX != null && opts.xKind !== "category";
      let x = 0;
      if (active) x = L.xOf(opts.xKind === "category" ? i : opts.xs[i]);
      else if (synced) x = L.xOf(syncedX);
      const xIn = (active || synced) && x >= L.left - 0.5 && x <= L.left + L.plotW + 0.5;
      show(xLine, xIn);
      if (xIn) {
        xLine.style.height = `${L.plotH}px`;
        place(xLine, x, L.top);
      }
      show(yLine, active);
      show(xBadge, active);
      show(yBadge, active);
      let used = 0;
      if (active) {
        const py = Math.max(L.top, Math.min(L.top + L.plotH, cursor.py));
        yLine.style.width = `${L.plotW}px`;
        place(yLine, L.left, py);
        // Points on every visible series at that x.
        for (const s of opts.cursorPoints === false ? [] : visibleSeries()) {
          if (s.xs) continue;
          const st = stacks && stacks.get(s.id);
          const v = st ? st.top[i] : s.values[i];
          if (!(v === v) || !(s.values[i] === s.values[i])) continue;
          const dx = opts.type === "bar" ? (barOffsets.get(s.id) || 0) : 0;
          const y = L.yOf(v);
          if (y < L.top - 1 || y > L.top + L.plotH + 1) continue;
          const dot = dotFor(used++);
          const bg = rgba(seriesColor(s), 1);
          if (dot._bg !== bg) { dot.style.background = bg; dot._bg = bg; }
          dot.classList.toggle("is-nearest", s.id === cursor.nearest);
          place(dot, x + dx, y);
          show(dot, true);
        }
        // Exact readouts on both axes.
        const xText = xReadout(i);
        if (xText !== lastBadgeX) { xBadge.textContent = xText; lastBadgeX = xText; }
        placeBadge(xBadge, x, L.top + L.plotH + 2, "center", 0, L.width);
        const yd = Math.min(10, decimalsFor(L.yStep) + 2);
        const yText = typeof opts.formatY === "function" ? opts.formatY(L.yAt(py)) : formatExact(Number(L.yAt(py).toFixed(yd)));
        if (yText !== lastBadgeY) { yBadge.textContent = yText; lastBadgeY = yText; }
        placeBadge(yBadge, L.left - 3, py - 8.5, "right", 0, L.left - 2);
        root.dataset.cursorIndex = String(i);
        root.dataset.cursorX = xText;
        root.dataset.cursorPx = String(Math.round(x * 100) / 100);
        // The pointer position this cursor was computed from (plot css px).
        root.dataset.pointerPx = String(Math.round(cursor.px * 100) / 100);
      } else {
        delete root.dataset.cursorIndex;
        delete root.dataset.cursorX;
        delete root.dataset.cursorPx;
        delete root.dataset.pointerPx;
      }
      for (let k = used; k < cursorDots.length; k++) show(cursorDots[k], false);
    }

    // --- tooltip ------------------------------------------------------------------

    function nearestSeries(i, py) {
      let best = null, bestD = Infinity;
      for (const s of visibleSeries()) {
        if (s.xs) continue;
        const st = stacks && stacks.get(s.id);
        const v = st ? st.top[i] : s.values[i];
        if (!(v === v) || !(s.values[i] === s.values[i])) continue;
        const d = Math.abs(layout.yOf(v) - py);
        if (d < bestD) { bestD = d; best = s.id; }
      }
      return best;
    }

    function renderTooltip() {
      if (!cursor || cursorIndex < 0 || opts.tooltip === "none") { tooltipEl.hidden = true; tooltipKey = ""; return; }
      const i = cursorIndex;
      const key = `${i}|${cursor.nearest}|${opts.tooltip}`;
      if (key !== tooltipKey) {
        tooltipKey = key;
        const rowsHtml = [];
        let total = 0, any = false;
        for (const s of tooltipSeries(i)) {
          if (s.xs || (opts.tooltip === "single" && s.id !== cursor.nearest)) continue;
          const v = s.values[i];
          const has = v === v;
          const isNull = !has && (s.nulls === null || s.nulls === undefined || s.nulls[i]);
          if (!has && (!isNull || opts.tooltipNulls === false)) continue; // no row for this series at this x
          if (has) { total += v; any = true; }
          const c = seriesColor(s);
          const text = has ? (typeof opts.formatValue === "function" ? opts.formatValue(v, s) : formatValue(v)) : "NULL";
          rowsHtml.push(`<span class="chartCore__tipRow${has ? "" : " is-empty"}${s.id === cursor.nearest ? " is-nearest" : ""}"><i style="background:${rgba(c)}"></i><em>${esc(s.label)}</em><b>${esc(text)}</b></span>`);
        }
        if (isStacked() && opts.tooltip !== "single" && rowsHtml.length > 1 && any) {
          rowsHtml.push(`<span class="chartCore__tipRow chartCore__tipRow--total"><i></i><em>Total</em><b>${esc(typeof opts.formatValue === "function" ? opts.formatValue(total, null) : formatValue(total))}</b></span>`);
        }
        if (!rowsHtml.length) rowsHtml.push(`<span class="chartCore__tipRow is-empty"><i></i><em>No value</em><b>\u2014</b></span>`);
        capTooltipRows(rowsHtml);
        const footer = typeof opts.tooltipFooter === "function" ? opts.tooltipFooter(i) : "";
        const title = typeof opts.tooltipTitle === "function" ? opts.tooltipTitle(i) : xReadout(i);
        tooltipEl.innerHTML = `<strong>${esc(title)}</strong>${rowsHtml.join("")}${footer ? `<small>${esc(footer)}</small>` : ""}`;
        tooltipEl.dataset.index = String(i);
        tooltipEl.hidden = false;
      }
      tooltipSize = measured(tooltipEl);
      tooltipEl.hidden = false;
      const L = layout;
      const x = L.xOf(opts.xKind === "category" ? i : opts.xs[i]);
      let lx = x + 16;
      if (lx + tooltipSize.w > L.width - 4) lx = x - 16 - tooltipSize.w;
      lx = Math.max(4, lx);
      const ty = Math.max(0, Math.min(L.height - tooltipSize.h, cursor.py - tooltipSize.h / 2));
      tooltipEl.style.transform = `translate(${Math.round(lx)}px, ${Math.round(ty)}px)`;
    }

    // --- pointer --------------------------------------------------------------------

    function localPoint(ev) {
      const box = overCanvas.getBoundingClientRect();
      return { px: ev.clientX - box.left, py: ev.clientY - box.top };
    }

    function inPlot(p) {
      const L = layout;
      return L && p.px >= L.left - 2 && p.px <= L.left + L.plotW + 2 && p.py >= L.top - 2 && p.py <= L.top + L.plotH + 2;
    }

    function moveCursor(p) {
      if (!layout || !opts.xs.length || boxDrag) return;
      if (!inPlot(p) && !(drag && drag.active)) { leaveCursor(); return; }
      if (!(drag && drag.active) && showPick(p)) return;
      const px = Math.max(layout.left, Math.min(layout.left + layout.plotW, p.px));
      cursorIndex = nearestIndex(px);
      cursor = { px, py: p.py, nearest: cursorIndex >= 0 ? nearestSeries(cursorIndex, p.py) : null };
      if (drag) {
        drag.x1 = px;
        if (!drag.active && Math.abs(drag.x1 - drag.x0) >= DRAG_MIN_PX) drag.active = true;
      }
      if (drag && drag.active) tooltipEl.hidden = true; else renderTooltip();
      scheduleOverlay();
      broadcast(cursorIndex >= 0 && opts.xKind !== "category" ? opts.xs[cursorIndex] : null);
    }

    function leaveCursor() {
      clearPick();
      if (!cursor && tooltipEl.hidden) return;
      cursor = null;
      cursorIndex = -1;
      tooltipEl.hidden = true;
      tooltipKey = "";
      scheduleOverlay();
      broadcast(null);
    }

    function broadcast(x) {
      if (!opts.syncKey) return;
      const group = syncGroups.get(opts.syncKey);
      if (!group) return;
      for (const other of group) if (other !== api && other.xKind() === opts.xKind) other.syncCursor(x);
    }

    let pendingMove = null;
    const moveFrame = ns.util.rafOnce(() => {
      if (!pendingMove) return;
      moveCursor(pendingMove);
      // Already in a frame: the crosshair and readouts move with the
      // tooltip now, not one frame behind it.
      if (overlayFrame.pending()) { overlayFrame.cancel(); drawOverlay(); }
    });
    // The selection follows every move (cheap); the cursor redraws once per frame.
    const trackDrag = (p) => {
      if (!drag || !layout) return;
      drag.x1 = Math.max(layout.left, Math.min(layout.left + layout.plotW, p.px));
      if (!drag.active && Math.abs(drag.x1 - drag.x0) >= DRAG_MIN_PX) drag.active = true;
    };
    overCanvas.addEventListener("pointermove", (ev) => {
      pendingMove = localPoint(ev);
      trackDrag(pendingMove);
      moveFrame();
    });
    overCanvas.addEventListener("pointerleave", () => {
      if (drag) return;
      pendingMove = null;
      leaveCursor();
    });
    // A press on the plot is a zoom gesture, never a text selection or a
    // native drag (which would cancel the pointer stream).
    overCanvas.addEventListener("mousedown", (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      const sel = window.getSelection ? window.getSelection() : null;
      if (sel && !sel.isCollapsed) sel.removeAllRanges();
      overCanvas.focus({ preventScroll: true });
    });
    overCanvas.addEventListener("dragstart", (ev) => ev.preventDefault());
    overCanvas.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0 || !layout) return;
      const p = localPoint(ev);
      if (!inPlot(p)) return;
      if (startBox(p, ev)) return;
      moveCursor(p);
      if (opts.zoomable === false || opts.xs.length < 2) return;
      drag = { x0: Math.max(layout.left, Math.min(layout.left + layout.plotW, p.px)), x1: p.px, active: false, id: ev.pointerId };
      try { overCanvas.setPointerCapture(ev.pointerId); } catch { /* capture is optional */ }
    });
    const endDrag = (ev, commit) => {
      if (!drag) return;
      if (ev && ev.type === "pointerup") trackDrag(localPoint(ev));
      const d = drag;
      drag = null;
      try { overCanvas.releasePointerCapture(d.id); } catch { /* already released */ }
      if (commit && d.active && layout) {
        const a = Math.min(d.x0, d.x1), b = Math.max(d.x0, d.x1);
        if (b - a >= DRAG_MIN_PX) {
          let lo = layout.xAt(a), hi = layout.xAt(b);
          if (opts.xKind === "category") { lo = Math.floor(lo + 0.5) - 0.5; hi = Math.ceil(hi - 0.5) + 0.5; }
          setZoom(lo, hi, true);
          return;
        }
      }
      scheduleOverlay();
      if (ev && ev.type === "pointerup") {
        const p = localPoint(ev);
        if (inPlot(p)) moveCursor(p); else leaveCursor();
      }
    };
    overCanvas.addEventListener("pointerup", (ev) => endDrag(ev, true));
    overCanvas.addEventListener("pointercancel", (ev) => endDrag(ev, false));
    overCanvas.addEventListener("lostpointercapture", () => { if (drag) endDrag(null, false); });
    overCanvas.addEventListener("dblclick", (ev) => {
      ev.preventDefault();
      if (zoom) resetZoom(true);
    });
    // Escape cancels a drag in progress (and is not seen by ns.layers).
    const onKey = (ev) => {
      if (ev.key === "Escape" && drag) { ev.preventDefault(); drag = null; scheduleOverlay(); }
    };
    // Keyboard cursor: the readouts point by point, without a mouse.
    overCanvas.addEventListener("keydown", (ev) => {
      if (!layout || !opts.xs.length) return;
      const L = layout;
      const last = Math.min(opts.xs.length, L.v1) - 1;
      const first = Math.min(L.v0, last);
      let i = cursorIndex >= 0 ? cursorIndex : first - 1;
      if (ev.key === "ArrowRight") i += ev.shiftKey ? 10 : 1;
      else if (ev.key === "ArrowLeft") i -= ev.shiftKey ? 10 : 1;
      else if (ev.key === "Home") i = first;
      else if (ev.key === "End") i = last;
      else if (ev.key === "Escape") { if (cursorIndex < 0) return; ev.preventDefault(); leaveCursor(); return; }
      else return;
      ev.preventDefault();
      i = Math.max(first, Math.min(last, i));
      const px = L.xOf(opts.xKind === "category" ? i : opts.xs[i]);
      const s = visibleSeries().find((x) => !x.xs && x.values[i] === x.values[i]);
      const st = s && stacks && stacks.get(s.id);
      const py = s ? L.yOf(st ? st.top[i] : s.values[i]) : L.top + L.plotH / 2;
      moveCursor({ px, py });
      // A hover readout is not announced; the keyboard cursor's is (one polite region).
      if (!tooltipEl.hidden) ns.uiState?.announce?.(tooltipEl.textContent);
    });
    overCanvas.addEventListener("blur", () => { if (!drag) leaveCursor(); });
    document.addEventListener("keydown", onKey, true);

    // --- legend (Grafana: click isolates, Ctrl / Cmd+click toggles) ---------------------

    function calcs(s) {
      const L = layout;
      let min = Infinity, max = -Infinity, sum = 0, count = 0, last = NaN;
      const a = L && !s.xs ? L.v0 : 0, b = L && !s.xs ? L.v1 : s.values.length;
      const summary = summaryOf(s);
      if (summary) {
        const r = summaryRange(summary, s.values, a, b);
        for (let i = b - 1; i >= a; i--) if (s.values[i] === s.values[i]) { last = s.values[i]; break; }
        return r.count ? { min: r.min, max: r.max, mean: r.total / r.count, last } : { min: NaN, max: NaN, mean: NaN, last: NaN };
      }
      for (let i = a; i < b; i++) {
        const v = s.values[i];
        if (v !== v) continue;
        if (v < min) min = v;
        if (v > max) max = v;
        sum += v;
        count++;
        last = v;
      }
      return count ? { min, max, mean: sum / count, last } : { min: NaN, max: NaN, mean: NaN, last: NaN };
    }

    function legendItemHtml(s, index) {
      const on = !hidden.has(s.id);
      const c = rgba(seriesColor(s));
      const title = `${s.label}\n${legendHint()}`;
      return `<button type="button" class="chartCore__legendItem${s.dash ? " is-dashed" : ""}" data-index="${index}" aria-pressed="${on}" title="${esc(title)}"><i style="background:${c}"></i><span>${esc(s.label)}</span></button>`;
    }

    // "totals" legend: each series with its total over the whole range; a
    // click goes to opts.onLegendClick(series, event) (a filter, say) and
    // opts.legendPressed(series) says which are on.
    function seriesTotal(s) {
      let sum = 0;
      for (let i = 0; i < s.values.length; i++) { const v = s.values[i]; if (v === v) sum += v; }
      return sum;
    }

    // The legend reads at full strength; once some series are pressed (a
    // filter), the others are left out and dim (is-off).
    function legendTotalItemHtml(s, index, anyPressed) {
      const pressed = typeof opts.legendPressed === "function" ? !!opts.legendPressed(s) : false;
      const c = rgba(seriesColor(s));
      const total = typeof opts.legendTotal === "function" ? opts.legendTotal(s, seriesTotal(s)) : formatValue(seriesTotal(s));
      const title = typeof opts.legendTitle === "function" ? opts.legendTitle(s, pressed) : s.label;
      return `<button type="button" class="chartCore__legendItem chartCore__legendItem--total${anyPressed && !pressed ? " is-off" : ""}" data-index="${index}" data-series="${esc(s.id)}" aria-pressed="${pressed}" title="${esc(title)}"><i style="background:${c}"></i><span>${esc(s.label)}</span><b>${esc(total)}</b></button>`;
    }

    // The legend markup is rebuilt only when it changes (a resize, a theme
    // change or streamed rows redraw the plot, not the legend): the values
    // of the min / max / mean / last table are written into its cells.
    let legendHtml = null;
    function setLegendHtml(html) {
      if (html === legendHtml) return false;
      counters.legendBuilds++;
      legendHtml = html;
      legendEl.innerHTML = html;
      return true;
    }

    // The legend shows by default as soon as there is more than one series
    // ("always": even for one; false: never; "totals": the totals legend).
    function renderLegend() {
      const totals = opts.legend === "totals";
      const shown = totals || opts.legend === "always" || (!!opts.legend && opts.series.length > 1);
      if (!shown || !opts.series.length) { setLegendHtml(""); legendEl.hidden = true; return; }
      legendEl.hidden = false;
      if (totals) {
        legendEl.dataset.mode = "totals";
        // legendOrder "reverse": a stack's top series first.
        const anyPressed = typeof opts.legendPressed === "function" && opts.series.some((s) => !!opts.legendPressed(s));
        const items = opts.series.map((s, index) => legendTotalItemHtml(s, index, anyPressed));
        if (opts.legendOrder === "reverse") items.reverse();
        setLegendHtml(`<div class="chartCore__legendList">${items.join("")}</div>`);
        return;
      }
      legendEl.dataset.mode = legendMode;
      const modeBtn = `<button type="button" class="chartCore__legendMode" aria-pressed="${legendMode === "table"}" title="${legendMode === "table" ? "Show the legend as a list" : "Show min / max / mean / last per series"}">${legendMode === "table" ? "List" : "Values"}</button>`;
      if (legendMode === "table") {
        const fmt = (v) => (v === v ? (typeof opts.formatValue === "function" ? opts.formatValue(v) : formatValue(v)) : "\u2014");
        const rows = opts.series.map((s, index) => `<tr><th scope="row">${legendItemHtml(s, index)}</th><td></td><td></td><td></td><td></td></tr>`).join("");
        setLegendHtml(`<div class="chartCore__legendTableWrap"><table class="chartCore__legendTable"><thead><tr><th scope="col">Series</th><th scope="col">Min</th><th scope="col">Max</th><th scope="col">Mean</th><th scope="col">Last</th></tr></thead><tbody>${rows}</tbody></table></div>${modeBtn}`);
        const body = $(".chartCore__legendTable tbody", legendEl);
        opts.series.forEach((s, index) => {
          const row = body && body.rows[index];
          if (!row) return;
          const c = calcs(s);
          [c.min, c.max, c.mean, c.last].forEach((v, k) => {
            const cell = row.cells[k + 1];
            const text = fmt(v);
            if (cell.textContent !== text) { cell.textContent = text; counters.legendUpdates++; }
          });
        });
      } else {
        setLegendHtml(`<div class="chartCore__legendList">${opts.series.map(legendItemHtml).join("")}</div>${modeBtn}`);
      }
    }

    function setHiddenInternal(next, focusIndex) {
      hidden = next;
      stacks = null;
      tooltipKey = "";
      if (typeof opts.onHiddenChange === "function") opts.onHiddenChange(new Set(hidden));
      flushDraw(true);
      if (focusIndex != null) {
        const again = $(`.chartCore__legendItem[data-index="${focusIndex}"]`, legendEl);
        if (again) again.focus({ preventScroll: true });
      }
    }

    legendEl.addEventListener("click", (ev) => {
      const mode = ev.target.closest(".chartCore__legendMode");
      if (mode) {
        legendMode = legendMode === "table" ? "list" : "table";
        storeLegendMode(legendMode);
        renderLegend();
        const again = $(".chartCore__legendMode", legendEl);
        if (again) again.focus({ preventScroll: true });
        return;
      }
      const item = ev.target.closest(".chartCore__legendItem");
      if (!item) return;
      const index = Number(item.dataset.index);
      const s = opts.series[index];
      if (!s) return;
      if (opts.legend === "totals") {
        if (typeof opts.onLegendClick === "function") opts.onLegendClick(s, ev);
        return;
      }
      const ids = opts.series.map((x) => x.id);
      const next = new Set(hidden);
      if (legendToggles(ev)) {
        if (next.has(s.id)) next.delete(s.id); else next.add(s.id);
        if (next.size === ids.length) next.delete(s.id);
      } else {
        const isolated = !hidden.has(s.id) && hidden.size === ids.length - 1;
        next.clear();
        if (!isolated) for (const id of ids) if (id !== s.id) next.add(id);
      }
      setHiddenInternal(next, index);
    });
    legendEl.addEventListener("pointerover", (ev) => {
      const item = ev.target.closest(".chartCore__legendItem");
      const s = item ? opts.series[Number(item.dataset.index)] : null;
      const next = s && !hidden.has(s.id) && visibleSeries().length > 1 ? s.id : null;
      if (next !== highlight) { highlight = next; scheduleDraw(); }
    });
    legendEl.addEventListener("pointerleave", () => {
      if (highlight) { highlight = null; scheduleDraw(); }
    });

    // --- zoom --------------------------------------------------------------------------

    function setZoom(lo, hi, fromUser = false) {
      const [fullLo, fullHi] = fullDomain();
      let a = Math.max(fullLo, Math.min(lo, hi));
      let b = Math.min(fullHi, Math.max(lo, hi));
      if (!(b > a)) return;
      if (a <= fullLo && b >= fullHi) { resetZoom(fromUser); return; }
      zoom = [a, b];
      tooltipKey = "";
      refreshCursor = true;
      // A gesture draws now (one per gesture); data changes wait for the frame.
      flushDraw(true);
      if (typeof opts.onZoom === "function") opts.onZoom([a, b], fromUser);
    }

    function resetZoom(fromUser = false) {
      if (!zoom) return;
      zoom = null;
      tooltipKey = "";
      flushDraw(true);
      if (typeof opts.onZoom === "function") opts.onZoom(null, fromUser);
    }

    // --- Options for the Logs histogram and the Metrics panels ------------------------------
    //
    //   xDomain: [lo, hi]          the full x domain (the requested time range), not the data's
    //   yInclude: [v, ...]         values the y domain always covers (0, exemplar values)
    //   yUnit(maxAbs)              -> { factor, suffix }: the y tick unit (default K / M / B / T)
    //   formatY(v)                 the y readout of the cursor
    //   barWidthRatio              bar width / slot width (default 0.72)
    //   series[].dash: [6, 3]      dashed line (and legend swatch)
    //   tooltipTitle(i)            the tooltip heading (default: the x readout)
    //   tooltipSort: "desc" | "reverse"   rows by value, or bottom-of-stack last
    //   tooltipMaxRows             rows past it fold into "+N more"
    //   tooltipNulls: false        no "NULL" rows (gap flags from bridgeGaps are not values)
    //   legendClick: "toggle"      click shows / hides, Alt / Ctrl / Cmd+click isolates
    //   cursorPoints: false        no points on the series under the cursor (stacked bars)
    //   markers: [{ x, y, href, className, label, attrs, tooltip() }]
    //                              DOM links over the plot (exemplars): y not finite sits on a
    //                              strip along the bottom; a marker overlapping one placed
    //                              before it (markerSpacing px, default 9) is skipped.

    function fixedDomain() {
      const d = opts.xDomain;
      return d && Number.isFinite(d[0]) && Number.isFinite(d[1]) && d[1] > d[0] ? [d[0], d[1]] : null;
    }

    function includedY() {
      const list = opts.yInclude;
      if (!list || !list.length) return null;
      let lo = Infinity, hi = -Infinity;
      for (const v of list) {
        if (!Number.isFinite(v)) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      return lo <= hi ? [lo, hi] : null;
    }

    function yUnitFor(maxAbs) {
      const unit = typeof opts.yUnit === "function" ? opts.yUnit(maxAbs) : null;
      return unit && unit.factor > 0 ? { factor: unit.factor, suffix: String(unit.suffix || "") } : compactUnitFor(maxAbs);
    }

    function strokeDashed(ctx, s) {
      const dash = Array.isArray(s.dash) && s.dash.length ? s.dash : null;
      if (dash) ctx.setLineDash(dash);
      ctx.stroke();
      if (dash) ctx.setLineDash([]);
    }

    const barRatio = () => (opts.barWidthRatio > 0 && opts.barWidthRatio <= 1 ? opts.barWidthRatio : 0.72);

    function tooltipSeries(i) {
      const list = visibleSeries();
      if (opts.tooltipSort === "reverse") return list.reverse();
      if (opts.tooltipSort === "desc") {
        const value = (s) => (s.values[i] === s.values[i] ? s.values[i] : -Infinity);
        return list.sort((a, b) => value(b) - value(a));
      }
      return list;
    }

    function capTooltipRows(rows) {
      const max = opts.tooltipMaxRows;
      if (!(max > 0)) return;
      const total = rows.length && rows[rows.length - 1].includes("chartCore__tipRow--total") ? rows.pop() : null;
      if (rows.length > max) {
        const more = rows.length - max;
        rows.length = max;
        rows.push(`<span class="chartCore__tipRow chartCore__tipRow--more"><i></i><em>+${more} more</em><b></b></span>`);
      }
      if (total) rows.push(total);
    }

    const legendHint = () => (opts.legendClick === "toggle"
      ? "Click: show or hide it\nAlt / Ctrl / Cmd+click: show only this series (again: show all)"
      : "Click: show only this series (again: show all)\nCtrl / Cmd+click: show or hide it");

    function legendToggles(ev) {
      const modified = ev.ctrlKey || ev.metaKey || (opts.legendClick === "toggle" && ev.altKey);
      return opts.legendClick === "toggle" ? !modified : modified;
    }

    // Markers: diamonds drawn on the plot canvas, under a pool of transparent
    // links (moved, never rebuilt, on redraws) that take the pointer and the
    // keyboard. The links paint nothing until hovered or focused, and sit at
    // left / top (no transform), so hundreds of them add no compositing work.
    let markerLayer = null;
    const markerNodes = [];

    function markerNode(k) {
      while (markerNodes.length <= k) {
        const node = document.createElement("a");
        node.className = "chartCore__marker";
        node.hidden = true;
        node.appendChild(document.createElement("i"));
        markerLayer.appendChild(node);
        markerNodes.push(node);
      }
      return markerNodes[k];
    }

    function configureMarker(node, m) {
      if (node._marker === m) return;
      if (node._marker && node._marker.attrs) for (const name of Object.keys(node._marker.attrs)) node.removeAttribute(name);
      node._marker = m;
      node.className = `chartCore__marker${m.className ? ` ${m.className}` : ""}`;
      if (m.href) node.setAttribute("href", m.href); else node.removeAttribute("href");
      if (m.label) node.setAttribute("aria-label", m.label); else node.removeAttribute("aria-label");
      if (m.attrs) for (const [name, value] of Object.entries(m.attrs)) node.setAttribute(name, String(value == null ? "" : value));
    }

    // Dense markers are sampled: past one per MARKER_DENSE_PX of plot width,
    // each column of that width keeps its highest marker (the slowest
    // exemplar), so a long range shows a readable scatter, not a row of
    // diamonds. Every marker of a column stays reachable by zooming in.
    const MARKER_DENSE_PX = 24;
    function sampleMarkers(list, L) {
      const inView = [];
      for (const m of list) {
        const x = L.xOf(Number(m.x));
        if (x >= L.left - 0.5 && x <= L.left + L.plotW + 0.5) inView.push([m, x]);
      }
      const cap = Math.max(1, Math.floor(L.plotW / MARKER_DENSE_PX));
      root.dataset.markersInView = String(inView.length);
      if (inView.length <= cap) return inView.map(([m]) => m);
      const columns = new Map();
      for (const [m, x] of inView) {
        const col = Math.floor((x - L.left) / MARKER_DENSE_PX);
        const y = m.y == null ? -Infinity : Number(m.y);
        const held = columns.get(col);
        if (!held || (Number.isFinite(y) ? y : -Infinity) > held[1]) columns.set(col, [m, Number.isFinite(y) ? y : -Infinity]);
      }
      return [...columns.values()].map(([m]) => m);
    }

    function placeMarkers() {
      const list = Array.isArray(opts.markers) ? opts.markers : [];
      if (!markerLayer) {
        if (!list.length) return;
        markerLayer = document.createElement("div");
        markerLayer.className = "chartCore__markers";
        plotEl.appendChild(markerLayer);
        bindMarkers();
      }
      const L = layout;
      let used = 0;
      if (L) {
        const spacing = opts.markerSpacing > 0 ? opts.markerSpacing : 9;
        // Placed markers by grid cell: an overlap test looks at 9 cells only.
        const placed = new Map();
        const free = (x, y) => {
          const cx = Math.floor(x / spacing), cy = Math.floor(y / spacing);
          for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
            for (const p of placed.get(`${cx + dx},${cy + dy}`) || []) {
              if (Math.abs(p[0] - x) < spacing && Math.abs(p[1] - y) < spacing) return false;
            }
          }
          return true;
        };
        const bottom = L.top + L.plotH - 5;
        for (const m of sampleMarkers(list, L)) {
          const x = L.xOf(Number(m.x));
          if (!(x >= L.left - 0.5 && x <= L.left + L.plotW + 0.5)) continue;
          const yv = m.y == null ? NaN : Number(m.y);
          const y = Number.isFinite(yv) ? L.yOf(yv) : bottom;
          if (y < L.top - 1 || y > L.top + L.plotH + 1 || !free(x, y)) continue;
          const key = `${Math.floor(x / spacing)},${Math.floor(y / spacing)}`;
          if (!placed.has(key)) placed.set(key, []);
          placed.get(key).push([x, y]);
          const node = markerNode(used++);
          configureMarker(node, m);
          const left = `${Math.round(x * dpr) / dpr}px`, top = `${Math.round(y * dpr) / dpr}px`;
          if (node.style.left !== left) node.style.left = left;
          if (node.style.top !== top) node.style.top = top;
          if (node.hidden) node.hidden = false;
        }
        if (used) drawMarkerMarks(L, used);
      }
      for (let k = used; k < markerNodes.length; k++) if (!markerNodes[k].hidden) markerNodes[k].hidden = true;
      root.dataset.markers = String(used);
    }

    // One path for every diamond: 3.5px half-diagonal, a panel-coloured rim.
    function drawMarkerMarks(L, count) {
      if (released || !theme) return;
      if (!theme.markerFill) theme.markerFill = rgba(color("color-mix(in srgb, var(--text) 82%, transparent)"));
      const ctx = baseCtx;
      const r = 4.2;
      ctx.save();
      ctx.beginPath();
      ctx.rect(L.left - r, L.top - r, L.plotW + 2 * r, L.plotH + 2 * r);
      ctx.clip();
      ctx.beginPath();
      for (let k = 0; k < count; k++) {
        const node = markerNodes[k];
        const x = parseFloat(node.style.left), y = parseFloat(node.style.top);
        ctx.moveTo(x, y - r);
        ctx.lineTo(x + r, y);
        ctx.lineTo(x, y + r);
        ctx.lineTo(x - r, y);
        ctx.closePath();
      }
      ctx.fillStyle = theme.markerFill;
      ctx.strokeStyle = rgba(theme.panel);
      ctx.lineWidth = 1.25;
      ctx.lineJoin = "miter";
      ctx.stroke();
      ctx.fill();
      ctx.restore();
    }

    function showMarkerTip(node) {
      const m = node._marker;
      if (!m || !layout) return;
      leaveCursor();
      const html = typeof m.tooltip === "function" ? m.tooltip() : esc(m.label || "");
      if (!html) return;
      tooltipEl.innerHTML = html;
      tooltipEl.hidden = false;
      tooltipKey = "marker";
      const w = tooltipEl.offsetWidth, h = tooltipEl.offsetHeight;
      const L = layout;
      const x = L.xOf(Number(m.x));
      const yv = m.y == null ? NaN : Number(m.y);
      const y = Number.isFinite(yv) ? L.yOf(yv) : L.top + L.plotH - 5;
      let lx = x + 14;
      if (lx + w > L.width - 4) lx = x - 14 - w;
      lx = Math.max(4, lx);
      const ty = Math.max(0, Math.min(L.height - h, y - h / 2));
      tooltipEl.style.transform = `translate(${Math.round(lx)}px, ${Math.round(ty)}px)`;
    }

    function hideMarkerTip() {
      if (tooltipKey !== "marker") return;
      tooltipEl.hidden = true;
      tooltipKey = "";
    }

    function bindMarkers() {
      const target = (ev) => (ev.target instanceof Element ? ev.target.closest(".chartCore__marker") : null);
      markerLayer.addEventListener("pointerover", (ev) => { const node = target(ev); if (node) showMarkerTip(node); });
      markerLayer.addEventListener("pointerout", (ev) => {
        const node = target(ev);
        if (node && !(ev.relatedTarget instanceof Node && node.contains(ev.relatedTarget))) hideMarkerTip();
      });
      markerLayer.addEventListener("focusin", (ev) => { const node = target(ev); if (node) showMarkerTip(node); });
      markerLayer.addEventListener("focusout", hideMarkerTip);
      markerLayer.addEventListener("click", (ev) => {
        const node = target(ev);
        if (node && typeof opts.onMarkerClick === "function") opts.onMarkerClick(node._marker, ev);
      });
    }

    // --- lifecycle -------------------------------------------------------------------------

    function scheduleDraw() {
      if (!drawRaf && !destroyed) drawRaf = requestAnimationFrame(() => draw());
    }

    // Redraw when the width changes or when the chart shows again after a
    // draw was skipped (hidden panel) or its canvases were released.
    const resizeObserver = typeof ResizeObserver === "function"
      ? new ResizeObserver((entries) => {
        const width = Math.floor(entries[entries.length - 1].contentRect.width);
        observedWidth = width;
        widthObserved = true;
        if (!width) { release(); return; }
        if (width !== sizeW || released || pendingDraw) scheduleDraw();
      })
      : null;
    if (resizeObserver) resizeObserver.observe(plotEl);

    let dprQuery = null;
    const onDpr = () => { watchDpr(); scheduleDraw(); };
    function watchDpr() {
      if (dprQuery) dprQuery.removeEventListener("change", onDpr);
      dprQuery = window.matchMedia ? window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`) : null;
      if (dprQuery && dprQuery.addEventListener) dprQuery.addEventListener("change", onDpr);
    }
    watchDpr();

    // A hidden chart gives its canvas memory back; it redraws when shown.
    function release() {
      if (released) return;
      released = true;
      for (const canvas of [baseCanvas]) { canvas.width = 0; canvas.height = 0; }
      sizeW = 0;
      leaveCursor();
      cancelBox();
    }

    // Every change draws once, on the next animation frame: several setData
    // calls in a frame (a streamed result, a zoom reset with new data) cost
    // one draw. next.append: the arrays only grew at their end since the last
    // setData (rows appended), so the block summaries grow instead of being
    // computed again. Reading layout(), stats(), points() or toClient()
    // draws a pending change first.
    function setData(next = {}) {
      counters.setData++;
      const appended = next.append === true;
      delete next.append;
      Object.assign(opts, next);
      if (appended) {
        for (const ser of opts.series) {
          const sum = summaries.get(ser.id);
          if (sum && sum.values !== ser.values) sum.adopt = ser.values;
        }
      } else summaries.clear();
      if (next.hidden) hidden = new Set(next.hidden);
      if (next.height) plotEl.style.height = `${opts.height}px`;
      if ("zoom" in next) zoom = next.zoom;
      // Keep a zoom while it still overlaps the data (streaming results).
      if (zoom) {
        const [lo, hi] = fullDomain();
        if (zoom[1] <= lo || zoom[0] >= hi) zoom = null;
      }
      stacks = null;
      if (theme) for (const s of opts.series) if (!theme.seriesColors.has(s.id)) theme.seriesColors.set(s.id, color(s.color || "var(--qchart-1)"));
      tooltipKey = "";
      if (cursorIndex >= opts.xs.length) leaveCursor();
      refreshCursor = true;
      scheduleDraw();
    }

    // Draws a scheduled change now (force: even when none is scheduled).
    function flushDraw(force = false) {
      if (destroyed || (!drawRaf && !force)) return;
      if (drawRaf) { cancelAnimationFrame(drawRaf); drawRaf = 0; }
      draw(true);
    }

    function themeChanged() {
      theme = null;
      widths.clear();
      tooltipKey = "";
      scheduleDraw();
    }

    function destroy() {
      destroyed = true;
      live.delete(api);
      if (opts.syncKey && syncGroups.has(opts.syncKey)) syncGroups.get(opts.syncKey).delete(api);
      if (resizeObserver) resizeObserver.disconnect();
      if (sizeObserver) sizeObserver.disconnect();
      if (dprQuery) dprQuery.removeEventListener("change", onDpr);
      document.removeEventListener("keydown", onKey, true);
      if (drawRaf) cancelAnimationFrame(drawRaf);
      overlayFrame.cancel();
      moveFrame.cancel();
      destroyExtras();
      release();
      root.remove();
    }

    // --- Extensions: own-x and per-point marks, picking, heatmap cells, custom /
    // log y axes, annotation markers, regions, 2-D brush (first used by the
    // Traces charts). Every option is optional: without them the chart behaves
    // as described above.
    //
    //   series[k].type        "line" | "area" | "points" | "bar": the series' own mark
    //                         (a line over bars, points over lines).
    //   series[k].xs          its own ascending x column (a scatter over the
    //                         shared-x series): it counts for the y domain, not
    //                         for the cursor snap, cursor dots or tooltip rows.
    //   series[k].radius      points: px, one number or a Float64Array per point.
    //   series[k].pointColor  points: (i) => CSS colour of point i (null: the series').
    //   series[k].fillAlpha   points: fill opacity (0.5; outlines at 0.85).
    //   series[k].pickable    points: hovering picks the point under the pointer
    //                         (within 3 px of its edge; the closer, smaller one wins).
    //   pick(pt)              custom picking, pt = { px, py, x, y }: a hit object
    //                         ({ key, x, px, py, r } all optional) or null.
    //   pickTooltip(hit)      { title, rows: [{ label, value, color, className }], footer }.
    //   onPick(hit)           a click on a hit (the pointer shows it is clickable).
    //   xReadout(i)           text of x index i (x badge, and the tooltip title
    //                         without tooltipTitle).
    //   yTickFormat(v, step)  y tick labels.
    //   yAxis(min, max, plotH) -> { min, max, ticks: [{ v, label }], step }: the y
    //                         domain and ticks from the data extent.
    //   yScale: "log"         log y (positive values; ticks 1-2-5 per decade).
    //   cells: { x0, x1, y0, y1: Float64Array, level: Uint8Array, palette: [CSS colours] }
    //                         heatmap cells: one rect each, palette[level - 1] (0: none).
    //   annotations: [{ x, label, title, className }]   vertical annotation lines
    //                         with a label (releases); markers are the exemplar links.
    //   regions: [{ id, x0, x1, y0, y1, className, hidden }]   persistent boxes in data
    //                         units (no y0 / y1: the plot height); setRegions(list).
    //   brush: "xy"           a drag (or a click) selects a box instead of zooming:
    //                         brushSnap(range) -> range, brushTooltip(range) -> tooltip,
    //                         onBrush(range) on release, range = { x0, x1, y0, y1 };
    //                         brushClass styles the box.
    //   keyboard: false       no keyboard cursor (the host element handles keys).
    // (The x domain, the y readout and the NULL rows are the xDomain, formatY
    // and tooltipNulls options above.)
    // API: setRegions(list), showTooltip(content, px, py), hideTooltip(),
    // points(id) -> [{ index, x, y, r }] (plot px), toClient(x, y) -> { x, y }.

    const annotationsEl = document.createElement("div");
    annotationsEl.className = "chartCore__annotations";
    annotationsEl.setAttribute("aria-hidden", "true");
    plotEl.appendChild(annotationsEl);
    const pickRing = document.createElement("i");
    pickRing.className = "chartCore__pick";
    pickRing.hidden = true;
    cursorEl.appendChild(pickRing);
    const boxEl = document.createElement("i");
    boxEl.className = "chartCore__box";
    boxEl.hidden = true;
    cursorEl.appendChild(boxEl);
    const annotationEls = [];
    const regionEls = new Map();
    const pickPoints = new Map(); // series id -> { index, px, py, r } arrays of the last draw
    let pickHit = null;
    let boxDrag = null;
    const boxFrame = ns.util.rafOnce((p) => updateBox(p));
    let press = null;
    if (opts.keyboard === false) overCanvas.removeAttribute("tabindex");
    if (opts.brush === "xy") overCanvas.style.touchAction = "none";

    const pointsMark = (s) => s.type === "points" || (!!s.xs && !s.type);
    function ownMark(s) {
      if (opts.yScale === "log" || s.xs) return true;
      if (s.type === "points") return s.radius != null || typeof s.pointColor === "function" || !!s.pickable;
      return opts.type === "bar" && !!s.type && s.type !== "bar";
    }

    function ownRange(s, lo, hi) {
      return [lowerBound(s.xs, lo), upperBound(s.xs, hi)];
    }

    function cssColor(value) {
      if (!theme.cssColors) theme.cssColors = new Map();
      let c = theme.cssColors.get(value);
      if (!c) { c = color(value); theme.cssColors.set(value, c); }
      return c;
    }

    function yTickLabel(v, step, unit) {
      return typeof opts.yTickFormat === "function" ? opts.yTickFormat(v, step) : formatTick(v, step, unit);
    }

    // The y domain and ticks of a yAxis hook, or of a log scale.
    function customYAxis(dataMin, dataMax, plotH) {
      if (typeof opts.yAxis === "function") {
        const ax = opts.yAxis(dataMin, dataMax, plotH);
        if (ax && ax.max > ax.min && Array.isArray(ax.ticks)) return ax;
      }
      if (opts.yScale !== "log") return null;
      const lo = dataMin > 0 ? dataMin : dataMax > 0 ? dataMax / 10 : 1;
      const hi = dataMax > lo ? dataMax : lo * 10;
      const unit = compactUnitFor(hi);
      return { min: lo, max: hi, ticks: logTicks(lo, hi).map((v) => ({ v, label: yTickLabel(v, v, unit) })) };
    }

    function applyLogScale(L) {
      const lo = Math.max(L.yMin, Number.MIN_VALUE);
      const hi = Math.max(L.yMax, lo * 1.000001);
      const lmin = Math.log(lo), lmax = Math.log(hi);
      const ky = L.plotH / (lmax - lmin);
      const base = L.top + L.plotH;
      Object.assign(L, {
        logY: true, yMin: lo, yMax: hi, ky,
        yOf: (y) => base - (Math.log(Math.max(y, lo)) - lmin) * ky,
        yAt: (py) => Math.exp(lmin + (base - py) / ky),
        // The same plot linear in log units, for the line / area tracer.
        logView: { ...L, yMin: lmin, yMax: lmax, ky, yOf: (v) => base - (v - lmin) * ky },
      });
    }

    const logValues = new WeakMap();
    function logSeries(s) {
      let values = logValues.get(s.values);
      if (!values) {
        values = new Float64Array(s.values.length);
        for (let i = 0; i < values.length; i++) { const v = s.values[i]; values[i] = v > 0 ? Math.log(v) : NaN; }
        logValues.set(s.values, values);
      }
      return { ...s, values, derived: true };
    }

    let cellsCache = null;
    function cellsExtent(lo, hi) {
      const c = opts.cells;
      if (!c || !c.level || !c.level.length) return null;
      if (cellsCache && cellsCache.cells === c && cellsCache.lo === lo && cellsCache.hi === hi) return cellsCache.out;
      let min = Infinity, max = -Infinity;
      for (let k = 0; k < c.level.length; k++) {
        if (!(c.x1[k] > lo && c.x0[k] < hi)) continue;
        if (c.y0[k] < min) min = c.y0[k];
        if (c.y1[k] > max) max = c.y1[k];
      }
      const out = min <= max ? [min, max] : null;
      cellsCache = { cells: c, lo, hi, out };
      return out;
    }

    // One fill per palette step; cells snap to device pixels and keep a 1 px
    // gap once they are wider (taller) than 3 px.
    function drawCells(ctx, L) {
      const c = opts.cells;
      if (!c || !c.level || !c.level.length) { delete root.dataset.cellsDrawn; return 0; }
      const palette = c.palette || [];
      const snap = (v) => Math.round(v * dpr) / dpr;
      let drawn = 0;
      for (let step = 1; step <= palette.length; step++) {
        ctx.beginPath();
        let any = false;
        for (let k = 0; k < c.level.length; k++) {
          if (c.level[k] !== step || !(c.x1[k] > L.xLo && c.x0[k] < L.xHi)) continue;
          const xa = snap(L.xOf(c.x0[k])), xb = snap(L.xOf(c.x1[k]));
          const ya = snap(L.yOf(c.y1[k])), yb = snap(L.yOf(c.y0[k]));
          const gx = xb - xa > 3 ? 1 : 0, gy = yb - ya > 3 ? 1 : 0;
          ctx.rect(xa, ya, Math.max(0.5, xb - xa - gx), Math.max(0.5, yb - ya - gy));
          any = true;
          drawn++;
        }
        if (!any) continue;
        ctx.fillStyle = rgba(cssColor(palette[step - 1]));
        ctx.fill();
      }
      root.dataset.cellsDrawn = String(drawn);
      return drawn;
    }

    // Series the main pass leaves out: points with their own x or per-point
    // styling, lines over bars, every series of a log chart.
    function drawOwnMarks(ctx, L, list, perSeries) {
      if (!list.length) return 0;
      let points = 0;
      const bars = list.filter((s) => (s.type || opts.type) === "bar" && !s.xs);
      if (bars.length) points = drawBars(ctx, L, bars, perSeries);
      for (const s of list) {
        if (bars.includes(s)) continue;
        let drawn;
        if (pointsMark(s)) drawn = drawPoints(ctx, L, s);
        else if (L.logY) drawn = drawSeries(ctx, L.logView, logSeries(s));
        else drawn = drawSeries(ctx, L, s);
        perSeries[s.label] = { points: drawn, runs: pointsMark(s) ? (drawn ? 1 : 0) : runs.length };
        points = Math.max(points, drawn);
      }
      return points;
    }

    function drawPoints(ctx, L, s) {
      const own = !!s.xs;
      const xs = own ? s.xs : opts.xs;
      const category = !own && opts.xKind === "category";
      const [i0, i1] = own ? ownRange(s, L.xLo, L.xHi) : [L.v0, L.v1];
      const values = s.values;
      const radius = s.radius;
      const alpha = alphaFor(s);
      const fill = s.fillAlpha == null ? 0.5 : s.fillAlpha;
      const cache = { index: [], px: [], py: [], r: [] };
      const groups = new Map();
      for (let i = i0; i < i1 && cache.index.length < 50000; i++) {
        const v = values[i];
        if (v !== v) continue;
        const key = typeof s.pointColor === "function" ? s.pointColor(i) || "" : "";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(cache.index.length);
        cache.index.push(i);
        cache.px.push(L.xOf(category ? i : xs[i]));
        cache.py.push(L.yOf(v));
        cache.r.push(typeof radius === "number" ? radius : radius ? radius[i] : 2.6);
      }
      for (const [key, members] of groups) {
        const c = key ? cssColor(key) : seriesColor(s);
        ctx.beginPath();
        for (const k of members) {
          ctx.moveTo(cache.px[k] + cache.r[k], cache.py[k]);
          ctx.arc(cache.px[k], cache.py[k], cache.r[k], 0, Math.PI * 2);
        }
        ctx.fillStyle = rgba(c, fill * alpha);
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = rgba(c, 0.85 * alpha);
        ctx.stroke();
      }
      pickPoints.set(s.id, cache);
      return cache.index.length;
    }

    // --- picking ---

    const picking = () => typeof opts.pick === "function" || opts.series.some((s) => s.pickable);

    function pickPoint(p) {
      let best = null, bestScore = Infinity;
      for (const s of visibleSeries()) {
        if (!s.pickable) continue;
        const c = pickPoints.get(s.id);
        if (!c) continue;
        for (let k = 0; k < c.index.length; k++) {
          const r = c.r[k];
          const d = Math.hypot(c.px[k] - p.px, c.py[k] - p.py);
          if (d > r + 3) continue;
          const score = d / (r + 3) + r / 100;
          if (score < bestScore) {
            bestScore = score;
            const i = c.index[k];
            best = { key: `${s.id}:${i}`, series: s, seriesId: s.id, index: i, x: (s.xs || opts.xs)[i], px: c.px[k], py: c.py[k], r };
          }
        }
      }
      return best;
    }

    function pickAt(p) {
      if (!layout || !picking()) return null;
      const custom = typeof opts.pick === "function" ? opts.pick({ px: p.px, py: p.py, x: layout.xAt(p.px), y: layout.yAt(p.py) }) : null;
      return custom || pickPoint(p);
    }

    function tooltipHtml(content) {
      if (!content) return "";
      const rows = (content.rows || []).map((row) => {
        const swatch = row.color ? ` style="background:${rgba(cssColor(row.color))}"` : "";
        return `<span class="chartCore__tipRow${row.className ? ` ${esc(row.className)}` : ""}"><i${swatch}></i><em>${esc(row.label)}</em> <b>${esc(row.value)}</b></span>`;
      }).join("");
      return `${content.title != null ? `<strong>${esc(content.title)}</strong>` : ""}${rows}${content.footer ? `<small>${esc(content.footer)}</small>` : ""}`;
    }

    // A tooltip with the host's content beside (px, py), in plot px; its size
    // comes from the size observer, which re-places it once the new content
    // is laid out (no synchronous layout on a pointer move).
    let contentTip = null;
    function showContentTooltip(content, px, py) {
      const key = `content|${JSON.stringify(content)}`;
      if (!content) { tooltipEl.hidden = true; tooltipKey = ""; contentTip = null; return; }
      if (key !== tooltipKey || tooltipEl.hidden) {
        tooltipKey = key;
        tooltipEl.innerHTML = tooltipHtml(content);
        delete tooltipEl.dataset.index;
        tooltipEl.hidden = false;
      }
      contentTip = { px, py };
      placeContentTip();
    }

    function placeContentTip() {
      if (!contentTip) return;
      const size = measured(tooltipEl);
      const { px, py } = contentTip;
      const width = layout ? layout.width : plotEl.clientWidth;
      let lx = px + 16;
      if (lx + size.w > width - 4) lx = px - 16 - size.w;
      lx = Math.max(4, lx);
      const ty = Math.max(0, Math.min(opts.height - size.h, py - size.h / 2));
      tooltipEl.style.transform = `translate(${Math.round(lx)}px, ${Math.round(ty)}px)`;
    }

    function showPick(p) {
      const hit = pickAt(p);
      if (!hit) { clearPick(); return false; }
      const same = pickHit && pickHit.key != null && pickHit.key === hit.key;
      pickHit = hit;
      cursor = { px: p.px, py: p.py, nearest: null };
      cursorIndex = -1;
      overCanvas.classList.toggle("is-pickable", typeof opts.onPick === "function");
      if (!same) {
        if (hit.r != null && hit.px != null) {
          const size = 2 * hit.r + 4;
          pickRing.style.width = `${size}px`;
          pickRing.style.height = `${size}px`;
          pickRing.style.margin = `${-size / 2}px 0 0 ${-size / 2}px`;
          place(pickRing, hit.px, hit.py);
          show(pickRing, true);
        } else show(pickRing, false);
        root.dataset.pick = String(hit.key == null ? "" : hit.key);
      }
      showContentTooltip(typeof opts.pickTooltip === "function" ? opts.pickTooltip(hit) : null, p.px, p.py);
      scheduleOverlay();
      broadcast(Number.isFinite(hit.x) && opts.xKind !== "category" ? hit.x : null);
      return true;
    }

    function clearPick() {
      if (!pickHit) return;
      pickHit = null;
      tooltipKey = "";
      contentTip = null;
      show(pickRing, false);
      overCanvas.classList.remove("is-pickable");
      delete root.dataset.pick;
    }

    overCanvas.addEventListener("pointerdown", (ev) => { press = { x: ev.clientX, y: ev.clientY }; });
    overCanvas.addEventListener("click", (ev) => {
      const from = press;
      press = null;
      if (typeof opts.onPick !== "function" || !from || Math.hypot(ev.clientX - from.x, ev.clientY - from.y) >= DRAG_MIN_PX) return;
      const hit = pickAt(localPoint(ev));
      if (hit) opts.onPick(hit);
    });

    // --- 2-D brush ---

    function clampPoint(p) {
      const L = layout;
      return { px: Math.max(L.left, Math.min(L.left + L.plotW, p.px)), py: Math.max(L.top, Math.min(L.top + L.plotH, p.py)) };
    }

    function startBox(p, ev) {
      if (opts.brush !== "xy" || !layout) return false;
      const at = clampPoint(p);
      boxDrag = { a: at, b: at, id: ev.pointerId, range: null };
      try { overCanvas.setPointerCapture(ev.pointerId); } catch { /* capture is optional */ }
      clearPick();
      cursor = null;
      cursorIndex = -1;
      scheduleOverlay();
      updateBox(at);
      return true;
    }

    function boxRange(a, b) {
      const L = layout;
      const range = {
        x0: L.xAt(Math.min(a.px, b.px)), x1: L.xAt(Math.max(a.px, b.px)),
        y0: L.yAt(Math.max(a.py, b.py)), y1: L.yAt(Math.min(a.py, b.py)),
      };
      return typeof opts.brushSnap === "function" ? opts.brushSnap(range) || range : range;
    }

    function placeBox(el, r, L) {
      const xa = Math.max(L.left, L.xOf(r.x0)), xb = Math.min(L.left + L.plotW, L.xOf(r.x1));
      const y0 = r.y0 == null ? L.yMin : r.y0, y1 = r.y1 == null ? L.yMax : r.y1;
      const ya = Math.max(L.top, L.yOf(y1)), yb = Math.min(L.top + L.plotH, L.yOf(y0));
      el.style.width = `${Math.max(1, xb - xa)}px`;
      el.style.height = `${Math.max(1, yb - ya)}px`;
      place(el, xa, ya);
    }

    function updateBox(p) {
      if (!boxDrag || !layout) return;
      boxDrag.b = clampPoint(p);
      const r = boxRange(boxDrag.a, boxDrag.b);
      boxDrag.range = r;
      boxEl.className = `chartCore__box${opts.brushClass ? ` ${opts.brushClass}` : ""}`;
      placeBox(boxEl, r, layout);
      show(boxEl, true);
      showContentTooltip(typeof opts.brushTooltip === "function" ? opts.brushTooltip(r) : null, p.px, p.py);
    }

    function cancelBox() {
      if (!boxDrag) return;
      const d = boxDrag;
      boxDrag = null;
      try { overCanvas.releasePointerCapture(d.id); } catch { /* already released */ }
      show(boxEl, false);
      tooltipEl.hidden = true;
      tooltipKey = "";
      contentTip = null;
      return d;
    }

    overCanvas.addEventListener("pointermove", (ev) => {
      if (!boxDrag) return;
      const p = localPoint(ev);
      boxFrame(p);
    });
    overCanvas.addEventListener("pointerup", (ev) => {
      if (!boxDrag) return;
      updateBox(localPoint(ev));
      const d = cancelBox();
      if (d && d.range && typeof opts.onBrush === "function") opts.onBrush(d.range);
    });
    overCanvas.addEventListener("pointercancel", () => cancelBox());
    overCanvas.addEventListener("lostpointercapture", () => { if (boxDrag) cancelBox(); });
    const onBoxKey = (ev) => { if (ev.key === "Escape" && boxDrag) { ev.preventDefault(); cancelBox(); } };
    document.addEventListener("keydown", onBoxKey, true);

    // --- annotations and regions (DOM, moved on every draw) ---

    function placeAnnotations(L) {
      const list = Array.isArray(opts.annotations) ? opts.annotations : [];
      while (annotationEls.length < list.length) {
        const el = document.createElement("div");
        el.appendChild(document.createElement("span"));
        annotationsEl.appendChild(el);
        annotationEls.push(el);
      }
      annotationEls.forEach((el, k) => {
        const m = list[k];
        const x = m ? L.xOf(Number(m.x)) : NaN;
        const on = !!m && x >= L.left - 0.5 && x <= L.left + L.plotW + 0.5;
        el.hidden = !on;
        if (!on) return;
        el.className = `chartCore__annotation${m.className ? ` ${m.className}` : ""}`;
        el.dataset.label = String(m.label == null ? "" : m.label);
        el.firstChild.textContent = el.dataset.label;
        el.firstChild.title = String(m.title || el.dataset.label);
        el.style.height = `${L.plotH}px`;
        place(el, x, L.top);
      });
    }

    function placeRegions(L) {
      const list = Array.isArray(opts.regions) ? opts.regions : [];
      const seen = new Set();
      for (const r of list) {
        const id = String(r.id);
        seen.add(id);
        let el = regionEls.get(id);
        if (!el) {
          el = document.createElement("i");
          cursorEl.insertBefore(el, pickRing);
          regionEls.set(id, el);
        }
        el.className = `chartCore__region${r.className ? ` ${r.className}` : ""}`;
        const on = !r.hidden && r.x1 > r.x0 && !!L;
        el.hidden = !on;
        if (on) placeBox(el, r, L);
      }
      for (const [id, el] of regionEls) if (!seen.has(id)) el.hidden = true;
    }

    function publishExtras() {
      const L = layout;
      root.dataset.yTicks = JSON.stringify(L.yTicks.map((t) => t.label));
      root.dataset.xTicks = JSON.stringify(L.xDrawn || []);
      if (opts.yScale) root.dataset.yScale = opts.yScale; else delete root.dataset.yScale;
      placeAnnotations(L);
      placeRegions(L);
      if (pickHit) clearPick();
      if (boxDrag && boxDrag.range) placeBox(boxEl, boxDrag.range, L);
    }

    function destroyExtras() {
      document.removeEventListener("keydown", onBoxKey, true);
      boxFrame.cancel();
      cancelBox();
    }

    const extraApi = {
      setRegions(list) {
        opts.regions = Array.isArray(list) ? list : [];
        if (layout && !released) placeRegions(layout);
      },
      showTooltip(content, px, py) { showContentTooltip(content, px, py); },
      hideTooltip() { tooltipEl.hidden = true; tooltipKey = ""; contentTip = null; },
      points(id) {
        flushDraw();
        const c = pickPoints.get(id);
        return c ? c.index.map((index, k) => ({ index, x: c.px[k], y: c.py[k], r: c.r[k] })) : [];
      },
      toClient(x, y) {
        flushDraw();
        const box = plotEl.getBoundingClientRect();
        return layout ? { x: box.left + layout.xOf(x), y: box.top + layout.yOf(y) } : null;
      },
    };

    const api = {
      root,
      setData,
      update: setData,
      setZoom: (lo, hi) => setZoom(lo, hi, false),
      resetZoom: () => resetZoom(false),
      getZoom: () => (zoom ? zoom.slice() : null),
      setHidden: (ids) => setHiddenInternal(new Set(ids)),
      getHidden: () => new Set(hidden),
      redraw: scheduleDraw,
      release,
      destroy,
      themeChanged,
      xKind: () => opts.xKind,
      syncCursor(x) {
        if (cursor) return;
        syncedX = x;
        if (x == null) delete root.dataset.syncX; else root.dataset.syncX = String(x);
        scheduleOverlay();
      },
      stats: () => { flushDraw(); return { ...stats }; },
      layout: () => { flushDraw(); return layout; },
      flush: () => flushDraw(),
      // True until the plot is drawn at its current width: a draw is
      // scheduled, or the width changed (a scrollbar came, the window
      // resized) and the resize observer has not drawn it yet. layout() and
      // toClient() describe the last frame drawn until then.
      drawPending: () => !destroyed && (!!drawRaf || pendingDraw || (!released && plotWidth() !== sizeW)),
      // Markers move with the plot; replacing them needs no plot redraw.
      setMarkers(list) { opts.markers = list; scheduleDraw(); },
    };
    Object.assign(api, extraApi);
    instances.set(root, api);
    live.add(api);
    watchTheme();
    if (opts.syncKey) {
      if (!syncGroups.has(opts.syncKey)) syncGroups.set(opts.syncKey, new Set());
      syncGroups.get(opts.syncKey).add(api);
    }
    draw();
    return api;
  }

  ns.chartCore = {
    create,
    // Scales and formats, shared with the charts that draw their own marks.
    timeTicks,
    linearTicks,
    niceStep,
    compactUnitFor,
    formatTick,
    formatExact,
    formatValue,
    formatInstant,
    formatDuration,
    utcOffsetText,
    decimalsFor,
    lowerBound,
    upperBound,
    bridgeGaps,
    logTicks,
    counters: () => ({ ...counters }),
    resetCounters,
    // The chart drawn in (or at) an element: tests and hosts reach its API.
    of(el) {
      const node = el && (el.classList && el.classList.contains("chartCore") ? el : el.querySelector && $(".chartCore", el));
      return (node && instances.get(node)) || null;
    },
  };
})();
