// Unit checks of the Explorer card's SQL expression helpers
// (app_explorer_detail.js: splitTopLevel, keyElements, expressionIdentifiers,
// keyColumnPositions) and of the shared highlighter on key expressions
// (app_highlight.js), run by test_explorer_card_contract.py:
//   node explorer_card_unit.js <repo root>
// Prints {"checks": n, "failures": [...]}.
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = process.argv[2] || path.resolve(__dirname, "..", "..");
const read = (name) => fs.readFileSync(path.join(root, "src", "static", name), "utf8");

function memoryStorage() {
  const data = new Map();
  return { getItem: (key) => (data.has(key) ? data.get(key) : null), setItem: (key, value) => data.set(key, String(value)), removeItem: (key) => data.delete(key) };
}

const window = { ChDash: {}, sessionStorage: memoryStorage(), localStorage: memoryStorage() };
const context = vm.createContext({ window, Intl, Date, Math, JSON, Number, String, Object, Map, Set, Array, RegExp, WeakMap, BigInt, console });
for (const file of ["app_format.js", "app_palette.js", "app_state.js", "app_util.js"]) vm.runInContext(read(file), context, { filename: file });
const ns = window.ChDash;
ns.dom = { $: () => null, $$: () => [], byId: () => null };
for (const file of ["app_highlight.js", "app_explorer_detail.js"]) vm.runInContext(read(file), context, { filename: file });

const failures = [];
let checks = 0;
function eq(label, actual, expected) {
  checks += 1;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) failures.push({ label, actual, expected });
}

const { splitTopLevel, keyElements, expressionIdentifiers, keyColumnPositions } = ns.explorerDetail;

// ------------------------------------------------------- top-level split
eq("split simple", splitTopLevel("a, b, c"), ["a", "b", "c"]);
eq("split nested commas", splitTopLevel("service, toStartOfHour(ts), cityHash64(a, b)"), ["service", "toStartOfHour(ts)", "cityHash64(a, b)"]);
eq("split deep nesting", splitTopLevel("f(g(a, b), h(c, (d, e))), x"), ["f(g(a, b), h(c, (d, e)))", "x"]);
eq("split brackets", splitTopLevel("arrayJoin([1, 2, 3]), m['a,b']"), ["arrayJoin([1, 2, 3])", "m['a,b']"]);
eq("split braces", splitTopLevel("{a: 1, b: 2}, z"), ["{a: 1, b: 2}", "z"]);
eq("split strings", splitTopLevel("concat(a, ', '), 'x,y', \"q,r\""), ["concat(a, ', ')", "'x,y'", "\"q,r\""]);
eq("split escaped quote", splitTopLevel("replace(s, 'it\\'s, ok', ''), t"), ["replace(s, 'it\\'s, ok', '')", "t"]);
eq("split doubled quote", splitTopLevel("'a'',b', c"), ["'a'',b'", "c"]);
eq("split backquoted", splitTopLevel("`weird, name`, b"), ["`weird, name`", "b"]);
eq("split empty", splitTopLevel(""), []);
eq("split blanks", splitTopLevel(" a ,  b "), ["a", "b"]);

// ------------------------------------------------------------ key elements
eq("key plain", keyElements("observation_date, station_id, observed_at, id"), ["observation_date", "station_id", "observed_at", "id"]);
eq("key tuple parens", keyElements("(service, toStartOfHour(ts))"), ["service", "toStartOfHour(ts)"]);
eq("key tuple()", keyElements("tuple(service, toStartOfHour(ts))"), ["service", "toStartOfHour(ts)"]);
eq("key empty tuple", keyElements("tuple()"), []);
eq("key single function", keyElements("toYYYYMM(observation_date)"), ["toYYYYMM(observation_date)"]);
eq("key not one tuple", keyElements("(a + b) * c, d"), ["(a + b) * c", "d"]);
eq("key nested commas", keyElements("ServiceName, MetricName, Attributes, toUnixTimestamp64Nano(TimeUnix)"), ["ServiceName", "MetricName", "Attributes", "toUnixTimestamp64Nano(TimeUnix)"]);
eq("key multi-arg function", keyElements("intDiv(id, 1000), if(x > 0, 'pos, yes', 'neg')"), ["intDiv(id, 1000)", "if(x > 0, 'pos, yes', 'neg')"]);
eq("key blank", keyElements("  "), []);

// ------------------------------------------------- identifiers / positions
eq("identifiers skip functions and strings", [...expressionIdentifiers("toStartOfHour(ts) + length('id') + `my col` + n.key")].sort(), ["my col", "n.key", "ts"]);
eq("position plain", keyColumnPositions("service, toStartOfHour(ts)", "service"), [0]);
eq("position in function", keyColumnPositions("service, toStartOfHour(ts)", "ts"), [1]);
eq("position not a substring", keyColumnPositions("tsx, ts", "ts"), [1]);
eq("position several", keyColumnPositions("a, cityHash64(a, b), b", "a"), [0, 1]);
eq("position subcolumn", keyColumnPositions("n.key, id", "n"), [0]);
eq("position function name is not a column", keyColumnPositions("toDate(ts)", "toDate"), []);
eq("position partition", keyColumnPositions("toYYYYMM(observation_date)", "observation_date"), [0]);

// ----------------------------------------------- highlighter on key parts
ns.state.selectedHostId = "local";
ns.state.meta = { hosts: { local: { functions: { ci: new Set(), cs: new Set(["toStartOfHour", "toYYYYMM", "cityHash64"]), meta: new Map() } } } };
const html = ns.highlight.toHtml("toStartOfHour(ts)");
eq("function token", /<span class="tok-fn">toStartOfHour<\/span>/.test(html), true);
eq("column stays plain", /tok-\w+">ts</.test(html), false);
eq("numbers", /<span class="tok-num">1000<\/span>/.test(ns.highlight.toHtml("intDiv(id, 1000)")), true);

process.stdout.write(JSON.stringify({ checks, failures }));
