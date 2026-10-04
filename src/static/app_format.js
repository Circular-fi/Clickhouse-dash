(() => {
  "use strict";
  // ns.format: the one place that turns numbers, sizes, durations and
  // instants into text (docs/ui-foundations.md). Pure functions, no DOM: the
  // loaders run this file first, so every other module can use it.
  //
  //   count      120,064          en-US grouping on every browser
  //   compact    120.1K 3.4M 1.2B uppercase suffix, one decimal (trimmed)
  //   number     1,235 3.142 0.5 25K, four significant digits (measurements)
  //   bytes      0 B 205 B 1.7 KB 10.3 MB, 1024 base, one decimal from KB
  //   duration   12 ns 350 \u00b5s 1.82 ms 2.5 s 8 min 30 s (never "8.5 min")
  //   percent    50% 12.3% 1.23% <0.1% 0%
  //   time       Sep 12 16:29:57[.123], 24 h, browser-local zone, year
  //              only when it is not the current year
  //   range      2026-09-12 16:00 \u2192 17:00, "Last 1 hour" for presets
  //   serverTime ClickHouse DateTime text from the server's zone, shown in
  //              the browser's (time + timeTitle + iso)
  //   EMPTY      \u2014 for every absent value
  //
  // Sources stay Latin-1 (tests/harness/test_static_sources_latin1_contract.py):
  // characters above U+00FF are written as \u escapes.
  const ns = (window.ChDash = window.ChDash || {});

  const EMPTY = "\u2014";
  const ARROW = "\u2192";
  const MICRO = "\u00b5";
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  const pad2 = (value) => String(value).padStart(2, "0");
  const pad3 = (value) => String(value).padStart(3, "0");

  // A finite number, or NaN for null, "", booleans and anything else that is
  // not a number (Number(null) is 0, which would print a value nobody sent).
  function num(value) {
    if (typeof value === "number") return value;
    if (typeof value === "bigint") return Number(value);
    if (typeof value === "string" && value.trim() !== "") return Number(value);
    return NaN;
  }

  // Up to three significant digits, trailing zeros dropped: 182, 18.2, 1.82.
  function significant(value) {
    const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
    const fixed = value.toFixed(digits);
    return digits ? fixed.replace(/\.?0+$/, "") : fixed;
  }

  function trimOneDecimal(value) {
    return value.toFixed(1).replace(/\.0$/, "");
  }

  // ------------------------------------------------------------- numbers

  const INTEGER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

  // Grouped en-US integer: "120,064". Integer strings and BigInts keep every
  // digit (UInt64 counts above 2^53).
  function count(value) {
    if (typeof value === "bigint") return value.toLocaleString("en-US");
    if (typeof value === "string" && /^\s*-?\d{16,}\s*$/.test(value)) {
      const text = value.trim();
      const sign = text.startsWith("-") ? "-" : "";
      return sign + text.replace(/^-/, "").replace(/^0+(?=\d)/, "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    }
    const n = num(value);
    if (!Number.isFinite(n)) return EMPTY;
    return INTEGER.format(Math.round(n));
  }

  const COMPACT_UNITS = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];

  // "120.1K", "3.4M", "1.2B": one decimal, ".0" dropped, a value that rounds
  // to 1000 of a unit moves up a unit. Below 1000: whole numbers grouped, and
  // a fraction keeps one decimal under 100 ("42.4").
  function compact(value) {
    const n = num(value);
    if (!Number.isFinite(n)) return EMPTY;
    const sign = n < 0 ? "-" : "";
    let abs = Math.abs(n);
    if (abs < 100 && !Number.isInteger(abs)) {
      const rounded = Math.round(abs * 10) / 10;
      if (rounded < 100) return rounded ? `${sign}${trimOneDecimal(rounded)}` : "0";
      abs = rounded;
    }
    if (abs < 1000) {
      const whole = Math.round(abs);
      if (whole < 1000) return whole ? `${sign}${whole}` : "0";
      abs = whole;
    }
    for (let i = 0; i < COMPACT_UNITS.length; i += 1) {
      const [scale, suffix] = COMPACT_UNITS[i];
      if (abs < scale) continue;
      const scaled = Math.round((abs / scale) * 10) / 10;
      if (scaled >= 1000 && i > 0) {
        const [upScale, upSuffix] = COMPACT_UNITS[i - 1];
        return `${sign}${trimOneDecimal(Math.round((abs / upScale) * 10) / 10)}${upSuffix}`;
      }
      return `${sign}${trimOneDecimal(scaled)}${suffix}`;
    }
    return `${sign}${Math.round(abs)}`;
  }

  // A measured value (a gauge, a ratio, a metric sum): four significant
  // digits grouped en-US ("1,235", "3.142", "0.5"), compact from 10,000
  // ("25K", "1.2M"), an exponent below 0.0001 ("4.2e-5").
  const NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 10 });

  function number(value) {
    const n = num(value);
    if (!Number.isFinite(n)) return EMPTY;
    const abs = Math.abs(n);
    if (abs === 0) return "0";
    if (abs >= 1e4) return compact(n);
    if (abs >= 1e-4) return NUMBER.format(Number(n.toPrecision(4)));
    return n.toExponential(1).replace(/\.0e/, "e");
  }

  // "1 row", "120,064 rows": a grouped count and the word that agrees with it.
  function countLabel(value, singular, pluralWord = `${singular}s`) {
    const text = count(value);
    if (text === EMPTY) return EMPTY;
    return `${text} ${num(value) === 1 ? singular : pluralWord}`;
  }

  // One byte format for the whole app (util.formatBytes delegates here):
  // "0 B", "205 B", "1.7 KB", "10.3 MB", one decimal from KB up, 1024 base.
  // Never four integer digits: from 1000 of a unit the value reads in the
  // next one ("1000 B" is "1.0 KB", as a rate beside "1K/s").
  const BYTE_UNITS = ["KB", "MB", "GB", "TB", "PB", "EB"];

  function bytes(value) {
    const n = num(value);
    if (!Number.isFinite(n)) return EMPTY;
    const sign = n < 0 ? "-" : "";
    let v = Math.abs(n);
    if (Math.round(v) < 1000) return `${sign}${Math.round(v)} B`;
    let unit = -1;
    // 999.96 KB would print as "1000.0 KB": the rounded figure decides.
    while (unit < BYTE_UNITS.length - 1 && (unit < 0 ? Math.round(v) : Number(v.toFixed(1))) >= 1000) {
      v /= 1024;
      unit += 1;
    }
    return `${sign}${v.toFixed(1)} ${BYTE_UNITS[unit]}`;
  }

  function bytesRate(value) {
    const text = bytes(value);
    return text === EMPTY ? EMPTY : `${text}/s`;
  }

  // A ratio (0.123) as a percentage: up to three significant digits ("12.3%",
  // "1.23%", "100%"), "<0.1%" for a value too small to show, "0%" only for 0.
  function percent(ratio) {
    const n = num(ratio);
    if (!Number.isFinite(n)) return EMPTY;
    const p = n * 100;
    if (p === 0) return "0%";
    const abs = Math.abs(p);
    if (abs < 0.1) return p > 0 ? "<0.1%" : ">-0.1%";
    return `${p < 0 ? "-" : ""}${significant(abs)}%`;
  }

  // Per-second rate of `unit` ("rows", "spans"): "1.2K rows/s", "3.46 rows/s".
  // A unit that already names its period ("rows/min") is kept as written.
  function rate(value, unit = "") {
    const n = num(value);
    if (!Number.isFinite(n)) return EMPTY;
    const abs = Math.abs(n);
    const text = abs >= 1000 ? compact(n) : abs === 0 ? "0" : abs < 0.005 ? `${n < 0 ? ">-" : "<"}0.01` : `${n < 0 ? "-" : ""}${significant(abs)}`;
    const label = String(unit || "");
    if (label.includes("/")) return `${text} ${label}`;
    return label ? `${text} ${label}/s` : `${text}/s`;
  }

  // ----------------------------------------------------------- durations

  // Decimal ns / \u00b5s / ms / s below a minute, then whole units two at a time
  // ("8 min 30 s", "2 h 5 min", "3 d 4 h"): the Traces convention.
  function duration(nsValue) {
    const n = num(nsValue);
    if (!Number.isFinite(n) || n < 0) return EMPTY;
    const decimal = [[1e9, "s"], [1e6, "ms"], [1e3, `${MICRO}s`]];
    // 999.6 ns rounds to "1000 ns": say "1 \u00b5s" instead.
    if (n < 1e3) return Math.round(n) < 1e3 ? `${Math.round(n)} ns` : `1 ${MICRO}s`;
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

  const fromUnit = (factor) => (value) => {
    const n = num(value);
    return Number.isFinite(n) ? duration(n * factor) : EMPTY;
  };
  duration.fromUs = fromUnit(1e3);
  duration.fromMs = fromUnit(1e6);
  duration.fromSeconds = fromUnit(1e9);

  // ------------------------------------------------------------- instants

  // Wall-clock fields of `ms` in "local" (the browser zone), "UTC" or an IANA
  // zone, with the zone's offset in minutes. null when the zone is unknown.
  const zoneFormats = new Map();

  function zoneFormat(zone) {
    if (!zoneFormats.has(zone)) {
      let format = null;
      try {
        format = new Intl.DateTimeFormat("en-US", {
          timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit", second: "2-digit",
        });
      } catch (_) {
        format = null;
      }
      zoneFormats.set(zone, format);
    }
    return zoneFormats.get(zone);
  }

  function fields(ms, zone = "local") {
    const d = new Date(Math.floor(ms));
    // Past the Date range (+-8.64e15 ms): no wall clock to print.
    if (!Number.isFinite(d.getTime())) return null;
    const millis = d.getUTCMilliseconds();
    if (zone === "local") {
      return {
        year: d.getFullYear(), month: d.getMonth(), day: d.getDate(), hour: d.getHours(), minute: d.getMinutes(),
        second: d.getSeconds(), millis, offset: -d.getTimezoneOffset(),
      };
    }
    if (zone === "UTC") {
      return {
        year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(),
        second: d.getUTCSeconds(), millis, offset: 0,
      };
    }
    const format = zoneFormat(zone);
    if (!format) return null;
    const parts = {};
    for (const part of format.formatToParts(d)) parts[part.type] = Number(part.value);
    const hour = parts.hour === 24 ? 0 : parts.hour;
    const wall = Date.UTC(parts.year, parts.month - 1, parts.day, hour, parts.minute, parts.second);
    const offset = Math.round((wall - (Math.floor(ms / 1000) * 1000)) / 60000);
    return { year: parts.year, month: parts.month - 1, day: parts.day, hour, minute: parts.minute, second: parts.second, millis, offset };
  }

  function offsetLabel(minutes) {
    const sign = minutes < 0 ? "-" : "+";
    const abs = Math.abs(minutes);
    return `UTC${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
  }

  // The digits after the second: 3 for "ms", 9 for "ns" (from options.ns, an
  // epoch-nanosecond string or BigInt, when the caller has it; otherwise from
  // the fraction of `ms`).
  function fraction(ms, f, precision, nsValue) {
    if (precision === "ms") return `.${pad3(f.millis)}`;
    if (precision === "us") return `.${pad3(f.millis)}${String(Math.min(999, Math.round((ms - Math.floor(ms)) * 1000))).padStart(3, "0")}`;
    if (precision !== "ns") return "";
    if (nsValue != null && nsValue !== "") {
      const digits = String(nsValue).replace(/^-/, "");
      if (/^\d+$/.test(digits)) return `.${digits.slice(-9).padStart(9, "0")}`;
    }
    const sub = Math.round((ms - Math.floor(ms)) * 1e6);
    return `.${pad3(f.millis)}${String(Math.min(sub, 999999)).padStart(6, "0")}`;
  }

  // "16:29:57" and its fraction; "16:29" for precision "min".
  function clockText(f, frac, precision = "s") {
    return precision === "min" ? `${pad2(f.hour)}:${pad2(f.minute)}` : `${pad2(f.hour)}:${pad2(f.minute)}:${pad2(f.second)}${frac}`;
  }

  function dateText(f, withYear) {
    return withYear ? `${MONTHS[f.month]} ${f.day}, ${f.year}` : `${MONTHS[f.month]} ${f.day}`;
  }

  function currentYear(nowMs, zone) {
    const f = fields(Number.isFinite(nowMs) ? nowMs : Date.now(), zone);
    return f ? f.year : new Date().getFullYear();
  }

  // "Sep 12 16:29:57" in the browser's zone, 24 h. Options:
  //   precision  "s" (default) | "min" (no seconds) | "ms" (".123") |
  //              "us" (".123456") | "ns" (".123456789")
  //   date       "auto" (default: the date, its year only when it is not the
  //              current year) | "always" (always with the year) | "never"
  //              (the time of day alone)
  //   ns         epoch nanoseconds (string or BigInt) for precision "ns"
  //   now        the current time in ms (tests), for the year rule
  function time(ms, options = {}) {
    const n = num(ms);
    if (!Number.isFinite(n)) return EMPTY;
    return formatIn(n, options.zone || "local", options);
  }

  function formatIn(ms, zone, { precision = "s", date = "auto", ns: nsValue = null, now = NaN } = {}) {
    const f = fields(ms, zone);
    if (!f) return EMPTY;
    const clock = clockText(f, fraction(ms, f, precision, nsValue), precision);
    if (date === "never") return clock;
    const withYear = date === "always" || f.year !== currentYear(now, zone);
    return `${dateText(f, withYear)} ${clock}`;
  }

  function localZoneName() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    } catch (_) {
      return "";
    }
  }

  // ISO 8601 in UTC, for exports, copies and tooltips: "2026-09-12T14:29:57.123Z".
  function iso(ms) {
    const n = num(ms);
    if (!Number.isFinite(n)) return EMPTY;
    const d = new Date(Math.floor(n));
    return Number.isFinite(d.getTime()) ? d.toISOString() : EMPTY;
  }

  // The tooltip of a displayed instant, one line each: ISO 8601, browser
  // local time (zone and offset), UTC, and the server's zone when known.
  //   2026-09-12T14:29:57.123Z
  //   Sep 12, 2026 16:29:57.123 local (Europe/Paris, UTC+02:00)
  //   Sep 12, 2026 14:29:57.123 UTC
  //   Sep 12, 2026 10:29:57.123 server (America/New_York, UTC-04:00)
  function timeTitle(ms, { serverTz = "", precision = "ms", ns: nsValue = null } = {}) {
    const n = num(ms);
    if (!Number.isFinite(n)) return EMPTY;
    const options = { precision, date: "always", ns: nsValue };
    const local = fields(n, "local");
    if (!local) return EMPTY;
    const zone = localZoneName();
    const lines = [
      iso(n),
      `${formatIn(n, "local", options)} local (${zone ? `${zone}, ` : ""}${offsetLabel(local.offset)})`,
      `${formatIn(n, "UTC", options)} UTC`,
    ];
    const server = String(serverTz || "").trim();
    const serverFields = server ? fields(n, server) : null;
    if (serverFields) lines.push(`${formatIn(n, server, options)} server (${server}, ${offsetLabel(serverFields.offset)})`);
    return lines.join("\n");
  }

  // ClickHouse DateTime text ("2026-09-12 16:29:57", DateTime64 ".123456")
  // as epoch ms. A zone-less value is wall-clock time in `zone`: an IANA name
  // (the server's timezone()), "UTC" or "local"; a value with "Z" or an offset
  // is absolute. NaN for other text, an unknown zone and the epoch-0 time
  // ClickHouse prints for an unset value ("1970-01-01 00:00:00" in UTC).
  const CH_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?\s*(Z|[+-]\d{2}:?\d{2})?$/;

  // Epoch ms of ClickHouse DateTime text, 0 included (NaN when it does not parse).
  function chTimeMs(text, zone) {
    const m = CH_TIME.exec(String(text ?? "").trim());
    if (!m) return NaN;
    const [, y, mo, d, h, mi, s, frac = "", offset] = m;
    const millis = frac ? Number(`0.${frac}`) * 1000 : 0;
    const wall = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)) + millis;
    if (offset) {
      if (offset === "Z") return wall;
      const sign = offset[0] === "-" ? -1 : 1;
      const digits = offset.slice(1).replace(":", "");
      return wall - sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))) * 60000;
    }
    if (zone === "UTC") return wall;
    // The zone's offset at that wall clock: guess with the offset at the wall
    // time read as UTC, then once more across a DST change.
    const first = fields(wall, zone);
    if (!first) return NaN;
    let ms = wall - first.offset * 60000;
    const second = fields(ms, zone);
    if (second && second.offset !== first.offset) ms = wall - second.offset * 60000;
    return ms;
  }

  function parseTime(text, { zone = "UTC" } = {}) {
    const ms = chTimeMs(text, zone);
    return ms === 0 ? NaN : ms;
  }

  // A server instant for display: { ms, text, title, iso }. text is
  // format.time() in the browser zone, title is format.timeTitle() with the
  // server line, iso is for copies. An unset (epoch 0) time is EMPTY. Text
  // that does not parse (or an unknown server zone) is shown as sent.
  function serverTime(value, { serverTz = "", precision = "s" } = {}) {
    const raw = String(value ?? "").trim();
    const zone = String(serverTz || "").trim();
    const ms = raw && zone ? chTimeMs(raw, zone) : NaN;
    if (ms === 0) return { ms: NaN, text: EMPTY, title: "", iso: "" };
    if (!Number.isFinite(ms)) return { ms: NaN, text: raw || EMPTY, title: "", iso: raw };
    return { ms, text: time(ms, { precision }), title: timeTitle(ms, { serverTz: zone }), iso: iso(ms) };
  }

  // ---------------------------------------------------------- time ranges

  const UNIT_WORDS = { s: "second", m: "minute", h: "hour", d: "day", w: "week", M: "month", y: "year" };

  // The label of a time range (the range buttons, a chart's range, a bucket):
  // absolute ms read as format.time does, "Sep 12 16:00 \u2192 17:00", the date
  // repeated only when it changes (its year only when it is not the current
  // year), browser-local 24 h time. options.precision: "auto" (default:
  // minutes, seconds for a range under 10 minutes), "s", "ms", "us", "ns" or
  // "day" (the dates alone). Relative raw sides ("now-1h", "now"): "Last 1
  // hour"; other relative ranges use the picker's names
  // (ns.timeRange.describeRange) when it is loaded.
  function range(from, to, { precision = "auto" } = {}) {
    const relative = (v) => typeof v === "string" && /now/i.test(v);
    if (relative(from) || relative(to)) {
      const a = String(from || "").trim();
      const b = String(to || "").trim();
      const last = /^now-(\d{1,5})([smhdwMy])$/.exec(a);
      if (last && b === "now") {
        const amount = Number(last[1]);
        return `Last ${amount} ${UNIT_WORDS[last[2]]}${amount === 1 ? "" : "s"}`;
      }
      if (ns.timeRange && typeof ns.timeRange.describeRange === "function") return ns.timeRange.describeRange({ from: a, to: b }).text;
      return `${a} ${ARROW} ${b}`;
    }
    const a = num(from);
    const b = num(to);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return EMPTY;
    const fa = fields(a, "local");
    const fb = fields(b, "local");
    if (!fa || !fb) return EMPTY;
    const p = precision === "auto" ? (Math.abs(b - a) < 600000 ? "s" : "min") : precision;
    const thisYear = currentYear(NaN, "local");
    const day = (f) => dateText(f, f.year !== thisYear);
    const sameDay = fa.year === fb.year && fa.month === fb.month && fa.day === fb.day;
    if (p === "day") return sameDay ? day(fa) : `${day(fa)} ${ARROW} ${day(fb)}`;
    const clock = (f, ms) => clockText(f, fraction(ms, f, p, null), p);
    return `${day(fa)} ${clock(fa, a)} ${ARROW} ${sameDay ? "" : `${day(fb)} `}${clock(fb, b)}`;
  }

  // "5 minutes ago", "1 hour ago": the largest whole unit, never negative.
  function ago(ms, { now = NaN } = {}) {
    const n = num(ms);
    if (!Number.isFinite(n)) return EMPTY;
    const delta = Math.max(0, (Number.isFinite(now) ? now : Date.now()) - n);
    const units = [[31536000000, "year"], [2592000000, "month"], [604800000, "week"], [86400000, "day"], [3600000, "hour"], [60000, "minute"], [1000, "second"]];
    for (const [size, label] of units) {
      if (delta >= size || label === "second") {
        const amount = Math.floor(delta / size);
        return `${amount} ${label}${amount === 1 ? "" : "s"} ago`;
      }
    }
    return EMPTY;
  }

  // ------------------------------------------------------------- absence

  // EMPTY for null, undefined, "" and NaN; otherwise formatter(value), or the
  // value as text.
  function emptyIfNull(value, formatter) {
    if (value == null || value === "" || (typeof value === "number" && Number.isNaN(value))) return EMPTY;
    return typeof formatter === "function" ? formatter(value) : String(value);
  }

  // A SQL NULL inside a value cell: muted italic, the --json-null colour.
  function nullToken() {
    return '<span class="nullToken">NULL</span>';
  }

  ns.format = Object.freeze({
    EMPTY,
    count,
    countLabel,
    compact,
    number,
    bytes,
    bytesRate,
    percent,
    rate,
    duration,
    time,
    timeTitle,
    iso,
    parseTime,
    serverTime,
    range,
    ago,
    emptyIfNull,
    nullToken,
  });
})();
