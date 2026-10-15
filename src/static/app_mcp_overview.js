// The Usage tab of the MCP pages (mcpusage.html, /mcp-integration/usage, docs/mcp-integration-page.md, "The Usage tab"): what every key did.
// A window (24 h to 90 d), the tiles of the whole, a chart of the requests over time that one dimension stacks, and a table for each of the
// four dimensions (key, method, result, and the clients). A filter is a value of a dimension: a chip, an entry of the chart legend or a row of a
// table adds or removes it, and every figure of the page follows (the values of one dimension match any of them, the dimensions all of them).
// The whole state is in the address (?window=&split=&key=&method=&result=&type=, one parameter for each value): a link says what it shows, and
// Back and Forward walk through the filters. Nothing runs on a timer: the usage is read when the page opens, on a change and with Refresh.
//
//   ns.mcpOverview.show(root, { meta })   draws the tab in `root` the first time, then reads the usage (again when it is shown again)
//   ns.mcpOverview.hide()                 hides the tab and stops its reads
//
// The server (app_api.js, getMcpUsageOverview) cuts the usage. The tiles and the chart have every filter. The table of a dimension has every
// filter but its own, so a filtered table still lists what else could be picked, and a value that is picked is always there (at 0 when it has
// nothing). The clients have the key filter only, and no window. The chart is the shared engine (app_chart_core.js): the legend is the filter of
// the dimension that the chart splits by, a group that the chart folds into "N more" cannot be picked there but in its table.

import { api } from "./app_api.js";
import { chartCore } from "./app_chart_core.js";
import { dom, h } from "./app_dom.js";
import { format } from "./app_format.js";
import { palette } from "./app_palette.js";
import { router } from "./app_router.js";
import { badge } from "./app_ui_badge.js";
import { icon } from "./app_ui_icon.js";
import { segmented } from "./app_ui_segmented.js";
import { stat } from "./app_ui_stat.js";
import { table as tableMod } from "./app_ui_table.js";
import { uiState } from "./app_ui_state.js";
import { util } from "./app_util.js";

const EMPTY = format.EMPTY;
const SLOT = "mcp.overview";
const PATH = "/mcp-integration/usage";
const DIMENSIONS = ["key", "method", "result", "type"];
const DEFAULT_SPLIT = "method";
// The server takes 20 values of a kind at most (a 400 `too_many` above).
const MAX_VALUES = 20;
// What the server accepts for a value of each dimension (a 400 `invalid` for the others): the id of a key (the name of a key of the
// configuration, which never starts with "ui_", or "ui_" and 12 hexadecimal digits), the name of a tool or of a method of the protocol, a
// result code, a type.
const VALID = {
  key: /^(?:ui_[0-9a-f]{12}|(?!ui_)[a-z0-9][a-z0-9_-]{0,31})$/,
  method: /^[A-Za-z0-9_/]{1,64}$/,
  result: /^[a-z0-9_]{1,64}$/,
  type: /^(?:call|request|limited|rejected)$/,
};
const SPLITS = [{ value: "key", label: "Keys" }, { value: "method", label: "Methods" }, { value: "result", label: "Results" }, { value: "type", label: "Type" }];
const DIMENSION_LABEL = { key: "Key", method: "Method", result: "Result", type: "Type" };
// The four kinds of request (the `type` of the server): what each one is, for the chip, the legend and the tooltip.
const TYPE_LABEL = { call: "Tool calls", request: "Protocol", limited: "Rate limited", rejected: "Rejected" };
const TYPE_TITLE = {
  call: "A call of a tool (tools/call)",
  request: "A request of the MCP protocol: initialize, tools/list, ping, a notification...",
  limited: "Refused by the rate limit (429)",
  rejected: "Refused before its message was read: 400, 413 or 415",
};
// The methods that are not the name of a tool: what they count (the title of the cell).
const METHOD_NOTE = {
  unread: "Refused before the message was read: the rate limit (429), a body that was too large (413), a content type that is not JSON (415) or a request that was not valid (400)",
  invalid: "A message whose method could not be read: not JSON, a batch, no jsonrpc member, or a method that is not a string",
  other: "A method that is not in the vocabulary of ClickHouse Dash (a method that a client made up is counted here, never by its name)",
  response: "The answer of a client to a request of the server",
  initialize: "The start of a session: the client says who it is",
  "tools/list": "The client asks for the tools that its key may call",
  "tools/call": "A tool call that failed before the tool ran (an unknown tool, a missing argument)",
  ping: "A client checks that the server answers",
};
const WINDOW_LABEL = { "24h": "24 h", "7d": "7 d", "30d": "30 d", "90d": "90 d", "365d": "365 d" };
const WINDOW_TEXT = { "24h": "the last 24 hours", "7d": "the last 7 days", "30d": "the last 30 days", "90d": "the last 90 days", "365d": "the last 365 days" };
const STEP_MS = { hour: 3600000, day: 86400000 };
const CHART_HEIGHT = 220;
// The id of the series that holds the groups the chart folds together: no group can have it (an id has no "~").
const REST_ID = "~rest";
// palette.categorical(i) has these slots (--qchart-1..18).
const COLOURS = 18;

