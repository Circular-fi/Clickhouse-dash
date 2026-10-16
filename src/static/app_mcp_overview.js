// The Usage tab of the MCP pages (mcpusage.html, /mcp-integration/usage, docs/mcp-integration-page.md, "The Usage tab"): what every key did.
// A filter bar at the top (app_mcp_bar.js: Group by key, method, client or result, a picker for each of the five, the window, Refresh), the tiles
// of the whole, and six charts over time (app_mcp_charts.js): the requests, the errors, the rate of the errors, the requests that were refused,
// the time of a call and the bytes returned. The Group by groups all of them. A filter is a value of a dimension: a chip, a picker of the bar or
// an entry of a chart legend adds or removes it, and every figure of the page follows (the values of one dimension match any of them, the
// dimensions all of them). The instance is a dimension of the bar and the chips only: ChDash instances that share the usage directory add up
// (app_mcp_instances.js), and the filter cuts one of them out.
// The whole state is in the address (?window=&group=&key=&method=&client=&instance=&result=&type=, one parameter for each value): a link says
// what it shows, and Back and Forward walk through the filters. Nothing runs on a timer: the usage is read when the page opens, on a change
// and with Refresh (the pickers of the bar wait for the clicks to pause, once, before they read).
//
//   ns.mcpOverview.show(root, { meta, onOff })   draws the tab in `root` the first time, then reads the usage (again when it is shown again);
//                                         onOff() is called when the server says that the usage is off (404 not_enabled: the meta is older
//                                         than a restart): the caller hides the tab and says so
//   ns.mcpOverview.hide()                 hides the tab and stops its reads
//
// The server (app_api.js, getMcpUsageOverview) cuts the usage. The tiles and the charts have every filter. The list of a picker has every filter
// but its own, so a filtered list still shows what else could be picked, and a value that is picked is always there (at 0 when it has nothing).
// The legend of a chart is the filter of the dimension that the charts are grouped by; a group that a chart folds into "N more" cannot be picked
// there but in its list of the bar. One read of the server has all the charts need (a ranking of the groups for each metric, `orders`): each chart
// shows the 8 groups that rank first for its own metric. The groups of the six charts are the values that were picked when the Group by
// dimension is filtered, and then the read has no `orders`. A dimension that has fewer than two values in the answer, and no filter, is not
// offered at all (offered()): its list in the bar is off, and its legend entries cannot be picked. The bar and the chips sit under the row of
// the two pages, out of the panel that scrolls, as the filter bar of System does.
//
// Nothing moves when a filter is added or removed, or when the next answer comes: the chips are one line that is always there (a hint when
// there is no filter; the period stays at the right end of it), the cards of the charts keep one height (app_mcp_charts.js), and so do the
// tiles (mcp.css).
//
// The tab has no heading row: its h2 is for screen readers only (the titles of the charts are h3), and the period of the window
// ("Oct 9 02:00 to Oct 16 01:15") is muted at the right end of the chips row.
//
// The instances: the Instance list of the bar is where they are (app_mcp_bar.js: "Instance · All (2)" while two or more are summed and none is
// picked, and a row for each with when it wrote last and a badge when its file is not read). A file that is left out of the sum, or a name that
// two ChDash write under, is a warning above the tiles too. Both come from the answer's `instances`, which no filter but the instance's own
// changes, so they stay put while the filters do.

import { api } from "./app_api.js";
import { dom, h, shell } from "./app_dom.js";
import { format } from "./app_format.js";
import { mcpBar } from "./app_mcp_bar.js";
import { mcpCharts } from "./app_mcp_charts.js";
import { mcpInstances } from "./app_mcp_instances.js";
import { router } from "./app_router.js";
import { badge } from "./app_ui_badge.js";
import { stat } from "./app_ui_stat.js";
import { uiState } from "./app_ui_state.js";
import { util } from "./app_util.js";

