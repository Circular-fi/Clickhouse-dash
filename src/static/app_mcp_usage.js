// The usage of a key and the ClickHouse cost of its statements, in the details of the key (docs/mcp-integration-page.md, "The details
// of a key"). app_mcp_form.js puts the two sections under the data that the key reads; a deleted key shows them alone.
//
//   ns.mcpUsage.sections(key, { meta })   [usage, cost]: two sections, the second one closed; [cost] while the usage is off
//       Usage: what the key did in a window (1 h, 6 h, 24 h, 7 d, ... as the retention keeps them): tiles, the calls of each step of the
//       window (a minute to a day) with the errors, the tools, the results and the clients. The window that the reader picks stays for the
//       visit of the page. "Open in Usage" leads to the Usage tab (app_mcp_overview.js), filtered by this key, in the same window. When
//       several instances share the usage directory the head says "Summed over 3 instances" (a list of them opens from it), and a file that
//       is left out of the sum is a warning above the tiles (app_mcp_instances.js).
//       ClickHouse cost: what the statements of the key cost, read from system.query_log of its host when the section is opened (a
//       scan of the log: never before it is asked), in the window of the usage when the cost has it (1 h, 6 h, 24 h, 7 d), else in 7 d.
//       It does not depend on the usage: while the usage is off it is the one section of the details, and it has the window buttons of its own.
//   ns.mcpUsage.forget()                  the next read asks the server again (the Refresh button of the page)
//   ns.mcpUsage.cancel()                  stops the reads in flight (the details close)
// Each answer is kept 60 s for its key and window, as the server keeps the cost.

import { api } from "./app_api.js";
import { h } from "./app_dom.js";
import { format } from "./app_format.js";
import { mcpInstances } from "./app_mcp_instances.js";
import { mcpView } from "./app_mcp_view.js";
import { chartUi } from "./app_ui_chart.js";
import { icon } from "./app_ui_icon.js";
import { segmented } from "./app_ui_segmented.js";
import { stat } from "./app_ui_stat.js";
import { table as tableMod } from "./app_ui_table.js";
import { uiState } from "./app_ui_state.js";
import { util } from "./app_util.js";

const EMPTY = format.EMPTY;
const TTL_MS = 60000;
const USAGE_SLOT = "mcp.usage.";
const COST_SLOT = "mcp.cost.";
// `${key id}|${window}` -> { at, value }
const usageCache = new Map();
const costCache = new Map();
// The keys whose cost is open: a redraw of the details keeps it open.
const openCosts = new Set();
// The window that the reader picked: the same for every key of the visit, so two keys are compared on the same window.
let chosenWindow = "";
// The notes of the instances that are on screen (each opens a list): the details that close take them away.
const instanceNotes = new Set();

const WINDOW_LABEL = { "1h": "1 h", "6h": "6 h", "24h": "24 h", "7d": "7 d", "30d": "30 d", "90d": "90 d", "365d": "365 d" };
const WINDOW_TEXT = {
  "1h": "the last hour", "6h": "the last 6 hours", "24h": "the last 24 hours", "7d": "the last 7 days", "30d": "the last 30 days", "90d": "the last 90 days", "365d": "the last 365 days",
};
const count = (n) => format.count(n);
const plural = (n, one, many) => `${count(n)} ${n === 1 ? one : many}`;
const ms = (value) => (value == null ? EMPTY : format.duration.fromMs(value));
const minute = (t) => format.time(t, { precision: "min" });
const day = (t) => format.iso(t).slice(0, 10);

// The step of a series (seconds) as a word: "minute", "5 minutes", "15 minutes", "3 hours", "12 hours", "day".
function stepWord(seconds) {
  if (seconds >= 86400) return "day";
  const [n, unit] = seconds >= 3600 ? [seconds / 3600, "hour"] : [seconds / 60, "minute"];
  return n === 1 ? unit : `${n} ${unit}s`;
}

