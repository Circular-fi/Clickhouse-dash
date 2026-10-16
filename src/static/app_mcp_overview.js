// The Usage tab of the MCP pages (mcpusage.html, /mcp-integration/usage, docs/mcp-integration-page.md, "The Usage tab"). It shows what every key did.
// The page has a filter bar at the top (app_mcp_bar.js). The bar has Group by key, method, client or result, a picker for each of the five, the window and Refresh.
// Below the bar are the tiles of the whole and six charts over time (app_mcp_charts.js).
// The charts show the requests, the errors, the rate of the errors, the refused requests, the time of a call and the bytes returned.
// The Group by setting groups all of them.
// A filter is a value of a dimension. A chip, a picker of the bar or an entry of a chart legend adds or removes a filter.
// Every figure of the page follows the filters.
// The values of one dimension match any of them. The dimensions match all of them.
// The instance is a dimension of the bar and the chips only.
// ChDash instances that share the usage directory add up (app_mcp_instances.js). A filter on the instance excludes the other instances.
//
//   ns.mcpOverview.show(root, { meta, onOff })   draws the tab in `root` the first time. Then it reads the usage. It reads again each time the tab is shown.
//                                         onOff() is called when the server states that the usage is off (404 not_enabled: the meta is older than a restart). The caller hides the tab and reports this.
//   ns.mcpOverview.hide()                 hides the tab and stops its reads
//
// The server (app_api.js, getMcpUsageOverview) applies the filters to the usage. The tiles and the charts use every filter.
// The list of a picker has every filter except its own. A filtered list still shows the other values that can be picked.
// A value that is picked is always in the list, at 0 when it has nothing.
// The legend of a chart is the filter of the dimension that the charts are grouped by.
// A group that a chart folds into "N more" cannot be picked in the legend. Pick it in the list of the bar.
// One read of the server gives all the data that the charts need. The read has a ranking of the groups for each metric (`orders`).
// Each chart shows the 8 groups that rank first for its own metric.
// The groups of the six charts are the values that were picked when the Group by dimension is filtered. Then the read has no `orders`.
// A dimension that has fewer than two values in the answer, and no filter, is not offered (offered()). Its list in the bar is off, and its legend entries cannot be picked.
// The bar and the chips are under the row of the two pages. They are outside the panel that scrolls, as the filter bar of System is.
//
// Nothing moves when a filter is added or removed, or when the next answer arrives.
// The chips are one line that is always there. A hint shows when there is no filter. The period stays at the right end of the line.
// The cards of the charts keep one height (app_mcp_charts.js), and the tiles do the same (mcp.css).
//
// The tab has no heading row. Its h2 is for screen readers only (the titles of the charts are h3).
// The period of the window ("Oct 9 02:00 to Oct 16 01:15") is muted at the right end of the chips row.
//
// The instances are in the Instance list of the bar (app_mcp_bar.js).
// The list shows "Instance · All (2)" while two or more instances are summed and none is picked.
// It has a row for each instance. The row shows when the instance wrote last. A badge shows when its file is not read.
// A file that the sum omits is a warning above the tiles too. So is a name that two ChDash instances write under.
// Both come from the `instances` of the answer. Only the instance filter changes them, so they stay put while the other filters change.

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
// The dimensions that a filter can have appear in the order of the address.
// The charts group by one of key, method, client or result. The bar offers these four. The instance and the type are filters only.
const DIMENSIONS = ["key", "method", "client", "instance", "result", "type"];
const GROUPS = [{ value: "key", label: "Key" }, { value: "method", label: "Method" }, { value: "client", label: "Client" }, { value: "result", label: "Result" }];
const DEFAULT_GROUP = "method";
// The groups of the charts are ranked once for each metric, besides the requests (`order`). The ranks are in the one read of the tab (`orders`).
// The metrics are: the errors (for the errors and their rate), the refused requests, the tool calls (for their time), and the bytes returned.
const RANKED = ["errors", "refused", "calls", "bytes"];
// The server accepts 20 values of a kind at most. A larger number returns a 400 `too_many` error.
const MAX_VALUES = mcpBar.MAX_VALUES;
// The server accepts these values for each dimension. Other values return a 400 `invalid` error.
// A key id is the name of a key in the configuration, which never starts with "ui_". Or it is "ui_" and 12 hexadecimal digits.
// The value can be the name of a tool or of a method of the protocol.
// A client name is printable ASCII, from 1 to 64 characters, with no space at either end.
// An instance name is the name of its file: letters, digits, dot, hyphen and underscore, from 1 to 64 characters.
// The other values are a result code and a type.
const VALID = {
  key: /^(?:ui_[0-9a-f]{12}|(?!ui_)[a-z0-9][a-z0-9_-]{0,31})$/,
  method: /^[A-Za-z0-9_/]{1,64}$/,
  client: /^[\x21-\x7e](?:[\x20-\x7e]{0,62}[\x21-\x7e])?$/,
  instance: /^[A-Za-z0-9._-]{1,64}$/,
  result: /^[a-z0-9_]{1,64}$/,
  type: /^(?:call|request|limited|rejected)$/,
};
const DIMENSION_LABEL = { key: "Key", method: "Method", client: "Client", instance: "Instance", result: "Result", type: "Type" };
// The values that an answer lists for a dimension that can be picked. This is the facet: every filter except its own.
// The type has no list or legend to pick it from. The instance has no legend. Its list is in the bar.
const FACET = { key: (data) => data.keys, method: (data) => data.methods, client: (data) => data.clients, instance: (data) => data.instances, result: (data) => data.results };
// The four kinds of request (the `type` of the server). This block says what each kind is. The chip and the tooltip use this text.
const TYPE_LABEL = { call: "Tool calls", request: "Protocol", limited: "Rate limited", rejected: "Rejected" };
const TYPE_TITLE = {
  call: "A call of a tool (tools/call)",
  request: "A request of the MCP protocol: initialize, tools/list, ping, a notification...",
  limited: "Refused by the rate limit (429)",
  rejected: "Refused before its message was read: 400, 413 or 415",
};
// The methods that are not a tool name. This block says what they count. The text is the title of their legend entry.
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
// The names that ClickHouse Dash gives to a client that has no name, or to clients that it cannot tell apart.
const CLIENT_NOTE = {
  unknown: "The client sent no name in initialize and no User-Agent",
  other: "The clients past the caps: a key keeps 16 client names, and ClickHouse Dash 4,096",
};
// This block says what a result is. The text is the title of its legend entry.
// The results are `ok`, the code that the server creates for a JSON-RPC error ("rpc_error_32601"), and the code for a refused request ("429_rate_limited").
// The other results are the error codes of the tools.
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
// The server counts whole milliseconds. A time of 0 is less than one millisecond.
const ms = (value) => (value == null ? EMPTY : value === 0 ? "<1 ms" : format.duration.fromMs(value));
// A count in a tile shows all its digits up to a million ("1,013", not "1K"), because a total is read exactly. Above a million the count is compact.
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
// The nodes that the view fills. The build() function creates them once.
const els = {};
let bar = null;
let charts = null;
// The action of the caller when the server states that the usage is off.
let onOff = null;
// The chips on screen, with their values and names. The program draws them again only when they change.
let chipsDrawn = "";
let chipsShown = [];
let mounted = false;

