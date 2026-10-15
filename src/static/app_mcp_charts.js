// The four charts of the Usage tab (app_mcp_overview.js, docs/mcp-integration-page.md, "The Usage tab"): the requests, the errors, the time of
// a tool call (its average) and the bytes returned, over the window, in a grid of two columns (one under 1100 px). They are grouped by one
// dimension (the Group by of the bar: key, method or client) and cut by the same filters, so they have the same x axis (the steps of the
// window, 1 minute to 1 day), the same groups and, for a group, the same colour: it comes from a hash of its id, so a name has one colour in
// every chart, window and filter. Each chart has its own legend (the totals of its figure), and a legend is the filter of the group: a click
// on an entry adds or removes it. The groups that a chart folds into "N more" cannot be picked there (the tables list them), and neither can
// any group when the dimension has one value and no filter (there is nothing to filter by). The cursor and the zoom go from one chart to the
// others. The engine is app_chart_core.js.
//
// The four cards keep one height, whatever they hold (a filter never moves what is under them): the plot is CHART_HEIGHT, the legend has the
// room of three lines (four on a phone) and scrolls inside past them, and a card with nothing to draw says so in a box of the same size
// (mcp.css, .mcpOverview__card).
//
//   mcpCharts.create(box, { pressed(group, id), onToggle(group, id), offered(group) }) -> charts
//                           offered(group): whether a filter on the group dimension is offered (it has two values, or a filter is on)
//   charts.draw(data, empty)  the four charts for an answer (the cards are built the first time; the engines are drawn again each time).
//                           `empty` (null when the window has requests) is { title, body, action }: the sentence of the Requests card
//                           for a window with no request; the three others say what they count, as for a figure that is 0
//   charts.redraw()         the legends again, for a filter that is picked while the next answer is read
//   charts.destroy()        stops the engines and empties the box

import { chartCore } from "./app_chart_core.js";
import { dom, h } from "./app_dom.js";
import { format } from "./app_format.js";
import { palette } from "./app_palette.js";
import { uiState } from "./app_ui_state.js";

const { $, $$ } = dom;

const CHART_HEIGHT = 200;
const DAY_MS = 86400000;
// The id of the series that holds the groups the chart folds together: no group can have it (an id has no "~").
const REST_ID = "~rest";
// palette.categorical(i) has these slots (--qchart-1..18).
const COLOURS = 18;
// The charts of a page that move their cursor and their zoom together.
const SYNC_KEY = "mcp-usage";
const GROUP_NOUN = { key: "key", method: "method", client: "client" };

const count = (n) => format.count(n);
// The server counts whole milliseconds: a time of 0 is under a millisecond.
const ms = (value) => (value == null ? format.EMPTY : value === 0 ? "<1 ms" : format.duration.fromMs(value));
const day = (t) => format.iso(t).slice(0, 10);

// How long a step is, for the head of a chart: "by the minute", "by 5 minutes", "by 3 hours", "by the UTC day".
function stepText(seconds) {
  if (seconds >= 86400) return "by the UTC day";
  const [n, unit] = seconds >= 3600 ? [seconds / 3600, "hour"] : [seconds / 60, "minute"];
  return n === 1 ? `by the ${unit}` : `by ${n} ${unit}s`;
}

// The axis of a chart of bytes: round ticks in the unit of 1024 (KB, MB...), from 0.
function byteUnit(max) {
  for (const [factor, suffix] of [[1024 ** 4, " TB"], [1024 ** 3, " GB"], [1024 ** 2, " MB"], [1024, " KB"]]) if (max >= factor) return { factor, suffix };
  return { factor: 1, suffix: " B" };
}

function bytesAxis(dataMin, dataMax, plotH) {
  const lo = Math.min(0, dataMin);
  const hi = Math.max(dataMax * 1.06, lo + 1);
  const unit = byteUnit(Math.max(Math.abs(lo), Math.abs(hi)));
  const ticks = chartCore.linearTicks(lo / unit.factor, hi / unit.factor, Math.max(2, Math.floor(plotH / 34)));
  const decimals = chartCore.decimalsFor(ticks.step);
  return {
    min: lo,
    max: hi,
    step: ticks.step * unit.factor,
    ticks: ticks.values.map((v) => ({ v: v * unit.factor, label: v === 0 ? "0" : `${v.toFixed(decimals)}${unit.suffix}` })),
  };
}

const sum = (values) => values.reduce((total, value) => total + value, 0);
// A zero is no value: a bar is not drawn and the tooltip lists the groups that have something.
const bars = (values) => Float64Array.from(values, (value) => (value > 0 ? value : NaN));
// The average time of a call at each step (the time of the calls over their number), a gap where no call was made.
const averages = (group) => Float64Array.from(group.calls, (calls, i) => (calls > 0 ? group.durationMsSum[i] / calls : NaN));