function cached(cache, key) {
  const hit = cache.get(key);
  return hit && Date.now() - hit.at < TTL_MS ? hit.value : null;
}

const note = (text, fine = false) => h("p", { class: `mcpNote${fine ? " mcpNote--fine" : ""}` }, text);
const block = (title, ...content) => h("div", { class: "mcpUsage__block" }, h("h4", { class: "mcpUsage__title" }, title), ...content);

// A value beside a bar of its share of `of` (the most called tool, all the results).
function share(value, of, text = count(value)) {
  const el = h("span", { class: "mcpUsage__share" });
  tableMod.shareBar(el, of ? (value / of) * 100 : 0, text);
  return el;
}

// A compact table: columns [title, numeric], rows of cells (text or nodes); `className` is added to the table.
function compactTable(label, columns, rows, className = "") {
  const head = h("tr", null, columns.map(([title, numeric]) => h("th", { scope: "col", class: numeric ? "num" : null }, title)));
  const body = h("tbody", null, rows.map((cells) => h("tr", null, cells.map((cell, index) => h("td", { class: columns[index][1] ? "num" : null }, cell)))));
  return h("div", { class: "dataTableWrap mcpUsage__tableWrap" },
    h("table", { class: `dataTable dataTable--compact mcpUsage__table${className ? ` ${className}` : ""}`, "aria-label": label }, h("thead", null, head), body));
}

// --- Usage -------------------------------------------------------------------------------

