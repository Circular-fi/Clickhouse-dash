// The Usage tab of the MCP pages (mcpusage.html, /mcp-integration/usage, docs/mcp-integration-page.md, "The Usage tab"): what every key did.
// A filter bar at the top (app_mcp_bar.js: Group by key, method or client, a picker for each of the three, the window, Refresh), the tiles of
// the whole, four charts over time that the Group by groups (app_mcp_charts.js: the requests, the errors, the time of a call and the bytes
// returned), and a table for each of the four dimensions that the tables list (key, method, client, result). A filter is a value of a
// dimension: a chip, a picker of the bar, an entry of a chart legend or a row of a table adds or removes it, and every figure of the page
// follows (the values of one dimension match any of them, the dimensions all of them).
// The whole state is in the address (?window=&group=&key=&method=&client=&result=&type=, one parameter for each value): a link says what it
// shows, and Back and Forward walk through the filters. Nothing runs on a timer: the usage is read when the page opens, on a change and
// with Refresh (the pickers of the bar wait for the clicks to pause, once, before they read).
//
//   ns.mcpOverview.show(root, { meta })   draws the tab in `root` the first time, then reads the usage (again when it is shown again)
//   ns.mcpOverview.hide()                 hides the tab and stops its reads
//
// The server (app_api.js, getMcpUsageOverview) cuts the usage. The tiles and the charts have every filter. The table of a dimension, and the
// list of its picker, have every filter but their own, so a filtered table still lists what else could be picked, and a value that is picked
// is always there (at 0 when it has nothing). The legend of a chart is the filter of the dimension that the charts are grouped by; a group
// that a chart folds into "N more" cannot be picked there but in its table. A dimension that has fewer than two values in the answer, and no
// filter, is not offered at all (offered()): its list in the bar is off, its rows and its legend entries cannot be picked. The bar and the
// chips sit under the row of the two pages, out of the panel that scrolls, as the filter bar of System does.
//
// Nothing moves when a filter is added or removed, or when the next answer comes: the chips are one line that is always there (a hint when
// there is no filter), the cards of the charts keep one height (app_mcp_charts.js), and so do the tiles (mcp.css).

import { api } from "./app_api.js";
import { dom, h, shell } from "./app_dom.js";
import { format } from "./app_format.js";
import { mcpBar } from "./app_mcp_bar.js";
import { mcpCharts } from "./app_mcp_charts.js";
import { router } from "./app_router.js";
import { badge } from "./app_ui_badge.js";
import { stat } from "./app_ui_stat.js";
import { table as tableMod } from "./app_ui_table.js";
import { uiState } from "./app_ui_state.js";
import { util } from "./app_util.js";

const EMPTY = format.EMPTY;
const SLOT = "mcp.overview";
const PATH = "/mcp-integration/usage";
// The dimensions that a filter has, in the order of the address; the charts are grouped by one of the first three (what the bar offers).
const DIMENSIONS = ["key", "method", "client", "result", "type"];
const GROUPS = [{ value: "key", label: "Key" }, { value: "method", label: "Method" }, { value: "client", label: "Client" }];
const DEFAULT_GROUP = "method";
// The server takes 20 values of a kind at most (a 400 `too_many` above).
const MAX_VALUES = mcpBar.MAX_VALUES;
// What the server accepts for a value of each dimension (a 400 `invalid` for the others): the id of a key (the name of a key of the
// configuration, which never starts with "ui_", or "ui_" and 12 hexadecimal digits), the name of a tool or of a method of the protocol, the
// name of a client (printable ASCII, 1 to 64 characters, no space at either end), a result code, a type.
const VALID = {
  key: /^(?:ui_[0-9a-f]{12}|(?!ui_)[a-z0-9][a-z0-9_-]{0,31})$/,
  method: /^[A-Za-z0-9_/]{1,64}$/,
  client: /^[\x21-\x7e](?:[\x20-\x7e]{0,62}[\x21-\x7e])?$/,
  result: /^[a-z0-9_]{1,64}$/,
  type: /^(?:call|request|limited|rejected)$/,
};
const DIMENSION_LABEL = { key: "Key", method: "Method", client: "Client", result: "Result", type: "Type" };
// The values that an answer lists for a dimension that can be picked (its facet: every filter but its own). The type has no list, row or
// legend to pick it from.
const FACET = { key: (data) => data.keys, method: (data) => data.methods, client: (data) => data.clients, result: (data) => data.results };
// The four kinds of request (the `type` of the server): what each one is, for the chip and the tooltip.
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
// The names that ClickHouse Dash gives a client that has none, or that it cannot keep apart.
const CLIENT_NOTE = {
  unknown: "The client sent no name in initialize and no User-Agent",
  other: "The clients past the caps: a key keeps 16 client names, and ClickHouse Dash 4,096",
};
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
  filters: { key: [], method: [], client: [], result: [], type: [] },
  data: null,
  error: null,
  loading: false,
  announced: false,
  // The sort of each table: it stays for the visit of the page and is not in the address.
  sort: { keys: { key: "requests", dir: "desc" }, methods: { key: "requests", dir: "desc" }, clients: { key: "requests", dir: "desc" }, results: { key: "count", dir: "desc" } },
};
// The nodes that the view fills (built once by build()).
const els = { blocks: {} };
let bar = null;
let charts = null;
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
// taken off). One value, or none, is nothing to choose: its list, its rows and its legend entries stay as they are, but cannot be used.
// Before the first answer nothing is known, and everything is offered.
function offered(dimension) {
  if (!model.data || !FACET[dimension]) return true;
  return model.filters[dimension].length > 0 || FACET[dimension](model.data).length > 1;
}