// The four charts: what each draws, how it reads, and what it says when its figure is 0 over the window. `figure(group)` is the series of a
// group; `any(group)` whether a group (or the folded ones) has a value to draw; `total(series, sum)` the text of its legend entry.
const CHARTS = [
  {
    id: "requests",
    title: "Requests",
    type: "bar",
    stack: true,
    figure: (group) => bars(group.requests),
    any: () => true,
    total: (series, total) => format.compact(total),
    value: count,
  },
  {
    id: "errors",
    title: "Errors",
    type: "bar",
    stack: true,
    figure: (group) => bars(group.errors),
    any: (group) => group.errors.some((value) => value > 0),
    none: "No errors in this window",
    total: (series, total) => format.compact(total),
    value: count,
  },
  {
    id: "time",
    title: "Call time",
    type: "line",
    stack: false,
    figure: averages,
    any: (group) => group.calls.some((value) => value > 0),
    none: "No tool calls in this window",
    // An average does not add up: the entry says the average of the group over the window, the time of its calls over their number.
    total: (series) => ms(series.average),
    value: ms,
    // Milliseconds under a second ("20 ms"), seconds from there.
    unit: (max) => (max >= 1000 ? { factor: 1000, suffix: " s" } : { factor: 1, suffix: " ms" }),
  },
  {
    id: "bytes",
    title: "Returned",
    type: "bar",
    stack: true,
    figure: (group) => bars(group.bytes),
    any: (group) => group.bytes.some((value) => value > 0),
    none: "Nothing was returned in this window",
    total: (series, total) => format.bytes(total),
    value: (value) => format.bytes(value),
    axis: bytesAxis,
  },
];

// The slot of a group: the one that the hash of its id gives (FNV-1a, as palette.service does for a name it has not met), so a group has the
// same colour on every visit, in every window and under every filter, whatever its rank. The groups of one chart never share a slot: a group
// whose slot is taken takes the next free one (the order is the hash and the id, never the size).
function slotsOf(ids) {
  const hashOf = (text) => {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash % COLOURS;
  };
  const taken = new Set();
  const slots = new Map();
  for (const id of [...ids].sort((a, b) => hashOf(a) - hashOf(b) || (a < b ? -1 : a > b ? 1 : 0))) {
    let slot = hashOf(id);
    while (taken.has(slot) && taken.size < COLOURS) slot = (slot + 1) % COLOURS;
    taken.add(slot);
    slots.set(id, slot);
  }
  return slots;
}

// A card: its head (the title and the step) and the box of its chart.
function cardOf(spec) {
  const title = h("h3", { class: "chartCard__title", id: `mcpChartTitle-${spec.id}` });
  const meta = h("span", { class: "chartCard__meta" });
  const body = h("div", { class: "chartCard__body mcpOverview__chart", dataset: { chart: spec.id } });
  const el = h("section", { class: "chartCard mcpOverview__card", dataset: { card: spec.id }, aria: { labelledby: `mcpChartTitle-${spec.id}` } },
    h("header", { class: "chartCard__head" }, title, meta), body);
  return { spec, el, title, meta, body, group: "", chart: null, watch: null };
}