const count = (n) => format.count(n);
// The server counts whole milliseconds: a time of 0 is under a millisecond.
const ms = (value) => (value == null ? EMPTY : value === 0 ? "<1 ms" : format.duration.fromMs(value));
// A count of a tile: all its digits up to a million ("1,013", not "1K": a total is read exactly), then compact.
const figure = (n) => (n < 1e6 ? count(n) : format.compact(n));
const minute = (t) => format.time(t, { precision: "min" });
const day = (t) => format.iso(t).slice(0, 10);

const model = {
  meta: null,
  window: "",
  split: DEFAULT_SPLIT,
  filters: { key: [], method: [], result: [], type: [] },
  data: null,
  error: null,
  loading: false,
  announced: false,
  // The sort of each table: it stays for the visit of the page and is not in the address.
  sort: { keys: { key: "requests", dir: "desc" }, methods: { key: "requests", dir: "desc" }, results: { key: "count", dir: "desc" }, clients: { key: "last", dir: "desc" } },
};
// The nodes that the view fills (built once by build()).
const els = { blocks: {} };
let chart = null;
let legendWatch = null;
// The id of the legend entry that was pressed: the chart that the answer draws takes the focus back to it.
let legendFocus = "";
// The chips on screen (their values and names), to draw them again only when they change.
let chipsDrawn = "";
let mounted = false;

// The address of the tab (ns.router): its parameters are the state of the page, written by the changes and read on load and by Back and Forward.
const address = router.owner("mcpusage", { view: null, path: PATH, params: () => urlParams() });

// --- The address ---------------------------------------------------------------------------

const windows = () => (model.meta?.usage?.windows?.length ? model.meta.usage.windows : ["24h"]);
const defaultWindow = () => (windows().includes(model.meta?.usage?.defaultWindow) ? model.meta.usage.defaultWindow : windows()[0]);

// The address into the model. Returns true when a value had to be fixed: a window that the retention does not keep, a split that is not
// one, a value that is malformed or repeated, or more than 20 values of a kind (the caller replaces the address with the fixed one).
function readUrl() {
  const params = router.current().params;
  let fixed = false;
  const asked = params.get("window");
  model.window = windows().includes(asked) ? asked : defaultWindow();
  if (params.has("window") && model.window !== asked) fixed = true;
  const split = params.get("split");
  model.split = DIMENSIONS.includes(split) ? split : DEFAULT_SPLIT;
  if (params.has("split") && model.split !== split) fixed = true;
  for (const dimension of DIMENSIONS) {
    const sent = params.getAll(dimension);
    const values = [...new Set(sent.filter((value) => VALID[dimension].test(value)))].slice(0, MAX_VALUES);
    if (values.length !== sent.length) fixed = true;
    model.filters[dimension] = values;
  }
  return fixed;
}

// The model as parameters: what a default is stays out (the window of the server, the split by method).
function urlParams() {
  const params = new URLSearchParams();
  if (model.window && model.window !== defaultWindow()) params.set("window", model.window);
  if (model.split !== DEFAULT_SPLIT) params.set("split", model.split);
  for (const dimension of DIMENSIONS) for (const value of model.filters[dimension]) params.append(dimension, value);
  return params;
}

// A change of the window, of the split or of a filter: an entry of the history, then the new figures.
function changed() {
  address.push();
  void load();
}

// Back and Forward (and a link to the tab from itself): the address is the state.
function onLocation() {
  if (!mounted || els.root.hidden) return;
  if (readUrl()) address.replace();
  void load();
}

function toggleFilter(dimension, value) {
  const list = model.filters[dimension];
  if (!list.includes(value) && list.length >= MAX_VALUES) {
    uiState.announce(`A filter takes ${MAX_VALUES} values at most.`);
    return;
  }
  model.filters[dimension] = list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
  changed();
}

function clearFilters() {
  for (const dimension of DIMENSIONS) model.filters[dimension] = [];
  changed();
}

const filterCount = () => DIMENSIONS.reduce((sum, dimension) => sum + model.filters[dimension].length, 0);

// --- Reading -------------------------------------------------------------------------------

// The usage for the window, the split and the filters. A newer read cancels the one in flight (util.latest); the figures that are on screen
// stay (dimmed) until the answer comes. No timer: only a change of the page, or Refresh, reads.
async function load() {
  const req = util.latest(SLOT);
  model.loading = true;
  model.error = null;
  render();
  try {
    const data = await api.getMcpUsageOverview({ window: model.window, split: model.split, filters: model.filters, signal: req.signal });
    if (!req.isCurrent()) return;
    model.data = data;
  } catch (error) {
    if (!req.isCurrent() || util.isAbort(error)) return;
    model.data = null;
    model.error = error;
  } finally {
    if (req.isCurrent()) model.loading = false;
  }
  if (!req.isCurrent()) return;
  render();
  if (model.data && model.announced) {
    const found = format.countLabel(model.data.totals.requests, "request");
    uiState.announce(`${found} in ${WINDOW_TEXT[model.data.window] || "this window"}${filterCount() ? " with these filters" : ""}.`);
  }
  if (model.data) model.announced = true;
}