const EMPTY = format.EMPTY;
const SLOT = "mcp.overview";
const PATH = "/mcp-integration/usage";
// The dimensions that a filter has, in the order of the address; the charts are grouped by one of key, method, client or result (what the bar
// offers: the instance and the type are filters only).
const DIMENSIONS = ["key", "method", "client", "instance", "result", "type"];
const GROUPS = [{ value: "key", label: "Key" }, { value: "method", label: "Method" }, { value: "client", label: "Client" }, { value: "result", label: "Result" }];
const DEFAULT_GROUP = "method";
// The groups of the charts are ranked once for each of these metrics, besides the requests (`order`), in the one read of the tab (`orders`): the
// errors for the errors and their rate, the refused requests, the tool calls for their time, and the bytes returned.
const RANKED = ["errors", "refused", "calls", "bytes"];
// The server takes 20 values of a kind at most (a 400 `too_many` above).
const MAX_VALUES = mcpBar.MAX_VALUES;
// What the server accepts for a value of each dimension (a 400 `invalid` for the others): the id of a key (the name of a key of the
// configuration, which never starts with "ui_", or "ui_" and 12 hexadecimal digits), the name of a tool or of a method of the protocol, the
// name of a client (printable ASCII, 1 to 64 characters, no space at either end), the name of an instance (the name of its file: letters,
// digits, dot, hyphen and underscore, 1 to 64 characters), a result code, a type.
const VALID = {
  key: /^(?:ui_[0-9a-f]{12}|(?!ui_)[a-z0-9][a-z0-9_-]{0,31})$/,
  method: /^[A-Za-z0-9_/]{1,64}$/,
  client: /^[\x21-\x7e](?:[\x20-\x7e]{0,62}[\x21-\x7e])?$/,
  instance: /^[A-Za-z0-9._-]{1,64}$/,
  result: /^[a-z0-9_]{1,64}$/,
  type: /^(?:call|request|limited|rejected)$/,
};
const DIMENSION_LABEL = { key: "Key", method: "Method", client: "Client", instance: "Instance", result: "Result", type: "Type" };
// The values that an answer lists for a dimension that can be picked (its facet: every filter but its own). The type has no list or legend to
// pick it from, and the instance has no legend: its list is in the bar.
const FACET = { key: (data) => data.keys, method: (data) => data.methods, client: (data) => data.clients, instance: (data) => data.instances, result: (data) => data.results };
// The four kinds of request (the `type` of the server): what each one is, for the chip and the tooltip.
const TYPE_LABEL = { call: "Tool calls", request: "Protocol", limited: "Rate limited", rejected: "Rejected" };
const TYPE_TITLE = {
  call: "A call of a tool (tools/call)",
  request: "A request of the MCP protocol: initialize, tools/list, ping, a notification...",
  limited: "Refused by the rate limit (429)",
  rejected: "Refused before its message was read: 400, 413 or 415",
};
// The methods that are not the name of a tool: what they count (the title of their legend entry).
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
// The names that ClickHouse Dash gives a client that has none, or that it cannot keep apart.
const CLIENT_NOTE = {
  unknown: "The client sent no name in initialize and no User-Agent",
  other: "The clients past the caps: a key keeps 16 client names, and ClickHouse Dash 4,096",
};
// What a result is, for the title of its legend entry: `ok`, the code that the server makes of a JSON-RPC error ("rpc_error_32601") or of a
// request that was refused ("429_rate_limited"); the other results are the error codes of the tools.
function resultNote(value) {
  if (value === "ok") return "The request succeeded";
  const code = /^rpc_error_(\d+)$/.exec(value);
  if (code) return `A JSON-RPC error of the protocol (code -${code[1]})`;
  const status = /^(\d{3})_/.exec(value);
  return status ? `Refused before its message was read (HTTP ${status[1]})` : "";
}

const WINDOW_TEXT = {
  "1h": "the last hour", "6h": "the last 6 hours", "24h": "the last 24 hours", "7d": "the last 7 days", "30d": "the last 30 days", "90d": "the last 90 days", "365d": "the last 365 days",
};

