(() => {
  "use strict";

  // Query result charts: a Table / Chart toggle for a result panel and a
  // client-side chart drawn from the rows the panel already received (no
  // re-query). Each result panel (the main one and every multiquery panel)
  // owns one controller, so its view and chart settings live with the result.
  const ns = window.ChDash;
  if (!ns) return;

  const VIEW_STORE_KEY = "chdash.results.view";
  const SVG_NS = "http://www.w3.org/2000/svg";
  // Drawing budget: at most this many points per series reach the SVG. Larger
  // results keep every row for the tooltip but draw a min/max envelope.
  const MAX_DRAWN_POINTS = 2000;
  const ENVELOPE_BUCKETS = 500;
  // Coloured series slots (--qchart-1..8); further groups fold into "Other".
  const MAX_SERIES = 8;
  const PLOT_HEIGHT = 300;
  const MARGIN = { top: 12, right: 16, bottom: 30 };
  const MIN_REBUILD_INTERVAL_MS = 200;
  const CHART_TYPES = [
    ["line", "Line"],
    ["area", "Stacked area"],
    ["bar", "Bar"],
    ["number", "Number"],
  ];
  const NO_NUMERIC_TITLE = "Chart unavailable: the result has no numeric column";

  const esc = (value) => String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  function readStoredView() {
    try {
      return window.localStorage.getItem(VIEW_STORE_KEY) === "chart" ? "chart" : "table";
    } catch {
      return "table";
    }
  }

  function storeView(view) {
    try {
      window.localStorage.setItem(VIEW_STORE_KEY, view === "chart" ? "chart" : "table");
    } catch {
      // Storage may be unavailable (private mode); the panel keeps its view.
    }
  }

  // --- Column types ---------------------------------------------------------

  function unwrapType(type) {
    let text = String(type || "").trim();
    for (let guard = 0; guard < 8; guard++) {
      const wrapper = /^(?:Nullable|LowCardinality)\((.*)\)$/.exec(text);
      if (wrapper) { text = wrapper[1].trim(); continue; }
      const simple = /^SimpleAggregateFunction\([^,]+,\s*(.*)\)$/.exec(text);
      if (simple) { text = simple[1].trim(); continue; }
      break;
    }
    return text;
  }

  // "date" | "time" | "number" | "string" | "other"
  function columnKind(type) {
    const t = unwrapType(type);
    if (/^Date(?:32)?$/.test(t)) return "date";
    if (/^DateTime(?:64)?(?:\(.*\))?$/.test(t)) return "time";
    if (/^(?:U?Int(?:8|16|32|64|128|256)|Float(?:32|64)|BFloat16|Decimal(?:32|64|128|256)?(?:\(.*\))?)$/.test(t)) return "number";
    if (/^(?:String|FixedString\(\d+\)|Enum(?:8|16)?\(.*\)|UUID|IPv4|IPv6|Bool)$/.test(t)) return "string";
    return "other";
  }

  function axisKindOf(columnKindValue) {
    if (columnKindValue === "date" || columnKindValue === "time") return "time";
    if (columnKindValue === "number") return "number";
    return "category";
  }

  // --- Values ---------------------------------------------------------------

  function toNumber(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
    if (typeof value === "string") {
      if (!value.trim()) return NaN;
      const n = Number(value);
      return Number.isFinite(n) ? n : NaN;
    }
    if (typeof value === "boolean") return value ? 1 : 0;
    return NaN;
  }

  const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/;

  // Milliseconds since the epoch (fractional below a millisecond). A bare date
  // is a calendar day (local midnight), so it reads the same day everywhere.
  function toTimeMs(value, kind) {
    if (value == null) return NaN;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return NaN;
      return kind === "date" ? value * 86400000 : value * 1000;
    }
    const text = String(value).trim();
    const m = ISO_TIME.exec(text);
    if (!m) {
      const parsed = Date.parse(text);
      return Number.isFinite(parsed) ? parsed : NaN;
    }
    const [, y, mo, d, h = "0", mi = "0", s = "0", frac = "", zone] = m;
    const fracMs = frac ? Number(`0.${frac}`) * 1000 : 0;
    const wholeMs = Math.floor(fracMs);
    if (!zone) {
      return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), wholeMs).getTime() + (fracMs - wholeMs);
    }
    let ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), wholeMs) + (fracMs - wholeMs);
    if (zone !== "Z") {
      const sign = zone[0] === "-" ? -1 : 1;
      const digits = zone.slice(1).replace(":", "");
      ms -= sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4))) * 60000;
    }
    return ms;
  }

  function categoryKey(value) {
    if (value == null) return "NULL";
    if (typeof value === "object") {
      try { return JSON.stringify(value); } catch { return String(value); }
    }
    return String(value);
  }

  // --- Number formatting ----------------------------------------------------

  const COMPACT_UNITS = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];

  // Plain numbers up to 9,999 ("200", "1,000"), then K / M / B / T.
  function compactUnitFor(maxAbs) {
    for (const [factor, suffix] of COMPACT_UNITS) if (maxAbs >= (factor === 1e3 ? 1e4 : factor)) return { factor, suffix };
    return { factor: 1, suffix: "" };
  }

  // Axis labels share one unit and one decimal count, so ticks line up:
  // 0, 2.5K, 5K, 7.5K / 0.05, 0.10, 0.15.
  function formatTickNumber(value, step, unit) {
    if (value === 0) return "0";
    const { factor, suffix } = unit;
    const scaledStep = Math.abs(step / factor);
    const decimals = scaledStep > 0 ? Math.min(8, Math.max(0, Math.ceil(-Math.log10(scaledStep) - 1e-9))) : 0;
    const scaled = value / factor;
    const text = suffix
      ? scaled.toFixed(decimals)
      : scaled.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    return `${/^-0(?:\.0*)?$/.test(text) ? "0" : text}${suffix}`;
  }

  function formatFullNumber(value) {
    if (!Number.isFinite(value)) return "null";
    if (Number.isInteger(value)) return value.toLocaleString("en-US");
    const abs = Math.abs(value);
    if (abs !== 0 && (abs < 1e-6 || abs >= 1e15)) return value.toPrecision(6);
    return Number(value.toPrecision(12)).toLocaleString("en-US", { maximumFractionDigits: 6 });
  }

  function niceStep(rawStep) {
    if (!(rawStep > 0) || !Number.isFinite(rawStep)) return 1;
    const magnitude = 10 ** Math.floor(Math.log10(rawStep));
    const normalized = rawStep / magnitude;
    const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
    return nice * magnitude;
  }

  // Ticks on round values covering [min, max]; the domain snaps to them.
  function niceTicks(min, max, targetCount, { integer = false } = {}) {
    let lo = Number(min);
    let hi = Number(max);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = 0; hi = 1; }
    if (hi < lo) [lo, hi] = [hi, lo];
    if (hi === lo) {
      const pad = lo === 0 ? 1 : Math.abs(lo) * 0.1;
      lo -= pad;
      hi += pad;
    }
    let step = niceStep((hi - lo) / Math.max(1, targetCount));
    if (integer) step = Math.max(1, Math.round(step));
    const start = Math.floor(lo / step + 1e-9) * step;
    const end = Math.ceil(hi / step - 1e-9) * step;
    const values = [];
    for (let i = 0; start + i * step <= end + step * 1e-6 && i < 200; i++) {
      const v = start + i * step;
      values.push(Math.abs(v) < step * 1e-9 ? 0 : Number(v.toPrecision(12)));
    }
    return { min: start, max: end, step, values };
  }

  // --- Time axis (browser-local time, like the Traces charts) --------------

  const SECOND_MS = 1000, MINUTE_MS = 60000, HOUR_MS = 3600000, DAY_MS = 86400000;
  const SUB_DAY_STEPS_MS = [
    1, 2, 5, 10, 20, 50, 100, 200, 500,
    SECOND_MS, 2 * SECOND_MS, 5 * SECOND_MS, 10 * SECOND_MS, 15 * SECOND_MS, 30 * SECOND_MS,
    MINUTE_MS, 2 * MINUTE_MS, 5 * MINUTE_MS, 10 * MINUTE_MS, 15 * MINUTE_MS, 30 * MINUTE_MS,
    HOUR_MS, 2 * HOUR_MS, 3 * HOUR_MS, 6 * HOUR_MS, 12 * HOUR_MS,
  ];
  const DAY_STEPS = [1, 2, 7, 14];
  const MONTH_STEPS = [1, 2, 3, 6];
  const YEAR_STEPS = [1, 2, 5, 10, 20, 50, 100];
  const pad2 = (value) => String(value).padStart(2, "0");
  const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const labelWidthPx = (text) => String(text).length * 6.1 + 4;

  function localMidnight(ms) {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function clockLabel(ms, precision) {
    const d = new Date(ms);
    const base = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    if (precision === "minute") return base;
    const withSeconds = `${base}:${pad2(d.getSeconds())}`;
    if (precision === "second") return withSeconds;
    return `${withSeconds}.${String(d.getMilliseconds()).padStart(3, "0")}`;
  }

  const dayLabel = (ms) => {
    const d = new Date(ms);
    return `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`;
  };

  // Full instant for tooltips: 2026-09-30 14:05:00 (milliseconds when the
  // data has them).
  function formatInstant(ms, withMillis) {
    if (!Number.isFinite(ms)) return "—";
    const d = new Date(Math.floor(ms));
    const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    return `${date} ${clockLabel(d.getTime(), withMillis ? "milli" : "second")}`;
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
    for (let y = first; y <= first + 10000; y++) {
      const t = new Date(y, 0, 1).getTime();
      if (t > endMs) break;
      if (t >= startMs && y % everyYears === 0) ticks.push(t);
    }
    return ticks;
  }

  // The smallest calendar-aligned step whose labels keep apart at this width.
  function timeAxisTicks(startMs, endMs, plotWidthPx) {
    const span = Math.max(1, endMs - startMs);
    const width = Math.max(80, plotWidthPx);
    const multiDay = span > DAY_MS;
    const fits = (count, sample) => count <= 60 && width / Math.max(1, count) >= labelWidthPx(sample) + 16;
    for (const step of SUB_DAY_STEPS_MS) {
      const precision = step < SECOND_MS ? "milli" : step < MINUTE_MS ? "second" : "minute";
      const sample = multiDay ? "Sep 30 12:00" : precision === "milli" ? "00:00:00.000" : precision === "second" ? "00:00:00" : "00:00";
      if (!fits(span / step, sample)) continue;
      return subDayTicks(startMs, endMs, step).map((t) => ({
        t,
        label: localMidnight(t) === t && precision === "minute" ? dayLabel(t) : multiDay ? `${dayLabel(t)} ${clockLabel(t, "minute")}` : clockLabel(t, precision),
      }));
    }
    for (const days of DAY_STEPS) {
      if (!fits(span / (days * DAY_MS), "Sep 30")) continue;
      return dayTicks(startMs, endMs, days).map((t) => ({ t, label: dayLabel(t) }));
    }
    const monthMs = 30.44 * DAY_MS;
    for (const months of MONTH_STEPS) {
      if (!fits(span / (months * monthMs), "Sep 2026")) continue;
      return monthTicks(startMs, endMs, months).map((t, index) => {
        const d = new Date(t);
        return { t, label: d.getMonth() === 0 || index === 0 ? `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}` : MONTH_NAMES[d.getMonth()] };
      });
    }
    for (const years of YEAR_STEPS) {
      if (!fits(span / (years * 365.25 * DAY_MS), "2026") && years !== YEAR_STEPS[YEAR_STEPS.length - 1]) continue;
      return yearTicks(startMs, endMs, years).map((t) => ({ t, label: String(new Date(t).getFullYear()) }));
    }
    return [];
  }

  // --- Configuration --------------------------------------------------------

  function metaSignature(columns, types) {
    return JSON.stringify([columns, types]);
  }

  function defaultConfig(meta) {
    const { kinds } = meta;
    const numeric = [];
    for (let i = 0; i < kinds.length; i++) if (kinds[i] === "number") numeric.push(i);
    let x = kinds.findIndex((kind) => kind === "time" || kind === "date");
    if (x < 0) {
      if (kinds[0] === "number" && numeric.length >= 2) x = 0;
      else if (kinds[0] === "string") x = 0;
      else x = -1;
    }
    const series = numeric.filter((i) => i !== x).slice(0, MAX_SERIES);
    // A time series with a label column is usually the long form of
    // GROUP BY time, label: one line per label.
    let group = -1;
    if (x >= 0 && axisKindOf(kinds[x]) === "time") {
      group = kinds.findIndex((kind, i) => kind === "string" && i !== x);
    }
    return { x, series, group, type: "line", typeAuto: true };
  }

  function normalizeConfig(cfg, meta) {
    const { kinds } = meta;
    const valid = (i) => Number.isInteger(i) && i >= 0 && i < kinds.length;
    if (cfg.x !== -1 && !valid(cfg.x)) cfg.x = -1;
    cfg.series = cfg.series.filter((i, pos, all) => valid(i) && i !== cfg.x && kinds[i] === "number" && all.indexOf(i) === pos).slice(0, MAX_SERIES);
    if (cfg.group !== -1 && (!valid(cfg.group) || cfg.group === cfg.x || cfg.series.includes(cfg.group))) cfg.group = -1;
    if (cfg.typeAuto) {
      const xKind = cfg.x < 0 ? "index" : axisKindOf(kinds[cfg.x]);
      cfg.type = xKind === "category" ? "bar" : "line";
    }
    return cfg;
  }

  // --- Model: rows -> sorted x values and one value array per drawn line ----

  function buildModel(cfg, meta, rows) {
    const { kinds, columns } = meta;
    const xi = cfg.x;
    const xKind = xi < 0 ? "index" : axisKindOf(kinds[xi]);
    const xColumnKind = xi < 0 ? "" : kinds[xi];
    const series = cfg.series.slice();
    const gi = cfg.group;
    const lines = [];
    let groupSlot = null;
    let groupCount = 0;
    let foldedGroups = 0;
    let hasOther = false;

    if (series.length && gi >= 0) {
      const totals = new Map();
      const s0 = series[0];
      for (let r = 0; r < rows.length; r++) {
        const row = rows[r];
        if (!Array.isArray(row)) continue;
        const key = categoryKey(row[gi]);
        let entry = totals.get(key);
        if (!entry) { entry = { key, total: 0, first: totals.size }; totals.set(key, entry); }
        const v = toNumber(row[s0]);
        if (v === v) entry.total += Math.abs(v);
      }
      const topN = Math.max(1, Math.floor(MAX_SERIES / series.length));
      const ranked = Array.from(totals.values()).sort((a, b) => b.total - a.total || a.first - b.first);
      // Colours follow the group's first appearance, not its rank.
      const kept = ranked.slice(0, topN).sort((a, b) => a.first - b.first);
      foldedGroups = Math.max(0, ranked.length - kept.length);
      hasOther = foldedGroups > 0;
      groupSlot = new Map(kept.map((entry, index) => [entry.key, index]));
      groupCount = kept.length;
      series.forEach((col, j) => {
        kept.forEach((entry, g) => {
          lines.push({ id: `${col}\u0001${entry.key}`, label: series.length > 1 ? `${columns[col]} · ${entry.key}` : entry.key, slot: j * groupCount + g, seriesIndex: j });
        });
        if (hasOther) lines.push({ id: `${col}\u0001\u0002other`, label: series.length > 1 ? `${columns[col]} · Other` : "Other", slot: -1, seriesIndex: j });
      });
    } else {
      series.forEach((col, j) => lines.push({ id: String(col), label: String(columns[col]), slot: j, seriesIndex: j }));
    }

    const perSeries = groupSlot ? groupCount + (hasOther ? 1 : 0) : 1;
    const xIndex = new Map();
    const xsRaw = [];
    const categories = [];
    const cols = lines.map(() => []);
    let skipped = 0;
    let summed = false;
    let subMillisecond = false;

    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      if (!Array.isArray(row)) continue;
      let x;
      if (xKind === "index") x = Number(row.__chdashRowIndex) || r + 1;
      else if (xKind === "time") x = toTimeMs(row[xi], xColumnKind);
      else if (xKind === "number") x = toNumber(row[xi]);
      else {
        const key = categoryKey(row[xi]);
        x = xIndex.get(key);
        if (x === undefined) {
          x = categories.length;
          categories.push(key);
          xIndex.set(key, x);
          xsRaw.push(x);
          for (const c of cols) c.push(undefined);
        }
      }
      if (!(x === x)) { skipped++; continue; }
      let idx;
      if (xKind === "category") idx = x;
      else {
        idx = xIndex.get(x);
        if (idx === undefined) {
          idx = xsRaw.length;
          xIndex.set(x, idx);
          xsRaw.push(x);
          for (const c of cols) c.push(undefined);
          if (xKind === "time" && !subMillisecond && x % 1000 !== 0) subMillisecond = true;
        }
      }
      let offset = 0;
      if (groupSlot) {
        const slot = groupSlot.get(categoryKey(row[gi]));
        offset = slot === undefined ? groupCount : slot;
      }
      // A cell is undefined (no row at this x: lines connect across it),
      // null (a NULL value: lines break) or the value, summed when several
      // rows share the x.
      for (let j = 0; j < series.length; j++) {
        const v = toNumber(row[series[j]]);
        const column = cols[j * perSeries + offset];
        const current = column[idx];
        if (!(v === v)) {
          if (current === undefined) column[idx] = null;
          continue;
        }
        if (typeof current === "number") { column[idx] = current + v; summed = true; } else column[idx] = v;
      }
    }

    const n = xsRaw.length;
    let order = null;
    if (xKind === "time" || xKind === "number") {
      order = new Uint32Array(n);
      for (let i = 0; i < n; i++) order[i] = i;
      let sorted = true;
      for (let i = 1; i < n; i++) if (xsRaw[i] < xsRaw[i - 1]) { sorted = false; break; }
      if (!sorted) order.sort((a, b) => xsRaw[a] - xsRaw[b]);
    }
    const xs = new Float64Array(n);
    for (let i = 0; i < n; i++) xs[i] = order ? xsRaw[order[i]] : xsRaw[i];
    lines.forEach((line, li) => {
      const values = new Float64Array(n);
      const nulls = new Uint8Array(n);
      const src = cols[li];
      for (let i = 0; i < n; i++) {
        const cell = order ? src[order[i]] : src[i];
        if (typeof cell === "number") values[i] = cell;
        else {
          values[i] = NaN;
          if (cell === null) nulls[i] = 1;
        }
      }
      line.values = values;
      line.nulls = nulls;
    });

    return {
      xKind,
      xColumnKind,
      xLabel: xi < 0 ? "Row" : String(columns[xi]),
      xs,
      categories,
      lines,
      rowCount: rows.length,
      skipped,
      summed,
      foldedGroups,
      subMillisecond,
    };
  }

  // --- Drawing helpers ------------------------------------------------------

  const fmt = (value) => (Math.round(value * 10) / 10).toString();

  // Path through (px[i], py(values[i])) with gaps at NaN. Past the drawing
  // budget, each of ENVELOPE_BUCKETS pixel buckets keeps its first, lowest,
  // highest and last point, so peaks survive downsampling.
  function linePath(pxs, values, yOf, left, plotW, stats, nulls = null) {
    const n = pxs.length;
    let d = "";
    let pen = false;
    let drawn = 0;
    const emit = (i) => {
      d += `${pen ? "L" : "M"}${fmt(pxs[i])} ${fmt(yOf(values[i]))}`;
      pen = true;
      drawn++;
    };
    // Next index with a value or a NULL (rows missing at an x are skipped).
    const nextCell = (i) => {
      let j = i + 1;
      while (j < n && !(values[j] === values[j]) && !(nulls && nulls[j])) j++;
      return j;
    };
    if (n <= MAX_DRAWN_POINTS) {
      for (let i = 0; i < n; i++) {
        if (values[i] === values[i]) {
          const wasPen = pen;
          emit(i);
          if (!wasPen) {
            const j = nextCell(i);
            if (j >= n || !(values[j] === values[j])) d += "h0";
          }
        } else if (!nulls || nulls[i]) pen = false;
      }
      stats.drawn = Math.max(stats.drawn, drawn);
      return d;
    }
    const bucketW = plotW / ENVELOPE_BUCKETS;
    let bucket = -1;
    let first = -1, lo = -1, hi = -1, last = -1;
    let gap = false;
    const flush = () => {
      if (first < 0) return;
      const picks = [first, lo, hi, last].filter((v, i, all) => all.indexOf(v) === i).sort((a, b) => a - b);
      for (const i of picks) emit(i);
      first = lo = hi = last = -1;
    };
    for (let i = 0; i < n; i++) {
      const v = values[i];
      const b = Math.floor((pxs[i] - left) / bucketW);
      if (!(v === v)) {
        if (!nulls || nulls[i]) gap = true;
        continue;
      }
      if (b !== bucket) {
        flush();
        if (gap) pen = false;
        bucket = b;
        first = lo = hi = last = i;
      } else {
        if (v < values[lo]) lo = i;
        if (v > values[hi]) hi = i;
        last = i;
      }
      gap = false;
    }
    flush();
    stats.drawn = Math.max(stats.drawn, drawn);
    return d;
  }

  function lowerBound(xs, value) {
    let lo = 0, hi = xs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] < value) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  function slotColor(slot) {
    return slot < 0 ? "var(--qchart-other)" : `var(--qchart-${(slot % MAX_SERIES) + 1})`;
  }

  // --- Controller -----------------------------------------------------------

  function createController({ getData, viewRoot, onViewChange = null, toggleClassName = "" } = {}) {
    const toggleEl = document.createElement("div");
    toggleEl.className = `resultsViewToggle ${toggleClassName}`.trim();
    toggleEl.setAttribute("role", "group");
    toggleEl.setAttribute("aria-label", "Result view");
    toggleEl.hidden = true;
    const tableBtn = document.createElement("button");
    tableBtn.type = "button";
    tableBtn.className = "resultsViewToggle__opt";
    tableBtn.dataset.view = "table";
    tableBtn.textContent = "Table";
    const chartBtn = document.createElement("button");
    chartBtn.type = "button";
    chartBtn.className = "resultsViewToggle__opt";
    chartBtn.dataset.view = "chart";
    chartBtn.textContent = "Chart";
    toggleEl.append(tableBtn, chartBtn);

    const hostEl = document.createElement("div");
    hostEl.className = "queryChart";
    hostEl.innerHTML = `
      <div class="queryChart__toolbar">
        <div class="queryChart__types" role="group" aria-label="Chart type"></div>
        <label class="queryChart__field"><span class="queryChart__fieldLabel">X</span><select class="queryChart__select queryChart__x" aria-label="X axis column"></select></label>
        <div class="queryChart__field queryChart__seriesField">
          <span class="queryChart__fieldLabel">Series</span>
          <button type="button" class="queryChart__select queryChart__seriesButton" aria-haspopup="true" aria-expanded="false" aria-label="Series columns"></button>
          <div class="queryChart__seriesMenu" role="group" aria-label="Series columns" hidden></div>
        </div>
        <label class="queryChart__field"><span class="queryChart__fieldLabel">Group by</span><select class="queryChart__select queryChart__group" aria-label="Group by column"></select></label>
        <span class="queryChart__note"></span>
      </div>
      <div class="queryChart__plot">
        <div class="queryChart__tooltip" role="status" hidden></div>
      </div>
      <div class="queryChart__legend" role="group" aria-label="Series"></div>`;
    const typesEl = hostEl.querySelector(".queryChart__types");
    const xSelect = hostEl.querySelector(".queryChart__x");
    const seriesButton = hostEl.querySelector(".queryChart__seriesButton");
    const seriesMenu = hostEl.querySelector(".queryChart__seriesMenu");
    const groupSelect = hostEl.querySelector(".queryChart__group");
    const noteEl = hostEl.querySelector(".queryChart__note");
    const plotEl = hostEl.querySelector(".queryChart__plot");
    const tooltipEl = hostEl.querySelector(".queryChart__tooltip");
    const legendEl = hostEl.querySelector(".queryChart__legend");
    const typeButtons = new Map();
    for (const [type, label] of CHART_TYPES) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "queryChart__type";
      btn.dataset.type = type;
      btn.textContent = label;
      btn.addEventListener("click", () => {
        if (btn.disabled || !cfg) return;
        cfg.type = type;
        cfg.typeAuto = false;
        syncToolbar();
        render();
      });
      typeButtons.set(type, btn);
      typesEl.appendChild(btn);
    }

    let meta = null; // { columns, types, kinds, signature }
    let cfg = null;
    let lastCfg = null; // kept across results with the same columns and types
    let chosenView = readStoredView();
    let effective = "table";
    let model = null;
    let dirty = true;
    let rebuildTimer = 0;
    let renderRaf = 0;
    let lastBuildMs = 0;
    let lastBuildAt = 0;
    let lastWidth = 0;
    const hidden = new Set();
    let hover = null; // { pxs, xs, yOf... } of the last render, for the pointer
    let lastPointer = null;
    let destroyed = false;
    // Until the terminal event a one-row result may still grow: the Number
    // view is only chosen once the stream is done (like the vertical table).
    let streamDone = false;

    const resizeObserver = typeof ResizeObserver === "function"
      ? new ResizeObserver(() => {
        const width = Math.round(plotEl.clientWidth);
        if (width && width !== lastWidth) scheduleRender();
      })
      : null;
    if (resizeObserver) resizeObserver.observe(plotEl);

    function chartable() {
      return !!(meta && meta.kinds.some((kind) => kind === "number"));
    }

    function applyView() {
      const next = chosenView === "chart" && chartable() ? "chart" : "table";
      const can = chartable();
      toggleEl.hidden = !meta;
      chartBtn.disabled = !can;
      chartBtn.title = can ? "Chart the received rows" : NO_NUMERIC_TITLE;
      toggleEl.title = can ? "" : NO_NUMERIC_TITLE;
      tableBtn.setAttribute("aria-pressed", String(next === "table"));
      chartBtn.setAttribute("aria-pressed", String(next === "chart"));
      toggleEl.dataset.view = next;
      const changed = next !== effective;
      effective = next;
      if (viewRoot) viewRoot.classList.toggle("is-chartView", next === "chart");
      if (next === "chart") {
        syncToolbar();
        scheduleRender({ immediate: true });
      } else {
        hideTooltip();
        closeSeriesMenu();
      }
      if (changed && typeof onViewChange === "function") onViewChange(next);
    }

    function setView(view) {
      chosenView = view === "chart" ? "chart" : "table";
      storeView(chosenView);
      applyView();
    }

    tableBtn.addEventListener("click", () => setView("table"));
    chartBtn.addEventListener("click", () => { if (!chartBtn.disabled) setView("chart"); });

    // --- toolbar ---

    function columnOptionLabel(i) {
      return `${meta.columns[i]}`;
    }

    function syncToolbar() {
      if (!meta || !cfg) return;
      const { kinds } = meta;
      const xOptions = [`<option value="-1">Row #</option>`];
      kinds.forEach((kind, i) => {
        xOptions.push(`<option value="${i}">${esc(columnOptionLabel(i))}</option>`);
      });
      xSelect.innerHTML = xOptions.join("");
      xSelect.value = String(cfg.x);

      const candidates = [];
      kinds.forEach((kind, i) => { if (kind === "number" && i !== cfg.x) candidates.push(i); });
      seriesMenu.innerHTML = candidates.length
        ? candidates.map((i) => {
          const checked = cfg.series.includes(i);
          const disabled = !checked && cfg.series.length >= MAX_SERIES;
          return `<label class="queryChart__seriesOpt"><input type="checkbox" value="${i}"${checked ? " checked" : ""}${disabled ? " disabled" : ""}><span>${esc(columnOptionLabel(i))}</span></label>`;
        }).join("")
        : `<span class="queryChart__seriesEmpty">No other numeric column</span>`;
      const names = cfg.series.map((i) => meta.columns[i]);
      seriesButton.textContent = names.length ? names.join(", ") : "None";
      seriesButton.title = names.join(", ");

      const groupOptions = [`<option value="-1">None</option>`];
      kinds.forEach((kind, i) => {
        if (i === cfg.x || cfg.series.includes(i) || kind === "other") return;
        groupOptions.push(`<option value="${i}">${esc(columnOptionLabel(i))}</option>`);
      });
      groupSelect.innerHTML = groupOptions.join("");
      groupSelect.value = String(cfg.group);

      const rows = currentRows();
      const type = effectiveType(rows.length);
      for (const [key, btn] of typeButtons) {
        const numberOnly = key === "number";
        btn.disabled = numberOnly && !(rows.length === 1 && streamDone);
        btn.title = btn.disabled ? "Number needs a single-row result" : "";
        btn.setAttribute("aria-pressed", String(key === type));
      }
      hostEl.dataset.chartType = type;
    }

    function effectiveType(rowCount) {
      if (!cfg) return "line";
      if (rowCount === 1 && streamDone && (cfg.typeAuto || cfg.type === "number")) return "number";
      if (cfg.type === "number") return "line";
      return cfg.type;
    }

    xSelect.addEventListener("change", () => {
      if (!cfg) return;
      const x = Number(xSelect.value);
      cfg.x = Number.isInteger(x) ? x : -1;
      if (cfg.group === cfg.x) cfg.group = -1;
      cfg.series = cfg.series.filter((i) => i !== cfg.x);
      if (!cfg.series.length) {
        const first = meta.kinds.findIndex((kind, i) => kind === "number" && i !== cfg.x);
        if (first >= 0) cfg.series = [first];
      }
      normalizeConfig(cfg, meta);
      configChanged();
    });

    groupSelect.addEventListener("change", () => {
      if (!cfg) return;
      const g = Number(groupSelect.value);
      cfg.group = Number.isInteger(g) ? g : -1;
      normalizeConfig(cfg, meta);
      configChanged();
    });

    seriesMenu.addEventListener("change", (ev) => {
      const input = ev.target;
      if (!(input instanceof HTMLInputElement) || !cfg) return;
      const col = Number(input.value);
      if (input.checked) {
        if (!cfg.series.includes(col) && cfg.series.length < MAX_SERIES) cfg.series.push(col);
      } else cfg.series = cfg.series.filter((i) => i !== col);
      cfg.series.sort((a, b) => a - b);
      normalizeConfig(cfg, meta);
      configChanged({ keepMenu: true });
      const again = seriesMenu.querySelector(`input[value="${col}"]`);
      if (again) again.focus({ preventScroll: true });
    });

    let onDocPointer = null;
    let onDocKey = null;
    function closeSeriesMenu() {
      if (seriesMenu.hidden) return;
      seriesMenu.hidden = true;
      seriesButton.setAttribute("aria-expanded", "false");
      if (onDocPointer) document.removeEventListener("pointerdown", onDocPointer, true);
      if (onDocKey) document.removeEventListener("keydown", onDocKey, true);
      onDocPointer = onDocKey = null;
    }
    function openSeriesMenu() {
      seriesMenu.hidden = false;
      seriesButton.setAttribute("aria-expanded", "true");
      onDocPointer = (ev) => {
        if (!(ev.target instanceof Node) || !seriesMenu.parentElement.contains(ev.target)) closeSeriesMenu();
      };
      onDocKey = (ev) => {
        if (ev.key === "Escape") { closeSeriesMenu(); seriesButton.focus(); }
      };
      document.addEventListener("pointerdown", onDocPointer, true);
      document.addEventListener("keydown", onDocKey, true);
      const first = seriesMenu.querySelector("input:not(:disabled)");
      if (first) first.focus({ preventScroll: true });
    }
    seriesButton.addEventListener("click", () => {
      if (seriesMenu.hidden) openSeriesMenu(); else closeSeriesMenu();
    });

    function configChanged({ keepMenu = false } = {}) {
      lastCfg = cfg ? { ...cfg, series: cfg.series.slice(), signature: meta.signature } : null;
      dirty = true;
      if (!keepMenu) closeSeriesMenu();
      syncToolbar();
      scheduleRender({ immediate: true });
    }

    // --- data flow ---

    function currentRows() {
      const data = typeof getData === "function" ? getData() : null;
      return data && Array.isArray(data.rows) ? data.rows : [];
    }

    function setMeta(columns, types) {
      const cols = Array.isArray(columns) ? columns.map((c) => String(c ?? "")) : [];
      const tys = Array.isArray(types) ? types.map((t) => String(t ?? "")) : [];
      const signature = metaSignature(cols, tys);
      meta = { columns: cols, types: tys, kinds: tys.map(columnKind), signature };
      if (lastCfg && lastCfg.signature === signature) {
        cfg = normalizeConfig({ ...lastCfg, series: lastCfg.series.slice() }, meta);
      } else {
        cfg = normalizeConfig(defaultConfig(meta), meta);
        hidden.clear();
      }
      // A new result starts from the last view chosen anywhere.
      chosenView = readStoredView();
      streamDone = false;
      model = null;
      dirty = true;
      hostEl.dataset.chartType = cfg.type;
      applyView();
    }

    function rowsChanged() {
      dirty = true;
      if (effective !== "chart") return;
      scheduleRender();
    }

    function done() {
      streamDone = true;
      dirty = true;
      if (effective !== "chart") {
        syncToolbar();
        return;
      }
      syncToolbar();
      scheduleRender({ immediate: true });
    }

    function reset() {
      meta = null;
      cfg = null;
      model = null;
      dirty = true;
      if (rebuildTimer) { clearTimeout(rebuildTimer); rebuildTimer = 0; }
      if (renderRaf) { cancelAnimationFrame(renderRaf); renderRaf = 0; }
      clearPlot();
      applyView();
    }

    function scheduleRender({ immediate = false } = {}) {
      if (destroyed || effective !== "chart") return;
      if (immediate) {
        if (rebuildTimer) { clearTimeout(rebuildTimer); rebuildTimer = 0; }
        if (!renderRaf) renderRaf = requestAnimationFrame(() => { renderRaf = 0; render(); });
        return;
      }
      if (rebuildTimer || renderRaf) return;
      // Streaming: rebuild at most every MIN_REBUILD_INTERVAL_MS, and never
      // spend more than about a fifth of the main thread on it.
      const interval = Math.max(MIN_REBUILD_INTERVAL_MS, lastBuildMs * 5);
      const wait = Math.max(0, lastBuildAt + interval - performance.now());
      rebuildTimer = setTimeout(() => {
        rebuildTimer = 0;
        if (!renderRaf) renderRaf = requestAnimationFrame(() => { renderRaf = 0; render(); });
      }, wait);
    }

    function clearPlot() {
      hover = null;
      hideTooltip();
      for (const el of Array.from(plotEl.children)) if (el !== tooltipEl) el.remove();
      legendEl.innerHTML = "";
      noteEl.textContent = "";
      delete hostEl.dataset.pointsDrawn;
    }

    function showMessage(text) {
      clearPlot();
      const msg = document.createElement("div");
      msg.className = "queryChart__message";
      msg.textContent = text;
      plotEl.appendChild(msg);
    }

    function render() {
      if (destroyed || effective !== "chart" || !meta || !cfg) return;
      const width = Math.round(plotEl.clientWidth);
      if (!width) return; // collapsed panel: the resize observer redraws
      lastWidth = width;
      const rows = currentRows();
      if (dirty || !model) {
        const t0 = performance.now();
        model = buildModel(cfg, meta, rows);
        lastBuildMs = performance.now() - t0;
        lastBuildAt = performance.now();
        dirty = false;
      }
      syncTypeButtons(rows.length);
      if (!rows.length) { showMessage(streamDone ? "No rows to chart." : "Waiting for rows…"); return; }
      if (!cfg.series.length) { showMessage("Select at least one numeric series."); return; }
      const type = effectiveType(rows.length);
      hostEl.dataset.chartType = type;
      hostEl.dataset.xKind = model.xKind;
      if (type === "number") { renderNumber(rows); return; }
      if (!model.xs.length) { showMessage(`No chartable rows: ${model.xLabel} has no usable values.`); return; }
      renderPlot(type, width);
    }

    function syncTypeButtons(rowCount) {
      const type = effectiveType(rowCount);
      for (const [key, btn] of typeButtons) {
        if (key === "number") {
          btn.disabled = !(rowCount === 1 && streamDone);
          btn.title = btn.disabled ? "Number needs a single-row result" : "";
        }
        btn.setAttribute("aria-pressed", String(key === type));
      }
    }

    function renderNumber(rows) {
      clearPlot();
      const row = rows[0];
      const tiles = document.createElement("div");
      tiles.className = "queryChart__numbers";
      // One row: every charted value, the numeric X column included.
      const cols = cfg.series.slice();
      if (cfg.x >= 0 && meta.kinds[cfg.x] === "number" && !cols.includes(cfg.x)) cols.push(cfg.x);
      cols.sort((a, b) => a - b);
      for (const col of cols) {
        const v = toNumber(Array.isArray(row) ? row[col] : NaN);
        const tile = document.createElement("div");
        tile.className = "queryChart__number";
        tile.innerHTML = `<span class="queryChart__numberLabel">${esc(meta.columns[col])}</span><span class="queryChart__numberValue">${esc(v === v ? formatFullNumber(v) : "NULL")}</span>`;
        tiles.appendChild(tile);
      }
      plotEl.appendChild(tiles);
      noteEl.textContent = "1 row";
    }

    function buildNote() {
      const parts = [`${model.rowCount.toLocaleString("en-US")} row${model.rowCount === 1 ? "" : "s"}`];
      if (model.xs.length > MAX_DRAWN_POINTS) parts.push(`${model.xs.length.toLocaleString("en-US")} points, drawn as a min/max envelope`);
      if (model.summed) parts.push(`rows sharing the same ${model.xLabel} are summed`);
      if (model.foldedGroups) parts.push(`${model.foldedGroups} group${model.foldedGroups === 1 ? "" : "s"} folded into Other`);
      if (model.skipped) parts.push(`${model.skipped.toLocaleString("en-US")} row${model.skipped === 1 ? "" : "s"} without ${model.xLabel} skipped`);
      return parts.join(" · ");
    }

    function renderPlot(type, width) {
      const { xs, lines, xKind } = model;
      const n = xs.length;
      const visible = lines.filter((line) => !hidden.has(line.id));
      const stacked = type === "area" || type === "bar";

      // Stacks: cumulative tops over the visible lines (NULL counts as 0).
      // Areas stack every line; bars stack the groups of one series column
      // and put the columns side by side (different measures never add up).
      const tops = new Map();
      const bases = new Map();
      const seriesColumns = type === "bar" ? Array.from(new Set(visible.map((line) => line.seriesIndex))) : [0];
      if (stacked) {
        const stackState = new Map();
        for (const line of visible) {
          const stackKey = type === "bar" ? line.seriesIndex : 0;
          if (!stackState.has(stackKey)) stackState.set(stackKey, { pos: new Float64Array(n), neg: new Float64Array(n) });
          const state = stackState.get(stackKey);
          const basePos = state.pos;
          const baseNeg = state.neg;
          const top = new Float64Array(n);
          const base = new Float64Array(n);
          const nextPos = new Float64Array(basePos);
          const nextNeg = new Float64Array(baseNeg);
          for (let i = 0; i < n; i++) {
            const v = line.values[i];
            const value = v === v ? v : 0;
            if (type === "bar" && value < 0) {
              base[i] = baseNeg[i];
              top[i] = baseNeg[i] + value;
              nextNeg[i] = top[i];
            } else {
              base[i] = basePos[i];
              top[i] = basePos[i] + value;
              nextPos[i] = top[i];
            }
          }
          tops.set(line.id, top);
          bases.set(line.id, base);
          state.pos = nextPos;
          state.neg = nextNeg;
        }
      }

      let yMin = Infinity;
      let yMax = -Infinity;
      for (const line of visible) {
        const arr = stacked ? tops.get(line.id) : line.values;
        for (let i = 0; i < n; i++) {
          const v = arr[i];
          if (v === v) {
            if (v < yMin) yMin = v;
            if (v > yMax) yMax = v;
          }
        }
      }
      if (!(yMin <= yMax)) { yMin = 0; yMax = 1; }
      if (stacked) {
        yMin = Math.min(0, yMin);
        yMax = Math.max(0, yMax);
      } else if (yMin >= 0 && yMax - yMin > 0.25 * yMax) yMin = 0;
      else if (yMax <= 0 && yMax - yMin > 0.25 * -yMin) yMax = 0;

      const H = PLOT_HEIGHT;
      const plotH = H - MARGIN.top - MARGIN.bottom;
      const yTicks = niceTicks(yMin, yMax, Math.max(2, Math.min(8, Math.floor(plotH / 44))));
      const yUnit = compactUnitFor(Math.max(Math.abs(yTicks.min), Math.abs(yTicks.max)));
      const yLabels = yTicks.values.map((v) => formatTickNumber(v, yTicks.step, yUnit));
      const left = Math.ceil(Math.max(28, ...yLabels.map(labelWidthPx)) + 10);
      const W = width;
      const plotW = Math.max(40, W - left - MARGIN.right);
      const yOf = (v) => MARGIN.top + plotH - ((v - yTicks.min) / (yTicks.max - yTicks.min || 1)) * plotH;

      // X scale.
      let xOf;
      let xTicksSvg = "";
      let barWidth = 0;
      const continuous = xKind !== "category";
      let domainLo = n ? xs[0] : 0;
      let domainHi = n ? xs[n - 1] : 1;
      let minGap = Infinity;
      if (continuous) {
        for (let i = 1; i < n; i++) {
          const gap = xs[i] - xs[i - 1];
          if (gap > 0 && gap < minGap) minGap = gap;
        }
        if (domainHi === domainLo) {
          const pad = xKind === "time" ? MINUTE_MS : Math.max(1, Math.abs(domainLo) * 0.1);
          domainLo -= pad;
          domainHi += pad;
        } else if (type === "bar" && Number.isFinite(minGap)) {
          // Bars are centred on their x: keep half a bar inside each edge.
          const half = Math.max(minGap, (domainHi - domainLo) / Math.max(1, Math.floor(plotW / 3))) / 2;
          domainLo -= half;
          domainHi += half;
        }
        xOf = (x) => left + ((x - domainLo) / (domainHi - domainLo)) * plotW;
        if (type === "bar") {
          const gapPx = Number.isFinite(minGap) ? (minGap / (domainHi - domainLo)) * plotW : plotW / 2;
          barWidth = Math.max(1, Math.min(48, gapPx * 0.8));
        }
        if (xKind === "time") {
          xTicksSvg = timeAxisTicks(domainLo, domainHi, plotW).map(({ t, label }) => axisTickSvg(xOf(t), label, W, H)).join("");
        } else {
          const count = Math.max(2, Math.min(12, Math.floor(plotW / 90)));
          const ticks = niceTicks(domainLo, domainHi, count, { integer: xKind === "index" });
          const unit = compactUnitFor(Math.max(Math.abs(ticks.min), Math.abs(ticks.max)));
          xTicksSvg = ticks.values
            .filter((v) => v >= domainLo - 1e-9 && v <= domainHi + 1e-9)
            .map((v) => axisTickSvg(xOf(v), formatTickNumber(v, ticks.step, unit), W, H)).join("");
        }
      } else {
        const band = plotW / Math.max(1, n);
        xOf = (i) => left + (i + 0.5) * band;
        barWidth = Math.max(1, Math.min(60, band * 0.72));
        const maxChars = 18;
        const labels = model.categories.map((c) => (c.length > maxChars ? `${c.slice(0, maxChars - 1)}…` : c));
        const widest = labels.reduce((m, c) => Math.max(m, labelWidthPx(c)), 0);
        const every = Math.max(1, Math.ceil((Math.min(widest, labelWidthPx("x".repeat(maxChars))) + 10) / band));
        const parts = [];
        for (let i = 0; i < n; i += every) parts.push(axisTickSvg(xOf(i), labels[i], W, H, model.categories[i]));
        xTicksSvg = parts.join("");
      }

      const pxs = new Float64Array(n);
      for (let i = 0; i < n; i++) pxs[i] = xOf(continuous ? xs[i] : i);

      const grid = yTicks.values.map((v, i) => {
        const y = fmt(yOf(v));
        return `<line class="queryChart__grid${v === 0 ? " queryChart__grid--zero" : ""}" x1="${left}" x2="${left + plotW}" y1="${y}" y2="${y}"/>`
          + `<text class="queryChart__tick" x="${left - 8}" y="${y}" dy="0.32em" text-anchor="end">${esc(yLabels[i])}</text>`;
      }).join("");

      const stats = { drawn: 0 };
      const marks = [];
      const barOffsets = new Map();
      if (type === "bar") {
        // One path per line; past the budget each pixel bucket keeps the
        // index with the tallest stack.
        const maxBars = Math.max(1, Math.min(MAX_DRAWN_POINTS, Math.floor(plotW / 3)));
        let picks = null;
        if (n > maxBars) {
          picks = [];
          const bucketW = plotW / maxBars;
          let bucket = -1;
          let best = -1;
          let bestTotal = -Infinity;
          for (let i = 0; i < n; i++) {
            const b = Math.floor((pxs[i] - left) / bucketW);
            let total = 0;
            for (const line of visible) total += Math.abs(tops.get(line.id)[i] - bases.get(line.id)[i]);
            if (b !== bucket) {
              if (best >= 0) picks.push(best);
              bucket = b;
              best = i;
              bestTotal = total;
            } else if (total > bestTotal) { best = i; bestTotal = total; }
          }
          if (best >= 0) picks.push(best);
          barWidth = Math.max(1, Math.min(barWidth || Infinity, bucketW * 0.8));
        }
        const indexes = picks || Array.from({ length: n }, (_, i) => i);
        const clusterSize = Math.max(1, seriesColumns.length);
        const subWidth = barWidth / clusterSize;
        const drawWidth = clusterSize > 1 ? Math.max(1, subWidth - Math.min(2, subWidth * 0.15)) : barWidth;
        for (const line of visible) {
          const top = tops.get(line.id);
          const base = bases.get(line.id);
          const offset = (seriesColumns.indexOf(line.seriesIndex) - (clusterSize - 1) / 2) * subWidth;
          barOffsets.set(line.id, offset);
          let d = "";
          let count = 0;
          for (const i of indexes) {
            if (top[i] === base[i]) continue;
            const y1 = yOf(Math.max(top[i], base[i]));
            const y2 = yOf(Math.min(top[i], base[i]));
            d += `M${fmt(pxs[i] + offset - drawWidth / 2)} ${fmt(y1)}h${fmt(drawWidth)}V${fmt(y2)}h${fmt(-drawWidth)}Z`;
            count++;
          }
          stats.drawn = Math.max(stats.drawn, count);
          marks.push(`<path class="queryChart__bar" data-series="${esc(line.label)}" data-points="${count}" style="fill:${slotColor(line.slot)}" d="${d}"/>`);
        }
      } else if (type === "area") {
        for (const line of visible) {
          const lineStats = { drawn: 0 };
          const topPath = linePath(pxs, tops.get(line.id), yOf, left, plotW, lineStats);
          const baseStats = { drawn: 0 };
          const basePath = linePath(pxs, bases.get(line.id), yOf, left, plotW, baseStats);
          // Polygon: the top edge forward, then the base edge backward.
          const back = reversePath(basePath);
          const fill = topPath && back ? `${topPath}L${back.slice(1)}Z` : "";
          stats.drawn = Math.max(stats.drawn, lineStats.drawn);
          marks.push(`<path class="queryChart__area" style="fill:${slotColor(line.slot)}" d="${fill}"/>`
            + `<path class="queryChart__line" data-series="${esc(line.label)}" data-points="${lineStats.drawn}" style="stroke:${slotColor(line.slot)}" d="${topPath}"/>`);
        }
      } else {
        for (const line of visible) {
          const lineStats = { drawn: 0 };
          const d = linePath(pxs, line.values, yOf, left, plotW, lineStats, line.nulls);
          stats.drawn = Math.max(stats.drawn, lineStats.drawn);
          marks.push(`<path class="queryChart__line" data-series="${esc(line.label)}" data-points="${lineStats.drawn}" style="stroke:${slotColor(line.slot)}" d="${d}"/>`);
          // Few points: mark each one, so isolated values stay visible.
          if (n <= 60) {
            let dots = "";
            for (let i = 0; i < n; i++) if (line.values[i] === line.values[i]) dots += `<circle cx="${fmt(pxs[i])}" cy="${fmt(yOf(line.values[i]))}" r="2.6"/>`;
            marks.push(`<g class="queryChart__dots" style="fill:${slotColor(line.slot)}">${dots}</g>`);
          }
        }
      }

      const svg = `<svg class="queryChart__svg" xmlns="${SVG_NS}" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(chartAriaLabel(type))}">`
        + `<g class="queryChart__axes">${grid}${xTicksSvg}</g>`
        + `<line class="queryChart__baseline" x1="${left}" x2="${left + plotW}" y1="${MARGIN.top + plotH}" y2="${MARGIN.top + plotH}"/>`
        + `<g class="queryChart__marks">${marks.join("")}</g>`
        + `<g class="queryChart__hover" hidden><line class="queryChart__crosshair" x1="0" x2="0" y1="${MARGIN.top}" y2="${MARGIN.top + plotH}"/><g class="queryChart__hoverDots"></g></g>`
        + `<rect class="queryChart__hit" x="${left}" y="${MARGIN.top}" width="${plotW}" height="${plotH}"/>`
        + `</svg>`;
      for (const el of Array.from(plotEl.children)) if (el !== tooltipEl) el.remove();
      plotEl.insertAdjacentHTML("afterbegin", svg);
      hostEl.dataset.pointsDrawn = String(stats.drawn);
      hover = { pxs, left, plotW, top: MARGIN.top, plotH, yOf, visible, stacked, tops, type, barOffsets };
      bindHover();
      // A streaming redraw under the pointer keeps the tooltip on screen.
      if (lastPointer && !tooltipEl.hidden) showHover(lastPointer.x, lastPointer.y);
      renderLegend();
      noteEl.textContent = buildNote();
    }

    function chartAriaLabel(type) {
      const names = model.lines.map((line) => line.label).join(", ");
      const kind = type === "area" ? "Stacked area chart" : type === "bar" ? "Bar chart" : "Line chart";
      return `${kind} of ${names} by ${model.xLabel}`;
    }

    function axisTickSvg(x, label, W, H, fullLabel = null) {
      const half = labelWidthPx(label) / 2;
      const anchor = x - half < 2 ? "start" : x + half > W - 2 ? "end" : "middle";
      const tx = anchor === "start" ? Math.max(2, x - 4) : anchor === "end" ? Math.min(W - 2, x + 4) : x;
      const baseY = H - MARGIN.bottom;
      const title = fullLabel != null && fullLabel !== label ? `<title>${esc(fullLabel)}</title>` : "";
      return `<line class="queryChart__tickMark" x1="${fmt(x)}" x2="${fmt(x)}" y1="${baseY}" y2="${baseY + 4}"/>`
        + `<text class="queryChart__tick queryChart__xTick" x="${fmt(tx)}" y="${baseY + 17}" text-anchor="${anchor}">${esc(label)}${title}</text>`;
    }

    // "M1 2L3 4L5 6" -> "M5 6L3 4L1 2" (single run; area bases never gap).
    function reversePath(d) {
      if (!d) return "";
      const points = d.replace(/h0/g, "").split(/[ML]/).filter(Boolean);
      return `M${points.reverse().join("L")}`;
    }

    function renderLegend() {
      legendEl.innerHTML = "";
      if (!model || model.lines.length < 2) return;
      for (const line of model.lines) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "queryChart__legendItem";
        const on = !hidden.has(line.id);
        btn.setAttribute("aria-pressed", String(on));
        btn.title = on ? `Hide ${line.label}` : `Show ${line.label}`;
        btn.innerHTML = `<i style="background:${slotColor(line.slot)}"></i><span>${esc(line.label)}</span>`;
        btn.addEventListener("click", () => {
          if (hidden.has(line.id)) hidden.delete(line.id); else hidden.add(line.id);
          render();
          const again = legendEl.querySelector(`.queryChart__legendItem:nth-child(${model.lines.indexOf(line) + 1})`);
          if (again) again.focus({ preventScroll: true });
        });
        legendEl.appendChild(btn);
      }
    }

    // --- hover ---

    function hideTooltip() {
      tooltipEl.hidden = true;
      const layer = plotEl.querySelector(".queryChart__hover");
      if (layer) layer.setAttribute("hidden", "");
    }

    function nearestIndex(px) {
      const { pxs } = hover;
      const n = pxs.length;
      if (!n) return -1;
      const i = lowerBound(pxs, px);
      if (i <= 0) return 0;
      if (i >= n) return n - 1;
      return px - pxs[i - 1] <= pxs[i] - px ? i - 1 : i;
    }

    function xLabelAt(i) {
      if (model.xKind === "category") return model.categories[i];
      const x = model.xs[i];
      if (model.xKind === "time") return model.xColumnKind === "date" ? formatInstant(x, false).slice(0, 10) : formatInstant(x, model.subMillisecond);
      if (model.xKind === "index") return `Row ${x}`;
      return formatFullNumber(x);
    }

    function showHover(clientX, clientY) {
      if (!hover || !model) return;
      const svg = plotEl.querySelector("svg");
      if (!svg) return;
      const box = svg.getBoundingClientRect();
      const px = clientX - box.left;
      const i = nearestIndex(px);
      if (i < 0) return;
      const x = hover.pxs[i];
      const layer = svg.querySelector(".queryChart__hover");
      const cross = layer.querySelector(".queryChart__crosshair");
      cross.setAttribute("x1", fmt(x));
      cross.setAttribute("x2", fmt(x));
      let dots = "";
      const rowsHtml = [];
      let total = 0;
      let anyValue = false;
      for (const line of hover.visible) {
        const v = line.values[i];
        const has = v === v;
        const y = hover.stacked ? hover.tops.get(line.id)[i] : v;
        const dx = hover.barOffsets.get(line.id) || 0;
        if (has && y === y) dots += `<circle cx="${fmt(x + dx)}" cy="${fmt(hover.yOf(y))}" r="3.5" style="fill:${slotColor(line.slot)}"/>`;
        if (has) { total += v; anyValue = true; }
        if (!has && !line.nulls[i]) continue; // no row for this line at this x
        const text = has ? formatFullNumber(v) : "NULL";
        rowsHtml.push(`<span class="queryChart__tipRow${has ? "" : " is-empty"}"><i style="background:${slotColor(line.slot)}"></i><em>${esc(line.label)}</em><b>${esc(text)}</b></span>`);
      }
      if (hover.stacked && hover.visible.length > 1 && anyValue) {
        rowsHtml.push(`<span class="queryChart__tipRow queryChart__tipRow--total"><i></i><em>Total</em><b>${esc(formatFullNumber(total))}</b></span>`);
      }
      if (!rowsHtml.length) rowsHtml.push(`<span class="queryChart__tipRow is-empty"><i></i><em>No value</em><b>—</b></span>`);
      layer.querySelector(".queryChart__hoverDots").innerHTML = dots;
      layer.removeAttribute("hidden");
      tooltipEl.innerHTML = `<strong>${esc(xLabelAt(i))}</strong>${rowsHtml.join("")}`;
      tooltipEl.hidden = false;
      tooltipEl.dataset.index = String(i);
      const tipW = tooltipEl.offsetWidth;
      const tipH = tooltipEl.offsetHeight;
      const plotBox = plotEl.getBoundingClientRect();
      const offsetX = box.left - plotBox.left;
      let leftPos = offsetX + x + 14;
      if (leftPos + tipW > plotEl.clientWidth - 4) leftPos = offsetX + x - 14 - tipW;
      leftPos = Math.max(4, leftPos);
      let topPos = clientY - plotBox.top - tipH / 2;
      topPos = Math.max(0, Math.min(topPos, Math.max(0, PLOT_HEIGHT - tipH)));
      tooltipEl.style.left = `${Math.round(leftPos)}px`;
      tooltipEl.style.top = `${Math.round(topPos)}px`;
    }

    function bindHover() {
      const hit = plotEl.querySelector(".queryChart__hit");
      if (!hit) return;
      const track = (ev) => {
        lastPointer = { x: ev.clientX, y: ev.clientY };
        showHover(ev.clientX, ev.clientY);
      };
      hit.addEventListener("pointermove", track);
      hit.addEventListener("pointerdown", track);
      hit.addEventListener("pointerleave", () => {
        lastPointer = null;
        hideTooltip();
      });
    }

    function destroy() {
      destroyed = true;
      closeSeriesMenu();
      if (resizeObserver) resizeObserver.disconnect();
      if (rebuildTimer) clearTimeout(rebuildTimer);
      if (renderRaf) cancelAnimationFrame(renderRaf);
      rebuildTimer = 0;
      renderRaf = 0;
      model = null;
    }

    return {
      toggleEl,
      hostEl,
      setMeta,
      rowsChanged,
      done,
      reset,
      destroy,
      getView: () => effective,
      setView,
    };
  }

  ns.queryChart = {
    createController,
    // Exposed for reuse and tests.
    columnKind,
    toTimeMs,
    niceTicks,
    timeAxisTicks,
    formatTickNumber,
    formatFullNumber,
    compactUnitFor,
  };
})();
