// Unit checks of ns.format (app_format.js) and ns.palette (app_palette.js),
// run by test_ui_foundations_contract.py under several TZ values:
//   TZ=Europe/Paris node ui_foundations_unit.js <repo root>
// Prints a JSON list of failures (empty when every check passes).
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = process.argv[2] || path.resolve(__dirname, "..", "..");
const read = (name) => fs.readFileSync(path.join(root, "src", "static", name), "utf8");

const MU = String.fromCharCode(0xb5);
const DASH = String.fromCharCode(0x2014);
const ARROW = String.fromCharCode(0x2192);

function memoryStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
    dump: () => Object.fromEntries(data),
  };
}

// A fresh window with the two modules (and app_util.js) loaded, as the page loaders do.
function load({ storage = memoryStorage(), extra = {} } = {}) {
  const window = { ChDash: { ...extra }, sessionStorage: storage };
  const context = vm.createContext({ window, Intl, Date, Math, JSON, Number, String, Object, Map, Set, Array, RegExp, BigInt });
  for (const file of ["app_format.js", "app_palette.js", "app_util.js"]) vm.runInContext(read(file), context, { filename: file });
  return window.ChDash;
}

const failures = [];
let checks = 0;
function eq(label, actual, expected) {
  checks += 1;
  if (actual !== expected) failures.push({ label, actual, expected });
}

const ns = load();
const { format, palette, util } = ns;
const zone = process.env.TZ || "UTC";

// ------------------------------------------------------------ EMPTY / null
eq("EMPTY", format.EMPTY, DASH);
eq("EMPTY code point", format.EMPTY.charCodeAt(0), 0x2014);
eq("emptyIfNull null", format.emptyIfNull(null), DASH);
eq("emptyIfNull undefined", format.emptyIfNull(undefined), DASH);
eq("emptyIfNull empty", format.emptyIfNull(""), DASH);
eq("emptyIfNull NaN", format.emptyIfNull(NaN), DASH);
eq("emptyIfNull 0", format.emptyIfNull(0), "0");
eq("emptyIfNull formatter", format.emptyIfNull(1234, format.count), "1,234");
eq("nullToken", format.nullToken(), '<span class="nullToken">NULL</span>');

// --------------------------------------------------------------- duration
const durations = [
  [12, "12 ns"], [0, "0 ns"], [999.4, "999 ns"], [999.6, `1 ${MU}s`], [350e3, `350 ${MU}s`], [1500, `1.5 ${MU}s`],
  [1.82e6, "1.82 ms"], [182e6, "182 ms"], [999.7e6, "1 s"], [2.5e9, "2.5 s"], [59.94e9, "59.9 s"], [59.96e9, "1 min"],
  [510e9, "8 min 30 s"], [3599.6e9, "1 h"], [7500e9, "2 h 5 min"], [273600e9, "3 d 4 h"], [86400e9, "1 d"],
  [-1, DASH], [null, DASH], [undefined, DASH], ["", DASH], ["abc", DASH], ["1500", `1.5 ${MU}s`],
];
for (const [input, expected] of durations) eq(`duration(${input})`, format.duration(input), expected);
eq("duration micro sign is U+00B5", format.duration(350e3).charCodeAt(4), 0xb5);
eq("duration.fromMs", format.duration.fromMs(1.82), "1.82 ms");
eq("duration.fromMs 8.5 min", format.duration.fromMs(510000), "8 min 30 s");
eq("duration.fromSeconds", format.duration.fromSeconds(2.5), "2.5 s");
eq("duration.fromUs", format.duration.fromUs(350), `350 ${MU}s`);
eq("duration.fromMs null", format.duration.fromMs(null), DASH);
eq("duration.fromSeconds bad", format.duration.fromSeconds("x"), DASH);

// ------------------------------------------------------------------ count
eq("count", format.count(120064), "120,064");
eq("count rounds", format.count(-1234.6), "-1,235");
eq("count 0", format.count(0), "0");
eq("count string", format.count("98765"), "98,765");
eq("count UInt64 string", format.count("18446744073709551615"), "18,446,744,073,709,551,615");
eq("count BigInt", format.count(12345678901234567890n), "12,345,678,901,234,567,890");
eq("count null", format.count(null), DASH);
eq("count text", format.count("abc"), DASH);