// --- Page ----------------------------------------------------------------------------------

function show(root, { meta }) {
  model.meta = meta;
  if (!mounted) {
    mounted = true;
    build(root);
    if (readUrl()) address.replace();
    router.on(PATH, onLocation);
  } else if (!windows().includes(model.window)) {
    model.window = defaultWindow();
    address.replace();
  }
  els.root.hidden = false;
  segmented.render(els.windows, windows().map((value) => ({ value, label: WINDOW_LABEL[value] || value })), { attr: "window", value: model.window, size: "compact", label: "Window" });
  void load();
}

function hide() {
  util.latest.cancel(SLOT);
  if (!mounted) return;
  destroyChart();
  // Shown again, the tab reads again and says so: it does not show what it read before.
  model.data = null;
  model.error = null;
  model.loading = false;
  els.root.hidden = true;
}

// The head (title, dates, window, Refresh), the filter chips, then the body: the tiles, the chart, the four tables and the notes.
function build(root) {
  els.root = root;
  els.range = h("span", { class: "mcpMuted mcpOverview__range" });
  els.windows = h("div", { class: "mcpOverview__windows" });
  els.refresh = h("button", { type: "button", class: "refreshButton", id: "mcpRefresh", title: "Refresh", "aria-label": "Refresh" },
    icon.el("refresh", { size: "sm", className: "refreshGlyph" }));
  els.refresh.addEventListener("click", async () => {
    await load();
    // The button is off while the read runs, and that takes the focus from it: the keyboard comes back to it.
    if (document.activeElement === document.body) els.refresh.focus();
  });
  segmented.bind(els.windows, { attr: "window", onChange: (value) => { model.window = value; changed(); } });
  // The chips are a list; "Clear filters" is a button, so it stands beside the list and not in it.
  els.chips = h("div", { class: "chips mcpOverview__chips", role: "list", "aria-label": "Active filters" });
  els.clear = h.html(badge.clearHtml("Clear filters", { "data-chip-clear": true })).firstElementChild;
  els.clear.hidden = true;
  els.filters = h("div", { class: "mcpOverview__filters", hidden: true }, els.chips, els.clear);
  els.filters.addEventListener("click", onChipClick);

  els.state = h("div", { class: "mcpOverview__state" });
  els.tiles = h("div", { class: "statTiles statTiles--boxed mcpOverview__tiles", role: "group", "aria-label": "Totals" });
  els.chartTitle = h("strong", { class: "chartCard__title" });
  els.chartMeta = h("span", { class: "chartCard__meta" });
  els.splits = h("div", { class: "mcpOverview__split" });
  segmented.render(els.splits, SPLITS, { attr: "split", value: model.split, size: "compact", label: "Split the chart by" });
  segmented.bind(els.splits, { attr: "split", onChange: (value) => { model.split = value; changed(); } });
  els.chartBox = h("div", { class: "chartCard__body mcpOverview__chart" });
  const card = h("section", { class: "chartCard mcpOverview__card", "aria-label": "Requests over time" },
    h("header", { class: "chartCard__head" }, els.chartTitle, els.chartMeta, h("div", { class: "chartCard__actions" }, els.splits)), els.chartBox);

  // Two columns on a wide window: the keys over the methods (the wide tables), the results over the clients.
  els.tables = h("div", { class: "mcpOverview__tables" },
    h("div", { class: "mcpOverview__col" }, blockOf("keys"), blockOf("methods")),
    h("div", { class: "mcpOverview__col" }, blockOf("results"), blockOf("clients")));
  els.tables.addEventListener("click", onRowClick);
  els.notes = h("div", { class: "mcpOverview__notes" });
  els.content = h("div", { class: "mcpOverview__content" }, els.tiles, card, els.tables, els.notes);
  els.body = h("div", { class: "mcpOverview__body" }, els.state, els.content);

  root.replaceChildren(h("section", { class: "pagePart mcpOverview__part", "aria-labelledby": "mcpOverviewTitle" },
    h("div", { class: "pagePart__head mcpOverview__head" },
      h("h2", { class: "pagePart__title", id: "mcpOverviewTitle" }, "Usage of all keys"), els.range, els.windows, els.refresh),
    els.filters, els.body));
}

// What is on screen: the controls always; then the loading or the error, or the figures. A read in flight dims the figures that are there.
function render() {
  syncControls();
  uiState.busy(els.refresh, model.loading);
  uiState.busy(els.body, model.loading && !!model.data);
  if (model.error) {
    uiState.error(els.state, { title: "The usage cannot be read", body: util.errorText(model.error), retry: { label: "Try again", onClick: () => void load() } });
    showState(true);
  } else if (!model.data) {
    uiState.loading(els.state, { label: "Reading the usage of the keys\u2026" });
    showState(true);
  } else if (!model.loading) {
    showState(false);
    renderTiles(model.data);
    renderChart(model.data);
    for (const id of Object.keys(TABLES)) renderTable(id);
    renderNotes(model.data);
  } else {
    // A read is running: the figures stay, and the legend already shows what the click picked (the entries that it leaves out dim).
    chart?.redraw();
  }
}