const count = (n) => format.count(n);
// The server counts whole milliseconds: a time of 0 is under a millisecond.
const ms = (value) => (value == null ? EMPTY : value === 0 ? "<1 ms" : format.duration.fromMs(value));
// A count of a tile: all its digits up to a million ("1,013", not "1K": a total is read exactly), then compact.
const figure = (n) => (n < 1e6 ? count(n) : format.compact(n));
const minute = (t) => format.time(t, { precision: "min" });

const model = {
  meta: null,
  window: "",
  group: DEFAULT_GROUP,
  filters: { key: [], method: [], client: [], instance: [], result: [], type: [] },
  data: null,
  error: null,
  loading: false,
  announced: false,
};
// The nodes that the view fills (built once by build()).
const els = {};
let bar = null;
let charts = null;
// What the caller does when the server says that the usage is off.
let onOff = null;
// The chips on screen (their values and names), to draw them again only when they change.
let chipsDrawn = "";
let chipsShown = [];
let mounted = false;

// The address of the tab (ns.router): its parameters are the state of the page, written by the changes and read on load and by Back and Forward.
const address = router.owner("mcpusage", { view: null, path: PATH, params: () => urlParams() });

// --- The address ---------------------------------------------------------------------------

const windows = () => (model.meta?.usage?.windows?.length ? model.meta.usage.windows : ["24h"]);
const defaultWindow = () => (windows().includes(model.meta?.usage?.defaultWindow) ? model.meta.usage.defaultWindow : windows()[0]);

// The address into the model. Returns true when a value had to be fixed: a window that the retention does not keep, a group that the bar
// does not offer, the old `split`, a value that is malformed or repeated, or more than 20 values of a kind (the caller replaces the address
// with the fixed one).
function readUrl() {
  const params = router.current().params;
  let fixed = false;
  const asked = params.get("window");
  model.window = windows().includes(asked) ? asked : defaultWindow();
  if (params.has("window") && model.window !== asked) fixed = true;
  const group = params.get("group");
  model.group = GROUPS.some((item) => item.value === group) ? group : DEFAULT_GROUP;
  if (params.has("group") && model.group !== group) fixed = true;
  // The chart used to be split (Keys | Methods | Results | Type): that name is gone, and so is what it asked for.
  if (params.has("split")) fixed = true;
  for (const dimension of DIMENSIONS) {
    const sent = params.getAll(dimension);
    const values = [...new Set(sent.filter((value) => VALID[dimension].test(value)))].slice(0, MAX_VALUES);
    if (values.length !== sent.length) fixed = true;
    model.filters[dimension] = values;
  }
  return fixed;
}

// The model as parameters: what a default is stays out (the window of the server, the group by method).
function urlParams() {
  const params = new URLSearchParams();
  if (model.window && model.window !== defaultWindow()) params.set("window", model.window);
  if (model.group !== DEFAULT_GROUP) params.set("group", model.group);
  for (const dimension of DIMENSIONS) for (const value of model.filters[dimension]) params.append(dimension, value);
  return params;
}

// A change of the window, of the group or of a filter: an entry of the history, then the new figures. Picks that cancel out (a box ticked
// and cleared before the clicks paused) leave the address as it was: there is nothing to read.
function changed() {
  scheduleChange.cancel();
  if (address.push()) void load();
}

// The picks of a list in the bar wait for the clicks to pause: a few of them are one entry of the history and one read (as in Logs).
const scheduleChange = util.debounce(changed);

// Back and Forward (and a link to the tab from itself): the address is the state.
function onLocation() {
  if (!mounted || els.root.hidden) return;
  scheduleChange.cancel();
  if (readUrl()) address.replace();
  void load();
}

// A value that is on or off, with the limit of the server: false when the 21st is refused.
function toggle(dimension, value) {
  const list = model.filters[dimension];
  if (!list.includes(value) && list.length >= MAX_VALUES) {
    uiState.announce(`A filter takes ${MAX_VALUES} values at most.`);
    return false;
  }
  model.filters[dimension] = list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
  return true;
}

function toggleFilter(dimension, value) {
  if (toggle(dimension, value)) changed();
}

function clearFilters() {
  for (const dimension of DIMENSIONS) model.filters[dimension] = [];
  changed();
}