// ---------------------------------------------------------------- compact
const compacts = [
  [120064, "120.1K"], [3.4e6, "3.4M"], [1.2e9, "1.2B"], [1.5e12, "1.5T"], [999, "999"], [999.6, "1K"], [1000, "1K"],
  [999960, "1M"], [42.37, "42.4"], [99.96, "100"], [0.04, "0"], [0, "0"], [-1500, "-1.5K"], [12, "12"], [null, DASH],
];
for (const [input, expected] of compacts) eq(`compact(${input})`, format.compact(input), expected);

// ------------------------------------------------------------------ bytes
const KB = 1024;
const byteCases = [
  [0, "0 B"], [205, "205 B"], [1740, "1.7 KB"], [10.3 * KB * KB, "10.3 MB"], [1023.96 * KB, "1.0 MB"],
  [-2048, "-2.0 KB"], [5 * KB ** 4, "5.0 TB"], [null, DASH], ["x", DASH],
];
for (const [input, expected] of byteCases) eq(`bytes(${input})`, format.bytes(input), expected);
eq("bytesRate", format.bytesRate(1740), "1.7 KB/s");
eq("bytesRate null", format.bytesRate(null), DASH);

// util keeps its own "-" for a missing value and otherwise prints what it
// printed before the delegation.
function oldFormatBytes(value) {
  const units = ["KB", "MB", "GB", "TB", "PB", "EB"];
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "-";
  const sign = n < 0 ? "-" : "";
  let v = Math.abs(n);
  if (v < 1024) return `${sign}${Math.round(v)} B`;
  let unit = -1;
  while (v >= 1024 && unit < units.length - 1) { v /= 1024; unit += 1; }
  if (Number(v.toFixed(1)) >= 1024 && unit < units.length - 1) { v /= 1024; unit += 1; }
  return `${sign}${v.toFixed(1)} ${units[unit]}`;
}
function oldFormatInt(value) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "-";
  return Math.trunc(n).toLocaleString("en-US");
}
const parity = [0, -0.4, 1, 205, 1023, 1024, 1740, 1048575, 1048576, 10.3 * KB * KB, 1023.96 * KB, -5e9, 1e21, 2 ** 70, 12.7, -12.7, null, "", "12", "x", NaN, Infinity];
for (const value of parity) {
  eq(`util.formatBytes(${String(value)})`, util.formatBytes(value), oldFormatBytes(value));
  eq(`util.formatInt(${String(value)})`, util.formatInt(value), oldFormatInt(value));
}
eq("util.formatSeconds unchanged", util.formatSeconds(1.2344), "1.234s");

// ---------------------------------------------------------------- percent
const percents = [
  [0, "0%"], [0.5, "50%"], [0.1234, "12.3%"], [0.01234, "1.23%"], [0.001, "0.1%"], [0.0001, "<0.1%"], [0.00099, "<0.1%"],
  [1, "100%"], [0.99999, "100%"], [-0.25, "-25%"], [-0.00001, ">-0.1%"], [12.5, "1250%"], [null, DASH],
];
for (const [input, expected] of percents) eq(`percent(${input})`, format.percent(input), expected);

// ------------------------------------------------------------------- rate
eq("rate compact", format.rate(1234, "rows"), "1.2K rows/s");
eq("rate small", format.rate(3.456, "spans"), "3.46 spans/s");
eq("rate zero", format.rate(0), "0/s");
eq("rate tiny", format.rate(0.001, "rows"), "<0.01 rows/s");
eq("rate own period", format.rate(5, "rows/min"), "5 rows/min");
eq("rate null", format.rate(null, "rows"), DASH);