// The address of the tab (ns.router). Its parameters are the state of the page. The changes write the parameters. The page reads them on load and with Back and Forward.
const address = router.owner("mcpusage", { view: null, path: PATH, params: () => urlParams() });

// --- The address ---------------------------------------------------------------------------

const windows = () => (model.meta?.usage?.windows?.length ? model.meta.usage.windows : ["24h"]);
const defaultWindow = () => (windows().includes(model.meta?.usage?.defaultWindow) ? model.meta.usage.defaultWindow : windows()[0]);

// Copy the address into the model. The function returns true when a value had to be fixed.
// Values that are fixed: a window that the retention does not keep, a group that the bar does not offer, the old `split`, a value that is malformed or repeated, and more than 20 values of a kind.
// The caller replaces the address with the fixed one.
function readUrl() {
  const params = router.current().params;
  let fixed = false;
  const asked = params.get("window");
  model.window = windows().includes(asked) ? asked : defaultWindow();
  if (params.has("window") && model.window !== asked) fixed = true;
  const group = params.get("group");
  model.group = GROUPS.some((item) => item.value === group) ? group : DEFAULT_GROUP;
  if (params.has("group") && model.group !== group) fixed = true;
  // The chart was once split (Keys | Methods | Results | Type). That name no longer exists, and the program no longer supports the split.
  if (params.has("split")) fixed = true;
  for (const dimension of DIMENSIONS) {
    const sent = params.getAll(dimension);
    const values = [...new Set(sent.filter((value) => VALID[dimension].test(value)))].slice(0, MAX_VALUES);
    if (values.length !== sent.length) fixed = true;
    model.filters[dimension] = values;
  }
  return fixed;
}