function showState(on) {
  els.state.hidden = !on;
  els.content.hidden = on;
  if (on) destroyChart();
}

function syncControls() {
  segmented.set(els.windows, model.window, "window");
  segmented.set(els.splits, model.split, "split");
  const data = model.data;
  const from = data && data.since != null && data.from != null ? Math.max(data.from, data.since) : data?.from;
  els.range.textContent = data && from != null && data.to != null ? format.range(from, data.to) : "";
  renderChips();
}

// --- Filters -------------------------------------------------------------------------------

function valueLabel(dimension, value) {
  if (dimension === "type") return TYPE_LABEL[value] || value;
  if (dimension === "key") return model.data?.keys.find((key) => key.id === value)?.name || value;
  return value;
}

// One chip for each value, and "Clear filters" from the second (the shared chips, ns.badge). The chips are drawn again only when they
// change: the keyboard is on one of them while the answer comes.
function renderChips() {
  const chips = [];
  for (const dimension of DIMENSIONS) for (const value of model.filters[dimension]) chips.push({ dimension, value, text: valueLabel(dimension, value) });
  els.filters.hidden = !chips.length;
  els.clear.hidden = chips.length < 2;
  const drawn = JSON.stringify(chips);
  if (drawn === chipsDrawn) return;
  chipsDrawn = drawn;
  h.replace(els.chips, chips.map(({ dimension, value, text }) => h.html(badge.chipHtml({
    key: DIMENSION_LABEL[dimension],
    op: "=",
    value: text,
    className: "mcpOverview__chip",
    title: dimension === "type" ? `${text}: ${TYPE_TITLE[value]}` : `${DIMENSION_LABEL[dimension]} = ${text}`,
    remove: { label: `Remove filter ${DIMENSION_LABEL[dimension]} = ${text}`, attrs: { "data-chip-dimension": dimension, "data-chip-value": value } },
  }))));
}

// The control that a click leaves: a chip that went, or the button of the empty state that cleared the filters. The keyboard goes on from the
// chip that took its place (the last one at the end), else from the window.
function focusFilters(index = 0) {
  const buttons = dom.$$(".chip__remove", els.chips);
  (buttons[Math.min(index, buttons.length - 1)] || dom.$('[aria-pressed="true"]', els.windows))?.focus();
}

function onChipClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest("[data-chip-clear]")) {
    clearFilters();
    focusFilters();
    return;
  }
  const remove = target?.closest("[data-chip-dimension]");
  if (!remove) return;
  const index = dom.$$(".chip__remove", els.chips).indexOf(remove);
  toggleFilter(remove.dataset.chipDimension, remove.dataset.chipValue);
  focusFilters(index);
}

// A click on a row of a table (or Enter on it) picks its value as a filter, or lets it go.
function onRowClick(event) {
  const row = event.target instanceof Element ? event.target.closest("tr[data-dimension]") : null;
  if (row && !event.target.closest("a, button")) toggleFilter(row.dataset.dimension, row.dataset.value);
}

// --- Tiles ---------------------------------------------------------------------------------

// The Active keys tile: its value and "of N keys" count keys of one kind, the keys that exist now. A deleted key keeps its usage, so one that
// had a request in this view is counted apart ("1 deleted"): it is in neither figure, and "7 of 7 keys" is seven keys that exist. The server
// counts the deleted keys with the others (totals.activeKeys), so the page counts from the rows of the keys table, which have every filter but
// the one of the keys (applied here). When the server cut that table the rows cannot be counted: the tile says the total of the server and
// what it counts, instead of a ratio that it cannot know.
function activeKeys(data) {
  const { totals } = data;
  if (data.omitted.keys > 0) {
    return {
      value: count(totals.activeKeys),
      sub: "keys with requests",
      title: "The keys, the deleted ones too, with a request that has every filter of the page. There are too many keys to tell the deleted ones apart.",
    };
  }
  const picked = new Set(data.filters.key);
  let live = 0;
  let deleted = 0;
  for (const row of data.keys) {
    if (row.requests <= 0 || (picked.size && !picked.has(row.id))) continue;
    if (row.deletedAt == null) live += 1;
    else deleted += 1;
  }
  return {
    value: count(live),
    sub: `of ${format.countLabel(totals.keys, "key")}${deleted ? ` \u00b7 ${count(deleted)} deleted` : ""}`,
    title: "The keys that exist and have a request that every filter of the page keeps, out of the keys that exist. A deleted key keeps its usage: one that had such a request is counted apart (\"1 deleted\"), not in the two figures.",
  };
}