// ------------------------------------------------------------------- time
const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);
const T = Date.UTC(2026, 8, 12, 14, 29, 57, 123);
// Expected wall clock of T, and of the DST / year edge instants, per zone.
const ZONES = {
  UTC: { t: "Sep 12 14:29:57", offset: "UTC+00:00", newYear: "Jan 1 00:30:00", lastYear: "Jan 5, 2025 03:04:05" },
  "Europe/Paris": { t: "Sep 12 16:29:57", offset: "UTC+02:00", newYear: "Jan 1 01:30:00", lastYear: "Jan 5, 2025 04:04:05" },
  "America/New_York": { t: "Sep 12 10:29:57", offset: "UTC-04:00", newYear: "Dec 31, 2025 19:30:00", lastYear: "Jan 4, 2025 22:04:05" },
  "Asia/Kolkata": { t: "Sep 12 19:59:57", offset: "UTC+05:30", newYear: "Jan 1 06:00:00", lastYear: "Jan 5, 2025 08:34:05" },
  "Australia/Lord_Howe": { t: "Sep 13 00:59:57", offset: "UTC+10:30", newYear: "Jan 1 11:30:00", lastYear: "Jan 5, 2025 14:04:05" },
};
const expect = ZONES[zone];
if (!expect) failures.push({ label: "unknown TZ for the time checks", actual: zone, expected: Object.keys(ZONES) });
else {
  eq("time", format.time(T, { now: NOW }), expect.t);
  eq("time ms", format.time(T, { now: NOW, precision: "ms" }), `${expect.t}.123`);
  eq("time ns from ns", format.time(T, { now: NOW, precision: "ns", ns: "1789223397123456789" }), `${expect.t}.123456789`);
  eq("time ns from ms fraction", format.time(T + 0.25, { now: NOW, precision: "ns" }), `${expect.t}.123250000`);
  eq("time never", format.time(T, { now: NOW, date: "never" }), expect.t.slice(-8));
  eq("time always", format.time(T, { now: NOW, date: "always" }), expect.t.replace(/^(\w+ \d+) /, "$1, 2026 "));
  // The year shows when the local date is in another year than now.
  eq("time new-year edge", format.time(Date.UTC(2026, 0, 1, 0, 30), { now: Date.UTC(2026, 5, 1) }), expect.newYear);
  eq("time last year", format.time(Date.UTC(2025, 0, 5, 3, 4, 5), { now: NOW }), expect.lastYear);
  eq("time 24 h", /AM|PM/.test(format.time(Date.UTC(2026, 8, 12, 23, 0), { now: NOW })), false);
  eq("time null", format.time(null), DASH);
  eq("time NaN", format.time(NaN), DASH);
  // Past the Date range: no "undefined NaN" text.
  eq("time out of range", format.time(1e20), DASH);
  eq("timeTitle out of range", format.timeTitle(1e20), DASH);
  eq("range out of range", format.range(0, 1e20), DASH);
  eq("iso out of range", format.iso(1e20), DASH);
  eq("iso", format.iso(T), "2026-09-12T14:29:57.123Z");
  eq("iso null", format.iso(null), DASH);

  const always = expect.t.replace(/^(\w+ \d+) /, "$1, 2026 ");
  const title = format.timeTitle(T, { serverTz: "America/New_York" }).split("\n");
  eq("timeTitle lines", title.length, 4);
  eq("timeTitle iso", title[0], "2026-09-12T14:29:57.123Z");
  // ICU may name the zone by its canonical alias (Asia/Kolkata is Asia/Calcutta).
  eq("timeTitle local", title[1], `${always}.123 local (${Intl.DateTimeFormat().resolvedOptions().timeZone}, ${expect.offset})`);
  eq("timeTitle utc", title[2], "Sep 12, 2026 14:29:57.123 UTC");
  eq("timeTitle server", title[3], "Sep 12, 2026 10:29:57.123 server (America/New_York, UTC-04:00)");
  eq("timeTitle Kolkata server", format.timeTitle(T, { serverTz: "Asia/Kolkata" }).split("\n")[3], "Sep 12, 2026 19:59:57.123 server (Asia/Kolkata, UTC+05:30)");
  eq("timeTitle unknown server zone", format.timeTitle(T, { serverTz: "Mars/Olympus" }).split("\n").length, 3);
  eq("timeTitle no server", format.timeTitle(T).split("\n").length, 3);
  eq("timeTitle precision s", format.timeTitle(T, { precision: "s" }).split("\n")[2], "Sep 12, 2026 14:29:57 UTC");

  // Daylight saving time: the server-zone line follows each zone's own rules,
  // whatever the browser zone is.
  const paris = (ms) => format.timeTitle(ms, { serverTz: "Europe/Paris", precision: "s" }).split("\n")[3];
  eq("DST spring, before", paris(Date.UTC(2026, 2, 29, 0, 59, 59)), "Mar 29, 2026 01:59:59 server (Europe/Paris, UTC+01:00)");
  eq("DST spring, after", paris(Date.UTC(2026, 2, 29, 1, 0, 0)), "Mar 29, 2026 03:00:00 server (Europe/Paris, UTC+02:00)");
  eq("DST autumn, first 02:30", paris(Date.UTC(2026, 9, 25, 0, 30)), "Oct 25, 2026 02:30:00 server (Europe/Paris, UTC+02:00)");
  eq("DST autumn, second 02:30", paris(Date.UTC(2026, 9, 25, 1, 30)), "Oct 25, 2026 02:30:00 server (Europe/Paris, UTC+01:00)");
  const lordHowe = (ms) => format.timeTitle(ms, { serverTz: "Australia/Lord_Howe", precision: "s" }).split("\n")[3];
  eq("DST half-hour shift", lordHowe(Date.UTC(2026, 9, 4, 12, 0)), "Oct 4, 2026 23:00:00 server (Australia/Lord_Howe, UTC+11:00)");

  // ------------------------------------------------------------------ range
  const local = (ms) => format.time(ms, { now: NOW, date: "never" });
  const dayOf = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const hm = (ms) => local(ms).slice(0, 5);
  const a = Date.UTC(2026, 8, 12, 14, 0);
  eq("range same day", format.range(a, a + 3600000), `${dayOf(a)} ${hm(a)} ${ARROW} ${hm(a + 3600000)}`);
  eq("range seconds under 10 min", format.range(T, T + 300000), `${dayOf(T)} ${local(T)} ${ARROW} ${local(T + 300000)}`);
  eq("range 10 min has no seconds", format.range(T, T + 600000), `${dayOf(T)} ${hm(T)} ${ARROW} ${hm(T + 600000)}`);
  const late = Date.UTC(2026, 8, 12, 21, 0);
  const early = Date.UTC(2026, 8, 13, 1, 0);
  const crosses = dayOf(late) !== dayOf(early);
  eq("range repeats a changed date", format.range(late, early),
    `${dayOf(late)} ${hm(late)} ${ARROW} ${crosses ? `${dayOf(early)} ` : ""}${hm(early)}`);
  if (zone === "Europe/Paris") {
    eq("range across spring DST", format.range(Date.UTC(2026, 2, 29, 0, 30), Date.UTC(2026, 2, 29, 1, 30)), `2026-03-29 01:30 ${ARROW} 03:30`);
    eq("range late evening", format.range(late, early), `2026-09-12 23:00 ${ARROW} 2026-09-13 03:00`);
  }
  if (zone === "UTC") eq("range late evening UTC", format.range(late, early), `2026-09-12 21:00 ${ARROW} 2026-09-13 01:00`);
  eq("range Last 1 hour", format.range("now-1h", "now"), "Last 1 hour");
  eq("range Last 24 hours", format.range("now-24h", "now"), "Last 24 hours");
  eq("range Last 7 days", format.range("now-7d", "now"), "Last 7 days");
  eq("range Last 15 minutes", format.range("now-15m", "now"), "Last 15 minutes");
  eq("range other relative", format.range("now/d", "now/d"), `now/d ${ARROW} now/d`);
  eq("range bad", format.range(null, 5), DASH);
  const withPicker = load({ extra: { timeRange: { describeRange: (raw) => ({ text: raw.from === "now/d" ? "Today" : "?" }) } } });
  eq("range picker names", withPicker.format.range("now/d", "now/d"), "Today");

  // -------------------------------------------------------------------- ago
  eq("ago minutes", format.ago(NOW - 5 * 60000, { now: NOW }), "5 minutes ago");
  eq("ago one hour", format.ago(NOW - 3600000, { now: NOW }), "1 hour ago");
  eq("ago days", format.ago(NOW - 3 * 86400000, { now: NOW }), "3 days ago");
  eq("ago future", format.ago(NOW + 5000, { now: NOW }), "0 seconds ago");
  eq("ago null", format.ago(null), DASH);
}