// The model as parameters. The program omits each default value (the window of the server, and the group by method).
function urlParams() {
  const params = new URLSearchParams();
  if (model.window && model.window !== defaultWindow()) params.set("window", model.window);
  if (model.group !== DEFAULT_GROUP) params.set("group", model.group);
  for (const dimension of DIMENSIONS) for (const value of model.filters[dimension]) params.append(dimension, value);
  return params;
}

// A change of the window, the group or a filter adds an entry to the history. Then the page shows the new figures.
// Picks whose effects cancel each other leave the address as it was. An example is a box that is ticked and cleared before the clicks pause. There is nothing to read.
function changed() {
  scheduleChange.cancel();
  if (address.push()) void load();
}

// The picks of a list in the bar wait until the clicks pause. A few picks make one history entry and one read, as in Logs.
const scheduleChange = util.debounce(changed);

// The address is the state. This is true for Back, Forward and a link to the tab from itself.
function onLocation() {
  if (!mounted || els.root.hidden) return;
  scheduleChange.cancel();
  if (readUrl()) address.replace();
  void load();
}

// A value that is on or off, with the limit of the server. The function returns false when the 21st value is refused.
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

// A pick in a list of the bar. The model, the button and the chips update at once. The read starts when the clicks pause.
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

// Whether a filter on the dimension is offered. The dimension is offered when the answer has two values to choose from, or when a filter is on already.
// A filter that is on can be removed. One value, or none, gives nothing to choose. Its list and its legend entries stay as they are, but cannot be used.
// Before the first answer, nothing is known, and every dimension is offered.
function offered(dimension) {
  if (!model.data || !FACET[dimension]) return true;
  return model.filters[dimension].length > 0 || FACET[dimension](model.data).length > 1;
}

// --- Reading -------------------------------------------------------------------------------

// The usage for the window, the group and the filters comes from one read. The read groups by the Group by setting.
// The groups are ranked by the requests. They are ranked once more by each other metric that a chart ranks by (RANKED).
// When the Group by dimension is filtered, the groups are the values that were picked. These groups are the same for every metric, so the read asks for no ranking.
// A newer read cancels the read in flight (util.latest). The figures on screen stay dimmed until the answer comes. There is no timer. Only a change of the page or Refresh starts a read.
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
    // The usage was disabled after the meta was read (a restart). The tab shows the "Usage is off" state, not an error.
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
  // When the tab is shown again, it reads again and states this. It does not show what it read before.
  model.data = null;
  model.error = null;
  model.loading = false;
  setShown(false);
}

// The bar and the chips are not in the root of the tab. They show and hide with the tab.
function setShown(on) {
  els.root.hidden = !on;
  bar.form.hidden = !on;
  els.filters.hidden = !on;
}

// The text for the folded bar on a phone ("<time range> · 2 filters" on the other bars). The text shows the window and the group.
function describe() {
  const span = (WINDOW_TEXT[model.window] || model.window).replace(/^the /, "");
  return `${span.charAt(0).toUpperCase()}${span.slice(1)} · by ${model.group}`;
}

