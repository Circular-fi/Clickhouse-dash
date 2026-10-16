// The six charts of the Usage tab (app_mcp_overview.js, docs/mcp-integration-page.md, "The Usage tab"), in a grid of three columns (two under
// 1280 px, one under 761 px): the requests, the errors, the rate of the errors, the requests that were refused, the time of a tool call (its
// average) and the bytes returned, over the window. All of them are grouped by one dimension (the Group by of the bar: key, method, client or
// result) and cut by the same filters, so they have the same x axis (the steps of the window, 1 minute to 1 day) and, for a group, the same
// colour: it comes from a hash of its id, so a name has one colour in every chart, window and filter.
//
// Each chart draws the 8 groups that rank first for its own metric, and folds the others into "N more": the requests by their requests, the
// errors and the rate of the errors by their errors, the refusals by their refusals, the time of a call by the tool calls and the bytes by the
// bytes returned. The server ranks the groups once for each of them in the read of the tab (`series.rankings`, app_api.js: `order` and `orders`).
// When the dimension of the Group by is filtered the page asks for no ranking: the groups are the values that were picked, in their order, the
// same six in every chart (`series.groups`). A group has the same colour in the six charts, whichever of them it is in.
//
// Each chart has the legend of the engine (app_chart_core.js): the list of its groups, "Values" for a table of the total, min, max, mean and last of
// each (the mode is one preference for the six). A click on an entry, in the list or in the table, adds the group to the filter or takes it off.
// The groups that a chart folds into "N more" cannot be picked there (the lists of the bar have them), and neither can any group when the
// dimension has one value and no filter (there is nothing to filter by). The cursor and the zoom go from one chart to the others. The six charts
// are an alignment group of the engine: their y axes have the same number of intervals and end on a step (so their grid lines are at the same
// heights, and only the scale differs) and they have one gutter at the left of the plot (so their vertical grid lines are at the same x).
//
// The cards keep one height, whatever they hold (a filter never moves what is under them): the plot is CHART_HEIGHT, the legend has the room of
// three lines (four on a phone), or of a table when the legend is in its Values mode, and scrolls inside past it, and a card with nothing to draw
// says so in a box of the same size (mcp.css, .mcpOverview__card). Only the List / Values button changes the height, of the six together.
//
//   mcpCharts.create(box, { pressed(group, id), onToggle(group, id), offered(group), note(group, id) }) -> charts
//                           offered(group): whether a filter on the group dimension is offered (it has two values, or a filter is on)
//                           note(group, id): what a method, a client or a result is, for the title of its legend entry ("" for none)
//   charts.draw(data, empty)  the six charts for an answer (the cards are built the first time; the engines are made again each time): `data` is
//                           the read of the tab, grouped by the Group by. `empty` (null when the window has requests) is { title, body, action }:
//                           the sentence of the Requests card for a window with no request; the others say what they count, as for a figure
//                           that is 0
//   charts.redraw()         the legends again, for a filter that is picked while the next answer is read
//   charts.destroy()        stops the engines and empties the box

import { chartCore } from "./app_chart_core.js";
import { dom, h } from "./app_dom.js";
import { format } from "./app_format.js";
import { palette } from "./app_palette.js";
import { uiState } from "./app_ui_state.js";

const { $ } = dom;

const CHART_HEIGHT = 200;
const DAY_MS = 86400000;
// The id of the series that holds the groups the chart folds together: no group can have it (an id has no "~").
const REST_ID = "~rest";
// palette.categorical(i) has these slots (--qchart-1..18).
const COLOURS = 18;
// The charts of a page that move their cursor and their zoom together, and keep their grid lines on the same lines (the alignment group).
const GROUP_KEY = "mcp-usage";
const GROUP_NOUN = { key: "key", method: "method", client: "client", result: "result" };
// The lists of the bar that hold the groups (a legend sends the reader there for the groups it folds).
const GROUP_LIST = { key: "Key", method: "Method", client: "Client", result: "Result" };
// What each ranking counts, for the title of "N more": the chart keeps the groups that have the most of it.
const RANK_WORDS = { requests: "requests", errors: "errors", refused: "refused requests", calls: "tool calls", bytes: "bytes returned" };

const count = (n) => format.count(n);
// The server counts whole milliseconds: a time of 0 is under a millisecond.
const ms = (value) => (value == null ? format.EMPTY : value === 0 ? "<1 ms" : format.duration.fromMs(value));
const day = (t) => format.iso(t).slice(0, 10);
// A rate is a value in percent (0 to 100), to three significant digits: "12.3%", "1.23%", "<0.1%".
const percent = (value) => format.percent(value / 100);

