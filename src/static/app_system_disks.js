// The System page's Disks section (docs/system.md "Disks"): which disk, how
// full, how quickly it grows and which databases fill it, on the selected
// server. Two answers:
//   /api/system/disks              the disks (capacity, free,
//     unreserved, keep_free_space, kind, flags, policy membership), the
//     storage policies and the bytes of each runner-visible database on
//     each disk (cached 60 s by the server);
//   /api/system/series?panel=disk_growth  each disk's used bytes
//     over the window (asynchronous_metric_log), its trend and the days
//     until its free space is gone, the MergeTree bytes, and the bytes the
//     visible databases wrote and moved (part_log); cached 5 min.
//
// The section does not redo the Explorer's database storage: a database opens
// its page, scrolled to its storage (/explorer/catalog/<db>?tab=storage). The window is the
// Observability time range picker in the tab row (from / to in the
// address, absent for the default system.disk_growth_days); no
// Auto-refresh. Each disk's card says how long its free space lasts.
//
// Fill: neutral under 80 %, warning from 80 %, danger from 90 %. Days
// until full: shown only when the disk grows over enough history (the
// server's rule), warning under 30 days, danger under 7.

import { api } from "./app_api.js";
import { dom, h } from "./app_dom.js";
import { explorerTreemap } from "./app_explorer_treemap.js";
import { format } from "./app_format.js";
import { systemCharts } from "./app_system_charts.js";
import { kit } from "./app_system_kit.js";
import { timeRange } from "./app_timerange.js";
import { badge } from "./app_ui_badge.js";
import { icon } from "./app_ui_icon.js";
import { stat } from "./app_ui_stat.js";
import { uiState } from "./app_ui_state.js";
import { table as tableMod } from "./app_ui_table.js";
import { util } from "./app_util.js";

const { $ } = dom;
const SEP = kit.SEP;
const DASH = format.EMPTY;

const SYNC_KEY = "systemDisks";
const PLOT_HEIGHT = 172;
const FILL_WARN = 0.8;
const FILL_DANGER = 0.9;
const FULL_WARN_DAYS = 30;
const FULL_DANGER_DAYS = 7;
const TOP_DATABASES = 8;
// A drag narrower than this widens around its centre.
const MIN_ZOOM_MS = 15 * 60000;

const settings = () => kit.features() || {};
const maxMinutes = () => Math.max(1, Number(settings().max_lookback_days) || 30) * 1440;
const growthDays = () => Math.max(1, Math.min(Number(settings().disk_growth_days) || 7, maxMinutes() / 1440));
const defaultRange = () => ({ from: `now-${timeRange.minutesToSpan(growthDays() * 1440)}`, to: "now" });

// --- Figures -----------------------------------------------------------------

// The share of the disk that is not free, and its tone.
function fillOf(disk) {
  const total = Number(disk?.total_space) || 0;
  if (!(total > 0)) return null;
  const used = Math.max(0, total - (Number(disk.free_space) || 0));
  const ratio = Math.min(1, used / total);
  return { used, total, ratio, tone: ratio >= FILL_DANGER ? "error" : ratio >= FILL_WARN ? "warn" : "neutral" };
}

function fillTitle(fill) {
  return `${format.percent(fill.ratio)} used (neutral under 80 %, warning from 80 %, danger from 90 %)`;
}

function daysText(days) {
  if (!Number.isFinite(days)) return DASH;
  if (days < 1) return "Under a day";
  if (days > 3650) return "Over 10 years";
  return format.countLabel(Math.round(days), "day");
}

const daysTone = (days) => (days < FULL_DANGER_DAYS ? "error" : days < FULL_WARN_DAYS ? "warn" : "");

// What the growth answer says about one disk: { text, sub, tone, status }.
function forecastOf(growth, name, growthError) {
  if (!growth) return { text: growthError ? "Unavailable" : "Loading", sub: "", tone: "", status: growthError ? "failed" : "loading" };
  const source = growth.sources?.asynchronous_metric_log;
  if (source && source.status !== "ok") {
    return { text: "Needs asynchronous_metric_log", sub: "", tone: "", status: source.status };
  }
  const disk = (growth.disks || []).find((item) => item.name === name);
  const trend = disk?.trend;
  if (!trend) return { text: "Not enough history", sub: "", tone: "", status: "not_enough_history" };
  const history = `${format.countLabel(trend.points, "sample")} over ${trend.span_seconds > 0 ? format.duration.fromSeconds(trend.span_seconds) : "0 s"}`;
  switch (trend.status) {
    case "growing":
      return {
        text: daysText(Number(trend.days_until_full)),
        sub: `+${format.bytes(trend.slope_bytes_per_day)}/day`,
        tone: daysTone(Number(trend.days_until_full)),
        status: "growing",
        title: `At the trend of the window (${history}), the free space lasts ${daysText(Number(trend.days_until_full)).toLowerCase()}. Warning under 30 days, danger under 7.`,
      };
    case "not_growing":
      return { text: "Not growing", sub: trend.slope_bytes_per_day < 0 ? `${format.bytes(trend.slope_bytes_per_day)}/day` : "flat", tone: "", status: "not_growing", title: `No growth over the window (${history}): no forecast.` };
    case "no_capacity":
      return { text: "Capacity not reported", sub: "", tone: "", status: "no_capacity" };
    default:
      return {
        text: "Not enough history",
        sub: history,
        tone: "",
        status: "not_enough_history",
        title: `A forecast needs at least ${format.countLabel(growth.limits?.trend_min_points || 6, "sample")} over ${format.duration.fromSeconds(growth.limits?.trend_min_span_seconds || 21600)}.`,
      };
  }
}