function renderTiles(data) {
  const t = data.totals;
  const refused = t.rateLimited + t.rejected;
  // The requests that were read: the share of the errors is theirs (a refusal is no error of the tool or of the protocol).
  const read = t.requests - refused;
  const errorShare = read > 0 ? t.errors / read : 0;
  // A sub line is one line in a tile that is 9 rem wide at least (122 px for the text, when seven tiles share the line): the longest that come
  // ("12.3% of read requests", "12,345 by the rate limit") fit in it, and what the short form leaves out is in the title.
  h.replace(els.tiles,
    stat.tile({ label: "Requests", value: figure(t.requests), sub: WINDOW_TEXT[data.window] ? `in ${WINDOW_TEXT[data.window]}` : "",
      title: `${count(t.requests)} requests: the tool calls, the requests of the protocol (initialize, tools/list, ping...) and the refused ones` }),
    stat.tile({ label: "Tool calls", value: figure(t.calls), sub: t.requests ? `${format.percent(t.calls / t.requests)} of the requests` : "",
      title: `${count(t.calls)} calls of a tool` }),
    stat.tile({ label: "Errors", value: figure(t.errors), sub: read > 0 ? `${format.percent(errorShare)} of read requests` : "",
      tone: t.errors ? (errorShare >= 0.05 ? "error" : "warn") : "",
      title: `Tool calls that ended with an error code, and requests of the protocol that failed (a JSON-RPC error).${read > 0 ? ` ${format.percent(errorShare)} of the requests that were read: a request that was refused before its message was read is left out.` : ""}` }),
    stat.tile({ label: "Refused", value: figure(refused), sub: `${count(t.rateLimited)} by the rate limit`, tone: t.rateLimited ? "warn" : "",
      title: "429: more requests than mcp.rate_limit_per_minute. 400, 413 and 415: refused before the message was read." }),
    stat.tile({ label: "Call time", value: ms(t.durationMsAvg), sub: t.durationMsMax == null ? "" : `max ${ms(t.durationMsMax)}`,
      title: "The average and the longest time of a tool call, as ClickHouse Dash measured it" }),
    stat.tile({ label: "Returned", value: format.bytes(t.bytes), sub: t.rows ? format.countLabel(t.rows, "row") : "",
      title: "The bytes of the answers, and the rows of the tools that build their own SQL (an API tool counts no row)" }),
    stat.tile({ label: "Active keys", ...activeKeys(data) }));
}

// --- Chart ---------------------------------------------------------------------------------

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

// A group is a series; a zero is no value (the tooltip lists the groups that have something). The folded groups are the last series, "N more".
function seriesOf(data) {
  const { groups, rest } = data.series;
  const slots = slotsOf(groups.map((group) => group.id));
  const bars = (values) => Float64Array.from(values, (value) => (value > 0 ? value : NaN));
  const out = groups.map((group) => ({
    id: `${data.split}:${group.id}`,
    raw: group.id,
    label: data.split === "type" ? TYPE_LABEL[group.id] || group.label : group.label,
    color: palette.categorical(slots.get(group.id)),
    values: bars(group.values),
    nulls: null,
    group: 0,
  }));
  if (rest.groups > 0) {
    out.push({ id: REST_ID, raw: REST_ID, rest: true, label: `${count(rest.groups)} more`, color: palette.categorical(-1), values: bars(rest.values), nulls: null, group: 0 });
  }
  return out;
}

function destroyChart() {
  legendWatch?.disconnect();
  legendWatch = null;
  chart?.destroy();
  chart = null;
}

// "N more" holds the groups that the chart folds: it is not a filter, so it cannot be pressed (the tables pick any value).
function lockRest() {
  for (const item of dom.$$(`.chartCore__legendItem[data-series="${REST_ID}"]`, chart?.root)) {
    item.disabled = true;
    item.removeAttribute("aria-pressed");
  }
}