// A pick in a list of the bar: the model, the button and the chips follow at once, the read when the clicks pause.
function pick(dimension, value) {
  if (toggle(dimension, value)) scheduleChange();
  syncControls();
}

function clearDimension(dimension) {
  if (!model.filters[dimension].length) return;
  model.filters[dimension] = [];
  syncControls();
  scheduleChange();
}

const filterCount = () => DIMENSIONS.reduce((sum, dimension) => sum + model.filters[dimension].length, 0);

// Whether a filter on the dimension is offered: it has two values to choose from in the answer, or a filter is on already (so that it can be
// taken off). One value, or none, is nothing to choose: its list and its legend entries stay as they are, but cannot be used. Before the first
// answer nothing is known, and everything is offered.
function offered(dimension) {
  if (!model.data || !FACET[dimension]) return true;
  return model.filters[dimension].length > 0 || FACET[dimension](model.data).length > 1;
}

// --- Reading -------------------------------------------------------------------------------

// The usage for the window, the group and the filters: one read, grouped by the Group by, whose groups are ranked by the requests and once more
// by each of the other metrics that a chart ranks by (RANKED). When the Group by dimension is filtered its groups are the values that were
// picked, the same whatever the metric, so no ranking is asked for. A newer read cancels the one in flight (util.latest); the figures that are
// on screen stay (dimmed) until the answer comes. No timer: only a change of the page, or Refresh, reads.
async function load() {
  const req = util.latest(SLOT);
  model.loading = true;
  model.error = null;
  render();
  try {
    const picked = model.filters[model.group].length > 0;
    const data = await api.getMcpUsageOverview({ window: model.window, group: model.group, order: "requests", orders: picked ? [] : RANKED, filters: model.filters, signal: req.signal });
    if (!req.isCurrent()) return;
    model.data = data;
  } catch (error) {
    if (!req.isCurrent() || util.isAbort(error)) return;
    model.data = null;
    // The usage was turned off after the meta was read (a restart): the tab is the "Usage is off" state, not an error.
    if (error?.mcp?.code === "not_enabled" && onOff) {
      model.loading = false;
      onOff();
      return;
    }
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

function show(root, { meta, onOff: off = null }) {
  model.meta = meta;
  onOff = off;
  if (!mounted) {
    mounted = true;
    build(root);
    if (readUrl()) address.replace();
    router.on(PATH, onLocation);
    bar.mountSummary({ describe });
  } else if (!windows().includes(model.window)) {
    model.window = defaultWindow();
    address.replace();
  }
  setShown(true);
  bar.setWindows(windows(), model.window);
  void load();
}

function hide() {
  util.latest.cancel(SLOT);
  if (!mounted) return;
  scheduleChange.cancel();
  charts.destroy();
  // Shown again, the tab reads again and says so: it does not show what it read before.
  model.data = null;
  model.error = null;
  model.loading = false;
  setShown(false);
}

// The bar and the chips are not in the root of the tab: they show and hide with it.
function setShown(on) {
  els.root.hidden = !on;
  bar.form.hidden = !on;
  els.filters.hidden = !on;
}

// The text that stands for the folded bar on a phone ("<time range> · 2 filters" on the other bars): the window and the group.
function describe() {
  const span = (WINDOW_TEXT[model.window] || model.window).replace(/^the /, "");
  return `${span.charAt(0).toUpperCase()}${span.slice(1)} · by ${model.group}`;
}

// The bar and the chips (under the row of the two pages), then the body of the tab: the warnings, the tiles, the charts and the notes. Its
// heading is hidden (the page's h1 is "MCP usage", and the titles of the charts are h3).
function build(root) {
  els.root = root;
  bar = mcpBar.create({
    groups: GROUPS,
    labelOf: valueLabel,
    onGroup: (value) => { model.group = value; changed(); },
    onWindow: (value) => { model.window = value; changed(); },
    onPick: pick,
    onClear: clearDimension,
    onRefresh: async () => {
      await load();
      // The button is off while the read runs, and that takes the focus from it: the keyboard comes back to it.
      if (document.activeElement === document.body) bar.refresh.focus();
    },
  });
  els.refresh = bar.refresh;
  // The chips row is always there, one line high, so that a filter never moves what is under it: a hint while there is none, then the chips
  // (a list; one line that scrolls sideways when they do not fit) and "Clear filters", a button, which stands beside the list and not in it.
  // The period of the window is at the right end, muted: it never wraps and the chips never cover it. A phone has the room for the first
  // sentence of the hint beside it, and not for the second (mcp.css).
  els.hint = h("span", { class: "mcpMuted mcpOverview__filtersHint" }, "No filters.", h("span", { class: "mcpOverview__filtersHintMore" }, " Pick a value in a list or in a legend."));
  els.chips = h("div", { class: "chips mcpOverview__chips", role: "list", "aria-label": "Active filters", hidden: true });
  els.clear = h.html(badge.clearHtml("Clear filters", { "data-chip-clear": true })).firstElementChild;
  els.clear.hidden = true;
  els.period = h("span", { class: "mcpMuted mcpOverview__period", title: "The period that the figures cover" });
  els.filters = h("div", { class: "chips mcpOverview__filters", hidden: true }, els.hint, els.chips, els.clear, els.period);
  els.filters.addEventListener("click", onChipClick);
  dom.$(".mcpPage__nav", root.closest(".mcpPage")).after(bar.form, els.filters);
  shell.edgeCues(els.chips);

  els.state = h("div", { class: "mcpOverview__state" });
  els.tiles = h("div", { class: "statTiles statTiles--boxed mcpOverview__tiles", role: "group", "aria-label": "Totals" });
  els.charts = h("div", { class: "mcpOverview__charts" });
  charts = mcpCharts.create(els.charts, { pressed: (group, id) => model.filters[group]?.includes(id) === true, onToggle: toggleFilter, offered, note: legendNote });

  els.notes = h("div", { class: "mcpOverview__notes" });
  els.warnings = h("div", { class: "mcpOverview__warnings", hidden: true });
  els.content = h("div", { class: "mcpOverview__content" }, els.warnings, els.tiles, els.charts, els.notes);
  els.body = h("div", { class: "mcpOverview__body" }, els.state, els.content);

  root.replaceChildren(h("section", { class: "pagePart", "aria-labelledby": "mcpOverviewTitle" },
    h("h2", { class: "srOnly", id: "mcpOverviewTitle" }, "Usage of all keys"),
    els.body));
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
    mcpInstances.warn(els.warnings, model.data.instances);
    renderTiles(model.data);
    renderCharts(model.data);
    renderNotes(model.data);
  } else {
    // A read is running: the figures stay, and the legends already show what the click picked (the entries that it leaves out dim).
    charts.redraw();
  }
}

function showState(on) {
  els.state.hidden = !on;
  els.content.hidden = on;
  if (on) charts.destroy();
}

function syncControls() {
  bar.sync({ group: model.group, window: model.window, filters: model.filters, data: model.data, me: model.meta?.usage?.instance || "",
    offered: { key: offered("key"), method: offered("method"), client: offered("client"), result: offered("result"), instance: offered("instance") } });
  // The period of the answer that is on screen (nothing before the first one), from when the counting started when that is later.
  const data = model.data;
  const from = data && data.since != null && data.from != null ? Math.max(data.from, data.since) : data?.from;
  const period = data && from != null && data.to != null ? format.range(from, data.to) : "";
  if (els.period.textContent !== period) els.period.textContent = period;
  renderChips();
}

// --- Filters -------------------------------------------------------------------------------

function valueLabel(dimension, value) {
  if (dimension === "type") return TYPE_LABEL[value] || value;
  if (dimension === "key") return model.data?.keys.find((key) => key.id === value)?.name || value;
  return value;
}

// What a method, a client or a result is, for the title of its legend entry (the words that stand for a group of messages say what they are).
function legendNote(dimension, value) {
  return dimension === "method" ? METHOD_NOTE[value] || "" : dimension === "client" ? CLIENT_NOTE[value] || "" : dimension === "result" ? resultNote(value) : "";
}

const chipId = ({ dimension, value }) => `${dimension}=${value}`;

// One chip for each value, and "Clear filters" from the second (the shared chips, ns.badge), or the hint when there is no filter. The row
// does not change its size either way. The chips are drawn again only when they change: the keyboard is on one of them while the answer comes.
function renderChips() {
  const chips = [];
  for (const dimension of DIMENSIONS) for (const value of model.filters[dimension]) chips.push({ dimension, value, text: valueLabel(dimension, value) });
  els.filters.hidden = els.root.hidden;
  els.hint.hidden = chips.length > 0;
  els.chips.hidden = !chips.length;
  els.clear.hidden = chips.length < 2;
  const drawn = JSON.stringify(chips);
  if (drawn === chipsDrawn) return;
  chipsDrawn = drawn;
  const had = new Set(chipsShown.map(chipId));
  chipsShown = chips;
  h.replace(els.chips, chips.map(({ dimension, value, text }) => h.html(badge.chipHtml({
    key: DIMENSION_LABEL[dimension],
    op: "=",
    value: text,
    className: "mcpOverview__chip",
    title: dimension === "type" ? `${text}: ${TYPE_TITLE[value]}` : `${DIMENSION_LABEL[dimension]} = ${text}`,
    remove: { label: `Remove filter ${DIMENSION_LABEL[dimension]} = ${text}`, attrs: { "data-chip-dimension": dimension, "data-chip-value": value } },
  }))));
  // The chips are in the order of the dimensions, so a pick may land past the edge of a row that scrolls: the new chip comes into view.
  const added = chips.findIndex((chip) => !had.has(chipId(chip)));
  if (added >= 0 && had.size) shell.revealInRow(els.chips, els.chips.children[added]);
}

// The control that a click leaves: a chip that went, or the button of the empty state that cleared the filters. The keyboard goes on from the
// chip that took its place (the last one at the end), else from the window.
function focusFilters(index = 0) {
  const buttons = dom.$$(".chip__remove", els.chips);
  (buttons[Math.min(index, buttons.length - 1)] || dom.$('[aria-pressed="true"]', bar.windows))?.focus();
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

// --- Tiles ---------------------------------------------------------------------------------

// The Active keys tile: its value and "of N keys" count keys of one kind, the keys that exist now. A deleted key keeps its usage, so one that
// had a request in this view is counted apart ("1 deleted"): it is in neither figure, and "7 of 7 keys" is seven keys that exist. The server
// counts the deleted keys with the others (totals.activeKeys), so the page counts from the rows of the keys facet of the answer, which have every
// filter but the one of the keys (applied here). When the server cut that list the rows cannot be counted: the tile says the total of the server
// and what it counts, instead of a ratio that it cannot know.
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
    sub: `of ${format.countLabel(totals.keys, "key")}${deleted ? ` · ${count(deleted)} deleted` : ""}`,
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

// --- Charts --------------------------------------------------------------------------------

// The six charts. A window with no request keeps the six cards (the page does not shrink): the Requests card says why there is nothing to
// draw, with a way out when filters are on, and the others say what they count (nothing).
function renderCharts(data) {
  const none = !data.totals.requests || !data.series.times.length;
  if (!none) {
    charts.draw(data);
    return;
  }
  const span = WINDOW_TEXT[data.window] || "this window";
  charts.draw(data, filterCount()
    ? { title: "No request has all these filters", body: `Nothing in ${span} matches them.`, action: { label: "Clear filters", onClick: () => { clearFilters(); focusFilters(); } } }
    : { title: `No request in ${span}`, body: "Nothing was counted in this window." });
}

// --- Notes ---------------------------------------------------------------------------------

function renderNotes(data) {
  const notes = [];
  if (data.since != null && data.from != null && data.since > data.from) notes.push(`Counted since ${minute(data.since)}.`);
  // No note, no row: the content is a grid, and an empty row would add its gap under the charts.
  els.notes.hidden = !notes.length;
  h.replace(els.notes, notes.map((text) => h("p", { class: "mcpNote mcpNote--fine" }, text)));
}

export const mcpOverview = Object.freeze({ show, hide });