function usageBody(usage) {
  const out = [];
  const t = usage.totals;
  // A file that is left out of the sum says so before the figures (they are not the whole).
  const warnings = h("div", { class: "mcpUsage__warnings", hidden: true });
  mcpInstances.warn(warnings, usage.instances);
  if (!warnings.hidden) out.push(warnings);
  if (usage.since != null && usage.from != null && usage.since > usage.from) out.push(note(`Counted since ${minute(usage.since)}.`, true));
  if (!t.requests) {
    out.push(h("p", { class: "mcpNote mcpUsage__empty" }, usage.lastUsedAt != null
      ? `No request in ${WINDOW_TEXT[usage.window] || "this window"}. Last used ${minute(usage.lastUsedAt)}.`
      : `No request in ${WINDOW_TEXT[usage.window] || "this window"}.`));
    return out;
  }
  const errorShare = t.calls ? t.errors / t.calls : 0;
  const now = usage.to ?? Date.now();
  out.push(h("div", { class: "statTiles statTiles--boxed mcpUsage__tiles" },
    stat.tile({ label: "Tool calls", value: format.compact(t.calls), sub: plural(t.requests, "request", "requests"),
      title: `${count(t.calls)} tool calls in ${count(t.requests)} requests (initialize, tools/list, ping and the refused ones are requests too)` }),
    stat.tile({ label: "Errors", value: format.compact(t.errors), sub: t.calls ? `${format.percent(errorShare)} of the calls` : "",
      tone: t.errors ? (errorShare >= 0.05 ? "error" : "warn") : "", title: "Tool calls that ended with an error code, and JSON-RPC errors" }),
    stat.tile({ label: "Refused", value: format.compact(t.rateLimited + t.rejected), sub: `${count(t.rateLimited)} by the rate limit`, tone: t.rateLimited ? "warn" : "",
      title: "429: more calls than mcp.rate_limit_per_minute. 400, 413, 415: refused before the message was read." }),
    stat.tile({ label: "Call time", value: ms(t.durationMsAvg), sub: t.durationMsMax == null ? "" : `max ${ms(t.durationMsMax)}`,
      title: "The average and the longest time of a tool call, as ClickHouse Dash measured it" }),
    stat.tile({ label: "Returned", value: format.bytes(t.bytes), sub: t.rows ? plural(t.rows, "row", "rows") : "",
      title: "The bytes of the answers, and the rows of the tools that build their own SQL (an API tool counts no row)" }),
    stat.tile({ label: "Last use", value: usage.lastUsedAt == null ? EMPTY : format.ago(usage.lastUsedAt, { now, short: true }),
      sub: usage.firstUsedAt == null ? "" : `first ${minute(usage.firstUsedAt)}`, title: usage.lastUsedAt == null ? "" : format.timeTitle(usage.lastUsedAt) })));

  // The calls of each step of the window (1 minute to 1 day), and the errors as the second line.
  const points = usage.series.points;
  const daily = usage.series.step >= 86400;
  const peak = points.reduce((best, point) => (point.calls > best.calls ? point : best), { calls: 0, t: null });
  const when = (t) => (daily ? day(t) : minute(t));
  const trend = h("div", { class: "mcpUsage__trend" });
  chartUi.sparkline.draw(trend, points.map((point) => point.calls), {
    alt: points.map((point) => point.errors), area: true, min: 0, className: "mcpUsage__spark",
    label: `Tool calls by ${stepWord(usage.series.step)} in ${WINDOW_TEXT[usage.window] || "the window"}, the errors in red${peak.calls ? `; the most: ${count(peak.calls)} (${when(peak.t)})` : ""}`,
  });
  out.push(h("div", { class: "mcpUsage__trendRow" }, trend,
    h("span", { class: "mcpMuted mcpUsage__peak" }, peak.calls ? `Peak ${plural(peak.calls, "call", "calls")}, ${when(peak.t)}` : "No tool call")));

  const tables = h("div", { class: "mcpUsage__tables" });
  if (usage.tools.length) {
    const most = usage.tools[0].calls;
    tables.appendChild(block("Tools", compactTable("Tool calls by tool", [["Tool"], ["Calls", true], ["Errors", true], ["Avg time", true], ["Returned", true]],
      usage.tools.map((tool) => [h("code", { title: `${tool.tool}: the longest call took ${ms(tool.durationMsMax)}` }, tool.tool), share(tool.calls, most),
        tool.errors ? h("span", { class: "mcpWarn" }, count(tool.errors)) : "0", ms(tool.durationMsAvg), format.bytes(tool.bytes)]))));
  }
  if (usage.statuses.length) {
    const total = usage.statuses.reduce((sum, item) => sum + item.count, 0);
    tables.appendChild(block("Results", compactTable("The results of the calls, and the requests that failed", [["Result"], ["Count", true]],
      usage.statuses.map((item) => [h("code", { class: item.status === "ok" ? null : "mcpWarn" }, item.status), share(item.count, total)]))));
  }
  if (tables.childElementCount) out.push(tables);
  if (usage.clients.length) {
    out.push(block("Clients", compactTable("The clients of the key", [["Client"], ["User-Agent"], ["Requests", true], ["Seen"]],
      usage.clients.map((client) => [
        client.name ? h("span", null, h("strong", null, client.name), client.version ? h("span", { class: "mcpMuted" }, ` ${client.version}`) : null) : h("span", { class: "mcpMuted" }, "Unnamed"),
        h("code", { class: "mcpUsage__agent", title: client.userAgent }, client.userAgent || EMPTY),
        count(client.requests),
        h("span", { title: format.timeTitle(client.lastSeenAt) }, client.firstSeenAt === client.lastSeenAt ? minute(client.lastSeenAt) : format.range(client.firstSeenAt, client.lastSeenAt)),
      ]))));
  }
  return out;
}

