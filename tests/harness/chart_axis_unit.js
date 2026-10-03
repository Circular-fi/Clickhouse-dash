// Unit checks of the chart engine's time axis labels (app_chart_core.js:
// timeTicks and layoutXLabels), run by test_chart_axis_labels_contract.py
// under several TZ values (browser-local time is the display zone):
//   TZ=Europe/Paris node chart_axis_unit.js <repo root>
// Prints { zone, checks, failures }.
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = process.argv[2] || path.resolve(__dirname, "..", "..");
const read = (name) => fs.readFileSync(path.join(root, "src", "static", name), "utf8");

const window = { ChDash: { dom: { $: () => null }, storage: { KEYS: { chartLegend: "chart.legend" } } } };
const context = vm.createContext({ window, Intl, Date, Math, JSON, Number, String, Object, Map, Set, Array, RegExp, WeakMap });
vm.runInContext(read("app_chart_core.js"), context, { filename: "app_chart_core.js" });
const core = window.ChDash.chartCore;

const failures = [];
let checks = 0;
function ok(label, condition, detail) {
  checks += 1;
  if (!condition) failures.push({ label, detail });
}

// About the widths of the 11 px axis font and its 600 weight.
const measure = (text) => text.length * 6.2;
const measureBold = (text) => text.length * 6.9;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayOf = (ms) => { const d = new Date(ms); return `${MONTHS[d.getMonth()]} ${d.getDate()}`; };
const yearOf = (ms) => String(new Date(ms).getFullYear());
const HOUR = 3600000, DAY = 24 * HOUR;
const LEFT = 52, RIGHT = 14;

// The labels of an axis over [start, end] on a plot plotW px wide.
function axis(start, end, plotW) {
  const width = LEFT + plotW + RIGHT;
  const ticks = core.timeTicks(start, end, plotW, measure);
  const xOf = (v) => LEFT + ((v - start) / (end - start)) * plotW;
  return { ticks, width, labels: core.layoutXLabels(ticks, xOf, LEFT, LEFT + plotW, width, measure, measureBold) };
}

function checkAxis(name, start, end, plotW) {
  const { ticks, width, labels } = axis(start, end, plotW);
  const where = `${name} ${new Date(start).toString()} ${plotW}px`;
  ok(`${where}: labels drawn`, labels.length >= 2, labels.length);
  const contexts = labels.filter((t) => t.context);
  for (let i = 0; i < labels.length; i++) {
    const t = labels[i];
    ok(`${where}: label inside the canvas`, t.left >= 0 && t.right <= width, [t.label, t.left, t.right]);
    if (i) ok(`${where}: labels keep 6 px apart`, t.left >= labels[i - 1].right + 6 - 1e-9, [labels[i - 1].label, labels[i - 1].right, t.label, t.left]);
  }
  for (let i = 0; i < contexts.length; i++) {
    const t = contexts[i];
    ok(`${where}: context inside the canvas`, t.cleft >= 0 && t.cright <= width, [t.context, t.cleft, t.cright]);
    ok(`${where}: context measured at its font`, Math.abs(t.cright - t.cleft - measureBold(t.context)) < 1e-6, t.context);
    if (i) {
      const p = contexts[i - 1];
      ok(`${where}: contexts keep 10 px apart`, t.cleft >= p.cright + 10 - 1e-9, [p.context, p.cright, t.context, t.cleft]);
      ok(`${where}: a context shows a change`, t.context !== p.context, [p.context, t.context]);
    }
  }
  const dated = ticks.length && ticks[0].date;
  const yearly = ticks.length && ticks[0].year;
  if (!yearly) {
    ok(`${where}: year ticks have no context`, contexts.length === 0, contexts.map((t) => t.context));
    return;
  }
  ok(`${where}: a context dates the axis`, contexts.length >= 1, labels.map((t) => t.label));
  // Year on the first context and where the year changes, nowhere else; the
  // date of the label's own tick (clock times) or its year (days, months).
  let shownYear = "";
  for (const t of contexts) {
    const year = yearOf(t.v);
    const expected = dated ? (year !== shownYear ? `${dayOf(t.v)} ${year}` : dayOf(t.v)) : year;
    ok(`${where}: context text`, t.context === expected, [t.label, t.context, expected]);
    shownYear = year;
  }
  // A label never reads under another date: from the first context on, the
  // last context at or left of each label names its own day (or year).
  let last = null;
  for (const t of labels) {
    if (t.context) last = t;
    if (!last) continue;
    const same = dated ? dayOf(t.v) === dayOf(last.v) && yearOf(t.v) === yearOf(last.v) : yearOf(t.v) === yearOf(last.v);
    ok(`${where}: a label reads under its own date`, same, [t.label, dayOf(t.v), last.context]);
  }
}