function renderChart(data) {
  destroyChart();
  els.chartBox.replaceChildren();
  const focusId = legendFocus;
  legendFocus = "";
  const noun = (DIMENSION_LABEL[data.split] || "Group").toLowerCase();
  const { times, step } = data.series;
  els.chartTitle.textContent = `Requests by ${noun}`;
  els.chartMeta.textContent = step === "hour" ? "by the hour" : "by the UTC day";
  if (!data.totals.requests || !times.length) {
    const span = WINDOW_TEXT[data.window] || "this window";
    if (filterCount()) {
      uiState.empty(els.chartBox, { title: "No request has all these filters", body: `Nothing in ${span} matches them.`, compact: true,
        action: { label: "Clear filters", onClick: () => { clearFilters(); focusFilters(); } } });
    } else {
      uiState.empty(els.chartBox, { title: `No request in ${span}`, body: "Nothing was counted in this window.", compact: true });
    }
    return;
  }
  const bucket = STEP_MS[step];
  const series = seriesOf(data);
  const split = data.split;
  const pressed = (s) => !s.rest && model.filters[split].includes(s.raw);
  chart = chartCore.create(els.chartBox, {
    xKind: "time",
    type: "bar",
    stack: true,
    height: CHART_HEIGHT,
    xs: Float64Array.from(times, (t) => t + bucket / 2),
    xDomain: [times[0], times[times.length - 1] + bucket],
    bucketMs: bucket,
    bucketAlign: "center",
    // The days are UTC days: the tooltip and the badge of the axis name the date, not the local hours that it starts at.
    xReadout: (i) => (step === "day" ? `${day(times[i])} (UTC)` : format.range(times[i], times[i] + bucket)),
    // A bar of a day is labelled by its date ("Oct 9", one line), not by the hours that a wide screen has room for between the days (every
    // 6 h at 1920 px); the bars of an hour keep their hours, with the date under the first.
    xDateOnly: step === "day",
    series,
    xFractionDigits: 0,
    // The engine's totals legend is the filter of the dimension that the chart splits by.
    legend: "totals",
    legendTotal: (s, sum) => format.compact(sum),
    legendPressed: pressed,
    legendTitle: (s, on) => (s.rest ? `${s.label} ${noun}s that the chart folds together: pick them in the table` : `${on ? "Stop filtering by" : "Filter by"} ${noun} ${s.label}${TYPE_TITLE[s.raw] ? `\n${TYPE_TITLE[s.raw]}` : ""}`),
    onLegendClick: (s) => {
      if (s.rest) return;
      legendFocus = s.id;
      toggleFilter(split, s.raw);
    },
    barWidthRatio: times.length > 14 ? 0.86 : 0.6,
    cursorPoints: false,
    tooltipSort: "desc",
    tooltipNulls: false,
    formatValue: (value) => count(value),
    formatY: (value) => count(Math.max(0, value)),
  });
  chart.root.setAttribute("role", "group");
  chart.root.setAttribute("aria-label", `Requests by ${noun} over time`);
  // The chart is drawn again for the new figures: the keyboard stays on the entry of the legend that it pressed.
  if (focusId) dom.$(`.chartCore__legendItem[data-series="${CSS.escape(focusId)}"]`, chart.root)?.focus({ preventScroll: true });
  // A legend is drawn again when its groups or its pressed entries change: "N more" is locked each time.
  const legend = dom.$(".chartCore__legend", chart.root);
  if (legend && typeof MutationObserver === "function") {
    legendWatch = new MutationObserver(lockRest);
    legendWatch.observe(legend, { childList: true });
  }
  lockRest();
}

// --- Tables --------------------------------------------------------------------------------

// A value beside a bar of its share of `of` (the most called key, all the results).
function share(value, of) {
  const el = h("span", { class: "mcpOverview__share" });
  tableMod.shareBar(el, of ? (value / of) * 100 : 0, count(value));
  return el;
}

// Errors with their share of the requests that were read; the warning colour when there are some.
function errorsCell(errors, read) {
  if (!errors) return "0";
  return h("span", null, h("span", { class: "mcpWarn" }, count(errors)), read > 0 ? h("span", { class: "mcpMuted" }, ` ${format.percent(errors / read)}`) : null);
}

const refusals = (row) => row.rateLimited + row.rejected;

function keyCell(row) {
  const deleted = row.deletedAt != null;
  return h("span", { class: "mcpOverview__name", title: row.name === row.id ? row.name : `${row.name}\n${row.id}` },
    h("span", { class: "mcpKeyName" }, row.name),
    deleted ? badge.el("deleted", { tone: "warn", size: "sm", title: `Deleted ${minute(row.deletedAt)}: its usage stays until the retention ends` }) : null);
}

// A tool is code; a method of the protocol is muted, with a badge; the words that stand for a group of messages say what they are.
function methodCell(row) {
  const note = METHOD_NOTE[row.method] || "";
  return h("span", { class: "mcpOverview__name", title: note ? `${row.method}\n${note}` : row.method },
    row.kind === "call" ? h("code", { class: "mcpOverview__method" }, row.method) : h("span", { class: "mcpMuted mcpOverview__method" }, row.method),
    row.kind === "call" ? null : badge.el(row.kind === "refused" ? "refused" : "protocol", { tone: "neutral", size: "sm" }));
}

function clientCell(row) {
  if (!row.name) return h("code", { class: "mcpOverview__agent", title: row.userAgent || "No User-Agent" }, row.userAgent || EMPTY);
  return h("span", { class: "mcpOverview__name", title: row.userAgent }, h("strong", null, row.name), row.version ? h("span", { class: "mcpMuted" }, ` ${row.version}`) : null);
}

const when = (t, now) => (t == null ? EMPTY : h("span", { title: format.timeTitle(t) }, format.ago(t, { now, short: true })));

