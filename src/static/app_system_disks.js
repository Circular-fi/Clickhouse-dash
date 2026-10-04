(() => {
  "use strict";

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
  // The section does not redo the Explorer's Storage tab: a database opens
  // its card on that tab (/explorer/<db>?tab=storage). The window is the
  // Observability time range picker in the tab row (from / to in the
  // address, absent for the default system.disk_growth_days); no
  // Auto-refresh. Each disk's card says how long its free space lasts.
  //
  // Fill: neutral under 80 %, warning from 80 %, danger from 90 %. Days
  // until full: shown only when the disk grows over enough history (the
  // server's rule), warning under 30 days, danger under 7.

  const ns = window.ChDash;
  if (!ns || !ns.systemView) return;
  const { h } = ns;
  const { $ } = ns.dom;
  const format = ns.format;
  const kit = ns.systemView.kit;
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
  const defaultRange = () => ({ from: `now-${ns.timeRange.minutesToSpan(growthDays() * 1440)}`, to: "now" });
  const sameRange = (a, b) => String(a?.from || "") === String(b?.from || "") && String(a?.to || "") === String(b?.to || "");

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
      range: defaultRange(),
      loadedRange: null,
      resolved: null,
      disks: null,
      disksError: null,
      growth: null,
      growthError: null,
      loading: 0,
      serial: 0,
      active: false,
      host: "",
      pendingRender: false,
      charts: new Map(),
    };

    const { root: pickerRoot, wrap: range } = kit.rangePicker("systemDisks");
    // No Auto-refresh: the disks are cached a minute, their growth 5 min.
    const controls = kit.sectionBar({ id: "disks", label: "the disks", lead: range, onRefresh: () => void load(true) });
    ctx.actions.appendChild(controls.bar);

    const notes = h("div", { class: "systemDisks__notes", id: "systemDisksNotes" });
    const tiles = h("div", { class: "systemDisks__summary", id: "systemDisksSummary" });
    const cards = h("div", { class: "systemDisks__cards", id: "systemDiskCards" });
    const growthNotes = h("div", { class: "systemDisks__growthNotes", id: "systemDiskGrowthNotes" });
    const grid = h("div", { class: "systemPerf__grid systemDisks__charts", id: "systemDiskCharts" });
    const growthCard = h("section", { class: "systemCard systemDisks__growth", id: "systemDiskGrowth", dataset: { card: "growth" } },
      kit.cardHead("Growth"), growthNotes, grid);
    const databases = h("section", { class: "systemCard", id: "systemDiskDatabases", dataset: { card: "databases" } });
    const policies = h("section", { class: "systemCard", id: "systemDiskPolicies", dataset: { card: "policies" } });
    const body = h("div", { class: "systemDisks", id: "systemDisks" }, notes, tiles, cards, growthCard, databases, policies);
    ctx.panel.append(body);

    const picker = ns.timeRange.create(pickerRoot, {
      idPrefix: "systemDisks",
      getValue: () => state.range,
      getMaxMinutes: maxMinutes,
      settingName: "system.max_lookback_days",
      onApply: (raw) => {
        picker.close();
        applyRange(raw);
      },
    });

    // The growth charts, built once; each holds its chart once drawn.
    const CHARTS = [
      { id: "used", title: "Disk used", help: "Bytes used on each disk (the largest DiskUsed sample of each bucket, asynchronous_metric_log). The axis follows the data, not zero: the slope is the growth." },
      { id: "merge_tree", title: "MergeTree data", help: "Bytes of the MergeTree tables' active parts on this server (TotalBytesOfMergeTreeTables, asynchronous_metric_log)." },
      { id: "written", title: "Written and moved", help: "Bytes of the new parts the runner-visible databases wrote (inserts) and of the parts moved between disks by TTL or the storage policy (part_log). The tooltip adds the moves." },
    ];
    for (const spec of CHARTS) {
      const card = h.html(ns.ui.chartCardHtml({
        title: spec.title,
        className: `systemChart systemDisks__chart--${spec.id}`,
        id: `systemDiskChart-${spec.id}`,
        bodyClass: "systemChart__body",
        attrs: { "data-chart": spec.id },
      })).firstElementChild;
      $(".chartCard__title", card).title = spec.help;
      const plot = h("div", { class: "systemChart__plot" });
      const empty = h("div", { class: "systemChart__empty", hidden: true });
      $(".chartCard__body", card).append(plot, empty);
      card.hidden = true;
      grid.appendChild(card);
      state.charts.set(spec.id, { spec, card, plot, empty, meta: $(".chartCard__meta", card), chart: null });
    }


    // --- Address and range -------------------------------------------------

    function query() {
      if (sameRange(state.range, defaultRange())) return "";
      return ns.timeRange.url.write(new URLSearchParams(), state.range).toString();
    }

    function applyRange(raw, { history = "push" } = {}) {
      const next = { from: String(raw.from), to: String(raw.to) };
      if (sameRange(next, state.range)) {
        void loadGrowth(false);
        return;
      }
      state.range = next;
      picker.refresh();
      ctx.setQuery(query(), { history });
      void loadGrowth(false);
    }

    function onZoom(windowMs, fromUser) {
      if (!fromUser || !windowMs) return;
      let startMs = Math.floor(windowMs[0] / 1000) * 1000;
      let endMs = Math.ceil(windowMs[1] / 1000) * 1000;
      if (endMs - startMs < MIN_ZOOM_MS) {
        const centre = (startMs + endMs) / 2;
        startMs = Math.floor((centre - MIN_ZOOM_MS / 2) / 1000) * 1000;
        endMs = startMs + MIN_ZOOM_MS;
      }
      for (const entry of state.charts.values()) entry.chart?.setZoom(startMs, endMs);
      applyRange({ from: ns.timeRange.formatDateTime(startMs), to: ns.timeRange.formatDateTime(endMs) });
    }

    // --- Loading -------------------------------------------------------------

    function settle(serial, host) {
      if (serial !== state.serial || kit.hostId() !== host) return false;
      state.host = host;
      // An answer that lands while the section is hidden draws on its next show.
      if (!state.active) {
        state.pendingRender = true;
        return false;
      }
      return true;
    }

    async function loadDisks(force, serial, host) {
      state.loading += 1;
      renderStatus();
      let data = null;
      let error = null;
      try {
        data = await ns.api.getSystemDisks(host, force);
      } catch (e) {
        error = e;
      }
      state.loading = Math.max(0, state.loading - 1);
      if (serial !== state.serial || kit.hostId() !== host) return;
      if (data) { state.disks = data; state.disksError = null; } else state.disksError = error;
      if (settle(serial, host)) render();
    }

    async function loadGrowth(force, serial = state.serial, host = kit.hostId()) {
      if (!host) return;
      const resolved = ns.timeRange.resolveRange(state.range, Date.now());
      if (!Number.isFinite(resolved.startMs) || !Number.isFinite(resolved.endMs) || resolved.endMs <= resolved.startMs) {
        state.growthError = new Error("Select a valid time range.");
        state.growth = null;
        render();
        return;
      }
      if (resolved.endMs - resolved.startMs > maxMinutes() * 60000) {
        state.growthError = new Error(`Max range is ${ns.timeRange.formatMinutes(maxMinutes())} (system.max_lookback_days).`);
        state.growth = null;
        render();
        return;
      }
      const growthSerial = (state.growthSerial = (state.growthSerial || 0) + 1);
      state.loading += 1;
      renderStatus();
      let data = null;
      let error = null;
      try {
        data = await ns.api.getSystemDiskGrowth(host, { fromMs: resolved.startMs, toMs: Math.min(resolved.endMs, Date.now()) }, force);
      } catch (e) {
        error = e;
      }
      state.loading = Math.max(0, state.loading - 1);
      if (serial !== state.serial || growthSerial !== state.growthSerial || kit.hostId() !== host) return;
      state.resolved = resolved;
      state.loadedRange = { ...state.range };
      if (data) { state.growth = data; state.growthError = null; } else { state.growth = null; state.growthError = error; }
      if (settle(serial, host)) render();
    }

    function load(force = false) {
      const host = kit.hostId();
      if (!host) return Promise.resolve();
      const serial = ++state.serial;
      return Promise.all([loadDisks(force, serial, host), loadGrowth(force, serial, host)]);
    }

    // --- Rendering -----------------------------------------------------------

    function renderStatus() {
      const loading = state.loading > 0;
      ns.uiState.busy(controls.button, loading);
      ns.uiState.busy(body, loading && !state.disks);
    }


    function render() {
      state.pendingRender = false;
      renderStatus();
      picker.refresh();
      const data = state.disks;
      const children = [];
      if (state.disksError) {
        children.push(ns.uiState.banner(h("div"), { message: ns.util.errorText(state.disksError, "The disks are unavailable."), retry: () => void load(true), inset: true }));
      }
      if (data) for (const issue of data.unavailable_panels || []) if (issue.panel === "disks") children.push(kit.issueBlock(issue));
      h.replace(notes, children);
      notes.hidden = !children.length;
      if (!data) {
        h.replace(tiles);
        h.replace(cards, state.disksError ? null : ns.uiState.block("loading", { label: "Loading the disks\u2026", compact: true }));
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
      h.replace(tiles, h("div", { class: "statTiles statTiles--boxed systemDisks__tiles", role: "group", aria: { label: "Disks" } }, items.map((item) => ns.ui.statTile(item))));
    }

    function flagBadges(disk) {
      const out = [];
      if (disk.type) out.push(ns.badge.el(disk.type, { tone: "neutral", title: "Disk type (system.disks.type)", attrs: { "data-flag": "type" } }));
      if (disk.object_storage_type && disk.object_storage_type !== "None") out.push(ns.badge.el(disk.object_storage_type, { tone: "neutral", title: "Object storage", attrs: { "data-flag": "object-storage" } }));
      if (disk.is_remote) out.push(ns.badge.el("Remote", { tone: "neutral", attrs: { "data-flag": "remote" } }));
      if (disk.is_encrypted) out.push(ns.badge.el("Encrypted", { tone: "neutral", attrs: { "data-flag": "encrypted" } }));
      if (disk.is_read_only) out.push(ns.badge.el("Read-only", { tone: "warn", attrs: { "data-flag": "read-only" } }));
      if (disk.is_broken) out.push(ns.badge.el("Broken", { tone: "error", title: "ClickHouse could not access this disk at startup", attrs: { "data-flag": "broken" } }));
      return out;
    }

    function fact(key, label, value, { mono = false, title = "", tone = "", sub = "" } = {}) {
      return h("div", { class: "systemDisk__fact", dataset: { fact: key, tone: tone || null }, title: title || null },
        h("dt", { class: "systemDisk__key" }, label),
        h("dd", { class: ["systemDisk__value", mono && "mono"] }, value, sub ? h("span", { class: "systemDisk__sub" }, sub) : null));
    }

    function renderCards(data) {
      const disks = data.disks || [];
      if (!disks.length) {
        h.replace(cards, data.unavailable_panels?.some((issue) => issue.panel === "disks") ? null
          : ns.uiState.block("empty", { title: "No disk", body: "system.disks lists no disk.", compact: true }));
        return;
      }
      const list = disks.map((disk) => {
        const fill = fillOf(disk);
        const usage = usageOf(data, disk.name);
        const forecast = forecastOf(state.growth, disk.name, state.growthError);
        const head = h("header", { class: "systemDisk__head" },
          h("h4", { class: "systemDisk__name mono" }, disk.name),
          h("span", { class: "systemDisk__flags" }, flagBadges(disk)));
        const meter = h("div", { class: "systemDisk__meter", dataset: { fill: fill ? fill.tone : "unknown" } });
        let summary;
        if (fill) {
          ns.table.shareBar(meter, Math.max(fill.ratio > 0 ? 1 : 0, fill.ratio * 100), format.percent(fill.ratio));
          meter.title = fillTitle(fill);
          summary = `${format.bytes(fill.used)} used of ${format.bytes(fill.total)}`;
        } else {
          h.replace(meter, h("span", { class: "systemDisk__noCapacity" }, "Capacity not reported"));
          summary = usage ? `${format.bytes(usage.bytes)} of active parts (the visible databases)` : "Object storage reports no capacity";
        }
        const facts = [
          fact("free", "Free", fill ? format.bytes(disk.free_space) : DASH, { title: "free_space: what ClickHouse may still write (keep_free_space excluded)" }),
          fact("unreserved", "Unreserved", disk.unreserved_space == null ? DASH : format.bytes(disk.unreserved_space), { title: "unreserved_space: free space not reserved by merges, mutations and fetches in progress" }),
          fact("keep_free", "Keep free", disk.keep_free_space == null ? DASH : format.bytes(disk.keep_free_space), { title: "keep_free_space_bytes: kept free by the server configuration" }),
          fact("until_full", "Until full", forecast.text, { tone: forecast.tone, sub: forecast.sub, title: forecast.title || "" }),
          fact("data", "ClickHouse data", usage ? format.bytes(usage.bytes) : format.bytes(0), { sub: usage ? `${format.countLabel(usage.parts, "part")}${SEP}${format.countLabel(usage.databases, "database")}` : "no active part of a visible database" }),
          fact("path", "Path", disk.path || DASH, { mono: true }),
          disk.cache_path ? fact("cache", "Cache path", disk.cache_path, { mono: true }) : null,
          fact("policies", "Policies", (disk.policies || []).length
            ? (disk.policies || []).map((item, index) => [index ? ", " : "", h("span", { class: "mono" }, `${item.policy} / ${item.volume}`)])
            : "In no storage policy", { title: "Storage policy / volume" }),
        ];
        return h("section", { class: "systemDisk", dataset: { disk: disk.name, fill: fill ? fill.tone : "unknown" }, aria: { label: `Disk ${disk.name}` } },
          head, meter, h("p", { class: "systemDisk__summary" }, summary),
          h("dl", { class: "systemDisk__facts" }, facts));
      });
      const note = data.disks_truncated ? h("p", { class: "systemCard__note" }, `The first ${format.count(data.limits?.disk_row_limit || 200)} disks.`) : null;
      h.replace(cards, list, note);
    }

    // --- Growth --------------------------------------------------------------

    function column(values, length) {
      const out = new Float64Array(length);
      for (let i = 0; i < length; i++) {
        const v = values?.[i];
        out[i] = v == null ? NaN : Number(v);
      }
      return out;
    }

    function byteUnit(max) {
      for (const [factor, suffix] of [[1024 ** 4, " TB"], [1024 ** 3, " GB"], [1024 ** 2, " MB"], [1024, " KB"]]) if (max >= factor) return { factor, suffix };
      return { factor: 1, suffix: " B" };
    }

    // Round ticks in the 1024 unit. fromZero: the axis starts at 0; else it
    // follows the data, so a slow growth of a large disk still reads.
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
        const ticks = ns.chartCore.linearTicks(lo / unit.factor, hi / unit.factor, Math.max(2, Math.floor(plotH / 34)));
        const decimals = ns.chartCore.decimalsFor(ticks.step);
        return { min: lo, max: hi, step: ticks.step * unit.factor, ticks: ticks.values.map((v) => ({ v: v * unit.factor, label: v === 0 ? "0" : `${v.toFixed(decimals)}${unit.suffix}` })) };
      };
    }

    function renderGrowth() {
      const data = state.growth;
      const children = [];
      if (state.growthError) {
        children.push(ns.uiState.banner(h("div"), { message: ns.util.errorText(state.growthError, "The disk growth is unavailable."), retry: () => void loadGrowth(true), inset: true }));
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
        for (const entry of state.charts.values()) entry.card.hidden = true;
        if (!state.growthError) h.replace(growthNotes, ns.uiState.block("loading", { label: "Loading the disk growth\u2026", compact: true }));
        growthNotes.hidden = false;
        return;
      }
      const xs = Float64Array.from(data.timestamps || [], Number);
      const step = Number(data.step_seconds || 0) * 1000;
      const slots = (data.disks || []).map((disk, index) => `var(--qchart-${(index % 8) + 1})`);
      const growingDisks = (data.disks || []).filter((disk) => disk.trend?.status === "growing").sort((a, b) => a.trend.days_until_full - b.trend.days_until_full);
      const written = column(data.series?.written_bytes, xs.length);
      const moved = column(data.series?.moved_bytes, xs.length);
      const moves = column(data.series?.moves, xs.length);
      const sum = (values) => { let total = 0; for (const v of values) if (v === v) total += v; return total; };
      const mergeTree = column(data.series?.merge_tree_bytes, xs.length);
      let lastMergeTree = NaN;
      for (let i = mergeTree.length - 1; i >= 0; i--) if (mergeTree[i] === mergeTree[i]) { lastMergeTree = mergeTree[i]; break; }
      // Disks on one filesystem report the same used bytes: one line for
      // them, named after all of them.
      const lines = [];
      for (const disk of data.disks || []) {
        const key = `${disk.total_space}|${(disk.used || []).join(",")}`;
        const same = lines.find((line) => line.key === key);
        if (same) same.names.push(disk.name);
        else lines.push({ key, names: [disk.name], values: column(disk.used, xs.length) });
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
          yAxis: bytesAxis(false),
          meta: growingDisks.length ? `${growingDisks[0].name} +${format.bytes(growingDisks[0].trend.slope_bytes_per_day)}/day` : "",
        },
        merge_tree: noAsync ? null : {
          series: [{ id: "merge_tree_bytes", label: "MergeTree tables", color: "var(--qchart-1)", values: mergeTree, nulls: null }],
          yAxis: bytesAxis(false),
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
          yAxis: bytesAxis(true),
          meta: `${format.bytes(sum(written))} written${SEP}${format.bytes(sum(moved))} moved`,
          footer: (i) => (moves[i] > 0 ? format.countLabel(moves[i], "part move") : ""),
        },
      };
      for (const [id, entry] of state.charts) drawChart(entry, specs[id], xs, step);
      // Written and moved takes the row when it has no neighbour.
      state.charts.get("written").card.classList.toggle("is-alone", state.charts.get("merge_tree").card.hidden);
    }

    function drawChart(entry, spec, xs, step) {
      if (!spec || !spec.series.length) {
        entry.card.hidden = true;
        return;
      }
      entry.card.hidden = false;
      ns.util.setMetaLine(entry.meta, spec.meta || "");
      const options = {
        xs,
        xDomain: xs.length > 1 ? [xs[0], xs[xs.length - 1]] : undefined,
        series: spec.series,
        type: spec.type || "line",
        stack: !!spec.stack,
        legend: "always",
        yInclude: [],
        yAxis: spec.yAxis,
        yUnit: (maxAbs) => byteUnit(maxAbs),
        formatValue: (v) => format.bytes(v),
        formatY: (v) => format.bytes(v),
        bucketMs: step || undefined,
        tooltipFooter: (i) => [typeof spec.footer === "function" ? spec.footer(i) : "", step ? `${format.duration.fromMs(step)} bucket` : ""].filter(Boolean).join(SEP),
      };
      if (!entry.chart) {
        entry.chart = ns.chartCore.create(entry.plot, {
          ...options,
          xKind: "time",
          height: PLOT_HEIGHT,
          xFractionDigits: 0,
          syncKey: SYNC_KEY,
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

    // --- Bytes by database -----------------------------------------------------

    // A database's link: its card on the Storage tab, in the Explorer.
    function databaseLink(name, { className = "", label = null } = {}) {
      const href = ctx.databaseHref(name, { tab: "storage" });
      const link = h(href ? "a" : "button", {
        class: ["systemDiskDb__link", className],
        href: href || null,
        type: href ? null : "button",
        title: `Open ${name} on its Storage tab`,
        dataset: { database: name },
      }, label ?? [ns.icon.el("database", { size: "sm" }), h("span", { class: "mono" }, name)]);
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
        h.replace(databases, head, ns.uiState.block("empty", { title: "No data on disk", body: "No database the runner can see has active parts.", compact: true }));
        return;
      }
      // One colour per database across the disks: the largest overall first.
      const overall = new Map();
      for (const row of rows) overall.set(row.database, (overall.get(row.database) || 0) + Number(row.bytes || 0));
      const ranked = [...overall.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([name]) => name);
      const colour = (name) => {
        const index = ranked.indexOf(name);
        return index >= 0 && index < 8 ? `var(--qchart-${index + 1})` : "var(--qchart-other)";
      };
      const disks = Object.keys(totals).sort((a, b) => (Number(totals[b].bytes) || 0) - (Number(totals[a].bytes) || 0) || (a < b ? -1 : 1));
      const blocks = disks.map((disk) => {
        const total = Number(totals[disk].bytes) || 0;
        const own = rows.filter((row) => row.disk === disk).sort((a, b) => Number(b.bytes) - Number(a.bytes));
        const top = own.slice(0, TOP_DATABASES);
        const listed = top.reduce((sum, row) => sum + Number(row.bytes || 0), 0);
        const others = Math.max(0, total - listed);
        const othersCount = Math.max(0, (Number(totals[disk].databases) || own.length) - top.length);
        const share = (bytes) => (total > 0 ? bytes / total : 0);
        // The stacked bar: a click opens the database's Storage tab. It
        // repeats the table under it, which holds the links.
        const strip = h("div", { class: "systemDiskDb__strip", aria: { hidden: "true" } },
          top.map((row) => h("span", {
            class: "systemDiskDb__segment",
            dataset: { database: row.database },
            title: `${row.database}${SEP}${format.bytes(row.bytes)}${SEP}${format.percent(share(Number(row.bytes)))}`,
            style: { flexGrow: String(Math.max(share(Number(row.bytes)) * 100, 0.4)), background: colour(row.database) },
            on: { click: () => ctx.openDatabase(row.database, { tab: "storage" }) },
          })),
          others > 0 ? h("span", { class: "systemDiskDb__segment is-other", style: { flexGrow: String(Math.max(share(others) * 100, 0.4)) }, title: `Others${SEP}${format.bytes(others)}` }) : null);
        const tableRows = top.map((row) => {
          const shareCell = h("td", { class: "systemDiskDb__share" });
          ns.table.shareBar(shareCell, share(Number(row.bytes)) * 100, format.percent(share(Number(row.bytes))));
          return h("tr", { dataset: { database: row.database } },
            h("td", { class: "systemDiskDb__name" }, h("span", { class: "systemDiskDb__cell" },
              h("span", { class: "systemDiskDb__swatch", style: { background: colour(row.database) } }),
              databaseLink(row.database))),
            h("td", { class: "num" }, format.bytes(row.bytes)),
            shareCell,
            h("td", { class: "num is-mid", title: Number(row.compact_parts) ? `${format.count(row.compact_parts)} compact` : null }, format.count(row.parts)));
        });
        if (others > 0 || othersCount > 0) {
          const shareCell = h("td", { class: "systemDiskDb__share" });
          ns.table.shareBar(shareCell, share(others) * 100, format.percent(share(others)));
          tableRows.push(h("tr", { class: "is-other" },
            h("td", { class: "systemDiskDb__name" }, h("span", { class: "systemDiskDb__cell" },
              h("span", { class: "systemDiskDb__swatch is-other" }), `Others (${format.countLabel(othersCount, "database")})`)),
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
          h("div", { class: "systemTableWrap" }, table));
      });
      const note = h("p", { class: "systemCard__note" },
        `Active parts of the databases the runner can see (bytes on disk); a database opens on its Storage tab.${data.usage?.truncated ? ` The first ${format.count(data.limits?.usage_row_limit || 1000)} rows.` : ""}`);
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
            h("td", { class: "is-mid" }, volume.prefer_not_to_merge == null ? DASH : volume.prefer_not_to_merge ? "No merges" : "Merges")));
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
      h.replace(policies, head, h("div", { class: "systemTableWrap" }, table), note);
    }

    function resetForHost() {
      state.disks = null;
      state.growth = null;
      state.disksError = null;
      state.growthError = null;
      state.serial += 1;
      state.loading = 0;
      render();
    }

    return {
      // query: the address's from / to when the address opened the section.
      show(addressQuery) {
        state.active = true;
        if (addressQuery !== undefined) {
          const next = ns.timeRange.url.read(new URLSearchParams(String(addressQuery || ""))) || defaultRange();
          if (!sameRange(next, state.range)) state.range = next;
        }
        if (state.host && state.host !== kit.hostId()) resetForHost();
        if (state.pendingRender) render();
        picker.refresh();
        renderStatus();
        if (!state.disks && !state.loading) void load(false);
        else if (!sameRange(state.loadedRange, state.range)) void loadGrowth(false);
      },
      hide() {
        state.active = false;
        if (picker.isOpen()) picker.close();
      },
      refresh(force = true) {
        if (state.host !== kit.hostId()) resetForHost();
        void load(force);
      },
      query,
    };
  }

  ns.systemView.register({ id: "disks", label: "Disks", order: 40, available: (f) => !!f?.enabled && !!ns.chartCore && !!ns.timeRange, create: createDisks });
})();
