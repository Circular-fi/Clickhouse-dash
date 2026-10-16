// Shared canvas chart engine (uPlot-style). It uses columnar Float64Array data and per-pixel min/max decimation.
// It has two stacked canvases. The plot canvas is redrawn on data, size, zoom and theme changes.
// The cursor overlay canvas is redrawn on every pointer move. The engine also has a DOM tooltip and legend.
// One engine serves every chart of the app. The Query result chart uses it first.
// The other charts move to it one by one. See each consumer for its migration notes.
//
//   const chart = ns.chartCore.create(hostEl, {
//     xKind: "time" | "number" | "index" | "category",
//     xs: Float64Array,                 // ascending. A category axis uses 0..n-1.
//     categories: ["a", "b"],          // labels of the category axis
//     series: [{ id, label, color, values: Float64Array, nulls: Uint8Array | null, group }],
//     type: "line" | "area" | "bar" | "points",
//     stack: false,                     // area and bar: cumulative per group
//   });
//   chart.setData({ ... }), chart.update({ type, stack }), chart.setZoom(lo, hi),
//   chart.resetZoom(), chart.setHidden(ids), chart.destroy().
//
// values[i] is NaN when the series has no value at xs[i]. nulls[i] = 1 marks a NULL.
// The line breaks at a NULL. A NaN without the flag is a missing row.
// The line connects across a missing row. nulls === null means that every NaN breaks the line.
//
// The legend is the list of the series under the plot. The "Values" mode shows a table of Total, Min, Max, Mean and Last.
// The engine keeps the mode as a preference. The legend is the same on every page.
// A series can have `weights`, one per point: the calls behind an average, or the requests behind a rate.
// Its Mean is then weighted. A chart whose values do not add up omits the Total (`legendColumns`).
// Set `legendClick: "filter"` to make a click the host's job (`onLegendClick`: a filter), not a hide.
// Charts that share an `alignKey` and sit side by side keep their grid lines on the same lines.
// See "Alignment groups" in create().

import { dom } from "./app_dom.js";
import { format } from "./app_format.js";
import { palette } from "./app_palette.js";
import { storage } from "./app_state.js";
import { uiState } from "./app_ui_state.js";
import { util } from "./app_util.js";

const { $ } = dom;

const DEFAULT_HEIGHT = 300;
const FONT_SIZE = 11;
const Y_TICK_SPACE = 34;
// An aligned axis has at most this many intervals.
const Y_MAX_INTERVALS = 10;
const X_TICK_GAP = 22;
const X_LABEL_GAP = 6;
const X_CONTEXT_GAP = 10;
const PAD_TOP = 10;
// Labelled annotations (release markers) write their label in a gutter above the plot.
// They never draw over the data.
const ANNOTATION_GUTTER = 16;
const PAD_RIGHT = 14;
const TICK_LEN = 4;
const DRAG_MIN_PX = 4;
const POINTS_AUTO_SPACING = 12;
const MAX_CATEGORY_CHARS = 18;
const LEGEND_STORE_KEY = storage.KEYS.chartLegend;

// Work counters of every chart on the page. They are test and profiling hooks.
// Use ns.chartCore.counters() and resetCounters(). The counters only increase.
const COUNTER_NAMES = ["setData", "draws", "drawMs", "layoutReads", "traces", "decimations", "tracedPoints",
  "extentScans", "stackBuilds", "legendBuilds", "legendUpdates", "allocBytes", "summarised", "textMeasures"];
const counters = {};
function resetCounters() { for (const name of COUNTER_NAMES) counters[name] = 0; }
resetCounters();

// --- Numbers ----------------------------------------------------------------

const COMPACT_UNITS = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];

function compactUnitFor(maxAbs) {
  for (const [factor, suffix] of COMPACT_UNITS) if (maxAbs >= (factor === 1e3 ? 1e4 : factor)) return { factor, suffix };
  return { factor: 1, suffix: "" };
}

// Decimals that write the step exactly: 2.5 -> 1, 0.25 -> 2, 500 -> 0.
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

// Exact value. Every digit that JavaScript round-trips is shown, grouped (12,345.678901).
function formatExact(value) {
  if (!Number.isFinite(value)) return "NULL";
  const abs = Math.abs(value);
  if (abs !== 0 && (abs < 1e-6 || abs >= 1e21)) return String(value);
  const text = String(value);
  const neg = text[0] === "-";
  const [whole, frac] = (neg ? text.slice(1) : text).split(".");
  return `${neg ? "-" : ""}${groupThousands(whole)}${frac ? `.${frac}` : ""}`;
}

// Readable value. Integers are grouped. Fractions have 12 significant digits.
function formatValue(value) {
  if (!Number.isFinite(value)) return "NULL";
  if (Number.isInteger(value)) return formatExact(value);
  const abs = Math.abs(value);
  if (abs !== 0 && (abs < 1e-6 || abs >= 1e15)) return value.toPrecision(6);
  return formatExact(Number(value.toPrecision(12)));
}

// The "nice" steps of a decade: 1, 2, 2.5 and 5 (then 10, the next decade's 1).
const NICE_MULTIPLES = [1, 2, 2.5, 5];