// --- Reading -------------------------------------------------------------------------------

// The usage for the window, the group and the filters. A newer read cancels the one in flight (util.latest); the figures that are on screen
// stay (dimmed) until the answer comes. No timer: only a change of the page, or Refresh, reads.
async function load() {
  const req = util.latest(SLOT);
  model.loading = true;
  model.error = null;
  render();
  try {
    const data = await api.getMcpUsageOverview({ window: model.window, group: model.group, filters: model.filters, signal: req.signal });
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

// The bar and the chips (under the row of the two pages), then the head of the tab (title, dates) and its body: the tiles, the charts, the
// four tables and the notes.
function build(root) {
  els.root = root;
  els.range = h("span", { class: "mcpMuted mcpOverview__range" });
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
  els.hint = h("span", { class: "mcpMuted mcpOverview__filtersHint" }, "No filters. Pick a value in a list, a legend or a table.");
  els.chips = h("div", { class: "chips mcpOverview__chips", role: "list", "aria-label": "Active filters", hidden: true });
  els.clear = h.html(badge.clearHtml("Clear filters", { "data-chip-clear": true })).firstElementChild;
  els.clear.hidden = true;
  els.filters = h("div", { class: "chips mcpOverview__filters", hidden: true }, els.hint, els.chips, els.clear);
  els.filters.addEventListener("click", onChipClick);
  dom.$(".mcpPage__nav", root.closest(".mcpPage")).after(bar.form, els.filters);
  shell.edgeCues(els.chips);

  els.state = h("div", { class: "mcpOverview__state" });
  els.tiles = h("div", { class: "statTiles statTiles--boxed mcpOverview__tiles", role: "group", "aria-label": "Totals" });
  els.charts = h("div", { class: "mcpOverview__charts" });
  charts = mcpCharts.create(els.charts, { pressed: (group, id) => model.filters[group]?.includes(id) === true, onToggle: toggleFilter, offered });

  // Two columns on a wide window: the keys over the methods (the wide tables), the results over the clients.
  els.tables = h("div", { class: "mcpOverview__tables" },
    h("div", { class: "mcpOverview__col" }, blockOf("keys"), blockOf("methods")),
    h("div", { class: "mcpOverview__col" }, blockOf("results"), blockOf("clients")));
  els.tables.addEventListener("click", onRowClick);
  els.notes = h("div", { class: "mcpOverview__notes" });
  els.content = h("div", { class: "mcpOverview__content" }, els.tiles, els.charts, els.tables, els.notes);
  els.body = h("div", { class: "mcpOverview__body" }, els.state, els.content);

  root.replaceChildren(h("section", { class: "pagePart mcpOverview__part", "aria-labelledby": "mcpOverviewTitle" },
    h("div", { class: "pagePart__head mcpOverview__head" }, h("h2", { class: "pagePart__title", id: "mcpOverviewTitle" }, "Usage of all keys"), els.range),
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
    renderTiles(model.data);
    renderCharts(model.data);
    for (const id of Object.keys(TABLES)) renderTable(id);
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
  bar.sync({ group: model.group, window: model.window, filters: model.filters, data: model.data,
    offered: { key: offered("key"), method: offered("method"), client: offered("client") } });
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

// The four charts. A window with no request keeps the four cards (the page does not shrink): the Requests card says why there is nothing to
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

// A client is its name, then the versions that it sent, muted (the latest first). The two names that ClickHouse Dash gives, `unknown` and
// `other`, are muted, and their title says what they stand for.
function clientCell(row) {
  const note = CLIENT_NOTE[row.client] || "";
  const lines = [row.client, row.versions.length ? `Versions: ${row.versions.join(", ")}` : "", note].filter(Boolean);
  return h("span", { class: "mcpOverview__name", title: lines.join("\n") },
    note ? h("span", { class: "mcpMuted mcpOverview__client" }, row.client) : h("strong", { class: "mcpOverview__client" }, row.client),
    row.versions.length ? h("span", { class: "mcpMuted mcpOverview__versions" }, ` ${row.versions.join(", ")}`) : null);
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
    title: "By client",
    label: "Usage by client",
    dimension: "client",
    noun: "clients",
    none: "No client sent a request in this view.",
    // How a client is named (the server counts it by that name): the clientInfo of its initialize, else the product of its User-Agent.
    note: "A client is named as it says in initialize (clientInfo), else by the product of its User-Agent (the text before the first / or space), else unknown. Other holds the names past the caps: 16 for a key, 4,096 in all. Its versions are those that it sent, the latest first.",
    rows: (data) => data.clients,
    omitted: (data) => data.omitted.clients,
    value: (row) => row.client,
    columns: (data) => [
      { key: "client", label: "Client", text: true, title: "Sort by name", sort: (row) => row.client.toLowerCase(), cell: clientCell },
      { key: "requests", label: "Requests", title: "Requests of the client", sort: (row) => row.requests, cell: (row) => count(row.requests) },
      { key: "errors", label: "Errors", title: "Errors, and their share of the requests that were read", sort: (row) => row.errors, cell: (row) => errorsCell(row.errors, row.requests - refusals(row)) },
      { key: "avg", label: "Avg time", title: "The average time of a tool call", sort: (row) => row.durationMsAvg, cell: (row) => h("span", { title: row.durationMsMax == null ? "" : `The longest call took ${ms(row.durationMsMax)}` }, ms(row.durationMsAvg)) },
      { key: "keys", label: "Keys", title: "Keys that the client used", sort: (row) => row.keys, cell: (row) => count(row.keys) },
      { key: "last", label: "Last seen", title: "When the keys last saw the client, in any window", sort: (row) => row.lastSeenAt, cell: (row) => when(row.lastSeenAt, data.to) },
    ],
  },
};

// A block of the tables: its title and count, the table (or a sentence) in its box, what the server left out.
function blockOf(id) {
  const spec = TABLES[id];
  const block = {
    count: h("span", { class: "pagePart__count" }),
    // The hint is there only while a row can be picked.
    hint: h("span", { class: "mcpMuted mcpOverview__hint", hidden: true }, "Click a row to filter"),
    box: h("div", { class: "dataTableWrap mcpOverview__wrap" }),
    more: h("p", { class: "mcpNote mcpNote--fine", hidden: true }),
  };
  block.section = h("section", { class: "mcpOverview__block", "aria-labelledby": `mcpOverviewTitle-${id}` },
    h("div", { class: "pagePart__head mcpOverview__blockHead" },
      h("h3", { class: "mcpOverview__blockTitle", id: `mcpOverviewTitle-${id}` }, spec.title), block.count, block.hint),
    block.box, block.more,
    spec.note ? h("p", { class: "mcpNote mcpNote--fine" }, spec.note) : null);
  tableMod.scrollCues(block.box);
  tableMod.rovingRows(block.box, { onOpen: (row) => toggleFilter(row.dataset.dimension, row.dataset.value), key: (row) => row.dataset.value });
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
  // A row is a filter only while its dimension is offered (two values, or a filter on); else it is a line to read.
  const pickable = rows.length > 0 && offered(spec.dimension);
  block.count.textContent = rows.length ? count(rows.length) : "";
  block.hint.hidden = !pickable;
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
    const on = model.filters[spec.dimension].includes(value);
    const cells = columns.map((column, index) => (index === 0 ? h("th", { scope: "row" }, column.cell(row)) : h("td", { class: column.text ? null : "num" }, column.cell(row))));
    // A row that is not offered has no class, tabindex or value: no pointer, no hover, no click, and not in the roving focus (rovingRows).
    if (!pickable) return h("tr", { class: "mcpOverview__row" }, cells);
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