function usageSection(key, meta, onWindow) {
  const windows = meta?.usage?.windows?.length ? meta.usage.windows : ["24h"];
  if (!windows.includes(chosenWindow)) chosenWindow = windows.includes(meta?.usage?.defaultWindow) ? meta.usage.defaultWindow : windows[0];
  const range = h("span", { class: "mcpMuted mcpUsage__range" });
  // "Summed over 3 instances": the usage of this key is the sum of the files of the instances that share the usage directory.
  const instances = mcpInstances.create({ prefix: "Summed over " });
  instanceNotes.add(instances);
  const picker = h("div", { class: "mcpUsage__windows" });
  segmented.render(picker, windows.map((value) => ({ value, label: WINDOW_LABEL[value] || value })), { attr: "window", value: chosenWindow, size: "compact", label: "Window" });
  // The Usage tab, filtered by this key, in the window that is picked here.
  const open = h("a", { class: "mcpUsage__open", title: "The usage of this key in the Usage tab, where it can be cut by method, client, result and type" }, "Open in Usage");
  const link = () => { open.href = `${api.resolveUrl("mcp-integration/usage")}?${new URLSearchParams({ key: key.id, window: chosenWindow }).toString()}`; };
  link();
  const body = h("div", { class: "mcpUsage__body" });
  const section = h("section", { class: "mcpUsage", dataset: { usage: key.id }, "aria-label": `What ${key.name} did` },
    h("h3", { class: "mcpDetails__title mcpUsage__head" }, "Usage", range, instances.el, open, picker), body);
  const slot = `${USAGE_SLOT}${key.id}`;
  const show = (usage) => {
    const from = usage.since != null && usage.from != null ? Math.max(usage.from, usage.since) : usage.from;
    range.textContent = from != null && usage.to != null ? format.range(from, usage.to) : "";
    instances.update(usage.instances, { me: meta?.usage?.instance || "", now: usage.to ?? NaN });
    body.replaceChildren(...usageBody(usage));
  };
  const load = async (announce) => {
    const window = chosenWindow;
    const hit = cached(usageCache, `${key.id}|${window}`);
    if (hit) {
      show(hit);
      return;
    }
    const req = util.latest(slot);
    uiState.loading(body, { label: "Reading what the key did\u2026", compact: true });
    try {
      const usage = await api.getMcpKeyUsage(key.id, { window, signal: req.signal });
      if (!req.isCurrent()) return;
      usageCache.set(`${key.id}|${window}`, { at: Date.now(), value: usage });
      show(usage);
      if (announce) uiState.announce(`The usage of ${key.name} in ${WINDOW_TEXT[window] || window} is shown.`);
    } catch (error) {
      if (req.isCurrent() && !util.isAbort(error)) {
        uiState.error(body, { title: "The usage of this key cannot be read", body: util.errorText(error), compact: true, retry: () => load(false) });
      }
    }
  };
  segmented.bind(picker, { attr: "window", onChange: (value) => {
    chosenWindow = value;
    link();
    void load(true);
    onWindow?.();
  } });
  void load(false);
  return section;
}

// --- ClickHouse cost -----------------------------------------------------------------------

// What the page says when the cost cannot be read (the reason of the server).
const COST_REASON = {
  not_granted: "The runner account of the host may not read system.query_log.",
  disabled: "This ClickHouse keeps no system.query_log.",
  window_too_large: "system.query_log has too many rows in this window for one read.",
  readonly_account: "The runner account of the host cannot run this read.",
  runner_unavailable: "The runner account of the host cannot connect.",
  no_host: "The host of this key is not in the config any more.",
  failed: "system.query_log could not be read.",
};

const ROLE_TEXT = { mcp: "MCP user", system: "system user", other: "another user" };