// --- Section ---------------------------------------------------------------

function createDisks(ctx) {
  const state = {
    loadedRange: null,
    disks: null,
    disksError: null,
    growth: null,
    growthError: null,
    host: "",
  };

  // The filter bar: the growth's time range, the refresh button. No
  // Auto-refresh: the disks are cached a minute, their growth 5 min.
  const controls = kit.sectionBar(ctx, { id: "disks", label: "the disks", range: "systemDisks", onRefresh: () => void load(true) });
  const pickerRoot = controls.rangeRoot;

  const notes = h("div", { class: "systemDisks__notes", id: "systemDisksNotes" });
  const tiles = h("div", { class: "systemDisks__summary", id: "systemDisksSummary" });
  const cards = h("div", { class: "systemDisks__cards", id: "systemDiskCards" });
  const growthNotes = h("div", { class: "systemDisks__growthNotes", id: "systemDiskGrowthNotes" });
  const grid = h("div", { class: "systemPerf__grid systemDisks__charts", id: "systemDiskCharts" });
  const growthCard = h("section", { class: "systemCard systemDisks__growth", id: "systemDiskGrowth", dataset: { card: "growth" } },
    kit.cardHead("Growth"), growthNotes, grid);
  const databases = h("section", { class: "systemCard", id: "systemDiskDatabases", dataset: { card: "databases" } });
  const policies = h("section", { class: "systemCard", id: "systemDiskPolicies", dataset: { card: "policies" } });
  // The cards, the charts and the tables are h3: this h2 (under the page's h1) is for the screen reader only.
  const body = h("div", { class: "systemDisks", id: "systemDisks" }, h("h2", { class: "srOnly" }, "Disks"), notes, tiles, cards, growthCard, databases, policies);
  ctx.panel.append(body);

  const range = systemCharts.range({
    ctx,
    root: pickerRoot,
    idPrefix: "systemDisks",
    defaultRange,
    maxMinutes,
    where: "system.max_lookback_days",
    minZoomMs: MIN_ZOOM_MS,
    onChange: () => void loadGrowth(false),
    onZoom: (startMs, endMs) => charts.setZoom(startMs, endMs),
  });

  const CHARTS = [
    { id: "used", title: "Disk used", help: "Bytes used on each disk (the largest DiskUsed sample of each bucket, asynchronous_metric_log). The axis follows the data, not zero: the slope is the growth." },
    { id: "merge_tree", title: "MergeTree data", help: "Bytes of the MergeTree tables' active parts on this server (TotalBytesOfMergeTreeTables, asynchronous_metric_log)." },
    { id: "written", title: "Written and moved", help: "Bytes of the new parts the runner-visible databases wrote (inserts) and of the parts moved between disks by TTL or the storage policy (part_log). The tooltip adds the moves." },
  ];
  // The growth charts, built once; each holds its chart once drawn.
  const charts = systemCharts.grid({
    root: grid,
    specs: CHARTS,
    idPrefix: "systemDiskChart",
    cardClass: (spec) => `systemChart systemDisks__chart--${spec.id}`,
    syncKey: SYNC_KEY,
    height: PLOT_HEIGHT,
    onZoom: range.zoom,
    empty: true,
  });

  // --- Loading -------------------------------------------------------------

  // The reads in flight, by name: each is the newest of its slot (util.latest). A read that was replaced or cut by a
  // host change leaves this set alone, so the busy state follows the reads that are really running.
  const inflight = new Set();

  async function loadDisks(force, host) {
    const req = util.latest("system.disks");
    inflight.add("disks");
    renderStatus();
    let data = null;
    let error = null;
    try {
      data = await api.getSystemDisks(host, force, { signal: req.signal });
    } catch (e) {
      error = e;
    }
    if (!req.isCurrent() || kit.hostId() !== host) return;
    inflight.delete("disks");
    renderStatus();
    if (data) { state.disks = data; state.disksError = null; } else state.disksError = error;
    state.host = host;
    render();
  }

  async function loadGrowth(force, host = kit.hostId()) {
    if (!host) return;
    const resolved = range.check();
    const invalid = resolved.error;
    if (invalid) {
      // The range on screen is not the one that a read in flight was asked for: that read stops, so its answer
      // never replaces this message with the data of another range.
      util.latest.cancel("system.diskgrowth");
      inflight.delete("growth");
      state.growthError = new Error(invalid);
      state.growth = null;
      render();
      return;
    }
    const req = util.latest("system.diskgrowth");
    inflight.add("growth");
    renderStatus();
    let data = null;
    let error = null;
    try {
      data = await api.getSystemDiskGrowth(host, { fromMs: resolved.startMs, toMs: Math.min(resolved.endMs, Date.now()) }, force, { signal: req.signal });
    } catch (e) {
      error = e;
    }
    if (!req.isCurrent() || kit.hostId() !== host) return;
    inflight.delete("growth");
    renderStatus();
    state.loadedRange = { ...range.value };
    if (data) { state.growth = data; state.growthError = null; } else { state.growth = null; state.growthError = error; }
    state.host = host;
    render();
  }

  function load(force = false) {
    const host = kit.hostId();
    if (!host) return Promise.resolve();
    state.host = host;
    return Promise.all([loadDisks(force, host), loadGrowth(force, host)]);
  }

  // --- Rendering -----------------------------------------------------------

  function renderStatus() {
    const loading = inflight.size > 0;
    uiState.busy(controls.button, loading);
    uiState.busy(body, loading && !state.disks);
  }

  function render() {
    renderStatus();
    range.picker.refresh();
    const data = state.disks;
    const children = [];
    if (state.disksError) {
      children.push(uiState.banner(h("div"), { message: util.errorText(state.disksError, "The disks are unavailable."), retry: () => void load(true), inset: true }));
    }
    if (data) for (const issue of data.unavailable_panels || []) if (issue.panel === "disks") children.push(kit.issueBlock(issue));
    h.replace(notes, children);
    notes.hidden = !children.length;
    if (!data) {
      h.replace(tiles);
      h.replace(cards, state.disksError ? null : uiState.block("loading", { label: "Loading the disks\u2026", compact: true }));
      databases.hidden = true;
      policies.hidden = true;
      renderGrowth();
      return;
    }
    renderTiles(data);
    renderCards(data);
    renderGrowth();
    renderDatabases(data);
    renderPolicies(data);
  }

  function usageOf(data, disk) {
    return data.usage?.disks?.[disk] || null;
  }

  function renderTiles(data) {
    const disks = data.disks || [];
    const fills = disks.map((disk) => ({ disk, fill: fillOf(disk) })).filter((item) => item.fill);
    fills.sort((a, b) => b.fill.ratio - a.fill.ratio);
    const fullest = fills[0] || null;
    const policyCount = (data.policies || []).length;
    const totals = data.usage?.disks || {};
    const bytes = Object.values(totals).reduce((sum, item) => sum + (Number(item.bytes) || 0), 0);
    const parts = Object.values(totals).reduce((sum, item) => sum + (Number(item.parts) || 0), 0);
    const items = [
      { label: "Disks", value: format.count(disks.length), sub: (data.unavailable_panels || []).some((issue) => issue.panel === "policies") ? "storage policies unreadable" : format.countLabel(policyCount, "storage policy", "storage policies"), attrs: { "data-tile": "disks" } },
      fullest
        ? { label: "Fullest", value: format.percent(fullest.fill.ratio), sub: fullest.disk.name, tone: fullest.fill.tone === "neutral" ? "" : fullest.fill.tone, title: fillTitle(fullest.fill), attrs: { "data-tile": "fullest", "data-fill": fullest.fill.tone } }
        : { label: "Fullest", value: DASH, sub: "no disk reports its capacity", attrs: { "data-tile": "fullest" } },
      { label: "ClickHouse data", value: format.bytes(bytes), sub: `${format.countLabel(parts, "active part")} of the visible databases`, attrs: { "data-tile": "data" } },
    ];
    h.replace(tiles, h("div", { class: "statTiles statTiles--boxed systemDisks__tiles", role: "group", aria: { label: "Disks" } }, items.map((item) => stat.tile(item))));
  }

  function flagBadges(disk) {
    const out = [];
    if (disk.type) out.push(badge.el(disk.type, { tone: "neutral", title: "Disk type (system.disks.type)", attrs: { "data-flag": "type" } }));
    if (disk.object_storage_type && disk.object_storage_type !== "None") out.push(badge.el(disk.object_storage_type, { tone: "neutral", title: "Object storage", attrs: { "data-flag": "object-storage" } }));
    if (disk.is_remote) out.push(badge.el("Remote", { tone: "neutral", attrs: { "data-flag": "remote" } }));
    if (disk.is_encrypted) out.push(badge.el("Encrypted", { tone: "neutral", attrs: { "data-flag": "encrypted" } }));
    if (disk.is_read_only) out.push(badge.el("Read-only", { tone: "warn", attrs: { "data-flag": "read-only" } }));
    if (disk.is_broken) out.push(badge.el("Broken", { tone: "error", title: "ClickHouse could not access this disk at startup", attrs: { "data-flag": "broken" } }));
    return out;
  }

  function fact(key, label, value, { mono = false, title = "", tone = "", sub = "" } = {}) {
    return h("div", { class: "systemDisk__fact", dataset: { fact: key, tone: tone || null }, title: title || null },
      h("dt", { class: "systemDisk__key" }, label),
      h("dd", { class: ["systemDisk__value", mono && "mono"] }, value, sub ? h("span", { class: "systemDisk__sub" }, sub) : null));
  }

  // Disks on one filesystem (the default disk and disks under its path,
  // the same device): the same capacity and free space, to the MiB (two
  // reads of a busy disk differ by what was written between them). They
  // share one card: its fill, free space and forecast once, then each
  // disk's own data, path and policies.
  const SAME_FREE_BYTES = 2 ** 20;
  const isLocal = (disk) => !disk.is_remote && !(disk.object_storage_type && disk.object_storage_type !== "None") && Number(disk.total_space) > 0;
  function filesystems(disks) {
    const groups = [];
    for (const disk of disks) {
      const same = isLocal(disk) ? groups.find((group) => {
        const first = group[0];
        return isLocal(first) && Number(first.total_space) === Number(disk.total_space) && String(first.type || "") === String(disk.type || "")
          && Math.abs((Number(first.free_space) || 0) - (Number(disk.free_space) || 0)) <= SAME_FREE_BYTES;
      }) : null;
      if (same) same.push(disk);
      else groups.push([disk]);
    }
    return groups;
  }

  // The forecast of a filesystem: the soonest full of its disks (one device,
  // one free space: their trends agree but for the samples they have).
  function groupForecast(group) {
    const days = (disk) => Number((state.growth?.disks || []).find((item) => item.name === disk.name)?.trend?.days_until_full);
    const list = group.map((disk) => ({ disk, forecast: forecastOf(state.growth, disk.name, state.growthError) }));
    const growing = list.filter((item) => item.forecast.status === "growing").sort((a, b) => days(a.disk) - days(b.disk));
    return (growing[0] || list[0]).forecast;
  }

  // A path breaks after a "/", never inside a segment: <wbr> after each slash (else "/var/lib/clickhouse/disks/fixture_" and
  // "hot/" on two lines).
  const pathNodes = (path) => String(path).split(/(?<=\/)/).flatMap((part, index) => (index ? [h("wbr"), part] : [part]));

  // A disk's own facts: its share of the visible data, its path and policies.
  function diskFacts(data, disk) {
    const usage = usageOf(data, disk.name);
    return [
      fact("data", "ClickHouse data", usage ? format.bytes(usage.bytes) : format.bytes(0), { sub: usage ? `${format.countLabel(usage.parts, "part")}${SEP}${format.countLabel(usage.databases, "database")}` : "no active part of a visible database" }),
      fact("path", "Path", disk.path ? pathNodes(disk.path) : DASH, { mono: true, title: disk.path || "" }),
      disk.cache_path ? fact("cache", "Cache path", pathNodes(disk.cache_path), { mono: true, title: disk.cache_path }) : null,
      fact("policies", "Policies", (disk.policies || []).length
        ? (disk.policies || []).map((item, index) => [index ? ", " : "", h("span", { class: "mono" }, `${item.policy} / ${item.volume}`)])
        : "In no storage policy", { title: "Storage policy / volume" }),
    ];
  }

  function renderCards(data) {
    const disks = data.disks || [];
    if (!disks.length) {
      h.replace(cards, data.unavailable_panels?.some((issue) => issue.panel === "disks") ? null
        : uiState.block("empty", { title: "No disk", body: "system.disks lists no disk.", compact: true }));
      return;
    }
    const list = filesystems(disks).map((group) => {
      const disk = group[0];
      const shared = group.length > 1;
      const names = group.map((item) => item.name);
      const fill = fillOf(disk);
      const usage = shared ? null : usageOf(data, disk.name);
      const forecast = groupForecast(group);
      const head = h("header", { class: "systemDisk__head" },
        h("h3", { class: "systemDisk__name mono" }, shared ? names.join(", ") : disk.name),
        shared ? h("span", { class: "systemDisk__group", title: "These disks report the same capacity and free space: one device" }, `${format.count(group.length)} disks, one filesystem`) : null,
        h("span", { class: "systemDisk__flags" }, flagBadges(disk)));
      const meter = h("div", { class: "systemDisk__meter", dataset: { fill: fill ? fill.tone : "unknown" } });
      let summary;
      if (fill) {
        tableMod.shareBar(meter, Math.max(fill.ratio > 0 ? 1 : 0, fill.ratio * 100), format.percent(fill.ratio));
        meter.title = fillTitle(fill);
        summary = `${format.bytes(fill.used)} used of ${format.bytes(fill.total)}`;
      } else {
        h.replace(meter, h("span", { class: "systemDisk__noCapacity" }, "Capacity not reported"));
        summary = usage ? `${format.bytes(usage.bytes)} of active parts (the visible databases)` : "Object storage reports no capacity";
      }
      // Space reserved by merges, mutations and fetches on any of the disks
      // is gone from the filesystem's free space.
      const reserved = group.reduce((sum, item) => sum + (item.unreserved_space == null ? 0 : Math.max(0, (Number(item.free_space) || 0) - Number(item.unreserved_space))), 0);
      const unreserved = group.every((item) => item.unreserved_space == null) ? null : Math.max(0, (Number(disk.free_space) || 0) - reserved);
      const facts = [
        fact("free", "Free", fill ? format.bytes(disk.free_space) : DASH, { title: "free_space: what ClickHouse may still write (keep_free_space excluded)" }),
        fact("unreserved", "Unreserved", unreserved == null ? DASH : format.bytes(unreserved), { title: "unreserved_space: free space not reserved by merges, mutations and fetches in progress" }),
        fact("keep_free", "Keep free", disk.keep_free_space == null ? DASH : format.bytes(disk.keep_free_space), { title: "keep_free_space_bytes: kept free by the server configuration" }),
        fact("until_full", "Until full", forecast.text, { tone: forecast.tone, sub: forecast.sub, title: forecast.title || "" }),
      ];
      const card = h("section", {
        class: ["systemDisk", shared && "is-group"],
        dataset: { disks: names.join(" "), disk: shared ? null : disk.name, fill: fill ? fill.tone : "unknown" },
        aria: { label: shared ? `Disks ${names.join(", ")} (one filesystem)` : `Disk ${disk.name}` },
      });
      card.appendChild(h("div", { class: "systemDisk__main" }, head, meter, h("p", { class: "systemDisk__summary" }, summary),
        h("dl", { class: "systemDisk__facts" }, facts, shared ? null : diskFacts(data, disk))));
      if (shared) {
        card.appendChild(h("div", { class: "systemDisk__members", role: "list" }, group.map((item) =>
          h("div", { class: "systemDisk__member", role: "listitem", dataset: { disk: item.name }, aria: { label: `Disk ${item.name}` } },
            h("h4", { class: "systemDisk__memberName mono" }, item.name),
            h("dl", { class: "systemDisk__facts" }, diskFacts(data, item))))));
      }
      return card;
    });
    const note = data.disks_truncated ? h("p", { class: "systemCard__note" }, `The first ${format.count(data.limits?.disk_row_limit || 200)} disks.`) : null;
    h.replace(cards, list, note);
  }

  // --- Growth --------------------------------------------------------------

  function renderGrowth() {
    const data = state.growth;
    const children = [];
    if (state.growthError) {
      children.push(uiState.banner(h("div"), { message: util.errorText(state.growthError, "The disk growth is unavailable."), retry: () => void loadGrowth(true), inset: true }));
    }
    const asyncSource = data?.sources?.asynchronous_metric_log;
    const partSource = data?.sources?.part_log;
    const noAsync = !!asyncSource && asyncSource.status !== "ok";
    if (noAsync) {
      const text = asyncSource.status === "disabled"
        ? "Growth needs system.asynchronous_metric_log (server configuration): the days until full need it too."
        : "";
      children.push(kit.issueBlock({ panel: "asynchronous_metric_log", table: "asynchronous_metric_log", reason: asyncSource.status, message: asyncSource.message, hint: asyncSource.hint, text }));
    }
    if (partSource && !["ok", "disabled"].includes(partSource.status)) {
      children.push(kit.issueBlock({ panel: "part_log", table: "part_log", reason: partSource.status, message: partSource.message, hint: partSource.hint }));
    }
    const disksSource = data?.sources?.disks;
    if (disksSource && disksSource.status !== "ok") {
      children.push(kit.issueBlock({ panel: "disks", table: "disks", reason: disksSource.status, message: disksSource.message, hint: disksSource.hint }));
    }
    if (data && !noAsync && (data.disks || []).length && data.disks.every((disk) => disk.trend?.status === "not_enough_history")) {
      const sample = forecastOf(data, data.disks[0].name, null);
      const need = `${format.countLabel(data.limits?.trend_min_points || 6, "sample")} over ${format.duration.fromSeconds(data.limits?.trend_min_span_seconds || 21600)}`;
      children.push(h("p", { class: "systemCard__note", id: "systemDiskHistoryNote" },
        `Not enough history for a forecast: it needs at least ${need}, the window holds ${sample.sub}. Widen the time range.`));
    }
    h.replace(growthNotes, children);
    growthNotes.hidden = !children.length;
    if (!data) {
      for (const entry of charts.entries.values()) entry.card.hidden = true;
      if (!state.growthError) h.replace(growthNotes, uiState.block("loading", { label: "Loading the disk growth\u2026", compact: true }));
      growthNotes.hidden = false;
      return;
    }
    const xs = Float64Array.from(data.timestamps || [], Number);
    const step = Number(data.step_seconds || 0) * 1000;
    const slots = (data.disks || []).map((disk, index) => `var(--qchart-${(index % 8) + 1})`);
    const growingDisks = (data.disks || []).filter((disk) => disk.trend?.status === "growing").sort((a, b) => a.trend.days_until_full - b.trend.days_until_full);
    const written = systemCharts.column(data.series?.written_bytes, xs.length);
    const moved = systemCharts.column(data.series?.moved_bytes, xs.length);
    const moves = systemCharts.column(data.series?.moves, xs.length);
    const sum = (values) => { let total = 0; for (const v of values) if (v === v) total += v; return total; };
    const mergeTree = systemCharts.column(data.series?.merge_tree_bytes, xs.length);
    let lastMergeTree = NaN;
    for (let i = mergeTree.length - 1; i >= 0; i--) if (mergeTree[i] === mergeTree[i]) { lastMergeTree = mergeTree[i]; break; }
    // Disks on one filesystem report the same used bytes: one line for them, named after all of them. The
    // filesystems are the cards' (same capacity, same free space): their samples may differ by a few bytes, so
    // two lines would lie on each other and the legend would name a colour nobody sees.
    const filesystemOf = new Map();
    for (const group of filesystems(state.disks?.disks || [])) for (const disk of group) filesystemOf.set(disk.name, group[0].name);
    const lines = [];
    for (const disk of data.disks || []) {
      const key = filesystemOf.has(disk.name) ? `fs:${filesystemOf.get(disk.name)}` : `${disk.total_space}|${(disk.used || []).join(",")}`;
      const same = lines.find((line) => line.key === key);
      if (same) same.names.push(disk.name);
      else lines.push({ key, names: [disk.name], values: systemCharts.column(disk.used, xs.length) });
    }
    const specs = {
      used: noAsync ? null : {
        series: lines.map((line, index) => ({
          id: `disk:${line.names[0]}`,
          label: line.names.length > 1 ? `${line.names.join(", ")} (one filesystem)` : line.names[0],
          color: slots[index],
          values: line.values,
          nulls: null,
        })),
        yAxis: systemCharts.bytesAxis(false),
        meta: growingDisks.length ? `${growingDisks[0].name} +${format.bytes(growingDisks[0].trend.slope_bytes_per_day)}/day` : "",
      },
      merge_tree: noAsync ? null : {
        series: [{ id: "merge_tree_bytes", label: "MergeTree tables", color: "var(--qchart-1)", values: mergeTree, nulls: null }],
        yAxis: systemCharts.bytesAxis(false),
        meta: Number.isFinite(lastMergeTree) ? `now ${format.bytes(lastMergeTree)}` : "",
      },
      // Hidden without part_log (or without a visible database's rows).
      written: !partSource || partSource.status !== "ok" ? null : {
        type: "bar",
        stack: true,
        series: [
          { id: "written_bytes", label: "Written", color: "var(--qchart-1)", values: written, nulls: null },
          { id: "moved_bytes", label: "Moved", color: "var(--qchart-3)", values: moved, nulls: null },
        ],
        yAxis: systemCharts.bytesAxis(true),
        meta: `${format.bytes(sum(written))} written${SEP}${format.bytes(sum(moved))} moved`,
        footer: (i) => (moves[i] > 0 ? format.countLabel(moves[i], "part move") : ""),
      },
    };
    for (const [id, entry] of charts.entries) drawChart(entry, specs[id], xs, step);
    // Written and moved takes the row when it has no neighbour.
    charts.entries.get("written").card.classList.toggle("is-alone", charts.entries.get("merge_tree").card.hidden);
  }

  function drawChart(entry, spec, xs, step) {
    if (!spec || !spec.series.length) {
      entry.card.hidden = true;
      return;
    }
    entry.card.hidden = false;
    util.setMetaLine(entry.meta, spec.meta || "");
    charts.draw(entry, {
      xs,
      step,
      series: spec.series,
      type: spec.type || "line",
      stack: !!spec.stack,
      yInclude: [],
      yAxis: spec.yAxis,
      yUnit: (maxAbs) => systemCharts.byteUnit(maxAbs),
      formatValue: (v) => format.bytes(v),
      footer: spec.footer,
    });
  }

  // --- Bytes by database -----------------------------------------------------

  // A database's link: its Explorer page, scrolled to its storage.
  function databaseLink(name, { className = "", label = null } = {}) {
    const href = ctx.databaseHref(name, { tab: "storage" });
    const link = h(href ? "a" : "button", {
      class: ["systemDiskDb__link", className],
      href: href || null,
      type: href ? null : "button",
      title: `Open the storage of ${name} in the Explorer`,
      dataset: { database: name },
    }, label ?? [icon.el("database", { size: "sm" }), h("span", { class: "mono" }, name)]);
    link.addEventListener("click", (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      ctx.openDatabase(name, { tab: "storage" });
    });
    return link;
  }

  function renderDatabases(data) {
    databases.hidden = false;
    const issues = (data.unavailable_panels || []).filter((issue) => issue.panel === "usage");
    const rows = data.usage?.rows || [];
    const totals = data.usage?.disks || {};
    const names = new Set(rows.map((row) => row.database));
    const head = kit.cardHead("Bytes by database", names.size ? format.countLabel(names.size, "database") : "");
    if (issues.length) {
      h.replace(databases, head, issues.map((issue) => kit.issueBlock(issue)));
      return;
    }
    if (!rows.length) {
      h.replace(databases, head, uiState.block("empty", { title: "No data on disk", body: "No database the runner can see has active parts.", compact: true }));
      return;
    }
    const disks = Object.keys(totals).sort((a, b) => (Number(totals[b].bytes) || 0) - (Number(totals[a].bytes) || 0) || (a < b ? -1 : 1));
    const blocks = disks.map((disk) => {
      const total = Number(totals[disk].bytes) || 0;
      const own = rows.filter((row) => row.disk === disk).sort((a, b) => Number(b.bytes) - Number(a.bytes));
      const top = own.slice(0, TOP_DATABASES);
      const listed = top.reduce((sum, row) => sum + Number(row.bytes || 0), 0);
      const others = Math.max(0, total - listed);
      const othersCount = Math.max(0, (Number(totals[disk].databases) || own.length) - top.length);
      const share = (bytes) => (total > 0 ? bytes / total : 0);
      // The disk's share strip: the size band of the Explorer and the
      // Overview (ns.explorerTreemap.band, one colour rule), always a strip
      // here; a click opens the database's storage. The table under it
      // names the databases (its legend).
      const strip = h("div", { class: "systemDiskDb__strip" });
      explorerTreemap?.band(strip, {
        tree: { kind: "server", name: disk, bytes: total, count: Math.max(own.length, Number(totals[disk].databases) || 0), children: top.map((row) => ({ kind: "database", name: row.database, path: row.database, database: row.database, bytes: Number(row.bytes) || 0, count: 1 })) },
        name: disk,
        ariaLabel: `Databases on ${disk}`,
        strip: "always",
        legend: false,
        onOpen: (target) => ctx.openDatabase(target.database, { tab: "storage" }),
      });
      const tableRows = top.map((row) => {
        const shareCell = h("td", { class: "systemDiskDb__share" });
        tableMod.shareBar(shareCell, share(Number(row.bytes)) * 100, format.percent(share(Number(row.bytes))));
        return h("tr", { dataset: { database: row.database } },
          h("td", { class: "systemDiskDb__name" }, h("span", { class: "systemDiskDb__cell" }, databaseLink(row.database))),
          h("td", { class: "num" }, format.bytes(row.bytes)),
          shareCell,
          h("td", { class: "num is-mid", title: Number(row.compact_parts) ? `${format.count(row.compact_parts)} compact` : null }, format.count(row.parts)));
      });
      if (others > 0 || othersCount > 0) {
        const shareCell = h("td", { class: "systemDiskDb__share" });
        tableMod.shareBar(shareCell, share(others) * 100, format.percent(share(others)));
        tableRows.push(h("tr", { class: "is-other" },
          h("td", { class: "systemDiskDb__name" }, h("span", { class: "systemDiskDb__cell" }, `Others (${format.countLabel(othersCount, "database")})`)),
          h("td", { class: "num" }, format.bytes(others)), shareCell, h("td", { class: "num is-mid" }, DASH)));
      }
      const table = h("table", { class: "dataTable dataTable--compact systemTable systemDiskDb__table", id: `systemDiskDb-${disk.replace(/[^A-Za-z0-9_-]/g, "_")}` },
        h("thead", null, h("tr", null,
          h("th", { scope: "col" }, "Database"),
          h("th", { scope: "col", class: "num" }, "Size"),
          h("th", { scope: "col", class: "systemDiskDb__share" }, "Share of the disk"),
          h("th", { scope: "col", class: "num is-mid" }, "Parts"))),
        h("tbody", null, tableRows));
      return h("div", { class: "systemDiskDb", dataset: { disk } },
        h("div", { class: "systemDiskDb__head" },
          h("span", { class: "systemDiskDb__disk mono" }, disk),
          h("span", { class: "systemDiskDb__total" }, `${format.bytes(total)}${SEP}${format.countLabel(Number(totals[disk].databases) || own.length, "database")}${SEP}${format.countLabel(Number(totals[disk].parts) || 0, "part")}`)),
        strip,
        tableMod.scrollCues(h("div", { class: "dataTableWrap" }, table)));
    });
    const note = h("p", { class: "systemCard__note" },
      `Active parts of the databases the runner can see (bytes on disk); a database opens on its storage in the Explorer.${data.usage?.truncated ? ` The first ${format.count(data.limits?.usage_row_limit || 1000)} rows.` : ""}`);
    h.replace(databases, head, blocks, note);
  }

  // --- Policies --------------------------------------------------------------

  function renderPolicies(data) {
    policies.hidden = false;
    const issues = (data.unavailable_panels || []).filter((issue) => issue.panel === "policies");
    const list = data.policies || [];
    const head = kit.cardHead("Storage policies", list.length ? format.countLabel(list.length, "policy", "policies") : "");
    if (issues.length) {
      h.replace(policies, head, issues.map((issue) => kit.issueBlock(issue)));
      return;
    }
    const only = list.length === 1 && list[0].name === "default" && (list[0].volumes || []).length === 1;
    if (only) {
      const disks = list[0].volumes[0].disks || [];
      h.replace(policies, head, h("p", { class: "systemDisks__single", id: "systemDiskPolicySingle" },
        "Only the ", h("span", { class: "mono" }, "default"), " policy: every MergeTree table writes to ",
        disks.map((disk, index) => [index ? ", " : "", h("span", { class: "mono" }, disk)]), "."));
      return;
    }
    const rows = [];
    for (const policy of list) {
      (policy.volumes || []).forEach((volume, index) => {
        rows.push(h("tr", { dataset: { policy: policy.name, volume: volume.name } },
          h("td", { class: "mono systemDiskPolicy__policy" }, index === 0 ? policy.name : ""),
          h("td", { class: "mono" }, volume.name, h("span", { class: "systemDiskPolicy__priority" }, ` #${format.count(volume.priority)}`)),
          h("td", { class: "mono systemDiskPolicy__disks" }, (volume.disks || []).join(", ") || DASH),
          h("td", { class: "is-mid" }, volume.volume_type || DASH),
          h("td", { class: "num is-mid", title: "max_data_part_size: larger parts go to the next volume (0: no limit)" }, volume.max_data_part_size == null ? DASH : Number(volume.max_data_part_size) > 0 ? format.bytes(volume.max_data_part_size) : "No limit"),
          h("td", { class: "num is-mid", title: "move_factor: parts move to the next volume when the free share falls under it" }, volume.move_factor == null ? DASH : format.percent(volume.move_factor)),
          h("td", { class: "is-mid", title: volume.prefer_not_to_merge ? "prefer_not_to_merge: merges avoid this volume" : null }, volume.prefer_not_to_merge ? "Avoided" : DASH)));
      });
    }
    const table = h("table", { class: "dataTable dataTable--compact systemTable systemDiskPolicy__table", id: "systemDiskPolicyTable" },
      h("thead", null, h("tr", null,
        h("th", { scope: "col" }, "Policy"),
        h("th", { scope: "col", title: "Volumes in priority order" }, "Volume"),
        h("th", { scope: "col" }, "Disks"),
        h("th", { scope: "col", class: "is-mid" }, "Type"),
        h("th", { scope: "col", class: "num is-mid" }, "Max part"),
        h("th", { scope: "col", class: "num is-mid" }, "Move factor"),
        h("th", { scope: "col", class: "is-mid", title: "prefer_not_to_merge" }, "Merging"))),
      h("tbody", null, rows));
    const note = data.policies_truncated ? h("p", { class: "systemCard__note" }, `The first ${format.count(data.limits?.policy_row_limit || 500)} volumes.`) : null;
    h.replace(policies, head, tableMod.scrollCues(h("div", { class: "dataTableWrap" }, table)), note);
  }

  function resetForHost() {
    state.disks = null;
    state.growth = null;
    state.disksError = null;
    state.growthError = null;
    util.latest.cancel("system.disks");
    util.latest.cancel("system.diskgrowth");
    inflight.clear();
    state.host = "";
    render();
  }

  return {
    // query: the address's from / to when the address opened the section.
    show(addressQuery) {
      if (addressQuery !== undefined) range.read(new URLSearchParams(String(addressQuery || "")));
      if (state.host && state.host !== kit.hostId()) resetForHost();
      range.picker.refresh();
      renderStatus();
      if (!state.disks && !inflight.size) void load(false);
      else if (!timeRange.sameRange(state.loadedRange, range.value)) void loadGrowth(false);
    },
    refresh(force = true) {
      // A Refresh while the first read runs (nothing has landed: state.host is set at launch) does not throw that
      // read away; a forced read replaces it.
      if (state.host && state.host !== kit.hostId()) resetForHost();
      void load(force);
    },
    query: range.query,
  };
}

export const systemDisks = { id: "disks", label: "Disks", available: (f) => !!f?.enabled, create: createDisks };