// How long a step is, for the head of a chart: "by the minute", "by 5 minutes", "by 3 hours", "by the UTC day".
function stepText(seconds) {
  if (seconds >= 86400) return "by the UTC day";
  const [n, unit] = seconds >= 3600 ? [seconds / 3600, "hour"] : [seconds / 60, "minute"];
  return n === 1 ? `by the ${unit}` : `by ${n} ${unit}s`;
}

// A zero is no bar: the plot leaves it out, and so does the tooltip, which lists the groups that have something. The legend reads the whole
// series (`stats`), zeros included, so its minimum and its mean are those of the steps and not of the steps that had a request.
const bars = (values) => ({ values: Float64Array.from(values, (value) => (value > 0 ? value : NaN)), stats: Float64Array.from(values) });
// The average time of a call at each step (the time of the calls over their number), a gap where no call was made. The legend's mean weighs each
// step by its calls: the average of the group over the window is the time of its calls over their number, never the mean of the averages.
const averages = (group) => ({
  values: Float64Array.from(group.calls, (calls, i) => (calls > 0 ? group.durationMsSum[i] / calls : NaN)),
  weights: Float64Array.from(group.calls),
});
// The rate of the errors at each step: the errors over the requests, in percent, a gap where there was no request. The mean of the legend weighs
// each step by its requests, so the rate of a group over the window is its errors over its requests, never the mean of the rates.
const rates = (group) => ({
  values: Float64Array.from(group.requests, (requests, i) => (requests > 0 ? (group.errors[i] / requests) * 100 : NaN)),
  weights: Float64Array.from(group.requests),
});

// The six charts: what each draws, how it reads, and what it says when its figure is 0 over the window. `rank` is the metric that picks its
// groups (an `order` of the server). `figure(group)` is the series of a group ({ values, stats?, weights? }); `any(group)` whether a group (or
// the folded ones) has a value to draw. `kind` is the steps and the unit of the y axis (the engine's yKind), `integer` whole steps only,
// `columns` what the table of the legend has (a time and a rate do not add up: no total).

// A count: whole steps on the axis, and the mean of its steps has decimals, three significant digits ("13.5", "1.78", "0.0893").
const COUNTS = {
  type: "bar", stack: true, kind: "number", integer: true, value: count,
  cell: (value, column) => (column === "mean" ? format.number(Number(value.toPrecision(3))) : count(value)),
};
const CHARTS = [
  { id: "requests", rank: "requests", title: "Requests", ...COUNTS, figure: (group) => bars(group.requests), any: () => true },
  {
    id: "errors", rank: "errors", title: "Errors", ...COUNTS, figure: (group) => bars(group.errors),
    any: (group) => group.errors.some((value) => value > 0), none: "No errors in this window",
  },
  {
    id: "rate", rank: "errors", title: "Error rate", type: "line", stack: false, kind: "percent", value: percent, cell: percent, figure: rates,
    any: (group) => group.errors.some((value) => value > 0), none: "No errors in this window", columns: ["min", "max", "mean", "last"],
  },
  {
    id: "refused", rank: "refused", title: "Refused", ...COUNTS, figure: (group) => bars(group.refused),
    any: (group) => group.refused.some((value) => value > 0), none: "No refused request in this window",
  },
  {
    id: "time", rank: "calls", title: "Call time", type: "line", stack: false, kind: "duration", value: ms, figure: averages,
    any: (group) => group.calls.some((value) => value > 0), none: "No tool calls in this window", columns: ["min", "max", "mean", "last"],
  },
  {
    id: "bytes", rank: "bytes", title: "Returned", type: "bar", stack: true, kind: "bytes", value: (value) => format.bytes(value),
    figure: (group) => bars(group.bytes), any: (group) => group.bytes.some((value) => value > 0), none: "Nothing was returned in this window",
  },
];

// The groups that a chart draws and the ones it folds, ranked by its own metric: the ranking of the answer, or the answer's own groups when it
// has none for the metric (the requests, which are what the answer ranks by; and every chart when the Group by is filtered, whose groups are the
// values that were picked).
const rankedOf = (spec, series) => series.rankings?.[spec.rank] || series;

// The slot of a group: the one that the hash of its id gives (FNV-1a, as palette.service does for a name it has not met), so a group has the
// same colour on every visit, in every window and under every filter, whatever its rank. The slots are given to the groups of all the charts
// together, so that a group has the same colour in each of them; two groups never share a colour while there are no more than the colours
// (a group whose slot is taken takes the next free one: the order is the hash and the id, never the size).
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
  return { spec, el, title, meta, body, group: "", chart: null };
}