// The bar and the chips are under the row of the two pages. The body of the tab follows them. It has the warnings, the tiles, the charts and the notes.
// The heading of the tab is hidden. The h1 of the page is "MCP usage". The titles of the charts are h3.
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
      // The button is off while the read runs. The disabled state takes the focus from the button. The keyboard focus returns to the button.
      if (document.activeElement === document.body) bar.refresh.focus();
    },
  });
  els.refresh = bar.refresh;
  // The chips row is always there. It is one line high, so a filter never moves the content under it.
  // The row shows a hint while there is no filter. Otherwise it shows the chips. The chips are a list in one line that scrolls sideways when they do not fit.
  // "Clear filters" is a button. It stands beside the list, not in it.
  // The period of the window is at the right end, muted. It never wraps, and the chips never cover it.
  // A phone has the room for the first sentence of the hint beside it, but not for the second (mcp.css).
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

// The screen shows these items: the controls always, and then the loading state, the error, or the figures. A read in flight dims the figures that are there.
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
    // A read is running. The figures stay on screen. The legends already show what the click picked. The entries that the click omits are dimmed.
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
  // The period of the answer on screen. Nothing is shown before the first answer. The period starts from when the counting started, if that is later.
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

// This block says what a method, a client or a result is. The text is the title of its legend entry. The words that stand for a group of messages say what they are.
function legendNote(dimension, value) {
  return dimension === "method" ? METHOD_NOTE[value] || "" : dimension === "client" ? CLIENT_NOTE[value] || "" : dimension === "result" ? resultNote(value) : "";
}

const chipId = ({ dimension, value }) => `${dimension}=${value}`;

// The program draws one chip for each value. It draws "Clear filters" from the second chip on (the shared chips, ns.badge). With no filter, it draws the hint instead.
// The row does not change its size. The program draws the chips again only when they change. The keyboard focus can be on one chip while the answer arrives.
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
  // The chips are in the order of the dimensions. A new chip can appear past the edge of a row that scrolls. The new chip then comes into view.
  const added = chips.findIndex((chip) => !had.has(chipId(chip)));
  if (added >= 0 && had.size) shell.revealInRow(els.chips, els.chips.children[added]);
}

// This block gives the control that a click leaves: a chip that was removed, or the button of the empty state that cleared the filters.
// The keyboard focus moves to the chip that took the place of the removed chip. If the removed chip was the last one, the focus moves to the new last chip. Otherwise, the focus moves to the window.
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

// The Active keys tile shows its value and "of N keys". The value counts the keys that exist now.
// A deleted key keeps its usage. A deleted key that had a request in this view is counted apart ("1 deleted"). It is in neither figure.
// The text "7 of 7 keys" means that seven keys exist.
// The server counts the deleted keys with the others (totals.activeKeys). The page therefore counts from the rows of the keys facet of the answer.
// These rows have every filter except the filter on the keys, which the page applies here.
// When the server truncates that list, the rows cannot be counted. The tile then shows the total of the server and what it counts. It does not show a ratio that the page cannot know.
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
  // The share of the errors is based on the requests that were read. A refusal is not an error of the tool or of the protocol.
  const read = t.requests - refused;
  const errorShare = read > 0 ? t.errors / read : 0;
  // A sub line is one line in a tile. The tile is at least 9 rem wide (122 px for the text, when seven tiles share the line).
  // The longest sub lines fit in this width, for example "12.3% of read requests" and "12,345 by the rate limit".
  // The title has the text that the short form omits.
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

// The page has six charts. A window with no request keeps the six cards, so the page does not shrink.
// The Requests card states why there is nothing to draw. It has a way out when filters are on.
// The other cards state what they count, which is nothing in this case.
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
  // Without a note, the program adds no row. The content is a grid. An empty row would add its gap under the charts.
  els.notes.hidden = !notes.length;
  h.replace(els.notes, notes.map((text) => h("p", { class: "mcpNote mcpNote--fine" }, text)));
}

export const mcpOverview = Object.freeze({ show, hide });