function create(box, { pressed, onToggle, offered }) {
  const cards = CHARTS.map(cardOf);
  // The entry of a legend that was pressed: the chart that the answer draws takes the keyboard back to it.
  let focus = null;
  let built = false;

  function destroy() {
    focus = null;
    for (const card of cards) {
      card.watch?.disconnect();
      card.watch = null;
      card.chart?.destroy();
      card.chart = null;
    }
    box.replaceChildren();
    built = false;
  }

  // An entry that is no filter cannot be pressed: "N more" holds the groups that a chart folds (the tables pick any value), and no entry is a
  // filter when the dimension of the groups has one value and no filter.
  function lockEntries(card) {
    const open = offered(card.group);
    for (const item of $$(".chartCore__legendItem", card.chart?.root)) {
      if (open && item.dataset.series !== REST_ID) continue;
      item.disabled = true;
      item.removeAttribute("aria-pressed");
    }
  }

  // The groups of the answer as the series of a chart: a group is a series, the folded ones are the last one, "N more".
  function seriesOf(card, data) {
    const { groups, rest } = data.series;
    const slots = slotsOf(groups.map((group) => group.id));
    const average = (group) => {
      const calls = sum(group.calls);
      return calls > 0 ? sum(group.durationMsSum) / calls : null;
    };
    const out = groups.map((group) => ({
      id: `${data.group}:${group.id}`,
      raw: group.id,
      label: group.label,
      color: palette.categorical(slots.get(group.id)),
      values: card.spec.figure(group),
      nulls: null,
      group: 0,
      average: average(group),
    }));
    if (rest.groups > 0) {
      out.push({ id: REST_ID, raw: REST_ID, rest: true, label: `${count(rest.groups)} more`, color: palette.categorical(-1), values: card.spec.figure(rest), nulls: null, group: 0, average: average(rest) });
    }
    return out;
  }

  function drawChart(card, data, empty) {
    const { spec } = card;
    const { times, step, groups, rest } = data.series;
    const group = data.group;
    const noun = GROUP_NOUN[group] || "group";
    card.group = group;
    card.chart?.destroy();
    card.chart = null;
    card.watch?.disconnect();
    card.watch = null;
    card.body.replaceChildren();
    card.title.textContent = `${spec.title} by ${noun}`;
    card.meta.textContent = step ? stepText(step) : "";
    // A window with no request: the Requests card has the sentence (and its way out), the others say what they count.
    if (empty && spec === CHARTS[0]) {
      uiState.empty(card.body, { ...empty, compact: true });
      return;
    }
    if (empty || ![...groups, rest].some(spec.any)) {
      uiState.empty(card.body, { title: spec.none, compact: true });
      return;
    }
    const stepMs = step * 1000;
    const on = (s) => !s.rest && pressed(group, s.raw);
    card.chart = chartCore.create(card.body, {
      xKind: "time",
      type: spec.type,
      stack: spec.stack,
      height: CHART_HEIGHT,
      xs: Float64Array.from(times, (t) => t + stepMs / 2),
      xDomain: [times[0], times[times.length - 1] + stepMs],
      bucketMs: stepMs,
      bucketAlign: "center",
      // The tooltip and the badge of the axis name the bucket: its range, or for a day its UTC date (not the local hours that it starts at).
      xReadout: (i) => (stepMs >= DAY_MS ? `${day(times[i])} (UTC)` : format.range(times[i], times[i] + stepMs, { precision: "min" })),
      // A bar of a day is labelled by its date ("Oct 9", one line), not by the hours that a wide screen has room for between the days.
      xDateOnly: stepMs >= DAY_MS,
      series: seriesOf(card, data),
      xFractionDigits: 0,
      // The engine's totals legend is the filter of the dimension that the charts are grouped by.
      legend: "totals",
      legendTotal: spec.total,
      legendPressed: on,
      legendTitle: (s, isOn) => {
        if (s.rest) return `${s.label} ${noun}s that the chart folds together: pick them in the table`;
        if (!offered(group)) return `Only one ${noun} in this view`;
        return `${isOn ? "Stop filtering by" : "Filter by"} ${noun} ${s.label}`;
      },
      onLegendClick: (s) => {
        if (s.rest || !offered(group)) return;
        focus = { chart: spec.id, series: s.id };
        onToggle(group, s.raw);
      },
      barWidthRatio: times.length > 14 ? 0.86 : 0.6,
      cursorPoints: spec.type === "line",
      tooltipSort: "desc",
      tooltipNulls: false,
      yInclude: [0],
      yUnit: spec.unit,
      yAxis: spec.axis,
      formatValue: spec.value,
      formatY: (value) => spec.value(Math.max(0, value)),
      syncKey: SYNC_KEY,
      // A drag over one chart zooms them all: they have the same axis.
      onZoom: (range, fromUser) => {
        if (!fromUser) return;
        for (const other of cards) if (other !== card) (range ? other.chart?.setZoom(range[0], range[1]) : other.chart?.resetZoom());
      },
    });
    card.chart.root.setAttribute("role", "group");
    card.chart.root.setAttribute("aria-label", `${spec.title} by ${noun} over time`);
    // A legend is drawn again when its groups or its pressed entries change: what is no filter is locked each time.
    const legend = $(".chartCore__legend", card.chart.root);
    if (legend && typeof MutationObserver === "function") {
      card.watch = new MutationObserver(() => lockEntries(card));
      card.watch.observe(legend, { childList: true });
    }
    lockEntries(card);
  }

  return {
    draw(data, empty = null) {
      if (!built) {
        h.replace(box, cards.map((card) => card.el));
        built = true;
      }
      const back = focus;
      focus = null;
      for (const card of cards) drawChart(card, data, empty);
      // The chart is drawn again for the new figures: the keyboard stays on the entry of the legend that it pressed.
      if (back) {
        const card = cards.find((item) => item.spec.id === back.chart);
        $(`.chartCore__legendItem[data-series="${CSS.escape(back.series)}"]`, card?.chart?.root)?.focus({ preventScroll: true });
      }
    },
    redraw() {
      for (const card of cards) card.chart?.redraw();
    },
    destroy,
  };
}

export const mcpCharts = Object.freeze({ create });