function costBody(cost, usageOn) {
  const out = [];
  if (cost.status !== "ok") {
    out.push(h("p", { class: "mcpNote mcpWarn mcpCost__reason" }, COST_REASON[cost.reason] || COST_REASON.failed));
    if (cost.statement) out.push(note("Give it the grant, as for System > Queries:"), mcpView.codeBlock(cost.statement, "the GRANT statement"));
    if (cost.suggestedWindow === "24h") out.push(note(usageOn ? "Pick the window of 24 hours in Usage: the cost follows it." : "Pick the window of 24 hours."));
    if (cost.error) out.push(note(cost.error, true));
    return out;
  }
  const t = cost.totals;
  if (cost.clamped) out.push(note(`Cut to the last ${plural(cost.maxLookbackHours, "hour", "hours")} (system.query_log_max_lookback_hours).`, true));
  if (!t.statements) {
    out.push(h("p", { class: "mcpNote mcpCost__empty" }, "No statement of this key in system.query_log in this window."));
  } else {
    out.push(h("div", { class: "statTiles statTiles--boxed mcpUsage__tiles" },
      stat.tile({ label: "Statements", value: format.compact(t.statements), sub: `${count(t.failed)} failed`, tone: t.failed ? "warn" : "",
        title: `${count(t.statements)} statements; ${count(t.failed)} failed, ${count(t.canceled)} stopped by ClickHouse Dash once it had what the call asked for` }),
      stat.tile({ label: "Read", value: format.bytes(t.readBytes), sub: plural(t.readRows, "row", "rows"), title: "What ClickHouse read for the statements of the key" }),
      stat.tile({ label: "CPU", value: ms(t.cpuMs), title: "The CPU time of the statements (OSCPUVirtualTimeMicroseconds)" }),
      stat.tile({ label: "Memory peak", value: format.bytes(t.memoryPeakBytes), title: "The most memory that one statement used" }),
      stat.tile({ label: "Time", value: ms(t.durationMs), title: "The time of the statements, added up" }),
      stat.tile({ label: "Result", value: format.bytes(t.resultBytes), sub: plural(t.resultRows, "row", "rows"), title: "What the statements returned to ClickHouse Dash" })));
    const tables = h("div", { class: "mcpUsage__tables" });
    if (cost.tools.length) {
      const most = Math.max(...cost.tools.map((tool) => tool.statements));
      tables.appendChild(block("By tool", compactTable("The cost by tool", [["Tool"], ["Statements", true], ["Read", true], ["CPU", true]],
        cost.tools.map((tool) => [h("code", null, tool.tool), share(tool.statements, most), format.bytes(tool.readBytes), ms(tool.cpuMs)]))));
    }
    // The tables beside the tools (two narrow columns), the users under them.
    if (cost.tables.length) {
      const most = cost.tables[0].statements;
      // A long name (analytics.page_views_by_country_and_day) ends in an ellipsis, and its title says all of it.
      tables.appendChild(block("Tables read", compactTable("The tables that the statements read the most", [["Table"], ["Statements", true]],
        cost.tables.map((item) => [h("code", { title: item.name }, item.name), share(item.statements, most)]), "mcpCost__tablesRead"),
        cost.tablesTruncated ? note("The 10 tables read the most.", true) : null));
    }
    if (cost.identities.length) {
      tables.appendChild(block("By user", compactTable("The cost by ClickHouse user", [["User"], ["Statements", true], ["Read", true]],
        cost.identities.map((item) => [h("span", null, h("code", { class: item.role === "other" ? "mcpWarn" : null }, item.user), h("span", { class: "mcpMuted" }, ` ${ROLE_TEXT[item.role]}`)),
          count(item.statements), format.bytes(item.readBytes)]))));
    }
    if (tables.childElementCount) out.push(tables);
  }
  out.push(note("Read from system.query_log of the host, which ClickHouse writes every few seconds. Only the statements named for this key count (their query_id): not the answers of a cache, nor the statements of an older ClickHouse Dash.", true));
  return out;
}