// The tables: what each lists, what a click on a row filters by, and its columns { key, label, title, text (a column of words: it sorts
// from A, the others from the largest), sort(row), cell(row) }. The first column is the row header.
const TABLES = {
  keys: {
    title: "By key",
    label: "Usage by key",
    dimension: "key",
    noun: "keys",
    none: "No key sent a request in this view.",
    rows: (data) => data.keys,
    omitted: (data) => data.omitted.keys,
    value: (row) => row.id,
    columns: (data) => {
      const most = Math.max(0, ...data.keys.map((row) => row.calls));
      return [
        { key: "name", label: "Key", text: true, title: "Sort by name", sort: (row) => row.name.toLowerCase(), cell: keyCell },
        { key: "requests", label: "Requests", title: "Requests of the key: tool calls, protocol and refused", sort: (row) => row.requests, cell: (row) => count(row.requests) },
        { key: "calls", label: "Calls", title: "Tool calls, with their share of the most called key", sort: (row) => row.calls, cell: (row) => share(row.calls, most) },
        { key: "errors", label: "Errors", title: "Errors, and their share of the requests that were read", sort: (row) => row.errors, cell: (row) => errorsCell(row.errors, row.requests - refusals(row)) },
        { key: "limited", label: "429", title: "Requests that the rate limit refused", sort: (row) => row.rateLimited, cell: (row) => (row.rateLimited ? h("span", { class: "mcpWarn" }, count(row.rateLimited)) : "0") },
        { key: "avg", label: "Avg time", title: "The average time of a tool call", sort: (row) => row.durationMsAvg, cell: (row) => h("span", { title: row.durationMsMax == null ? "" : `The longest call took ${ms(row.durationMsMax)}` }, ms(row.durationMsAvg)) },
        { key: "bytes", label: "Returned", title: "The bytes of the answers", sort: (row) => row.bytes, cell: (row) => format.bytes(row.bytes) },
        { key: "last", label: "Last used", title: "When the key was last used, in any window", sort: (row) => row.lastUsedAt, cell: (row) => when(row.lastUsedAt, data.to) },
      ];
    },
  },
  methods: {
    title: "By method",
    label: "Usage by method",
    dimension: "method",
    noun: "methods",
    none: "No method was called in this view.",
    rows: (data) => data.methods,
    omitted: (data) => data.omitted.methods,
    value: (row) => row.method,
    columns: () => [
      { key: "method", label: "Method", text: true, title: "Sort by name", sort: (row) => row.method.toLowerCase(), cell: methodCell },
      { key: "requests", label: "Requests", title: "Requests that used the method", sort: (row) => row.requests, cell: (row) => count(row.requests) },
      { key: "errors", label: "Errors", title: "Requests that ended with an error", sort: (row) => row.errors, cell: (row) => (row.errors ? h("span", { class: "mcpWarn" }, count(row.errors)) : "0") },
      { key: "avg", label: "Avg time", title: "The average time of a request", sort: (row) => row.durationMsAvg, cell: (row) => ms(row.durationMsAvg) },
      { key: "max", label: "Max", title: "The longest request", sort: (row) => row.durationMsMax, cell: (row) => ms(row.durationMsMax) },
      { key: "bytes", label: "Returned", title: "The bytes of the answers", sort: (row) => row.bytes, cell: (row) => format.bytes(row.bytes) },
      { key: "keys", label: "Keys", title: "Keys that used the method", sort: (row) => row.keys, cell: (row) => count(row.keys) },
    ],
  },
  results: {
    title: "By result",
    label: "Usage by result",
    dimension: "result",
    noun: "results",
    none: "No result in this view.",
    rows: (data) => data.results,
    omitted: (data) => data.omitted.results,
    value: (row) => row.result,
    columns: (data) => {
      const total = data.results.reduce((sum, row) => sum + row.count, 0);
      return [
        { key: "result", label: "Result", text: true, title: "Sort by name", sort: (row) => row.result, cell: (row) => h("code", { class: row.result === "ok" ? null : "mcpWarn" }, row.result) },
        { key: "count", label: "Count", title: "Requests that ended with the result, and their share of all", sort: (row) => row.count, cell: (row) => share(row.count, total) },
        { key: "keys", label: "Keys", title: "Keys that had the result", sort: (row) => row.keys, cell: (row) => count(row.keys) },
      ];
    },
  },
  clients: {
    title: "Clients",
    label: "Clients of the keys",
    dimension: "",
    noun: "clients",
    none: "No client was seen.",
    rows: (data) => data.clients,
    omitted: (data) => data.omitted.clients,
    value: () => "",
    columns: (data) => [
      { key: "name", label: "Client", text: true, title: "Sort by name", sort: (row) => (row.name || row.userAgent).toLowerCase(), cell: clientCell },
      { key: "keys", label: "Keys", title: "Keys that the client used", sort: (row) => row.keys, cell: (row) => count(row.keys) },
      { key: "requests", label: "Requests", title: "Requests of the client", sort: (row) => row.requests, cell: (row) => count(row.requests) },
      { key: "first", label: "First seen", title: "When the client was first seen", sort: (row) => row.firstSeenAt, cell: (row) => (row.firstSeenAt == null ? EMPTY : h("span", { title: format.timeTitle(row.firstSeenAt) }, minute(row.firstSeenAt))) },
      { key: "last", label: "Last seen", title: "When the client was last seen", sort: (row) => row.lastSeenAt, cell: (row) => when(row.lastSeenAt, data.to) },
    ],
  },
};

