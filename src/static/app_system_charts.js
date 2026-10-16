// The cycle "a section with a time range and charts" (ARCH-F-195). The three System sections used to copy this cycle.
// It covers the range of the section, with its address and its zoom. It covers the grid of chart cards and the axes of bytes.
// A section gives what is its own: the defaults of its range, the series of each chart, and the load.
// Every page gets the rest in the same way.
//
//   const range = systemCharts.range({ ctx, root, idPrefix, defaultRange, maxMinutes, where, minZoomMs, onChange, onZoom });
//     range.value             the range { from, to } on screen. Assign it to change the range without a load.
//     range.picker            the time range picker (timeRange.create) in `root`. It is the place of the range in the filter bar.
//     range.query()           the address parameters of the section. It returns "" for the defaults. It returns the range's own from / to,
//                             or what the `query` option of the section says. The option applies when the section has more parameters than the range.
//     range.read(params)      takes the range of the address, or the default. It returns true when the range changed.
//     range.apply(raw, opts)  keeps a range that the user picked. It writes the range to the address (ctx.setQuery) and runs onChange.
//     range.zoom(window, fromUser)  a drag over a chart. The window is in whole seconds, at least minZoomMs wide. It works as apply().
//     range.check()           runs timeRange.checkRange on the range. It compares the range with the widest range that the server reads.
//
//   const grid = systemCharts.grid({ root, specs, idPrefix, syncKey, height, onZoom: range.zoom, empty, badge });
//     grid.entries            Map id -> { spec, card, plot, empty, badge, meta, chart }
//     grid.draw(entry, { xs, step, series, type, stack, yUnit, yAxis, formatValue, footer, ... })  creates or updates the chart
//     grid.setZoom(startMs, endMs)  every chart shows that window at once. grid.destroy() removes the charts.
//
// bytesAxis(fromZero) is the y axis of a chart of bytes. Its ticks are round numbers in the 1024 unit.
// column(values, length) makes a series as a Float64Array. The array has NaN where there is no sample.

import { chartCore } from "./app_chart_core.js";
import { h, dom } from "./app_dom.js";
import { format } from "./app_format.js";
import { kit } from "./app_system_kit.js";
import { timeRange } from "./app_timerange.js";
import { chartUi } from "./app_ui_chart.js";

const { $ } = dom;

// --- The range of a section --------------------------------------------------------------

function range({ ctx, root, idPrefix, defaultRange, maxMinutes, where, minZoomMs, onChange, onZoom = null, query: fullQuery = null }) {
  const state = { value: defaultRange() };
  const picker = timeRange.create(root, {
    idPrefix,
    getValue: () => state.value,
    getMaxMinutes: maxMinutes,
    settingName: where,
    onApply: (raw) => {
      picker.close();
      apply(raw);
    },
  });

  // The address parameters of the section. They are the range's own parameters. When the section has more parameters,
  // they are all of the section's parameters (`query` option).
  function query() {
    if (fullQuery) return fullQuery();
    if (timeRange.sameRange(state.value, defaultRange())) return "";
    return timeRange.url.write(new URLSearchParams(), state.value).toString();
  }

  // The range of an address is its from / to, or the default. It returns true when the range is not the range on screen.
  function read(params) {
    const next = timeRange.url.read(params) || defaultRange();
    const changed = !timeRange.sameRange(next, state.value);
    state.value = next;
    return changed;
  }

  function apply(raw, { history = "push" } = {}) {
    const next = { from: String(raw.from), to: String(raw.to) };
    if (timeRange.sameRange(next, state.value)) {
      onChange();
      return;
    }
    state.value = next;
    picker.refresh();
    ctx.setQuery(query(), { history });
    onChange();
  }

  // A drag over a chart. The window is in whole seconds. When it is narrower than minZoomMs, the window is widened around its centre.
  function zoom(windowMs, fromUser) {
    if (!fromUser || !windowMs) return;
    let startMs = Math.floor(windowMs[0] / 1000) * 1000;
    let endMs = Math.ceil(windowMs[1] / 1000) * 1000;
    if (endMs - startMs < minZoomMs) {
      const centre = (startMs + endMs) / 2;
      startMs = Math.floor((centre - minZoomMs / 2) / 1000) * 1000;
      endMs = startMs + minZoomMs;
    }
    onZoom?.(startMs, endMs);
    apply({ from: timeRange.formatDateTime(startMs), to: timeRange.formatDateTime(endMs) });
  }

  return {
    get value() { return state.value; },
    set value(next) { state.value = next; },
    picker,
    query,
    read,
    apply,
    zoom,
    check: () => timeRange.checkRange(state.value, maxMinutes(), where),
  };
}

// --- The grid of chart cards -------------------------------------------------------------