function costSection(key, meta) {
  const windows = meta?.usage?.costWindows || [];
  const usageOn = meta?.usage?.enabled === true;
  const bodyId = `mcpCost-${key.id}`;
  const toggle = h("button", { type: "button", class: "mcpCostToggle", "aria-expanded": "false", "aria-controls": bodyId },
    icon.el("chevron-right", { size: "sm", className: "icon--disclosure mcpKeyChevron" }), h("span", null, "ClickHouse cost"));
  const refresh = h("button", { type: "button", class: "button button--small mcpCost__refresh", title: "Read system.query_log again", hidden: true }, "Check again");
  const range = h("span", { class: "mcpMuted mcpCost__range" }, "read from system.query_log when opened");
  // The window of the cost follows the usage, which has the buttons. Without the usage the cost has its own, shown while it is open.
  const picker = usageOn ? null : h("div", { class: "mcpCost__windows", hidden: true });
  const body = h("div", { class: "mcpCost__body", id: bodyId, hidden: true });
  const section = h("section", { class: "mcpCost", dataset: { cost: key.id }, "aria-label": `What the statements of ${key.name} cost ClickHouse` },
    h("h3", { class: "mcpDetails__title mcpCost__head" }, toggle, range, picker, refresh), body);
  if (!windows.length) {
    toggle.disabled = true;
    range.textContent = "off: system.top_queries is off in the config";
    return { section, reload: () => {} };
  }
  const slot = `${COST_SLOT}${key.id}`;
  // The window of the usage, or the largest window of the cost (7 days) when the usage reads more.
  const windowOf = () => (windows.includes(chosenWindow) ? chosenWindow : windows[windows.length - 1]);
  const isOpen = () => toggle.getAttribute("aria-expanded") === "true";
  const show = (cost) => {
    range.textContent = cost.from != null && cost.to != null ? format.range(cost.from, cost.to) : "";
    body.replaceChildren(...costBody(cost, usageOn));
  };
  const load = async (again) => {
    const window = windowOf();
    const cacheKey = `${key.id}|${window}`;
    const hit = again ? null : cached(costCache, cacheKey);
    if (hit) {
      show(hit);
      refresh.hidden = false;
      return;
    }
    const req = util.latest(slot);
    refresh.disabled = true;
    uiState.loading(body, { label: "Reading system.query_log\u2026", compact: true });
    try {
      const cost = await api.getMcpKeyCost(key.id, { window, refresh: again, signal: req.signal });
      if (!req.isCurrent()) return;
      costCache.set(cacheKey, { at: Date.now(), value: cost });
      show(cost);
      uiState.announce(`The ClickHouse cost of ${key.name} is shown.`);
    } catch (error) {
      if (req.isCurrent() && !util.isAbort(error)) {
        uiState.error(body, { title: "The cost of this key cannot be read", body: util.errorText(error), compact: true, retry: () => load(true) });
      }
    } finally {
      if (req.isCurrent()) {
        refresh.disabled = false;
        refresh.hidden = false;
      }
    }
  };
  const setOpen = (open) => {
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    body.hidden = !open;
    if (picker) picker.hidden = !open;
    if (open) {
      openCosts.add(key.id);
      void load(false);
    } else {
      openCosts.delete(key.id);
      util.latest.cancel(slot);
    }
  };
  toggle.addEventListener("click", () => setOpen(!isOpen()));
  refresh.addEventListener("click", () => load(true));
  if (picker) {
    segmented.render(picker, windows.map((value) => ({ value, label: WINDOW_LABEL[value] || value })), { attr: "window", value: windowOf(), size: "compact", label: "Window of the cost" });
    segmented.bind(picker, { attr: "window", onChange: (value) => {
      chosenWindow = value;
      void load(false);
    } });
  }
  if (openCosts.has(key.id)) setOpen(true);
  return { section, reload: () => { if (isOpen()) void load(false); } };
}

// The two sections of a key: its usage, and the cost of its statements, which follows the window of the usage. The usage is not counted while it is
// off: the cost is then the only section.
function sections(key, { meta }) {
  const cost = costSection(key, meta);
  if (meta?.usage?.enabled !== true) return [cost.section];
  return [usageSection(key, meta, cost.reload), cost.section];
}

function forget() {
  usageCache.clear();
  costCache.clear();
}

function cancel() {
  util.latest.cancelPrefix(USAGE_SLOT);
  util.latest.cancelPrefix(COST_SLOT);
  for (const instances of instanceNotes) instances.destroy();
  instanceNotes.clear();
}

export const mcpUsage = Object.freeze({ sections, forget, cancel });