// A block of the tables: its title and count, the table (or a sentence) in its box, what the server left out.
function blockOf(id) {
  const spec = TABLES[id];
  const block = {
    count: h("span", { class: "pagePart__count" }),
    box: h("div", { class: "dataTableWrap mcpOverview__wrap" }),
    more: h("p", { class: "mcpNote mcpNote--fine", hidden: true }),
  };
  block.section = h("section", { class: "mcpOverview__block", "aria-labelledby": `mcpOverviewTitle-${id}` },
    h("div", { class: "pagePart__head mcpOverview__blockHead" },
      h("h3", { class: "mcpOverview__blockTitle", id: `mcpOverviewTitle-${id}` }, spec.title), block.count,
      spec.dimension ? h("span", { class: "mcpMuted mcpOverview__hint" }, "Click a row to filter") : null),
    block.box, block.more,
    spec.dimension ? null : h("p", { class: "mcpNote mcpNote--fine" },
      "A client is counted since it was first seen, as far as the retention keeps it: the window, and every filter but the key, do not apply to it."));
  tableMod.scrollCues(block.box);
  if (spec.dimension) {
    tableMod.rovingRows(block.box, { onOpen: (row) => toggleFilter(row.dataset.dimension, row.dataset.value), key: (row) => row.dataset.value });
  }
  els.blocks[id] = block;
  return block.section;
}

// The rows in the order of a column; what has no value is last, whichever way the column sorts.
function sorted(rows, column, dir) {
  const sign = dir === "asc" ? 1 : -1;
  return rows.map((row, index) => ({ row, index, value: column.sort(row) })).sort((a, b) => {
    if (a.value == null || b.value == null) return a.value == null && b.value == null ? a.index - b.index : a.value == null ? 1 : -1;
    return sign * (a.value < b.value ? -1 : a.value > b.value ? 1 : 0) || a.index - b.index;
  }).map((item) => item.row);
}

function setSort(id, column) {
  const sort = model.sort[id];
  model.sort[id] = sort.key === column.key ? { key: column.key, dir: sort.dir === "asc" ? "desc" : "asc" } : { key: column.key, dir: column.text ? "asc" : "desc" };
  renderTable(id);
  // The header was drawn again: the keyboard stays on the one that it sorted by.
  dom.$(`th[data-sort-key="${column.key}"] .dataTable__sort`, els.blocks[id].box)?.focus();
}

function renderTable(id) {
  const spec = TABLES[id];
  const block = els.blocks[id];
  const data = model.data;
  const rows = data ? spec.rows(data) : [];
  const omitted = data ? spec.omitted(data) : 0;
  block.count.textContent = rows.length ? count(rows.length) : "";
  block.more.hidden = !omitted;
  block.more.textContent = omitted ? `${count(omitted)} more ${spec.noun} not shown.` : "";
  if (!rows.length) {
    h.replace(block.box, h("p", { class: "mcpNote mcpOverview__none" }, spec.none));
    return;
  }
  const columns = spec.columns(data);
  const sort = model.sort[id];
  const by = columns.find((column) => column.key === sort.key) || columns[0];
  const head = columns.map((column) => {
    const th = h("th", { scope: "col", class: column.text ? null : "num" }, column.label);
    tableMod.sortHeader(th, { key: column.key, dir: column.key === by.key ? sort.dir : "", title: column.title, onSort: () => setSort(id, column) });
    return th;
  });
  const body = sorted(rows, by, sort.dir).map((row) => {
    const value = spec.value(row);
    const on = !!spec.dimension && model.filters[spec.dimension].includes(value);
    const cells = columns.map((column, index) => (index === 0 ? h("th", { scope: "row" }, column.cell(row)) : h("td", { class: column.text ? null : "num" }, column.cell(row))));
    if (!spec.dimension) return h("tr", { class: "mcpOverview__row" }, cells);
    return h("tr", { class: ["mcpOverview__row", "is-pickable", on && "is-selected"], tabindex: "-1", "aria-selected": on ? "true" : "false", dataset: { dimension: spec.dimension, value } }, cells);
  });
  h.replace(block.box, h("table", { class: "dataTable dataTable--compact mcpOverview__table", "aria-label": spec.label },
    h("thead", null, h("tr", null, head)), h("tbody", null, body)));
}

// --- Notes ---------------------------------------------------------------------------------

function renderNotes(data) {
  const notes = [];
  if (!data.persisted) notes.push(`Counted in memory${data.since != null ? ` since ${minute(data.since)}` : ""}, when ClickHouse Dash started: a restart clears it.`);
  else if (data.since != null && data.from != null && data.since > data.from) notes.push(`Counted since ${minute(data.since)}.`);
  notes.push("The rows are those of the tools that build their own SQL: an API tool counts no row.");
  h.replace(els.notes, notes.map((text) => h("p", { class: "mcpNote mcpNote--fine" }, text)));
}

export const mcpOverview = Object.freeze({ show, hide });