// ---------------------------------------------------------------- palette
eq("categorical 0", palette.categorical(0), "var(--qchart-1)");
eq("categorical 7", palette.categorical(7), "var(--qchart-8)");
eq("categorical wraps", palette.categorical(8), "var(--qchart-1)");
eq("categorical other", palette.categorical(-1), "var(--qchart-other)");
eq("quantile p95", palette.quantile("p95"), "var(--pct-p95)");
eq("quantile P99", palette.quantile("P99"), "var(--pct-p99)");
eq("quantile 90", palette.quantile(90), "var(--pct-p90)");
eq("quantile 0.5", palette.quantile(0.5), "var(--pct-p50)");
eq("quantile nearest", palette.quantile(75), "var(--pct-p90)");
const severities = [
  [21, "fatal"], [17, "error"], [13, "warn"], [9, "info"], [5, "debug"], [1, "trace"], ["24", "fatal"],
  ["ERROR", "error"], ["Warning", "warn"], ["critical", "fatal"], ["Information", "info"], ["TRACE", "trace"],
  ["debug", "debug"], ["", "debug"], ["weird", "debug"], [null, "debug"],
];
for (const [input, level] of severities) {
  eq(`severityLevel(${input})`, palette.severityLevel(input), level);
  eq(`severity(${input})`, palette.severity(input), `var(--sev-${level})`);
}
eq("sequential 0", palette.sequential(0), "var(--trace-heat-1)");
eq("sequential 0.5", palette.sequential(0.5), "var(--trace-heat-5)");
eq("sequential 1", palette.sequential(1), "var(--trace-heat-8)");
eq("sequential clamps", palette.sequential(3), "var(--trace-heat-8)");
eq("sequential NaN", palette.sequential(NaN), "var(--trace-heat-1)");
const kinds = [
  ["MaterializedView", "mv"], ["materialized_view", "mv"], ["mv", "mv"], ["View", "view"], ["Dictionary", "dict"],
  ["dict", "dict"], ["Buffer", "buffer"], ["Distributed", "distributed"], ["ReplicatedMergeTree", "table"], ["", "table"],
];
for (const [input, kind] of kinds) eq(`kind(${input})`, palette.kind(input), `var(--kind-${kind})`);