function niceStep(rawStep) {
  if (!(rawStep > 0) || !Number.isFinite(rawStep)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  return (NICE_MULTIPLES.find((multiple) => normalized <= multiple) || 10) * magnitude;
}

// Round the tick values inside [lo, hi]. The domain itself is not snapped.
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

// Example: 2026-09-30 14:05:00.000. A fractionDigits value of 6 adds the microseconds.
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
      // Wall-clock hours, such as 00:00, 06:00 and 12:00, even on DST days.
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

// Calendar-aligned ticks. The function uses the smallest step whose labels stay apart, like Grafana.
// Each tick is { v, label, date, year }: the label and its context.
// The date is the day under clock times. The year is the year under clock times, days and months.
// layoutXLabels decides where the context line shows.
function timeTicks(startMs, endMs, plotWidthPx, measure) {
  const span = Math.max(1e-3, endMs - startMs);
  const width = Math.max(60, plotWidthPx);
  const fits = (count, sample) => count <= 80 && width / Math.max(1, count) >= measure(sample) + X_TICK_GAP;
  const make = (ticks, labelOf, dated) => ticks.map((t) => ({
    v: t, label: labelOf(t), date: dated ? dayLabel(t) : "", year: String(new Date(t).getFullYear()),
  }));
  for (const step of SUB_DAY_STEPS_MS) {
    const unit = step < SECOND_MS ? "milli" : step < MINUTE_MS ? "second" : "minute";
    const sample = unit === "milli" ? "00:00:00.000" : unit === "second" ? "00:00:00" : "00:00";
    if (!fits(span / step, sample)) continue;
    return make(subDayTicks(startMs, endMs, step), (t) => clockText(t, unit), true);
  }
  for (const days of DAY_STEPS) {
    if (!fits(span / (days * DAY_MS), "Sep 30")) continue;
    return make(dayTicks(startMs, endMs, days), dayLabel, false);
  }
  const monthMs = 30.44 * DAY_MS;
  for (const months of MONTH_STEPS) {
    if (!fits(span / (months * monthMs), "Sep")) continue;
    return make(monthTicks(startMs, endMs, months), (t) => MONTH_NAMES[new Date(t).getMonth()], false);
  }
  for (const years of YEAR_STEPS) {
    if (!fits(span / (years * 365.25 * DAY_MS), "2026") && years !== YEAR_STEPS[YEAR_STEPS.length - 1]) continue;
    return yearTicks(startMs, endMs, years).map((t) => ({ v: t, label: String(new Date(t).getFullYear()), date: "", year: "" }));
  }
  return [];
}

// The x labels to draw, from left to right. The function is pure: the tests run it on made-up ticks.
// A tick label shows where it keeps X_LABEL_GAP px from the one before. Otherwise, the label is skipped.
// Under each label, on a second line, its context shows: "Oct 3" under clock times, "2026" under days or months.
// The first label shows its context. The context also shows where it changes, and the year shows only where the year changes.
// For example: "Oct 2 2026", then "Oct 3" at 00:00.
// A context that is closer than X_CONTEXT_GAP px to the context shown before is skipped too. No label reads under the previous date.
// The function then waits for the next one. The exception: the first label's context only dates the axis, so it yields to the change.
//   ticks [{ v, label, date, year }]; xOf(v) -> px; [lo, hi] the plot's px
//   span; width the canvas width (labels stay inside it); measure(text) and
//   measureContext(text) the widths at the label and the context fonts.
//   -> [{ v, label, x, left, right, context, cx, cleft, cright }]
function layoutXLabels(ticks, xOf, lo, hi, width, measure, measureContext) {
  const out = [];
  const centre = (x, w) => Math.max(w / 2 + 1, Math.min(width - w / 2 - 1, x));
  let lastRight = -Infinity;
  let shown = null; // the label whose context was shown last
  let first = null; // the first context shown, while it may give way
  for (const t of ticks) {
    const x = xOf(t.v);
    if (!(x >= lo - 0.5 && x <= hi + 0.5)) continue;
    const w = measure(t.label);
    const lx = centre(x, w);
    if (lx - w / 2 < lastRight + X_LABEL_GAP) continue;
    const item = { v: t.v, label: t.label, x: lx, left: lx - w / 2, right: lx + w / 2, context: "", cx: 0, cleft: 0, cright: 0 };
    const date = t.date || "", year = t.year || "";
    if ((!date && !year) || (shown && date === shown.date && year === shown.year)) {
      out.push(item);
      lastRight = item.right;
      continue;
    }
    let text = contextText(date, year, shown ? shown.year : "");
    let cw = measureContext(text), cx = centre(x, cw);
    if (shown && cx - cw / 2 < shown.item.cright + X_CONTEXT_GAP) {
      if (shown.item !== first) continue;
      first.context = "";
      first.cx = first.cleft = first.cright = 0;
      text = contextText(date, year, "");
      cw = measureContext(text);
      cx = centre(x, cw);
    }
    out.push(item);
    lastRight = item.right;
    first = shown ? null : item;
    item.context = text;
    item.cx = cx;
    item.cleft = cx - cw / 2;
    item.cright = cx + cw / 2;
    shown = { item, date, year };
  }
  return out;
}

function contextText(date, year, shownYear) {
  if (!date) return year;
  return year && year !== shownYear ? `${date} ${year}` : date;
}

// --- Aligned y axes ---------------------------------------------------------
//
// The y axis of a chart that has an `alignKey` (create(), "Alignment groups") has `intervals` equal steps. The plot height gives their number.
// The domain is [0 or the minimum, that many steps]. The step is taken from the sequence of the chart's kind.
// The step depends on the extent of the data and on the number of intervals only.
// Charts of one group whose plots have one height keep their grid lines at the same heights, whatever the data. Only the numbers on the lines differ.
//   number    1-2-2.5-5 x 10^n (niceStep). `whole` omits the steps that are not whole numbers. Under 10, 3 replaces 2.5 (a count of requests).
//   bytes     The same steps, in the largest unit of 1024 that the data reaches (B, KB, MB, GB, TB). The steps of B are whole numbers.
//   duration  Values in milliseconds. 1-2-2.5-5 x 10^n ms up to a second. Then the clock steps (1, 2, 5, 10, 15, 30 s; the same in minutes; 1, 2, 3, 6, 12 h).
//             Then whole days. The unit of the ticks is the unit of the step.
//   percent   Values in percent. 1-2-2.5-5 x 10^n with a % suffix (0.25%, 1%, 25%...). A rate cannot pass 100.
//             When the data does not pass 100, the domain stops at 100. For example, four intervals of a plot of 156 px are 25 each.
//             When no nice step divides 100 by the interval count, the steps are 100 / intervals. They have at most one decimal.
const CLOCK_STEPS_MS = [
  ...[1, 2, 5, 10, 15, 30].map((s) => s * SECOND_MS),
  ...[1, 2, 5, 10, 15, 30].map((m) => m * MINUTE_MS),
  ...[1, 2, 3, 6, 12].map((h) => h * HOUR_MS),
];
const BYTE_UNITS = [[1024 ** 4, " TB"], [1024 ** 3, " GB"], [1024 ** 2, " MB"], [1024, " KB"], [1, " B"]];
const DURATION_UNITS = [[DAY_MS, " d"], [HOUR_MS, " h"], [MINUTE_MS, " min"], [SECOND_MS, " s"], [1, " ms"]];
const PERCENT_UNIT = { factor: 1, suffix: "%" };
// The highest value of a rate, in percent.
const PERCENT_MAX = 100;
const unitOfFactor = (list, value) => {
  const [factor, suffix] = list.find(([size]) => value >= size) || list[list.length - 1];
  return { factor, suffix };
};

// The 1-2-2.5-5 x 10^n steps that are at least `from`, smallest first. `whole` keeps the whole numbers only.
// It uses 3 where the 2.5 of the units is not a whole number. A count has steps of 1, 2, 3, 5, 10, 20, 25, 50...
function* niceSteps(from, whole = false) {
  const start = from > 0 && Number.isFinite(from) ? from : 1;
  let magnitude = 10 ** Math.floor(Math.log10(start));
  for (let decade = 0; decade < 300; decade += 1, magnitude *= 10) {
    for (const multiple of NICE_MULTIPLES) {
      const step = Number(((whole && multiple === 2.5 && magnitude === 1 ? 3 : multiple) * magnitude).toPrecision(12));
      if (step < start * (1 - 1e-9) || (whole && !Number.isInteger(step))) continue;
      yield step;
    }
  }
}

// The steps of a duration in milliseconds that are at least `from`, smallest first.
function* durationSteps(from, whole = false) {
  const start = from > 0 && Number.isFinite(from) ? from : 1;
  for (const step of niceSteps(start, whole)) {
    if (step >= SECOND_MS) break;
    yield step;
  }
  for (const step of CLOCK_STEPS_MS) if (step >= start * (1 - 1e-9)) yield step;
  for (const days of niceSteps(Math.max(1, start / DAY_MS), true)) yield days * DAY_MS;
}

// The axis of the kind over [lo, hi] in `intervals` steps: { min, max, step, unit: { factor, suffix }, values }.
// The function takes the first step of the sequence for which [lo rounded down to a step, + intervals steps] reaches hi.
// `unitOf(maxAbs)` gives the unit of a "number" axis. The default is K, M, B, T.
// `values` are the ticks, `min` to `max`.
function alignedAxis(kind, lo, hi, intervals, { whole = false, unitOf = compactUnitFor } = {}) {
  const count = Math.max(1, Math.round(intervals));
  const top = hi > lo ? hi : lo + 1;
  const reach = Math.max(Math.abs(lo), Math.abs(top));
  let unit = kind === "bytes" ? unitOfFactor(BYTE_UNITS, reach) : null;
  let steps;
  if (kind === "bytes") {
    const factor = unit.factor;
    steps = (function* bytes() { for (const step of niceSteps((top - lo) / count / factor, whole || factor === 1)) yield step * factor; })();
  } else if (kind === "duration") {
    steps = durationSteps((top - lo) / count, whole);
  } else {
    steps = niceSteps((top - lo) / count, whole);
  }
  let found = null;
  for (const step of steps) {
    const min = lo === 0 ? 0 : Number((Math.floor(lo / step + 1e-9) * step).toPrecision(12));
    if (min + count * step >= top - step * 1e-9) { found = { min, step }; break; }
  }
  if (!found) found = { min: lo, step: (top - lo) / count };
  const { min } = found;
  let { step } = found;
  // The ticks are `min + k * span`. A rate does not pass 100. When the data does not pass 100, the domain ends at 100.
  // Each interval is then 100 / count. This is not always a nice step. For example, a plot of three intervals has 33.3, 66.7 and 100.
  // The code rounds such a step to three digits for the labels.
  let span = step;
  if (kind === "percent" && top <= PERCENT_MAX && min + count * step > PERCENT_MAX * (1 + 1e-9)) {
    span = (PERCENT_MAX - min) / count;
    step = Number(span.toPrecision(3));
  }
  const max = Number((min + count * span).toPrecision(12));
  if (kind === "duration") unit = unitOfFactor(DURATION_UNITS, step);
  else if (kind === "percent") unit = PERCENT_UNIT;
  else if (kind !== "bytes") unit = unitOf(Math.max(Math.abs(min), Math.abs(max)));
  const values = Array.from({ length: count + 1 }, (_, k) => {
    const v = Number((min + k * span).toPrecision(12));
    return Math.abs(v) < span * 1e-9 ? 0 : v;
  });
  return { min, max, step, unit, values };
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

// parseColor of many texts. From 5000 texts, the parsing runs on src/wasm/color.c (ns.palette.batch.colorKernel, docs/wasm.md).
// A short list and a missing kernel use parseColor. So does each item that the kernel hands back with a non-zero status.
// force: use the kernel at any size (the tests).
function parseColors(texts, force) {
  const list = Array.from(texts);
  const out = palette && palette.batch ? palette.batch.colorKernel("parseChart", { texts: list.map((text) => String(text || "")) }, list.length, force) : null;
  if (!out) return list.map(parseColor);
  return list.map((text, i) => (out.status[i] === 0 ? { r: out.nums[i * 4], g: out.nums[i * 4 + 1], b: out.nums[i * 4 + 2], a: out.nums[i * 4 + 3] } : parseColor(text)));
}

// rgba(c, alpha) of many colors (the same alpha for all). The kernel does this work from 5000 colors.
function rgbaBatch(colors, alpha = 1, force) {
  const list = Array.from(colors);
  let out = null;
  if (palette && palette.batch && (force || list.length >= palette.batch.minItems.rgba)) {
    const colorsIn = new Float64Array(list.length * 4);
    for (let i = 0; i < list.length; i += 1) {
      colorsIn[i * 4] = list[i].r;
      colorsIn[i * 4 + 1] = list[i].g;
      colorsIn[i * 4 + 2] = list[i].b;
      colorsIn[i * 4 + 3] = list[i].a;
    }
    out = palette.batch.colorKernel("rgba", { colors: colorsIn, alphas: new Float64Array(list.length).fill(alpha) }, list.length, force);
  }
  if (!out) return list.map((c) => rgba(c, alpha));
  return list.map((c, i) => (out.status[i] === 0 ? out.texts[i] : rgba(c, alpha)));
}

const rgba = (c, alpha = 1) => `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${+(c.a * alpha).toFixed(3)})`;
const luminance = (c) => (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;

// --- Shared state: theme changes and the cursor sync groups -----------------

const live = new Set();
const syncGroups = new Map();
// Alignment groups: each alignKey maps to the charts that have it. Each chart is { xScaleKey(), gutter(), settle(), setLegendMode(mode) }. See create().
const alignGroups = new Map();
let themeWatch = null;

function watchTheme() {
  if (themeWatch) return;
  const invalidate = () => { for (const chart of live) chart.themeChanged(); };
  const observer = new MutationObserver(invalidate);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  const media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  if (media && media.addEventListener) media.addEventListener("change", invalidate);
  // Axis labels that were measured before a web font loaded use the fallback face.
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

// The widest gutter (px) among the charts of an alignment group that have the x scale `key`.
function alignGutter(group, key) {
  let left = 0;
  for (const member of group) if (member.xScaleKey() === key) left = Math.max(left, member.gutter());
  return left;
}

// --- Block summaries of long series --------------------------------------------
//
// A series with BLOCK_MIN_POINTS values or more is summarised per BLOCK points.
// The summary holds the min, max, sum and count of the finite values. It also says whether all values are finite.
// A summary grows with the series when rows are only appended (setData({ append: true })). The blocks already summed stay.
// Extents, decimation and the legend values read whole blocks where a range covers them.
// So, a draw costs O(n / BLOCK + columns * BLOCK) instead of O(n).
const BLOCK = 64;
const BLOCK_SHIFT = 6;
const BLOCK_MIN_POINTS = 1 << 14;

function newSummary() {
  return { values: null, n: 0, mins: new Float64Array(0), maxs: new Float64Array(0), sums: new Float64Array(0), counts: new Uint32Array(0), clean: new Uint8Array(0) };
}

// Summarise the values from block sum.n to n. The last, partial block is summed again.
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

// util.escapeHtml is the only escaper. null prints as "".
const esc = (value) => util.escapeHtml(value == null ? "" : value);

const legendPref = () => storage.pref(LEGEND_STORE_KEY, "list", { allowed: ["list", "table"] });

function readLegendMode() {
  return legendPref().get();
}

function storeLegendMode(mode) {
  legendPref().set(mode);
}

// --- Gap bridging (Metrics) --------------------------------------------------

// A series that reports less often than the bucket has regular empty buckets.
// NaN gaps up to `factor` times its median spacing are bridged. Longer gaps (missing data) break the line.
// The function returns the `nulls` flags of the series.
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

// The function makes 1-2-5 ticks per decade inside [lo, hi]. lo must be above 0.
// It keeps only the powers of ten when there are more than 7 ticks. It makes linear ticks when the range spans less than 8x.
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

// The step of an ascending time axis whose points sit on one regular spacing, such as a row per hour.
// The step is the median spacing. The function takes it when at least half of the spacings equal it, within 1 %.
// It returns 0 for an irregular axis, such as event times or months, and for fewer than 4 points.
function regularStep(xs) {
  const n = xs ? xs.length : 0;
  if (n < 4) return 0;
  const stride = Math.max(1, Math.floor((n - 1) / 4096));
  const deltas = [];
  for (let i = 1; i < n; i += stride) {
    const d = xs[i] - xs[i - 1];
    if (d > 0) deltas.push(d);
  }
  if (deltas.length < 3) return 0;
  deltas.sort((a, b) => a - b);
  const step = deltas[deltas.length >> 1];
  let regular = 0;
  for (const d of deltas) if (Math.abs(d - step) <= step * 0.01) regular++;
  return regular * 2 >= deltas.length ? step : 0;
}

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
        <div class="chartCore__overlay" tabindex="0" role="application" aria-roledescription="chart" aria-label="Chart cursor: Left / Right move it point by point (Shift: 10), Home / End jump to the ends, drag to zoom"></div>
        <i class="chartCore__probe" aria-hidden="true"></i>
      </div>
      <div class="chartCore__legend" role="group" aria-label="Series"></div>`;
  host.appendChild(root);
  const plotEl = $(".chartCore__plot", root);
  // The plot width is the width that the resize observer reports. It is the content box, floored.
  // clientWidth rounds the width. A 523.5 px plot drawn at clientWidth (524) is redrawn at 523 px.
  // The engine redraws it at 523 px as soon as the observer reports the width.
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
  const overlayFrame = util.rafOnce(() => drawOverlay());
  let released = false;
  let pendingDraw = false;
  let destroyed = false;
  let tooltipKey = "";
  let tooltipSize = { w: 0, h: 0 };
  let stats = { points: 0, series: 0, ms: 0 };
  // Line series of the last draw that marked each value. This applies to few values.
  let markedSeries = 0;
  // Series drawn with the light wash under their line. See stats().washed.
  let washedSeries = 0;
  let observedWidth = 0;
  let widthObserved = false;
  let refreshCursor = false;
  // The alignment group of the chart is set when the chart is made. See "Alignment groups" below.
  // The y axis of the visible range is kept until the data, the zoom, the hidden series or the theme changes (axisStamp).
  // The charts of a group ask each other for this axis. So, the engine works it out once.
  const alignKey = String(initial.alignKey || "");
  let axisStamp = 1;
  let axisCache = null;

  // --- Alignment groups -------------------------------------------------------
  //
  // Charts that have the same `alignKey` are read together. They are drawn side by side or one under the other.
  //   - Their y axes have the same number of intervals. The plot height gives this number. The axes end on a step of their kind.
  //     So, their grid lines sit at the same heights. Only the scale differs (yKind, yInteger: alignedAxis, and yAxisOf below).
  //   - Charts that share an x scale have the same kind, the same domain and the same plot width.
  //     They have one gutter at the left of the plot: the widest of their y labels. So, their vertical grid lines sit at the same x.
  //   - They share the mode of their legend (list or table).
  // The engine works out the layout in one pass, and it never feeds the result back.
  // The steps are taken from the data and the plot height. The labels are taken from the steps. The gutter is taken from the labels.
  // The x ticks are taken from the plot that is left. Only the resize observer and the data read the layout.
  // A chart that changes tells the other charts of its group. Those charts draw again only when their gutter differs from the one they drew with.
  const member = alignKey ? {
    xScaleKey: () => xScaleKey(axisNow().view, knownWidth()),
    gutter: () => ownGutter(axisNow().axis),
    settle() {
      if (destroyed || released || !layout || !sizeW) return;
      const { view, axis } = axisNow();
      if (layout.left !== gutterFor(axis, view, knownWidth())) scheduleDraw();
    },
    setLegendMode: (mode) => setLegendMode(mode),
  } : null;

  // The width of the plot as the chart last saw it. This is the width of the resize observer, or the chart's own measure.
  // Each draw takes its own measure until the observer reports a width.
  // The other charts of a group compare this width. A chart that nobody measured yet is measured now, once.
  function knownWidth() {
    if (!widthObserved && !observedWidth) observedWidth = plotWidth();
    return observedWidth;
  }

  // The charts of the group read their gutter again after this chart draws or leaves. A chart whose gutter changed draws again.
  function settleGroup() {
    const group = alignKey ? alignGroups.get(alignKey) : null;
    if (group) for (const other of group) if (other !== member) other.settle();
  }

  plotEl.style.height = `${opts.height}px`;

  // --- theme -------------------------------------------------------------

  function computedColor(value) {
    probe.style.color = "";
    probe.style.color = value;
    return getComputedStyle(probe).color;
  }

  function color(value) {
    return parseColor(computedColor(value));
  }

  function readTheme() {
    const style = getComputedStyle(root);
    // Forced colors (Windows high contrast): the axes, labels and grid take the system palette.
    // The series keep their colors. The probe is excluded from the forcing.
    const forced = typeof window.matchMedia === "function" && window.matchMedia("(forced-colors: active)").matches;
    const text = color(forced ? "CanvasText" : "var(--text)");
    const muted = color(forced ? "GrayText" : "var(--muted)");
    const panel = color(forced ? "Canvas" : "var(--panel)");
    const dark = luminance(panel) < 0.5;
    const family = style.fontFamily || "system-ui, sans-serif";
    const seriesColors = new Map();
    // Many series (Metrics): the engine reads the colors from the page, then parses them in one batch.
    const parsed = parseColors(opts.series.map((s) => computedColor(s.color || "var(--qchart-1)")));
    opts.series.forEach((s, i) => seriesColors.set(s.id, parsed[i]));
    return {
      dark,
      text,
      muted,
      panel,
      font: `500 ${FONT_SIZE}px ${family}`,
      fontBold: `600 ${FONT_SIZE}px ${family}`,
      // Grafana: hairline grids at 9% of the text color. The grid uses the theme tokens.
      // The grid has no color of its own.
      grid: rgba(text, forced ? 0.3 : 0.09),
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

  // Cumulative tops and bases of the visible series. NULL counts as 0.
  // Bars stack positive values up and negative values down. Areas only add up.
  function computeStacks() {
    if (!isStacked()) { stacks = null; return; }
    counters.stackBuilds++;
    const n = opts.xs.length;
    const state = new Map();
    stacks = new Map();
    // stackMode "percent": each x shows the shares of its group, out of 100.
    const totals = new Map();
    if (opts.stackMode === "percent") {
      for (const s of visibleSeries()) {
        if (ownMark(s)) continue;
        const key = s.group == null ? "" : String(s.group);
        if (!totals.has(key)) totals.set(key, new Float64Array(n));
        const sum = totals.get(key);
        for (let i = 0; i < n; i++) { const v = s.values[i]; if (v === v) sum[i] += Math.abs(v); }
      }
    }
    for (const s of visibleSeries()) {
      if (ownMark(s)) continue;
      const key = s.group == null ? "" : String(s.group);
      if (!state.has(key)) state.set(key, { pos: new Float64Array(n), neg: opts.type === "bar" ? new Float64Array(n) : null });
      const st = state.get(key);
      const top = new Float64Array(n);
      const base = new Float64Array(n);
      counters.allocBytes += 16 * n;
      const values = s.values;
      const sum = totals.get(key);
      for (let i = 0; i < n; i++) {
        const v = values[i];
        const value = v === v ? (sum ? (sum[i] > 0 ? v / sum[i] * 100 : 0) : v) : 0;
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

  // Label widths at the axis font, and at the bold font of the date line. The engine caches them.
  // Tick labels repeat on redraws. So, a draw measures only new texts.
  const widths = new Map();
  const boldWidths = new Map();
  function measureIn(cache, font, text) {
    let w = cache.get(text);
    if (w === undefined) {
      baseCtx.font = font;
      w = baseCtx.measureText(text).width;
      counters.textMeasures++;
      if (cache.size > 2000) cache.clear();
      cache.set(text, w);
    }
    return w;
  }
  const measure = (text) => measureIn(widths, theme.font, text);
  const measureBold = (text) => measureIn(boldWidths, theme.fontBold, text);

  // Block summaries of the long series, by series id. See extendSummary.
  // setData({ append: true }) lets each summary grow with its series.
  // Any other setData call starts the summaries again on their next use.
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

  // Min and max of a value array over [v0, v1). The engine keeps them while the array and the range stay the same.
  // Redraws on hover-free changes, resizes and theme changes use the kept values.
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

  // The visible range is the x domain: the zoom, or the whole domain. It also gives the indexes of its points.
  // A line has one point beyond each edge, so that the line leaves the plot.
  function viewOf() {
    const xs = opts.xs;
    const n = xs.length;
    const [fullLo, fullHi] = fullDomain();
    let [xLo, xHi] = zoom || [fullLo, fullHi];
    if (!(xHi > xLo)) [xLo, xHi] = [fullLo, fullHi];
    let i0 = opts.xKind === "category" ? Math.max(0, Math.ceil(xLo)) : lowerBound(xs, xLo);
    let i1 = opts.xKind === "category" ? Math.min(n, Math.floor(xHi) + 1) : upperBound(xs, xHi);
    const v0 = i0, v1 = i1;
    if (opts.type !== "bar" && opts.xKind !== "category") { i0 = Math.max(0, i0 - 1); i1 = Math.min(n, i1 + 1); }
    return { xLo, xHi, i0, i1, v0, v1 };
  }

  // The y axis of a visible range has a domain, ticks with their labels, and the width of the widest label.
  // It reads the data, the height of the plot and the font. It never reads the width of the chart.
  // So, the charts of an alignment group can ask each other for this axis.
  // A chart with an `alignKey` takes its step from the sequence of its kind. It ends its domain on a step (alignedAxis).
  // The other charts pad their range and keep the ticks inside it.
  function yAxisOf(view) {
    const { xLo, xHi, v0, v1 } = view;
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
    const xTwoLines = opts.xKind === "time" && !opts.xDateOnly;
    const bottom = xTwoLines ? 34 : 22;
    const padTop = PAD_TOP + ((opts.annotations || []).some((m) => m && m.label) ? ANNOTATION_GUTTER : 0);
    const plotH = Math.max(40, opts.height - padTop - bottom);
    // A fixed edge (yBounds), a log scale and a yAxis hook keep their own axis. They cannot end on a step.
    const aligned = !!alignKey && opts.yScale !== "log" && typeof opts.yAxis !== "function" && !Array.isArray(opts.yBounds);
    const pinned = isStacked() || opts.type === "bar";
    if (pinned) { yMin = Math.min(0, yMin); yMax = Math.max(0, yMax); }
    else if (yMin >= 0 && yMax - yMin > 0.25 * yMax) yMin = 0;
    else if (yMax <= 0 && yMax - yMin > 0.25 * -yMin) yMax = 0;
    if (yMax === yMin) {
      const pad = yMin === 0 ? 1 : Math.abs(yMin) * 0.1;
      yMin -= pad; yMax += pad;
    } else if (!aligned) {
      const pad = (yMax - yMin) * 0.06;
      // yHeadroom: more room above the largest value. Dots of a sparse series never sit on the top edge of the plot.
      const head = opts.yHeadroom > 0 ? (yMax - yMin) * opts.yHeadroom : pad;
      if (yMax !== 0 || !pinned) yMax += head;
      if (yMin !== 0) yMin -= pad;
    }

    // yBounds [min, max]: a fixed edge. null uses the edge of the data. A pair that leaves no range is ignored.
    if (Array.isArray(opts.yBounds)) {
      const lo = Number.isFinite(opts.yBounds[0]) ? opts.yBounds[0] : yMin;
      const hi = Number.isFinite(opts.yBounds[1]) ? opts.yBounds[1] : yMax;
      if (hi > lo) { yMin = lo; yMax = hi; }
    }

    let yAx;
    if (aligned) {
      // The plot height gives the number of intervals. So, every chart of a group whose plots are as high has the same number.
      const ax = alignedAxis(opts.yKind, yMin, yMax, Math.min(Y_MAX_INTERVALS, Math.max(2, Math.floor(plotH / Y_TICK_SPACE))), { whole: opts.yInteger === true, unitOf: yUnitFor });
      yAx = { min: ax.min, max: ax.max, step: ax.step, ticks: ax.values.map((v) => ({ v, label: yTickLabel(v, ax.step, ax.unit) })) };
    } else yAx = customYAxis(dataMin, dataMax, plotH);
    if (yAx) { yMin = yAx.min; yMax = yAx.max; }
    const yt = yAx ? { step: yAx.step || 0, values: yAx.ticks.map((t) => t.v) } : linearTicks(yMin, yMax, Math.max(2, Math.floor(plotH / Y_TICK_SPACE)));
    const yUnit = yUnitFor(Math.max(Math.abs(yMin), Math.abs(yMax)));
    const yLabels = yAx ? yAx.ticks.map((t) => t.label) : yt.values.map((v) => yTickLabel(v, yt.step, yUnit));
    let labelW = 0;
    for (const l of yLabels) labelW = Math.max(labelW, measure(l));
    return { yMin, yMax, plotH, padTop, bottom, ticks: yt, labels: yLabels, labelW };
  }

  // The visible range and its y axis are kept while nothing that they read changes (axisStamp).
  // A draw and the charts of the group that ask for the gutter share one computation.
  function axisNow() {
    if (axisCache && axisCache.stamp === axisStamp) return axisCache;
    if (!theme) theme = readTheme();
    if (stacks === undefined || stacks === null) computeStacks();
    const view = viewOf();
    axisCache = { stamp: axisStamp, view, axis: yAxisOf(view) };
    return axisCache;
  }

  // The gutter at the left of the plot (px) has room for the widest y label.
  // A chart of an alignment group uses the widest of the charts that share its x scale (alignGutter). So, their vertical grid lines sit at the same x.
  const ownGutter = (axis) => Math.ceil(Math.max(24, axis.labelW) + 12);
  const xScaleKey = (view, width) => `${opts.xKind}|${view.xLo}|${view.xHi}|${width}`;
  function gutterFor(axis, view, width) {
    const own = ownGutter(axis);
    const group = alignKey ? alignGroups.get(alignKey) : null;
    return group ? Math.max(own, alignGutter(group, xScaleKey(view, width))) : own;
  }

  function computeLayout(width) {
    const { view, axis } = axisNow();
    const { xLo, xHi, i0, i1, v0, v1 } = view;
    const { yMin, yMax, plotH, padTop, bottom, ticks: yt, labels: yLabels } = axis;
    const left = gutterFor(axis, view, width);
    const plotW = Math.max(40, width - left - PAD_RIGHT);
    const ky = plotH / (yMax - yMin);
    const kx = plotW / (xHi - xLo);
    const L = {
      width, height: opts.height, left, top: padTop, plotW, plotH, bottom,
      xLo, xHi, yMin, yMax, kx, ky, i0, i1, v0, v1,
      yTicks: yt.values.map((v, k) => ({ v, label: yLabels[k] })), yStep: yt.step,
      xOf: (x) => left + (x - xLo) * kx,
      yOf: (y) => padTop + plotH - (y - yMin) * ky,
      xAt: (px) => xLo + (px - left) / kx,
      yAt: (py) => yMin + (padTop + plotH - py) / ky,
    };
    if (opts.yScale === "log") applyLogScale(L);
    L.xTicks = xTicks(L);
    L.xLabels = layoutXLabels(L.xTicks, L.xOf, left, left + plotW, width, measure, measureBold);
    return L;
  }

  function xTicks(L) {
    const { xLo, xHi, plotW } = L;
    if (opts.xKind === "time") {
      if (opts.xDateOnly) {
        return timeTicks(xLo, xHi, plotW, measure).filter((t) => localMidnight(t.v) === t.v).map((t) => ({ v: t.v, label: dayLabel(t.v) }));
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
      for (let i = lo; i <= hi; i += every) labels.push({ v: i, label: short(i) });
      return labels;
    }
    const sample = formatValue(Math.max(Math.abs(xLo), Math.abs(xHi)));
    const count = Math.max(2, Math.min(14, Math.floor(plotW / (measure(sample) + 36))));
    const t = linearTicks(xLo, xHi, count, opts.xKind === "index");
    const unit = compactUnitFor(Math.max(Math.abs(xLo), Math.abs(xHi)));
    return t.values.map((v) => ({ v, label: formatTick(v, t.step, unit) }));
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

  // Snap a CSS coordinate to the device pixel grid. So, 1px lines stay crisp.
  const crisp = (v) => (Math.round(v * dpr) + 0.5) / dpr;

  // measure: a draw that is asked for now (flush) measures the plot.
  // It does this when the resize observer last saw the plot hidden. The plot may just have been shown.
  function draw(measure = false) {
    drawRaf = 0;
    if (destroyed) return;
    // The width that the resize observer saw last. A measure forces a layout for each chart.
    // Several charts redraw in one frame.
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
    markedSeries = 0;
    washedSeries = 0;
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
    stats = { points, series: all.length, perSeries, marked: markedSeries, washed: washedSeries, ms: performance.now() - t0 };
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
    settleGroup();
  }

  function publish() {
    const L = layout;
    root.dataset.pointsDrawn = String(stats.points);
    root.dataset.seriesDrawn = String(stats.series);
    root.dataset.pointsMarked = String(stats.marked || 0);
    root.dataset.seriesWashed = String(stats.washed || 0);
    root.dataset.xMin = String(L.xLo);
    root.dataset.xMax = String(L.xHi);
    root.dataset.interpolation = interpolation();
    root.dataset.gaps = String(gapInfo().count);
    root.dataset.yMin = String(L.yMin);
    root.dataset.yMax = String(L.yMax);
    root.dataset.zoomed = String(!!zoom);
    root.dataset.drawMs = stats.ms.toFixed(2);
    root.dataset.type = opts.type;
    // Test and debug hooks. They show what each series drew and where the plot is.
    root.dataset.seriesStats = JSON.stringify(stats.perSeries);
    root.dataset.draws = String((Number(root.dataset.draws) || 0) + 1);
    root.dataset.plot = `${L.left} ${L.top} ${L.plotW} ${L.plotH}`;
    // The y step and the number of its intervals. The charts of an alignment group have the same number.
    root.dataset.yStep = String(L.yStep);
    if (alignKey) root.dataset.align = alignKey;
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
    ctx.textAlign = "center";
    const y1 = top + plotH + TICK_LEN + 3;
    for (const t of L.xLabels) ctx.fillText(t.label, t.x, y1);
    ctx.font = theme.fontBold;
    ctx.fillStyle = rgba(theme.text, 0.8);
    for (const t of L.xLabels) if (t.context) ctx.fillText(t.context, t.cx, y1 + 14);
    ctx.font = theme.font;
  }

  function alphaFor(s) {
    return highlight && highlight !== s.id ? 0.18 : 1;
  }

  // Vertices of the series that is drawn. The engine reuses them across series and draws:
  // vx and vy are the line. vb is the stack base under it. runs gives the index where each
  // unbroken run starts. Lines break at NULLs.
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

  // A time axis has one regular step, such as a row per hour. Rows can be missing.
  // A gap wider than GAP_FACTOR steps breaks the line. So, a stop of the data does not read as a trend. This is the same break as a NULL.
  // The break is Infinity (no break) for the other axes, bars, a series of few points, and an irregular spacing (event times, months).
  // It is also Infinity when opts.connectGaps is set. The step is the median spacing. The engine takes it when most spacings equal it.
  const GAP_FACTOR = 1.5;
  let gapCache = { xs: null, n: -1, limit: Infinity, count: 0 };
  function gapInfo() {
    const xs = opts.xs;
    const n = xs ? xs.length : 0;
    if (opts.xKind !== "time" || opts.type === "bar" || n < 4) return { limit: Infinity, count: 0 };
    if (gapCache.xs === xs && gapCache.n === n) return gapCache;
    let limit = Infinity;
    let count = 0;
    const step = regularStep(xs);
    if (step) {
      limit = step * GAP_FACTOR;
      for (let i = 1; i < n; i++) if (xs[i] - xs[i - 1] > limit) count++;
    }
    gapCache = { xs, n, limit, count };
    return gapCache;
  }
  // The step times 1.5 when the line has gaps to break at. Otherwise it is Infinity, and the block summaries stay in use.
  const gapLimit = () => {
    if (opts.connectGaps) return Infinity;
    const info = gapInfo();
    return info.count ? info.limit : Infinity;
  };

  // One line goes through the visible points, as vertices. When there are more than two points per
  // device-pixel column, each column keeps its first, lowest, highest and last value. This makes one vertical stroke (base: false).
  // So every peak survives at any zoom. Otherwise, the column keeps its highest point and the matching base (base: an array, for stacked areas).
  // A draw costs O(points) arithmetic, but only O(width) canvas calls.
  function trace(L, ys, nulls, base, sum = null) {
    const xs = opts.xs;
    const { i0, i1, left, plotW, kx, ky, xLo, yMin } = L;
    const category = opts.xKind === "category";
    const bottom = L.top + L.plotH;
    const breakAll = !nulls;
    const gl = category ? Infinity : gapLimit();
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
        if (i > i0 && xs[i] - xs[i - 1] > gl) pen = false;
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
      if (i > i0 && xs[i] - xs[i - 1] > gl) { flush(); pen = false; }
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

  // A dense line has one entry per device-pixel column (colCount of them).
  // An entry holds its centre (css px), its first and last value, and its extent.
  // The extent is the highest and lowest value, and the step from the previous column. Values are in plot px.
  // colBrk marks a column after a NULL break, or the first column.
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

  // Per-column first, lowest, highest and last value of the visible points.
  // With a block summary (sum), a whole block of finite values that falls in one column is read from the summary.
  // The cost is O(n / BLOCK + columns * BLOCK).
  function traceColumns(L, ys, nulls, sum) {
    const xs = opts.xs;
    const { i0, i1, left, plotW, kx, ky, xLo, yMin } = L;
    const category = opts.xKind === "category";
    const bottom = L.top + L.plotH;
    const breakAll = !nulls;
    const gl = category ? Infinity : gapLimit();
    const xDev = (i) => Math.floor((left + ((category ? i : xs[i]) - xLo) * kx) * dpr);
    // A block summary does not know the gaps between its points. A series with gaps is read point by point.
    const useBlocks = !!sum && gl === Infinity && i1 - i0 > plotW * dpr * BLOCK * 2;
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
      if (i > i0 && xs[i] - xs[i - 1] > gl) { flush(); brk = true; }
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

  // The engine draws a column taller than this (css px) as a rect.
  // It draws flatter columns as a stroked line through their first and last value.
  const TALL_PX = 2;
  const isTall = (k) => colBot[k] - colTop[k] > TALL_PX || (colBrk[k] === 1 && (k + 1 === colCount || colBrk[k + 1] === 1));

  // A dense line is made by traceColumns(). Each tall column is one filled,
  // pixel-aligned rect. It runs from the highest to the lowest value, and the step
  // from the previous column. Runs of flat columns are one stroked line.
  // A stroke through every column's first, low, high and last value makes a
  // zigzag of thousands of tall segments. That took 100 ms and more to
  // rasterise per frame. The rects need no antialiasing pass.
  function drawColumns(ctx, L, s, c, alpha, wash) {
    const n = colCount;
    const lw = lineW(1.5);
    if (wash) {
      washedSeries++;
      // The wash under a single series, along each column's top.
      const baseY = Math.min(L.top + L.plotH, Math.max(L.top, L.yOf(Math.max(L.yMin, Math.min(0, L.yMax)))));
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
      ctx.fillStyle = washStyle(ctx, L, c, alpha, wash);
      ctx.fill();
    }
    const color = rgba(c, alpha);
    ctx.fillStyle = color;
    let rects = 0;
    // A rect is as wide as the line width (in device pixels). It is cut short where
    // the next column's rect starts. This stops double blending when the series is dimmed.
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

  // Line interpolation (opts.interpolation): "linear" (the default), "smooth" (a monotone cubic with no
  // overshoot past the data), "stepBefore" (the value of a point applies back to the previous one), and
  // "stepAfter" (the value of a point applies until the next one).
  const interpolation = () => (opts.interpolation === "smooth" || opts.interpolation === "stepBefore" || opts.interpolation === "stepAfter" ? opts.interpolation : "linear");
  let secants = new Float64Array(0);
  let tangents = new Float64Array(0);

  // The engine adds the vertices a to b-1 of X and Y to the path, forward or backward. An area's base comes back this way.
  // With `join`, the pen is already where the first vertex is. Otherwise, the pen moves there.
  function runTo(ctx, X, Y, a, b, back, join) {
    const first = back ? b - 1 : a;
    if (join) ctx.lineTo(X[first], Y[first]); else ctx.moveTo(X[first], Y[first]);
    if (b - a < 2) return;
    const mode = interpolation();
    if (mode === "smooth") { smoothRun(ctx, X, Y, a, b, back); return; }
    const step = back ? -1 : 1;
    const last = back ? a : b - 1;
    for (let k = first; k !== last; k += step) {
      const next = k + step;
      const lo = Math.min(k, next), hi = Math.max(k, next);
      if (mode === "stepBefore") ctx.lineTo(X[lo], Y[hi]);
      else if (mode === "stepAfter") ctx.lineTo(X[hi], Y[lo]);
      ctx.lineTo(X[next], Y[next]);
    }
  }

  // Fritsch-Butland tangents keep the direction of the data. So, the curve never swings past a value.
  function smoothRun(ctx, X, Y, a, b, back) {
    const n = b - a;
    if (secants.length < n) { secants = new Float64Array(Math.max(n, 2 * secants.length)); tangents = new Float64Array(secants.length); }
    for (let j = 0; j < n - 1; j++) {
      const dx = X[a + j + 1] - X[a + j];
      secants[j] = dx > 0 ? (Y[a + j + 1] - Y[a + j]) / dx : 0;
    }
    tangents[0] = secants[0];
    tangents[n - 1] = secants[n - 2];
    for (let j = 1; j < n - 1; j++) {
      const d0 = secants[j - 1], d1 = secants[j];
      if (d0 * d1 <= 0) { tangents[j] = 0; continue; }
      const h0 = X[a + j] - X[a + j - 1], h1 = X[a + j + 1] - X[a + j];
      tangents[j] = 3 * (h0 + h1) / ((2 * h1 + h0) / d0 + (h1 + 2 * h0) / d1);
    }
    const curve = (j) => {
      const x0 = X[a + j], y0 = Y[a + j], x1 = X[a + j + 1], y1 = Y[a + j + 1];
      const t = (x1 - x0) / 3;
      const c0x = x0 + t, c0y = y0 + tangents[j] * t, c1x = x1 - t, c1y = y1 - tangents[j + 1] * t;
      if (back) ctx.bezierCurveTo(c1x, c1y, c0x, c0y, x0, y0);
      else ctx.bezierCurveTo(c0x, c0y, c1x, c1y, x1, y1);
    };
    if (back) for (let j = n - 2; j >= 0; j--) curve(j);
    else for (let j = 0; j < n - 1; j++) curve(j);
  }

  function pathLine(ctx) {
    ctx.beginPath();
    for (let r = 0; r < runs.length; r++) runTo(ctx, vx, vy, runs[r], runEnd(r), false, false);
  }

  // Closed shapes between the line and its base. The base is an array, or one y.
  function pathFill(ctx, baseY) {
    ctx.beginPath();
    for (let r = 0; r < runs.length; r++) {
      const a = runs[r], b = runEnd(r);
      if (b - a < 2) continue;
      runTo(ctx, vx, vy, a, b, false, false);
      if (baseY == null) runTo(ctx, vx, vb, a, b, true, true);
      else { ctx.lineTo(vx[b - 1], baseY); ctx.lineTo(vx[a], baseY); }
      ctx.closePath();
    }
  }

  // The width of a line is opts.lineWidth. Otherwise, it is the width of the mark.
  const lineW = (own) => (opts.lineWidth > 0 ? opts.lineWidth : own);

  // The fill under a line: opts.fillOpacity (0..1) applies to every line.
  // When it is unset, a lone series ("auto") gets a light wash. Each line of an area that is not stacked gets 0.3.
  function washOf(unstackedArea) {
    if (Number.isFinite(opts.fillOpacity)) return opts.fillOpacity;
    if (unstackedArea) return 0.3;
    return opts.fill !== false && visibleSeries().length === 1 ? "auto" : 0;
  }

  function washStyle(ctx, L, c, alpha, wash) {
    if (wash !== "auto") return rgba(c, wash * alpha);
    const grad = ctx.createLinearGradient(0, L.top, 0, L.top + L.plotH);
    grad.addColorStop(0, rgba(c, 0.14 * alpha));
    grad.addColorStop(1, rgba(c, 0));
    return grad;
  }

  function drawSeries(ctx, L, s) {
    const c = seriesColor(s);
    const alpha = alphaFor(s);
    let type = s.type || opts.type;
    const nulls = s.nulls || null;
    const st = stacks && stacks.get(s.id);
    if (type === "area" && st) {
      // Fill between the top and the base of this series. Then stroke the top.
      trace(L, st.top, null, st.base);
      pathFill(ctx, null);
      ctx.fillStyle = rgba(c, (Number.isFinite(opts.fillOpacity) ? opts.fillOpacity : 0.3) * alpha);
      ctx.fill();
      pathLine(ctx);
      ctx.strokeStyle = rgba(c, alpha);
      ctx.lineWidth = lineW(1.25);
      ctx.lineJoin = "round";
      ctx.stroke();
      return vCount;
    }
    // An area that is not stacked: each series is a line with its own fill.
    const unstackedArea = type === "area";
    if (unstackedArea) type = "line";
    // A line with few values (few rows, or a sparse series between gaps) marks each value.
    // opts.showPoints controls this. "always" marks all values. "never" marks none.
    const maxPoints = L.plotW / POINTS_AUTO_SPACING;
    let count = 0;
    if (type === "line") for (let i = L.v0; i < L.v1 && count <= maxPoints; i++) if (s.values[i] === s.values[i]) count++;
    const marks = opts.showPoints === "always" ? "always" : opts.showPoints === "never" ? "never" : "auto";
    const showPoints = type === "points" || (type === "line" && (marks === "always" ? true : marks === "auto" && count > 0 && count <= maxPoints));
    if (showPoints && type === "line") markedSeries++;
    const radius = opts.pointSize > 0 ? opts.pointSize / 2 : 2.6;
    let drawn = 0;
    if (type === "line") {
      const wash = washOf(unstackedArea);
      trace(L, s.values, nulls, null, s.derived ? null : summaryOf(s));
      if (decimated) return drawColumns(ctx, L, s, c, alpha, wash);
      drawn = vCount;
      // Grafana's "opacity" gradient: a light wash under each line.
      if (wash) {
        washedSeries++;
        const baseY = Math.min(L.top + L.plotH, Math.max(L.top, L.yOf(Math.max(L.yMin, Math.min(0, L.yMax)))));
        pathFill(ctx, baseY);
        ctx.fillStyle = washStyle(ctx, L, c, alpha, wash);
        ctx.fill();
      }
      pathLine(ctx);
      ctx.strokeStyle = rgba(c, alpha);
      ctx.lineWidth = lineW(1.5);
      // Use round joins only where angles show. A decimated line is mostly
      // vertical strokes. These rasterise much cheaper with bevels.
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
        ctx.moveTo(x + radius, y);
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        dots++;
      }
      ctx.fillStyle = rgba(c, alpha);
      ctx.fill();
      if (type === "points") drawn = dots;
    }
    return drawn;
  }

  // Bars are centred on x. Groups are side by side, and the series of a group are stacked.
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
    // Adjacent bars keep a 1 px gap at least, however dense.
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

  // The x readout is the tooltip title and the x badge. A time axis of buckets
  // (bucketMs) reads the range of the bucket (ns.format.range). This is one format for every chart.
  // bucketAlign "center" applies when xs are bucket middles.
  function xReadout(i) {
    if (typeof opts.xReadout === "function") return opts.xReadout(i);
    if (opts.xKind === "category") return String(opts.categories[i] ?? "");
    const x = opts.xs[i];
    if (opts.xKind === "time" && Number(opts.bucketMs) > 0 && format?.range) {
      const start = opts.bucketAlign === "center" ? x - Number(opts.bucketMs) / 2 : x;
      return format.range(start, start + Number(opts.bucketMs));
    }
    if (opts.xKind === "time") return opts.xDateOnly ? dateText(x) : formatInstant(x, opts.xFractionDigits);
    if (opts.xKind === "index") return `Row ${formatExact(x)}`;
    return formatExact(x);
  }

  function scheduleOverlay() {
    overlayFrame();
  }

  // The cursor is DOM, like uPlot's. Dashed lines, series points and the axis readouts move with compositor-only transforms.
  // So, a hover never repaints or uploads a canvas, whatever the devicePixelRatio.
  const show = (el, on) => { if (el.hidden === on) el.hidden = !on; };
  const place = (el, x, y) => { el.style.transform = `translate(${Math.round(x * dpr) / dpr}px, ${Math.round(y * dpr) / dpr}px)`; };
  let lastBadgeX = "";
  let lastBadgeY = "";

  // Badge and tooltip sizes are set by a ResizeObserver, after the browser's own layout.
  // So, a cursor move never forces a synchronous layout.
  // A changed size re-places them on the next frame. Only the first sight of an element measures it directly.
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
  const moveFrame = util.rafOnce(() => {
    if (!pendingMove) return;
    moveCursor(pendingMove);
    // This frame already runs. The crosshair and readouts move with the
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
  // A press on the plot starts a zoom gesture. It never selects text or starts a native drag.
  // A native drag would cancel the pointer stream.
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
  // Escape cancels a drag in progress. ns.layers does not see the key.
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
    // A hover readout is not announced. The keyboard cursor readout is announced in one polite region.
    if (!tooltipEl.hidden) uiState?.announce?.(tooltipEl.textContent);
  });
  overCanvas.addEventListener("blur", () => { if (!drag) leaveCursor(); });
  document.addEventListener("keydown", onKey, true);

  // --- legend (Grafana: click isolates, Ctrl / Cmd+click toggles; legendClick "filter": the click is the host's) --------------

  const LEGEND_COLUMNS = ["total", "min", "max", "mean", "last"];
  const LEGEND_HEADS = { total: "Total", min: "Min", max: "Max", mean: "Mean", last: "Last" };
  const NO_CALCS = { total: NaN, min: NaN, max: NaN, mean: NaN, last: NaN };

  // The columns of the table, in their order. opts.legendColumns keeps some of them. A chart whose values do not add up omits the Total.
  function legendColumns() {
    const asked = Array.isArray(opts.legendColumns) ? LEGEND_COLUMNS.filter((name) => opts.legendColumns.includes(name)) : [];
    return asked.length ? asked : LEGEND_COLUMNS;
  }

  // The table shows these values of a series over the visible range: the total, the min, the max, the mean and the last value.
  // A series with `weights` (one per point: the calls behind an average, the requests behind a rate) has a weighted mean.
  // This mean is the average of all the points that it represents. It is not the average of the averages.
  function calcs(s) {
    const L = layout;
    let min = Infinity, max = -Infinity, sum = 0, count = 0, last = NaN, weighted = 0, weight = 0;
    // `stats`: the values to read when the plot omits some. An example is a zero that a stack does not draw.
    const values = s.stats && s.stats.length >= s.values.length ? s.stats : s.values;
    const a = L && !s.xs ? L.v0 : 0, b = L && !s.xs ? L.v1 : values.length;
    const weights = s.weights && s.weights.length >= values.length ? s.weights : null;
    const summary = weights || values !== s.values ? null : summaryOf(s);
    if (summary) {
      const r = summaryRange(summary, values, a, b);
      for (let i = b - 1; i >= a; i--) if (values[i] === values[i]) { last = values[i]; break; }
      return r.count ? { total: r.total, min: r.min, max: r.max, mean: r.total / r.count, last } : NO_CALCS;
    }
    for (let i = a; i < b; i++) {
      const v = values[i];
      if (v !== v) continue;
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
      count++;
      last = v;
      if (weights && weights[i] > 0) { weighted += weights[i] * v; weight += weights[i]; }
    }
    if (!count) return NO_CALCS;
    return { total: sum, min, max, mean: weights ? (weight > 0 ? weighted / weight : NaN) : sum / count, last };
  }

  // An entry is on when its series is shown (a legend that hides). It is also on when the host says it is picked (legendClick "filter": legendPressed(series)).
  const filterLegend = () => opts.legendClick === "filter";
  const legendPressedOf = (s) => (filterLegend() ? typeof opts.legendPressed === "function" && !!opts.legendPressed(s) : !hidden.has(s.id));

  // An entry is a row of the list, or a cell of the first column of the table. A legend that filters dims the entries that the pressed ones omit (is-off).
  // `legendDisabled(series)` locks an entry that is not a filter. The entry has no click and no aria-pressed.
  function legendItemHtml(s, index, anyPressed = false) {
    const filter = filterLegend();
    const pressed = legendPressedOf(s);
    const locked = filter && typeof opts.legendDisabled === "function" && !!opts.legendDisabled(s);
    const c = rgba(seriesColor(s));
    const title = typeof opts.legendTitle === "function" ? opts.legendTitle(s, pressed) : `${s.label}\n${legendHint()}`;
    const off = filter && anyPressed && !pressed;
    return `<button type="button" class="chartCore__legendItem${filter ? " chartCore__legendItem--filter" : ""}${s.dash ? " is-dashed" : ""}${off ? " is-off" : ""}" data-index="${index}" data-series="${esc(s.id)}"${locked ? " disabled" : ` aria-pressed="${pressed}"`} title="${esc(title)}"><i style="background-color:${c}"></i><span>${esc(s.label)}</span></button>`;
  }

  // The "totals" legend shows each series with its total over the whole range. A
  // click goes to opts.onLegendClick(series, event), for example a filter.
  // opts.legendPressed(series) says which series are on.
  function seriesTotal(s) {
    let sum = 0;
    for (let i = 0; i < s.values.length; i++) { const v = s.values[i]; if (v === v) sum += v; }
    return sum;
  }

  // The legend reads at full strength. When some series are pressed (a
  // filter), the others are left out and dim (is-off).
  function legendTotalItemHtml(s, index, anyPressed) {
    const pressed = typeof opts.legendPressed === "function" ? !!opts.legendPressed(s) : false;
    const c = rgba(seriesColor(s));
    const total = typeof opts.legendTotal === "function" ? opts.legendTotal(s, seriesTotal(s)) : formatValue(seriesTotal(s));
    const title = typeof opts.legendTitle === "function" ? opts.legendTitle(s, pressed) : s.label;
    return `<button type="button" class="chartCore__legendItem chartCore__legendItem--total${s.dash ? " is-dashed" : ""}${anyPressed && !pressed ? " is-off" : ""}" data-index="${index}" data-series="${esc(s.id)}" aria-pressed="${pressed}" title="${esc(title)}"><i style="background-color:${c}"></i><span>${esc(s.label)}</span><b>${esc(total)}</b></button>`;
  }

  // The engine rebuilds the legend markup only when it changes.
  // A resize, a theme change or streamed rows redraw the plot, not the legend.
  // The values of the total, min, max, mean and last table are written into its cells.
  let legendHtml = null;
  function setLegendHtml(html) {
    if (html === legendHtml) return false;
    counters.legendBuilds++;
    legendHtml = html;
    legendEl.innerHTML = html;
    return true;
  }

  // The legend shows by default when there is more than one series.
  // "always" shows it even for one series. false hides it. "totals" selects the totals legend.
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
    const columns = legendColumns();
    const names = columns.map((name) => LEGEND_HEADS[name].toLowerCase()).join(" / ");
    const modeBtn = `<button type="button" class="chartCore__legendMode" aria-pressed="${legendMode === "table"}" title="${legendMode === "table" ? "Show the legend as a list" : `Show ${names} per series`}">${legendMode === "table" ? "List" : "Values"}</button>`;
    const filter = filterLegend();
    const anyPressed = filter && opts.series.some(legendPressedOf);
    if (legendMode === "table") {
      // A cell uses the format of the chart values (formatValue). Otherwise, legendFormat(value, column, series) formats it. A mean of counts has decimals.
      const fmt = (v, column, s) => {
        if (v !== v) return "\u2014";
        if (typeof opts.legendFormat === "function") return opts.legendFormat(v, column, s);
        return typeof opts.formatValue === "function" ? opts.formatValue(v) : formatValue(v);
      };
      const rows = opts.series.map((s, index) => `<tr${anyPressed && !legendPressedOf(s) ? ' class="is-off"' : ""}><th scope="row">${legendItemHtml(s, index, anyPressed)}</th>${columns.map(() => "<td></td>").join("")}</tr>`).join("");
      const heads = columns.map((name) => `<th scope="col">${LEGEND_HEADS[name]}</th>`).join("");
      setLegendHtml(`<div class="chartCore__legendTableWrap"><table class="chartCore__legendTable" aria-label="Values of the series"><thead><tr><th scope="col">Series</th>${heads}</tr></thead><tbody>${rows}</tbody></table></div>${modeBtn}`);
      const body = $(".chartCore__legendTable tbody", legendEl);
      opts.series.forEach((s, index) => {
        const row = body && body.rows[index];
        if (!row) return;
        const c = calcs(s);
        columns.forEach((name, k) => {
          const cell = row.cells[k + 1];
          const text = fmt(c[name], name, s);
          if (cell.textContent !== text) { cell.textContent = text; counters.legendUpdates++; }
        });
      });
    } else {
      setLegendHtml(`<div class="chartCore__legendList">${opts.series.map((s, index) => legendItemHtml(s, index, anyPressed)).join("")}</div>${modeBtn}`);
    }
  }

  // The mode of the legend, list or table, is a preference. The next chart starts with it.
  // The charts of an alignment group change together, because they are read side by side.
  // onLegendMode(mode) tells the host, for example a page that sizes the cards for it.
  function setLegendMode(mode) {
    if (mode !== "list" && mode !== "table") return;
    const changed = mode !== legendMode;
    legendMode = mode;
    // A chart that has not drawn yet (no theme) writes its legend with its first draw.
    if (changed && theme) renderLegend();
    if (typeof opts.onLegendMode === "function") opts.onLegendMode(mode);
  }

  function setHiddenInternal(next, focusIndex) {
    hidden = next;
    stacks = null;
    axisStamp++;
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
      const next = legendMode === "table" ? "list" : "table";
      storeLegendMode(next);
      setLegendMode(next);
      const group = alignKey ? alignGroups.get(alignKey) : null;
      if (group) for (const other of group) if (other !== member) other.setLegendMode(next);
      const again = $(".chartCore__legendMode", legendEl);
      if (again) again.focus({ preventScroll: true });
      return;
    }
    const item = ev.target.closest(".chartCore__legendItem");
    if (!item) return;
    const index = Number(item.dataset.index);
    const s = opts.series[index];
    if (!s) return;
    if (opts.legend === "totals" || filterLegend()) {
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
    axisStamp++;
    tooltipKey = "";
    refreshCursor = true;
    // A gesture draws now (one per gesture); data changes wait for the frame.
    flushDraw(true);
    if (typeof opts.onZoom === "function") opts.onZoom([a, b], fromUser);
  }

  function resetZoom(fromUser = false) {
    if (!zoom) return;
    zoom = null;
    axisStamp++;
    tooltipKey = "";
    flushDraw(true);
    if (typeof opts.onZoom === "function") opts.onZoom(null, fromUser);
  }

  // --- Options for the Logs histogram and the Metrics panels ------------------------------
  //
  //   xDomain: [lo, hi]          the full x domain (the requested time range), not the data's
  //   yInclude: [v, ...]         values the y domain always covers (0, exemplar values)
  //   yHeadroom: 0.15            room above the largest value, a share of the range (default 0.06)
  //   yUnit(maxAbs)              -> { factor, suffix }: the y tick unit (default K / M / B / T)
  //   formatY(v)                 the y readout of the cursor
  //   barWidthRatio              bar width / slot width (default 0.72)
  //   series[].dash: [6, 3]      dashed line (and legend swatch)
  //   tooltipTitle(i)            the tooltip heading (default: the x readout)
  //   tooltipSort: "desc" | "reverse"   rows by value, or bottom-of-stack last
  //   tooltipMaxRows             rows past it fold into "+N more"
  //   tooltipNulls: false        no "NULL" rows (gap flags from bridgeGaps are not values)
  //   legendClick: "toggle"      click shows / hides, Alt / Ctrl / Cmd+click isolates
  //   legendClick: "filter"      the host handles the click: onLegendClick(series, event) (a filter), nothing is hidden. legendPressed(series) says
  //                              which entries are on (the others dim while some are), legendDisabled(series) locks an entry (no click, no
  //                              aria-pressed) and legendTitle(series, pressed) writes its title
  //   legendColumns: ["min", ...] the columns of the Values table, among total, min, max, mean and last (all by default); series[].weights (one
  //                              number per point: the calls behind an average, the requests behind a rate) makes the Mean the mean of the values weighted by them;
  //                              series[].stats: the values that the table reads when the plot omits some (the zeros of a stack);
  //                              legendFormat(value, column, series): the text of a cell (default: formatValue)
  //   onLegendMode(mode)         the legend went to "list" or "table" (by its button, or with the other charts of its alignment group)
  //   alignKey: "page"           charts that share it are aligned: the same number of intervals on the y axis, ending on a step of yKind,
  //                              and one gutter for those that share an x scale; set when the chart is made (see "Alignment groups")
  //   yKind: "number" | "bytes" | "duration" | "percent"   the steps and the unit of an aligned y axis: 1-2-2.5-5 x 10^n, the same in KB / MB / GB,
  //                              the clock for milliseconds, a % suffix for values in percent that stop at 100 (alignedAxis); yInteger: true
  //                              keeps the steps of a "number" axis whole (counts)
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

  const legendHint = () => (filterLegend()
    ? "Click: filter by this series"
    : opts.legendClick === "toggle"
      ? "Click: show or hide it\nAlt / Ctrl / Cmd+click: show only this series (again: show all)"
      : "Click: show only this series (again: show all)\nCtrl / Cmd+click: show or hide it");

  function legendToggles(ev) {
    const modified = ev.ctrlKey || ev.metaKey || (opts.legendClick === "toggle" && ev.altKey);
    return opts.legendClick === "toggle" ? !modified : modified;
  }

  // Markers are diamonds. They are drawn on the plot canvas, under a pool of transparent links.
  // The engine moves the links on redraws and never rebuilds them. The links take the pointer and the keyboard.
  // A link paints nothing until it is hovered or focused. Links sit at left and top, with no transform.
  // So, hundreds of them add no compositing work.
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

  // The engine samples dense markers. Past one per MARKER_DENSE_PX of plot width,
  // each column of that width keeps its highest marker (the slowest exemplar).
  // So, a long range shows a readable scatter, not a row of diamonds.
  // A closer zoom keeps every marker of a column reachable.
  const MARKER_DENSE_PX = 40;
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

  // Every change draws once, on the next animation frame. Several setData calls in a frame
  // (a streamed result, or a zoom reset with new data) cost one draw. next.append means that the arrays only grew at their end since the last
  // setData (rows appended). So, the block summaries grow and are not computed again.
  // A call to layout(), stats(), points() or toClient() draws a pending change first.
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
    axisStamp++;
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
    axisStamp++;
    widths.clear();
    boldWidths.clear();
    tooltipKey = "";
    scheduleDraw();
  }

  function destroy() {
    destroyed = true;
    live.delete(api);
    if (opts.syncKey && syncGroups.has(opts.syncKey)) syncGroups.get(opts.syncKey).delete(api);
    if (member) {
      const group = alignGroups.get(alignKey);
      if (group) {
        group.delete(member);
        if (!group.size) alignGroups.delete(alignKey);
      }
      settleGroup();
    }
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
  // Traces charts). Every option is optional. Without them, the chart behaves
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
  //   yBounds: [min, max]   fixed y edges (null: the data's own; a pair with max <= min is ignored).
  //   interpolation         "linear" | "smooth" | "stepBefore" | "stepAfter": the shape of line and area paths.
  //   lineWidth             px (default 1.5, an area's top 1.25); fillOpacity 0..1: the fill under every line.
  //   showPoints            "auto" | "always" | "never": the marks on a line; pointSize px (diameter, default 5.2).
  //   stackMode             "percent": a stack shows shares out of 100 (default: the values add up).
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
  const boxFrame = util.rafOnce((p) => updateBox(p));
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

  // Series that the main pass omits: points with their own x or per-point
  // style settings, lines over bars, every series of a log chart.
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

  // A tooltip shows the host's content beside (px, py), in plot px. Its size
  // is set by the size observer. The observer re-places the tooltip after the new content
  // is positioned. A pointer move causes no synchronous layout.
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
    // [label, context, left, right, context left, context right] of each x label drawn.
    root.dataset.xTicks = JSON.stringify(L.xLabels.map((t) => [t.label, t.context, Math.round(t.left), Math.round(t.right)]
      .concat(t.context ? [Math.round(t.cleft), Math.round(t.cright)] : [])));
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
    // The gaps of a regular time axis (rows missing between points): how many break the line.
    gaps: () => gapInfo().count,
    layout: () => { flushDraw(); return layout; },
    flush: () => flushDraw(),
    // True until the plot is drawn at its current width. This is true when a draw is
    // scheduled, or when the width changed (a scrollbar came, or the window
    // was resized) and the resize observer has not drawn it yet. Until then, layout() and
    // toClient() describe the last frame drawn.
    drawPending: () => !destroyed && (!!drawRaf || pendingDraw || (!released && plotWidth() !== sizeW)),
    // The mode of the legend, "list" or "table". setLegendMode does not keep it as the preference. The click on the button does.
    legendMode: () => legendMode,
    setLegendMode,
    // Markers move with the plot. A replacement needs no plot redraw.
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
  if (member) {
    if (!alignGroups.has(alignKey)) alignGroups.set(alignKey, new Set());
    alignGroups.get(alignKey).add(member);
    // The first draw waits for the frame. So, the charts of a group that are made one after the other are drawn with the gutter of all of
    // them. flush() and the readers of the layout draw at once.
    scheduleDraw();
  } else draw();
  return api;
}

export const chartCore = {
  create,
  // Scales and formats, shared with the charts that draw their own marks.
  timeTicks,
  layoutXLabels,
  linearTicks,
  niceStep,
  alignedAxis,
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
  regularStep,
  logTicks,
  counters: () => ({ ...counters }),
  resetCounters,
  // The mode of the legend that a chart starts with (the preference): "list" or "table".
  legendMode: readLegendMode,
  // The colour helpers and their batches, for the equivalence tests.
  colors: { parseColor, parseColors, rgba, rgbaBatch },
  // The chart drawn in (or at) an element: tests and hosts reach its API.
  of(el) {
    const node = el && (el.classList && el.classList.contains("chartCore") ? el : el.querySelector && $(".chartCore", el));
    return (node && instances.get(node)) || null;
  },
};