function create(box, { pressed, onToggle, offered, note = () => "" }) {
  const cards = CHARTS.map(cardOf);
  // The entry of a legend that was pressed: the chart that the answer draws takes the keyboard back to it.
  let focus = null;
  let built = false;

  // The six cards are as tall as the legend of their mode is (a list of three lines, or a table): the box says which (mcp.css, .is-values).
  const setMode = (mode) => box.classList.toggle("is-values", mode === "table");

  function destroy() {
    focus = null;
    for (const card of cards) {
      card.chart?.destroy();
      card.chart = null;
    }
    box.replaceChildren();
    built = false;
  }

  // The groups of a ranking as the series of a chart: a group is a series, the folded ones are the last one, "N more" (left out when none of
  // them has a value for the chart: the groups that have none of the metric are folded, and a legend entry of zeros says nothing).
  function seriesOf(card, { groups, rest }, slots) {
    const { spec } = card;
    const out = groups.map((group) => ({
      id: `${card.group}:${group.id}`,
      raw: group.id,
      label: group.label,
      color: palette.categorical(slots.get(group.id)),
      nulls: null,
      group: 0,
      ...spec.figure(group),
    }));
    if (rest.groups > 0 && spec.any(rest)) {
      out.push({
        id: REST_ID, raw: REST_ID, rest: true, label: `${count(rest.groups)} more`, color: palette.categorical(-1), nulls: null, group: 0,
        ...spec.figure(rest),
      });
    }
    return out;
  }

  function drawChart(card, data, slots, empty) {
    const { spec } = card;
    const { group } = data;
    const { times, step } = data.series;
    const ranked = rankedOf(spec, data.series);
    const noun = GROUP_NOUN[group] || "group";
    card.group = group;
    card.chart?.destroy();
    card.chart = null;
    card.body.replaceChildren();
    card.title.textContent = `${spec.title} by ${noun}`;
    card.meta.textContent = step ? stepText(step) : "";
    // A window with no request: the Requests card has the sentence (and its way out), the others say what they count.
    if (empty && spec === CHARTS[0]) {
      uiState.empty(card.body, { ...empty, compact: true });
      return;
    }
    if (empty || ![...ranked.groups, ranked.rest].some(spec.any)) {
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
      series: seriesOf(card, ranked, slots),
      xFractionDigits: 0,
      // The legend of the engine, whose click is the filter of the dimension that the chart is grouped by.
      legend: "always",
      legendClick: "filter",
      legendColumns: spec.columns,
      legendPressed: on,
      legendDisabled: (s) => !!s.rest || !offered(group),
      legendTitle: (s, isOn) => {
        if (s.rest) {
          return `${s.label} ${noun}s that the chart folds together: it keeps the 8 that have the most ${RANK_WORDS[spec.rank]}. `
            + `Pick them in the ${GROUP_LIST[group]} list of the bar`;
        }
        if (!offered(group)) return `Only one ${noun} in this view`;
        const about = note(group, s.raw);
        return `${isOn ? "Stop filtering by" : "Filter by"} ${noun} ${s.label}${about ? `\n${about}` : ""}`;
      },
      onLegendClick: (s) => {
        if (s.rest || !offered(group)) return;
        focus = { chart: spec.id, series: s.id };
        onToggle(group, s.raw);
      },
      onLegendMode: setMode,
      barWidthRatio: times.length > 14 ? 0.86 : 0.6,
      cursorPoints: spec.type === "line",
      tooltipSort: "desc",
      tooltipNulls: false,
      yInclude: [0],
      yKind: spec.kind,
      yInteger: spec.integer === true,
      formatValue: spec.value,
      legendFormat: spec.cell,
      formatY: (value) => spec.value(Math.max(0, value)),
      syncKey: GROUP_KEY,
      alignKey: GROUP_KEY,
      // A drag over one chart zooms them all: they have the same axis.
      onZoom: (range, fromUser) => {
        if (!fromUser) return;
        for (const other of cards) if (other !== card) (range ? other.chart?.setZoom(range[0], range[1]) : other.chart?.resetZoom());
      },
    });
    card.chart.root.setAttribute("role", "group");
    card.chart.root.setAttribute("aria-label", `${card.title.textContent} over time`);
  }

  return {
    draw(data, empty = null) {
      if (!built) {
        h.replace(box, cards.map((card) => card.el));
        built = true;
      }
      setMode(chartCore.legendMode());
      const back = focus;
      focus = null;
      // One slot for each group of any chart: the charts do not draw the same groups, and a group keeps its colour from one to the next.
      const slots = slotsOf(new Set(CHARTS.flatMap((spec) => rankedOf(spec, data.series).groups.map((group) => group.id))));
      for (const card of cards) drawChart(card, data, slots, empty);
      // The charts of the group wait for each other's gutter: they are drawn now, once all of them are made.
      for (const card of cards) card.chart?.flush();
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