// Service colours: Traces' first-seen assignment, shared through its sessionStorage key.
const KEY = "chdash.traces.serviceColors";
const store = memoryStorage();
const first = load({ storage: store }).palette;
first.registerServices(["frontend", "cart", "api", "cart"]);
eq("service name order", first.service("api"), "var(--trace-span-color-1)");
eq("service name order 2", first.service("cart"), "var(--trace-span-color-2)");
eq("service name order 3", first.service("frontend"), "var(--trace-span-color-3)");
eq("service first seen", first.service("zeta"), "var(--trace-span-color-4)");
eq("service unknown", first.service(""), "var(--trace-span-color-5)");
eq("service stored as Traces stores it", store.dump()[KEY], JSON.stringify({ api: 0, cart: 1, frontend: 2, zeta: 3, unknown: 4 }));
const again = load({ storage: store }).palette;
eq("service stable across loads", again.service("zeta"), "var(--trace-span-color-4)");
eq("service registering again keeps slots", (again.registerServices(["zeta", "aaa"]), again.service("zeta")), "var(--trace-span-color-4)");
eq("service new name after reload", again.service("aaa"), "var(--trace-span-color-6)");
const peek = again.serviceSlot("never-seen", { assign: false });
eq("service peek is the hash slot", peek, load({ storage: memoryStorage() }).palette.serviceSlot("never-seen", { assign: false }));
eq("service peek does not assign", JSON.parse(store.dump()[KEY])["never-seen"], undefined);
eq("service peek in range", peek >= 0 && peek < first.SERVICE_SLOTS, true);
const seeded = load({ storage: memoryStorage({ [KEY]: JSON.stringify({ checkout: 5, bad: 99 }) }) }).palette;
eq("service reads the Traces store", seeded.service("checkout"), "var(--trace-span-color-6)");
eq("service ignores bad slots", seeded.serviceSlot("bad"), 1);
const wrap = load({ storage: memoryStorage() }).palette;
wrap.registerServices(Array.from({ length: 20 }, (_, i) => `svc${String(i).padStart(2, "0")}`));
eq("service slots wrap after 18", wrap.service("svc18"), "var(--trace-span-color-1)");
eq("service slots wrap 19", wrap.service("svc19"), "var(--trace-span-color-2)");
const noStorage = (() => {
  const window = { ChDash: {}, get sessionStorage() { throw new Error("blocked"); } };
  const context = vm.createContext({ window, Intl, Date, Math, JSON, Number, String, Object, Map, Set, Array, RegExp });
  vm.runInContext(read("app_palette.js"), context);
  return window.ChDash.palette;
})();
eq("service without storage", noStorage.service("a"), "var(--trace-span-color-1)");
eq("service without storage 2", noStorage.service("b"), "var(--trace-span-color-2)");

process.stdout.write(JSON.stringify({ zone, checks, failures }));