// Spans of the range pickers, on a 1440 px page (1330 px plot), a 390 px
// one (300 px), and between, from many starts: through days, a year end and
// the DST changes of the zones under test.
const SPANS = [["1h", HOUR], ["24h", DAY], ["7d", 7 * DAY], ["30d", 30 * DAY]];
const WIDTHS = [1330, 640, 300];
const STARTS = [];
for (let k = 0; k < 60; k++) STARTS.push(new Date(2026, 9, 1, 0, 0).getTime() + k * 53 * 60000);
for (const [y, m, d] of [[2026, 11, 30], [2026, 11, 31], [2026, 2, 28], [2026, 2, 29], [2026, 9, 3], [2026, 9, 24], [2026, 9, 31], [2026, 3, 4]]) {
  for (const h of [0, 13, 22, 23]) STARTS.push(new Date(y, m, d, h, 30).getTime());
}
for (const [name, span] of SPANS) {
  for (const plotW of WIDTHS) {
    for (const start of STARTS) checkAxis(name, start, start + span, plotW);
  }
}
// Longer ranges: days and months across a year end, then years.
for (const plotW of WIDTHS) {
  checkAxis("90d", new Date(2026, 10, 1).getTime(), new Date(2027, 1, 1).getTime(), plotW);
  checkAxis("1y", new Date(2026, 5, 1).getTime(), new Date(2027, 5, 1).getTime(), plotW);
  checkAxis("20y", new Date(2010, 0, 1).getTime(), new Date(2030, 0, 1).getTime(), plotW);
}

// The reported case: 24 h from 22:30 on a 1440 px page. "Oct 2 2026" under
// 23:00 and "Oct 3 2026" under 00:00 ran into each other; now the first
// label's date gives way to the change, which carries the year.
{
  const start = new Date(2026, 9, 2, 22, 30).getTime();
  const { labels } = axis(start, start + DAY, 1330);
  const shown = labels.filter((t) => t.context).map((t) => [t.label, t.context]);
  ok("24h at 1440: one date, at midnight, with its year", JSON.stringify(shown) === JSON.stringify([["00:00", "Oct 3 2026"]]), shown);
  ok("24h at 1440: 23:00 still labelled", labels[0].label === "23:00", labels[0].label);
}
// 7 d: the first date carries the year, the next midnights only the day.
{
  const start = new Date(2026, 8, 26, 22, 30).getTime();
  const { labels } = axis(start, start + 7 * DAY, 1330);
  const shown = labels.filter((t) => t.context).map((t) => t.context);
  ok("7d at 1440: year on the first date only", shown[0] === "Sep 27 2026" && shown.slice(1).every((c) => !/\d{4}/.test(c)) && shown.length === 7, shown);
}
// A year end under clock times: the year again on the new year's date.
{
  const start = new Date(2026, 11, 31, 6, 0).getTime();
  const { labels } = axis(start, start + DAY, 1330);
  const shown = labels.filter((t) => t.context).map((t) => [t.label, t.context]);
  ok("a year end: both years shown", JSON.stringify(shown) === JSON.stringify([["06:00", "Dec 31 2026"], ["00:00", "Jan 1 2027"]]), shown);
}
// Months across a year end: "2027" under Jan.
{
  const { labels } = axis(new Date(2026, 0, 15).getTime(), new Date(2027, 5, 1).getTime(), 1330);
  const shown = labels.filter((t) => t.context).map((t) => [t.label, t.context]);
  ok("months: the year under the first month and under Jan", JSON.stringify(shown) === JSON.stringify([["Feb", "2026"], ["Jan", "2027"]]), shown);
}
// A context that would touch the previous (not the first) one skips its
// label and waits for the next one rather than overlap: made-up ticks 40 px
// apart, a day change on each of the first three.
{
  const ticks = [
    { v: 0, label: "22:00", date: "Oct 1", year: "2026" },
    { v: 1, label: "00:00", date: "Oct 2", year: "2026" },
    { v: 2, label: "00:00", date: "Oct 3", year: "2026" },
    { v: 3, label: "02:00", date: "Oct 3", year: "2026" },
    { v: 4, label: "04:00", date: "Oct 3", year: "2026" },
  ];
  const labels = core.layoutXLabels(ticks, (v) => 100 + v * 40, 100, 400, 500, measure, measureBold);
  const shown = labels.filter((t) => t.context).map((t) => [t.label, t.context]);
  ok("made-up ticks: the first date gives way, a later one waits", JSON.stringify(shown) === JSON.stringify([["00:00", "Oct 2 2026"], ["02:00", "Oct 3"]]), shown);
  ok("made-up ticks: the label of the hidden date skipped", JSON.stringify(labels.map((t) => t.v)) === "[0,1,3,4]", labels.map((t) => t.v));
}
// Ticks without a context (numbers, categories) and labels past the plot.
{
  const labels = core.layoutXLabels([{ v: -1, label: "x" }, { v: 0, label: "0" }, { v: 1, label: "10" }, { v: 9, label: "far" }], (v) => 100 + v * 100, 100, 300, 400, measure, measureBold);
  ok("plain ticks: no context, the plot's only", JSON.stringify(labels.map((t) => [t.label, t.context])) === JSON.stringify([["0", ""], ["10", ""]]), labels);
}

process.stdout.write(JSON.stringify({ zone: process.env.TZ || "", checks, failures: failures.slice(0, 40), failureCount: failures.length }));