// specs: [{ id, title, help }]. idPrefix: the card of a spec has the id #<idPrefix>-<id>. cardClass(spec): the class of a card.
// empty: a block next to the plot. It says why a chart has no data. badge: a slot in the head of the card. hidden: the cards start hidden.
// The section shows each card that has data.
function grid({ root, specs, idPrefix, cardClass = () => "systemChart", syncKey, height, onZoom, empty = false, badge = false, hidden = true }) {
  const entries = new Map();
  for (const spec of specs) {
    const card = h.html(chartUi.cardHtml({
      title: spec.title,
      className: cardClass(spec),
      id: `${idPrefix}-${spec.id}`,
      bodyClass: "systemChart__body",
      attrs: { "data-chart": spec.id },
    })).firstElementChild;
    $(".chartCard__title", card).title = spec.help;
    const badgeEl = badge ? h("span", { class: "systemChart__badge" }) : null;
    if (badgeEl) $(".chartCard__head", card).appendChild(badgeEl);
    const plot = h("div", { class: "systemChart__plot" });
    const emptyEl = empty ? h("div", { class: "systemChart__empty", hidden: true }) : null;
    $(".chartCard__body", card).append(...[plot, emptyEl].filter(Boolean));
    card.hidden = hidden;
    root.appendChild(card);
    entries.set(spec.id, { spec, card, plot, empty: emptyEl, badge: badgeEl, meta: $(".chartCard__meta", card), chart: null });
  }

  // series: [{ id, label, color, values, nulls }]. yUnit(maxAbs) gives the unit of the axis. formatValue(v) gives the value as text.
  // footer(i) gives a line under the values of the tooltip. hiddenSeries: ids of the series that start hidden.
  function draw(entry, { xs, step = 0, series, type = "line", stack = false, yInclude = [0], yHeadroom = 0, yUnit, yAxis = null, formatValue, footer = null, markers = [], hiddenSeries = null }) {
    const options = {
      xs,
      xDomain: xs.length > 1 ? [xs[0], xs[xs.length - 1]] : undefined,
      series,
      type,
      stack: !!stack,
      // The legend is always shown. This keeps the cards of a row at one height.
      legend: "always",
      markers,
      yInclude,
      yHeadroom,
      yUnit,
      yAxis,
      formatValue,
      formatY: formatValue,
      bucketMs: step || undefined,
      tooltipFooter: (i) => [typeof footer === "function" ? footer(i) : "", step ? `${format.duration.fromMs(step)} bucket` : ""].filter(Boolean).join(kit.SEP),
    };
    if (!entry.chart) {
      entry.chart = chartCore.create(entry.plot, {
        ...options,
        ...(hiddenSeries ? { hidden: hiddenSeries } : {}),
        xKind: "time",
        height,
        xFractionDigits: 0,
        syncKey,
        legendClick: "toggle",
        tooltipNulls: false,
        onZoom,
      });
      entry.chart.root.setAttribute("role", "group");
      entry.chart.root.setAttribute("aria-label", `${entry.spec.title} chart`);
    } else {
      entry.chart.setData({ ...options, zoom: null });
    }
  }

  return {
    entries,
    draw,
    setZoom(startMs, endMs) {
      for (const entry of entries.values()) entry.chart?.setZoom(startMs, endMs);
    },
    destroy() {
      for (const entry of entries.values()) entry.chart?.destroy?.();
      entries.clear();
    },
  };
}

// --- Axes and series of bytes ------------------------------------------------------------

function byteUnit(max) {
  for (const [factor, suffix] of [[1024 ** 4, " TB"], [1024 ** 3, " GB"], [1024 ** 2, " MB"], [1024, " KB"]]) if (max >= factor) return { factor, suffix };
  return { factor: 1, suffix: " B" };
}

// The ticks are round numbers in the 1024 unit. When fromZero is true, the axis starts at 0.
// Otherwise the axis follows the data. So a slow growth of a large disk is still readable.
function bytesAxis(fromZero) {
  return (dataMin, dataMax, plotH) => {
    let lo;
    let hi;
    if (fromZero) {
      lo = Math.min(0, dataMin);
      hi = Math.max(dataMax * 1.06, lo + 1);
    } else {
      const pad = Math.max((dataMax - dataMin) * 0.12, Math.abs(dataMax) * 0.001, 1);
      lo = Math.max(0, dataMin - pad);
      hi = dataMax + pad;
    }
    const unit = byteUnit(Math.max(Math.abs(lo), Math.abs(hi)));
    const ticks = chartCore.linearTicks(lo / unit.factor, hi / unit.factor, Math.max(2, Math.floor(plotH / 34)));
    const decimals = chartCore.decimalsFor(ticks.step);
    return {
      min: lo,
      max: hi,
      step: ticks.step * unit.factor,
      ticks: ticks.values.map((v) => ({ v: v * unit.factor, label: v === 0 ? "0" : `${v.toFixed(decimals)}${unit.suffix}` })),
    };
  };
}

// A series as a Float64Array of `length` values. The array has NaN where there is no sample.
function column(values, length = values?.length || 0) {
  const out = new Float64Array(length);
  for (let i = 0; i < length; i++) {
    const v = values?.[i];
    out[i] = v == null ? NaN : Number(v);
  }
  return out;
}

export const systemCharts = Object.freeze({ range, grid, byteUnit, bytesAxis, column });
