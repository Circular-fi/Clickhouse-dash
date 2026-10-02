(() => {
  "use strict";
  // Trace page views after Jaeger's TracePage view switcher: Trace Timeline
  // (the waterfall, app_traces.js), Trace Graph, Trace Statistics, Trace
  // Spans Table and Trace Flamegraph; plus the ?span= / ?view= location and
  // the span-bar event marker popover. app_traces.js calls install(ctx) with
  // its model and helpers at init.
  const ns = window.ChDash;
  if (!ns) return;

  const VIEWS = ["timeline", "graph", "statistics", "spans", "flamegraph"];
  const viewPref = () => ns.storage.pref(ns.storage.KEYS.traceView, "", { allowed: VIEWS });
  const SPANS_TABLE_LIMIT = 2000;
  const GRAPH_NODE_LIMIT = 1500;
  const FLAME_MIN_RATIO = 0.0005;

  let ctx = null;
  let lastCache = null;
  const view = {
    current: "timeline",
    stats: { groupBy: "service", subGroup: "", colorBy: "", sortKey: "count", sortAsc: false },
    spans: { sortKey: "start", sortAsc: true, text: "", service: "", status: "" },
    flame: { zoomKey: "" },
    graph: { mode: "service" },
  };
  // Per loaded trace (the app's trace cache object): self times, parsed
  // attributes, flame and graph trees.
  const derivedByCache = new WeakMap();

  const byId = (id) => document.getElementById(id);
  const esc = (value) => ctx.esc(value);
  const fmt = ns.format;
  const palette = ns.palette;

  function derived() {
    const cache = ctx.activeTraceCache();
    let entry = derivedByCache.get(cache);
    if (!entry) {
      entry = { cache };
      derivedByCache.set(cache, entry);
    }
    return entry;
  }

  function readStoredView() {
    return viewPref().get();
  }

  function storeView(value) {
    viewPref().set(value);
  }

  function updateParams(mutate, { push = false } = {}) {
    if (ns.observability && !ns.observability.isActive("traces")) return;
    const url = new URL(window.location.href);
    mutate(url.searchParams);
    const next = `${url.pathname}${url.search}${url.hash}`;
    if (next === `${window.location.pathname}${window.location.search}${window.location.hash}`) return;
    // A pushed view keeps the count of steps back to the search (app_traces.js).
    if (push) window.history.pushState(ns.traces?.detailEntryState ? ns.traces.detailEntryState(window.history.state) : window.history.state, "", next);
    else window.history.replaceState(window.history.state, "", next);
  }

  // ---------------------------------------------------------------- self time

  function spanStart(span) { return Number(span.start_ns || 0); }
  function spanDuration(span) { return Math.max(0, Number(span.duration_ns || 0)); }
  function isError(span) { return String(span.status_code || "").toLowerCase() === "error"; }

  // Self time: the span's duration minus the union of its children's
  // intervals, each clipped to the span.
  function selfTimeOf(node) {
    const start = spanStart(node.span);
    const duration = spanDuration(node.span);
    const end = start + duration;
    const intervals = [];
    for (const child of node.children) {
      const childStart = Math.max(start, spanStart(child.span));
      const childEnd = Math.min(end, spanStart(child.span) + spanDuration(child.span));
      if (childEnd > childStart) intervals.push([childStart, childEnd]);
    }
    intervals.sort((a, b) => a[0] - b[0]);
    let covered = 0;
    let runStart = 0;
    let runEnd = -Infinity;
    for (const [from, to] of intervals) {
      if (from > runEnd) {
        if (runEnd > runStart) covered += runEnd - runStart;
        runStart = from;
        runEnd = to;
      } else if (to > runEnd) {
        runEnd = to;
      }
    }
    if (runEnd > runStart) covered += runEnd - runStart;
    return Math.max(0, duration - covered);
  }

  function selfTimes() {
    const entry = derived();
    if (!entry.self) {
      entry.self = new Map();
      for (const node of entry.cache.tree.nodes) entry.self.set(node, selfTimeOf(node));
    }
    return entry.self;
  }

  function spanAttributes(span) {
    const entry = derived();
    if (!entry.attrs) entry.attrs = new Map();
    let attrs = entry.attrs.get(span);
    if (!attrs) {
      const own = ctx.parseStructuredValue(span.span_attributes);
      const resource = ctx.parseStructuredValue(span.resource_attributes);
      attrs = {
        ...(resource && typeof resource === "object" && !Array.isArray(resource) ? resource : {}),
        ...(own && typeof own === "object" && !Array.isArray(own) ? own : {}),
      };
      entry.attrs.set(span, attrs);
    }
    return attrs;
  }

  function tagKeys() {
    const entry = derived();
    if (!entry.tagKeys) {
      const keys = new Set();
      for (const span of entry.cache.spans) {
        for (const key of Object.keys(spanAttributes(span))) {
          keys.add(key);
          if (keys.size >= 300) break;
        }
      }
      entry.tagKeys = [...keys].sort((a, b) => a.localeCompare(b));
    }
    return entry.tagKeys;
  }

  // ---------------------------------------------------------------- pickers

  // A picker of a view's tools, its label inside the button ("Group By \u00b7
  // Service", ns.menu.select reads data-field-label).
  function pickerHtml(id, label, options, value) {
    const opts = options.map(([v, text]) => `<option value="${esc(v)}"${v === value ? " selected" : ""}>${esc(text)}</option>`).join("");
    return `<div class="traceViewBar__field"><select id="${esc(id)}" class="traceViewBar__select" data-field-label="${esc(label)}" aria-label="${esc(label)}">${opts}</select></div>`;
  }

  function setSelectOptions(select, options, value) {
    if (!select) return;
    const signature = JSON.stringify(options);
    if (select.dataset.optionsSignature !== signature) {
      select.dataset.optionsSignature = signature;
      select.innerHTML = options.map(([v, text]) => `<option value="${esc(v)}">${esc(text)}</option>`).join("");
    }
    select.value = options.some(([v]) => v === value) ? value : (options[0]?.[0] ?? "");
    select.dispatchEvent(new Event("tracepicker-refresh"));
  }

  // Each view's controls are built once, then shown for that view only.
  function toolsFor(name, build) {
    const host = byId("traceViewTools");
    if (!host) return null;
    let box = host.querySelector(`:scope > [data-view-tools="${name}"]`);
    if (!box) {
      box = document.createElement("div");
      box.className = "traceViewBar__group";
      box.dataset.viewTools = name;
      box.innerHTML = build();
      host.appendChild(box);
      box.querySelectorAll("select").forEach((select) => ctx.enhanceTraceSelect(select));
    }
    return box;
  }

  function showTools() {
    const host = byId("traceViewTools");
    if (!host) return;
    for (const box of host.querySelectorAll(":scope > [data-view-tools]")) box.hidden = box.dataset.viewTools !== view.current;
  }

  // ---------------------------------------------------------------- views

  // The view tabs (#traceViewTabs, app_ui_tabs.js); below 820 px the
  // #traceViewSelect dropdown stands in for them (CSS).
  let viewTabs = null;

  function setView(name, { url = "replace", persist = true } = {}) {
    const next = VIEWS.includes(name) ? name : "timeline";
    view.current = next;
    viewTabs?.select(next);
    const select = byId("traceViewSelect");
    if (select && select.value !== next) {
      select.value = next;
      select.dispatchEvent(new Event("tracepicker-refresh"));
    }
    const detail = byId("traceDetail");
    if (detail) detail.dataset.traceView = next;
    const frame = detail?.querySelector(".traceTimelineFrame");
    const alt = byId("traceAltView");
    if (frame) frame.hidden = next !== "timeline";
    if (alt) alt.hidden = next === "timeline";
    if (next !== "timeline") closeEventPopover();
    if (persist) storeView(next);
    if (url) {
      updateParams((params) => {
        if (next === "timeline") params.delete("view");
        else {
          params.set("view", next);
          params.delete("span");
        }
      }, { push: url === "push" });
    }
    render();
  }

  function showTimeline() {
    if (view.current !== "timeline") setView("timeline", { url: null });
  }

  function viewFromLocation() {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get("view");
    if (VIEWS.includes(fromUrl)) return fromUrl;
    if (params.get("span")) return "timeline";
    return readStoredView() || "timeline";
  }

  // After a trace load and on popstate within the trace: the view and the
  // deep-linked span of the URL.
  function applyLocation() {
    if (!ctx) return;
    const params = new URLSearchParams(window.location.search);
    const target = viewFromLocation();
    const explicit = VIEWS.includes(params.get("view"));
    setView(target, { url: explicit || target === "timeline" ? null : "replace", persist: explicit || !params.get("span") });
    const spanId = params.get("span");
    if (spanId && target === "timeline") {
      if (!ctx.focusSpanInTimeline(spanId, { replace: false })) ctx.model.focusedSpanId = "";
    }
  }

  function render() {
    if (!ctx) return;
    const alt = byId("traceAltView");
    const cache = ctx.activeTraceCache();
    if (cache !== lastCache) {
      // Another trace: its flamegraph starts unzoomed, no popover survives.
      lastCache = cache;
      view.flame.zoomKey = "";
      closeEventPopover();
    }
    showTools();
    if (!alt || view.current === "timeline") return;
    const spans = ctx.model.activeTrace?.spans || [];
    if (!spans.length) {
      alt.innerHTML = ns.uiState.emptyHtml({ body: "This trace has no spans." });
      return;
    }
    if (view.current === "statistics") renderStatistics(alt);
    else if (view.current === "spans") renderSpansTable(alt);
    else if (view.current === "flamegraph") renderFlamegraph(alt);
    else if (view.current === "graph") renderGraph(alt);
  }

  // Opening a span in the waterfall points the URL at it (?span=).
  function onSpanToggled(spanId, opening) {
    if (ctx.model.focusedSpanId && ctx.model.focusedSpanId !== spanId) {
      ctx.model.focusedSpanId = "";
      markFocusedSpan();
    }
    const current = new URLSearchParams(window.location.search).get("span");
    if (opening) updateParams((params) => { params.set("span", spanId); params.delete("view"); });
    else if (current === spanId) updateParams((params) => params.delete("span"));
  }

  function markFocusedSpan() {
    const root = ctx?.model && byId("traceWaterfall");
    if (!root) return;
    const id = String(ctx.model.focusedSpanId || "");
    for (const row of root.querySelectorAll(".traceSpanRow.is-deep-linked")) {
      if (row.getAttribute("data-span-id") !== id) row.classList.remove("is-deep-linked");
    }
    if (!id) return;
    for (const row of root.querySelectorAll(".traceSpanRow[data-span-id]")) {
      if (row.getAttribute("data-span-id") === id) row.classList.add("is-deep-linked");
    }
  }

  // ---------------------------------------------------------------- statistics

  const STAT_COLUMNS = [
    ["count", "Count", "Number of spans"],
    ["total", "Total", "Total duration of all spans"],
    ["avg", "Avg", "Average duration of all spans"],
    ["min", "Min", "Minimum duration across all spans"],
    ["max", "Max", "Maximum duration across all spans"],
    ["selfTotal", "ST Total", "Sum of self time (time spent in a span when it was not waiting on children)"],
    ["selfAvg", "ST Avg", "Average self time"],
    ["selfMin", "ST Min", "Minimum self time"],
    ["selfMax", "ST Max", "Maximum self time"],
    ["percent", "ST in Duration", "Percentage of ST Total vs. Total"],
  ];
  const GROUP_LABELS = { service: "Service Name", operation: "Operation Name", "service-operation": "Service & Operation" };

  function groupValue(node, by) {
    const span = node.span;
    if (by === "service") return String(span.service_name || "unknown");
    if (by === "operation") return String(span.span_name || "span");
    if (by === "service-operation") return `${span.service_name || "unknown"}\u0000${span.span_name || "span"}`;
    const value = spanAttributes(span)[by.slice(4)];
    return value == null ? null : String(value);
  }

  function groupLabel(key, by) {
    if (key == null) return `Without ${by.slice(4)}`;
    if (by === "service-operation") {
      const [service, operation] = key.split("\u0000");
      return `${service} · ${operation}`;
    }
    return key;
  }

  function groupService(nodes, by) {
    if (by !== "service" && by !== "service-operation") return "";
    return String(nodes[0]?.span.service_name || "unknown");
  }

  function aggregate(nodes, self) {
    let total = 0;
    let min = Infinity;
    let max = 0;
    let selfTotal = 0;
    let selfMin = Infinity;
    let selfMax = 0;
    for (const node of nodes) {
      const duration = spanDuration(node.span);
      const own = self.get(node) || 0;
      total += duration;
      selfTotal += own;
      if (duration < min) min = duration;
      if (duration > max) max = duration;
      if (own < selfMin) selfMin = own;
      if (own > selfMax) selfMax = own;
    }
    const count = nodes.length;
    return {
      count, total, avg: count ? total / count : 0, min: count ? min : 0, max,
      selfTotal, selfAvg: count ? selfTotal / count : 0, selfMin: count ? selfMin : 0, selfMax,
      percent: total > 0 ? (selfTotal / total) * 100 : 100,
    };
  }

  function groupNodes(nodes, by) {
    const groups = new Map();
    for (const node of nodes) {
      const key = groupValue(node, by);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(node);
    }
    return groups;
  }

  // Rows: one per group, each followed by its sub-group rows when a
  // sub-group is picked (Jaeger's detail rows).
  function statisticsRows() {
    const { groupBy, subGroup, sortKey, sortAsc } = view.stats;
    const self = selfTimes();
    const nodes = derived().cache.tree.nodes;
    const sorter = (a, b) => {
      const diff = sortKey === "name" ? a.name.localeCompare(b.name) : a.stats[sortKey] - b.stats[sortKey];
      return (sortAsc ? diff : -diff) || a.name.localeCompare(b.name);
    };
    const rows = [];
    for (const [key, members] of groupNodes(nodes, groupBy)) {
      const row = { key, name: groupLabel(key, groupBy), service: groupService(members, groupBy), stats: aggregate(members, self), details: [] };
      if (subGroup && subGroup !== groupBy) {
        for (const [subKey, subMembers] of groupNodes(members, subGroup)) {
          row.details.push({ key: subKey, name: groupLabel(subKey, subGroup), service: groupService(subMembers, subGroup), stats: aggregate(subMembers, self), detail: true });
        }
        row.details.sort(sorter);
      }
      rows.push(row);
    }
    rows.sort(sorter);
    return rows;
  }

  function formatStat(key, value) {
    if (key === "count") return fmt.count(value);
    if (key === "percent") return fmt.percent(value / 100);
    return fmt.duration(value);
  }

  // Jaeger's heat colouring: 8 % to 60 % of the heat colour by the row's share
  // of the column maximum (a percentage column against 100).
  function heatBackground(rows, key) {
    if (!key) return () => "";
    const max = key === "percent" ? 100 : rows.reduce((m, row) => Math.max(m, row.stats[key] || 0), 0);
    return (row) => {
      const ratio = max > 0 ? Math.min(1, Math.max(0, (row.stats[key] || 0) / max)) : 0;
      const weight = Math.round((8 + ratio * 52) * 100) / 100;
      return `--trace-heat-weight:${weight}%`;
    };
  }

  function statisticsOptions() {
    const tags = tagKeys().map((key) => [`tag:${key}`, `Tag: ${key}`]);
    const base = Object.entries(GROUP_LABELS);
    return { groupBy: [...base, ...tags], subGroup: [["", "No sub-group"], ...base.filter(([v]) => v !== "service-operation"), ...tags] };
  }

  function renderStatistics(alt) {
    const tools = toolsFor("statistics", () => [
      pickerHtml("traceStatsGroupBy", "Group By", Object.entries(GROUP_LABELS), view.stats.groupBy),
      pickerHtml("traceStatsSubGroup", "Sub-Group", [["", "No sub-group"]], ""),
      pickerHtml("traceStatsColorBy", "Color by", [["", "No colour"], ...STAT_COLUMNS.map(([key, label]) => [key, label])], view.stats.colorBy),
    ].join(""));
    const options = statisticsOptions();
    if (!options.groupBy.some(([v]) => v === view.stats.groupBy)) view.stats.groupBy = "service";
    if (!options.subGroup.some(([v]) => v === view.stats.subGroup) || view.stats.subGroup === view.stats.groupBy) view.stats.subGroup = "";
    setSelectOptions(tools?.querySelector("#traceStatsGroupBy"), options.groupBy, view.stats.groupBy);
    setSelectOptions(tools?.querySelector("#traceStatsSubGroup"), options.subGroup.filter(([v]) => v !== view.stats.groupBy), view.stats.subGroup);
    const rows = statisticsRows();
    const all = rows.flatMap((row) => [row, ...row.details]);
    const heat = heatBackground(all, view.stats.colorBy);
    const sortMark = (key) => (view.stats.sortKey === key ? (view.stats.sortAsc ? " \u25b4" : " \u25be") : "");
    const ariaSort = (key) => (view.stats.sortKey === key ? (view.stats.sortAsc ? "ascending" : "descending") : "none");
    const head = `<tr><th aria-sort="${ariaSort("name")}"><button type="button" data-stats-sort="name">${esc(GROUP_LABELS[view.stats.groupBy] || `Tag: ${view.stats.groupBy.slice(4)}`)}${sortMark("name")}</button></th>${STAT_COLUMNS.map(([key, label, title]) => `<th aria-sort="${ariaSort(key)}"><button type="button" data-stats-sort="${key}" title="${esc(title)}">${esc(label)}${sortMark(key)}</button></th>`).join("")}</tr>`;
    const rowHtml = (row) => {
      const style = [row.service ? `--trace-service-color:${palette.service(row.service)}` : "", heat(row)].filter(Boolean).join(";");
      const cls = `traceStats__row${row.detail ? " traceStats__row--detail" : ""}${row.service ? " has-service" : ""}${view.stats.colorBy ? " is-heat" : ""}`;
      return `<tr class="${cls}" style="${esc(style)}" data-stats-group="${esc(row.name)}"><th scope="row"><span>${esc(row.name)}</span></th>${STAT_COLUMNS.map(([key]) => `<td data-stat="${key}">${esc(formatStat(key, row.stats[key]))}</td>`).join("")}</tr>`;
    };
    const body = rows.map((row) => rowHtml(row) + row.details.map(rowHtml).join("")).join("");
    alt.innerHTML = `<div class="traceStats"><table class="traceStats__table"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
  }

  // ---------------------------------------------------------------- spans table

  const SPAN_COLUMNS = [
    ["service", "Service Name"],
    ["operation", "Operation"],
    ["duration", "Duration"],
    ["start", "Start Time"],
    ["status", "Status"],
    ["kind", "Kind"],
    ["id", "Span ID"],
  ];

  function spanSortValue(span, key, traceStart) {
    if (key === "service") return String(span.service_name || "");
    if (key === "operation") return String(span.span_name || "");
    if (key === "duration") return spanDuration(span);
    if (key === "start") return spanStart(span) - traceStart;
    if (key === "status") return String(span.status_code || "");
    if (key === "kind") return String(span.span_kind || "");
    return String(span.span_id || "");
  }

  function renderSpansTable(alt) {
    const cache = derived().cache;
    const services = [...new Set(cache.spans.map((span) => String(span.service_name || "unknown")))].sort((a, b) => a.localeCompare(b));
    const tools = toolsFor("spans", () => [
      `<label class="traceViewBar__field traceViewBar__field--search"><span class="traceViewBar__label">Filter</span><input id="traceSpansFilter" class="traceViewBar__input uiSearch uiSearch--compact" type="search" placeholder="Service, operation or span ID" autocomplete="off" spellcheck="false"></label>`,
      pickerHtml("traceSpansService", "Service", [["", "All services"]], ""),
      pickerHtml("traceSpansStatus", "Status", [["", "Any status"], ["error", "Error"], ["ok", "Ok"], ["unset", "Unset"]], view.spans.status),
      '<span id="traceSpansCount" class="traceViewBar__count"></span>',
    ].join(""));
    if (!services.includes(view.spans.service)) view.spans.service = "";
    setSelectOptions(tools?.querySelector("#traceSpansService"), [["", "All services"], ...services.map((s) => [s, s])], view.spans.service);
    const filterInput = tools?.querySelector("#traceSpansFilter");
    if (filterInput && filterInput.value !== view.spans.text) filterInput.value = view.spans.text;
    const traceStart = cache.bounds.start;
    const text = view.spans.text.trim().toLowerCase();
    const { sortKey, sortAsc } = view.spans;
    const rows = cache.spans.filter((span) => {
      if (view.spans.service && String(span.service_name || "unknown") !== view.spans.service) return false;
      if (view.spans.status && String(span.status_code || "unset").toLowerCase() !== view.spans.status) return false;
      if (!text) return true;
      return `${span.service_name || ""} ${span.span_name || ""} ${span.span_id || ""}`.toLowerCase().includes(text);
    }).sort((a, b) => {
      const va = spanSortValue(a, sortKey, traceStart);
      const vb = spanSortValue(b, sortKey, traceStart);
      const diff = typeof va === "number" ? va - vb : String(va).localeCompare(String(vb));
      return (sortAsc ? diff : -diff) || spanStart(a) - spanStart(b) || String(a.span_id || "").localeCompare(String(b.span_id || ""));
    });
    const count = tools?.querySelector("#traceSpansCount");
    if (count) count.textContent = `${rows.length} of ${cache.spans.length} span${cache.spans.length === 1 ? "" : "s"}`;
    const shown = rows.slice(0, SPANS_TABLE_LIMIT);
    const sortMark = (key) => (sortKey === key ? (sortAsc ? " \u25b4" : " \u25be") : "");
    const ariaSort = (key) => (sortKey === key ? (sortAsc ? "ascending" : "descending") : "none");
    const head = `<tr>${SPAN_COLUMNS.map(([key, label]) => `<th aria-sort="${ariaSort(key)}"><button type="button" data-spans-sort="${key}">${esc(label)}${sortMark(key)}</button></th>`).join("")}</tr>`;
    const body = shown.map((span) => {
      const status = String(span.status_code || "Unset");
      return `<tr class="traceSpansTable__row${isError(span) ? " is-error" : ""}" data-table-span="${esc(span.span_id)}" tabindex="0" title="Show in the timeline"><td data-col="service"><span class="traceSpansTable__service" style="--trace-service-color:${palette.service(span.service_name)}">${esc(span.service_name || "unknown")}</span></td><td data-col="operation">${esc(span.span_name || "span")}</td><td data-col="duration">${esc(fmt.duration(spanDuration(span)))}</td><td data-col="start">${esc(fmt.duration(Math.max(0, spanStart(span) - traceStart)))}</td><td data-col="status"><span class="traceSpansTable__status traceSpansTable__status--${esc(status.toLowerCase())}">${esc(status)}</span></td><td data-col="kind">${esc(ctx.spanKindLabel(span.span_kind))}</td><td data-col="id"><code>${esc(span.span_id)}</code></td></tr>`;
    }).join("");
    const more = rows.length > shown.length ? `<div class="traceSpansTable__more">Showing the first ${shown.length} of ${rows.length} spans: refine the filter to see the others.</div>` : "";
    alt.innerHTML = `<div class="traceSpansTable"><table class="traceSpansTable__table"><thead>${head}</thead><tbody>${body || `<tr><td colspan="${SPAN_COLUMNS.length}" class="traceSpansTable__empty">No spans match these filters.</td></tr>`}</tbody></table>${more}</div>`;
  }

  // ---------------------------------------------------------------- flamegraph

  // Jaeger's flamegraph data: one node per span, children with the same
  // "service: operation" merged, a parent at least as wide as its children,
  // under a virtual "total" root.
  function flameTree() {
    const entry = derived();
    if (entry.flame) return entry.flame;
    const build = (node) => ({
      name: `${node.span.service_name || "unknown"}: ${node.span.span_name || "span"}`,
      service: String(node.span.service_name || "unknown"),
      value: spanDuration(node.span),
      duration: spanDuration(node.span),
      count: 1,
      errors: isError(node.span) ? 1 : 0,
      children: groupFlameChildren(node.children.map(build)),
    });
    const root = { name: "total", service: "", value: 0, duration: 0, count: 1, errors: 0, children: entry.cache.tree.roots.map(build) };
    root.children = groupFlameChildren(root.children);
    root.value = root.children.reduce((sum, child) => sum + child.value, 0);
    root.duration = root.value;
    const cover = (node) => {
      for (const child of node.children) cover(child);
      const sum = node.children.reduce((total, child) => total + child.value, 0);
      if (sum > node.value) node.value = sum;
    };
    cover(root);
    const index = (node, key, parent, depth) => {
      node.key = key;
      node.parent = parent;
      node.depth = depth;
      node.children.forEach((child, i) => index(child, `${key}.${i}`, node, depth + 1));
    };
    index(root, "0", null, 0);
    entry.flame = root;
    return root;
  }

  function groupFlameChildren(children) {
    const groups = new Map();
    for (const child of children) {
      const existing = groups.get(child.name);
      if (existing) {
        existing.value += child.value;
        existing.duration += child.duration;
        existing.count += child.count;
        existing.errors += child.errors;
        existing.children.push(...child.children);
      } else {
        groups.set(child.name, { ...child, children: [...child.children] });
      }
    }
    for (const node of groups.values()) {
      if (node.children.length > 1) node.children = groupFlameChildren(node.children);
    }
    return [...groups.values()];
  }

  function findFlameNode(root, key) {
    if (!key) return root;
    let node = root;
    for (const part of key.split(".").slice(1)) {
      node = node?.children[Number(part)];
      if (!node) return root;
    }
    return node;
  }

  function renderFlamegraph(alt) {
    const root = flameTree();
    const zoom = findFlameNode(root, view.flame.zoomKey);
    const tools = toolsFor("flamegraph", () => '<span id="traceFlameCrumb" class="traceViewBar__crumb"></span><button type="button" id="traceFlameReset" class="button button--small traceViewBar__button" data-flame-reset>Reset zoom</button>');
    const crumb = tools?.querySelector("#traceFlameCrumb");
    if (crumb) crumb.textContent = zoom === root ? "Click a frame to zoom into it" : `Zoomed: ${zoom.name}`;
    const reset = tools?.querySelector("#traceFlameReset");
    if (reset) reset.disabled = zoom === root;
    const bars = [];
    // Ancestors of the zoomed frame stay on top at full width (zoom out).
    const ancestors = [];
    for (let node = zoom.parent; node; node = node.parent) ancestors.unshift(node);
    const total = Math.max(1, root.value);
    const frame = (node, left, width, row, ancestor) => {
      const share = (node.value / total) * 100;
      const color = node.service ? palette.service(node.service) : "";
      bars.push(`<div class="traceFlame__frame${ancestor ? " is-ancestor" : ""}${node === root ? " is-root" : ""}${node.errors ? " has-error" : ""}" data-flame-key="${esc(node.key)}" style="left:${left.toFixed(4)}%;width:${width.toFixed(4)}%;top:${row * 20}px${color ? `;--trace-service-color:${color}` : ""}" data-flame-name="${esc(node.name)}" data-flame-duration="${esc(fmt.duration(node.duration))}" data-flame-count="${node.count}" data-flame-share="${esc(sharePct(share))}"><span>${esc(node.name)}</span></div>`);
    };
    ancestors.forEach((node, row) => frame(node, 0, 100, row, true));
    let rows = ancestors.length;
    const layout = (node, left, width, row) => {
      frame(node, left, width, row, false);
      rows = Math.max(rows, row + 1);
      let offset = left;
      for (const child of node.children) {
        const childWidth = node.value > 0 ? width * (child.value / node.value) : 0;
        if (childWidth / 100 >= FLAME_MIN_RATIO) layout(child, offset, childWidth, row + 1);
        offset += childWidth;
      }
    };
    layout(zoom, 0, 100, ancestors.length);
    alt.innerHTML = `<div class="traceFlame"><div class="traceFlame__canvas" style="height:${rows * 20}px">${bars.join("")}</div></div>`;
  }

  // ---------------------------------------------------------------- graph

  // Jaeger's trace DAG: one node per (parent node, service, operation) path;
  // count / errors, total time (% of the trace), average and self time, and
  // the spans of the path (the panel jumps to them in the timeline).
  function graphTree() {
    const entry = derived();
    if (entry.graph) return entry.graph;
    const self = selfTimes();
    const nodes = [];
    const roots = [];
    const make = (parent, span) => ({
      key: `${parent ? parent.key : ""}\u0001${span.service_name || "unknown"}\u0000${span.span_name || "span"}`,
      service: String(span.service_name || "unknown"),
      operation: String(span.span_name || "span"),
      parent, children: [], childByName: new Map(), count: 0, errors: 0, time: 0, selfTime: 0, spans: [],
    });
    const visit = (treeNode, parent) => {
      const name = `${treeNode.span.service_name || "unknown"}\u0000${treeNode.span.span_name || "span"}`;
      const siblings = parent ? parent.childByName : rootByName;
      let node = siblings.get(name);
      if (!node) {
        node = make(parent, treeNode.span);
        siblings.set(name, node);
        nodes.push(node);
        if (parent) parent.children.push(node);
        else roots.push(node);
      }
      node.count += 1;
      node.spans.push(treeNode.span);
      node.errors += isError(treeNode.span) ? 1 : 0;
      node.time += spanDuration(treeNode.span);
      node.selfTime += self.get(treeNode) || 0;
      for (const child of treeNode.children) visit(child, node);
    };
    const rootByName = new Map();
    for (const root of entry.cache.tree.roots) visit(root, null);
    const traceDuration = Math.max(1, entry.cache.bounds.duration);
    for (const node of nodes) {
      node.percent = (node.time / traceDuration) * 100;
      node.percentSelf = node.time > 0 ? (node.selfTime / node.time) * 100 : 100;
    }
    entry.graph = { nodes, roots };
    return entry.graph;
  }

  // Time shares of the graph nodes are in percent (0-100).
  const sharePct = (value) => fmt.percent(Number(value || 0) / 100);

  // Drawn with the shared canvas graph kit (app_graph_kit.js), like the
  // Explorer graph and the Service map: one card per call path (the service
  // as title, the operation under it, "count / errors · avg" and "time % ·
  // self %"; a left strip in the service's waterfall colour; a red dot and
  // border on errors), orthogonal edges from a call path to its callees whose
  // dash pattern is the call kind and whose always visible label is the
  // callee's span count, hover outlines a card, a click recentres on it and
  // opens its side panel (a button jumps to its spans in the timeline). The
  // Time / Self time colour modes fill the cards with a heat mixed in JS
  // between --graph-node-bg and --graph-heat. The canvas is the only view, on
  // phones too (touch pans and pinches; the panel is a bottom sheet): the
  // kit's keyboard access (arrows, Enter, the live region) is the accessible
  // path.
  //
  // Layout: the tree slot layout turned left to right. Graph nodes form a
  // tree (one node per path), so the leaves take consecutive rows in call
  // order and a parent sits on the row of its first callee: no edge can cross
  // another, the first call of every path is a straight line and the rest
  // drop down the gap to their rows. The slot is the kit's lineage row, and
  // the kit's orthogonal router draws the edges on that row grid, one fan at
  // a time (routeGraphEdges). (The kit's
  // layered layout would sort callees by crossings and centre parents between
  // them: every edge then bends, and the call order is lost.)
  const GRAPH_CARD_W = 264;
  const GRAPH_CARD_H = 82;
  const GRAPH_X_GAP = 104;
  const GRAPH_Y_GAP = 26;
  const GRAPH_FIT_MAX = 1.35;
  // The smallest card font is 12 px: Fit keeps it at 11 px or more.
  const GRAPH_READABLE_SCALE = 11 / 12;
  // Heat: up to 45 % of --graph-heat over the card (text keeps 4.5:1).
  const GRAPH_HEAT_MAX = 0.45;
  // Time mode: a call path taking 20 % of the trace or more is fully hot.
  const GRAPH_TIME_HEAT_FULL = 20;
  const GRAPH_PANEL_SPANS = 8;
  const GRAPH_MODES = [["service", "Service"], ["time", "Time"], ["selftime", "Self time"]];
  const GRAPH_KIND_LABELS = { sync: "call", async: "message", db: "database" };

  const graphUi = {
    pane: null,
    ctl: null,
    // The graphTree() the layout was built for.
    graph: null,
    layout: null,
    view: { scale: 1, offsetX: 0, offsetY: 0 },
    fitScale: 1,
    fitted: true,
    // Node id | null.
    selected: null,
    // { type: "node" | "edge", id, key } | null
    hovered: null,
    labelHits: [],
    fills: new Map(),
    timing: null,
  };

  const graphKit = () => ns.graphKit;

  function graphEdgeKind(node) {
    const span = node.spans?.[0];
    const kind = String(span?.span_kind || "").toLowerCase();
    if (kind.includes("producer") || kind.includes("consumer")) return "async";
    if (span) {
      const attrs = spanAttributes(span);
      if (attrs["db.system"] || attrs["db.system.name"]) return "db";
    }
    return "sync";
  }

  function graphCountText(node) { return `${fmt.count(node.count)} / ${fmt.count(node.errors)} · avg ${fmt.duration(node.time / Math.max(1, node.count))}`; }
  function graphTimeText(node) { return `${fmt.duration(node.time)} (${sharePct(node.percent)}) · self ${fmt.duration(node.selfTime)} (${sharePct(node.percentSelf)})`; }
  function graphLabelText(node) { return `×${fmt.compact(node.count)}`; }
  function graphPathText(node) { return `${node.service} ${node.operation}`; }

  // The heat of a node in the current colour mode, 0..1 (null in Service mode).
  function graphHeat(node) {
    if (view.graph.mode === "time") return Math.min(1, Math.max(0, node.percent / GRAPH_TIME_HEAT_FULL));
    if (view.graph.mode === "selftime") return Math.min(1, Math.max(0, node.percentSelf / 100));
    return null;
  }

  function graphFill(node) {
    const kit = graphKit();
    const heat = graphHeat(node);
    if (heat == null || heat <= 0) return kit.color("nodeBg");
    const weight = Math.round(heat * GRAPH_HEAT_MAX * 100) / 100;
    let fill = graphUi.fills.get(weight);
    if (!fill) {
      fill = kit.mixColor(kit.color("nodeBg"), kit.theme.cssVar("--graph-heat"), weight);
      graphUi.fills.set(weight, fill);
    }
    return fill;
  }

  // ---------------------------------------------------------- graph layout

  function computeGraphLayout(graph, measure) {
    const kit = graphKit();
    const started = performance.now();
    graph.nodes.forEach((node, index) => { node.id = `n${index}`; });
    let row = 0;
    const place = (node, depth) => {
      node.depth = depth;
      if (!node.children.length) {
        node.row = row;
        row += 1;
        return;
      }
      for (const child of node.children) place(child, depth + 1);
      node.row = node.children[0].row;
    };
    for (const root of graph.roots) place(root, 0);
    const pitch = GRAPH_CARD_H + GRAPH_Y_GAP;
    const items = new Map();
    for (const node of graph.nodes) {
      items.set(node.id, {
        x: node.depth * (GRAPH_CARD_W + GRAPH_X_GAP),
        y: node.row * pitch,
        width: GRAPH_CARD_W,
        height: GRAPH_CARD_H,
        lineageRow: node.row,
        node,
      });
    }
    const edges = [];
    for (const node of graph.nodes) {
      if (node.parent) edges.push({ id: node.id, from: node.parent.id, to: node.id, node, kind: graphEdgeKind(node) });
    }
    const laidOut = performance.now();
    const routes = routeGraphEdges(items, edges);
    const routed = performance.now();
    const maxCount = Math.max(1, ...graph.nodes.map((node) => node.count));
    const edgeItems = edges.map((edge) => ({
      ...edge,
      points: routes.get(edge.id)?.points || [],
      error: edge.node.errors > 0,
      width: 1.25 + 1.75 * Math.sqrt(edge.node.count / maxCount),
    }));

    // Every edge label, busiest call paths first (they get the best spots).
    const textWidth = measure || ((text) => text.length * 7);
    const requests = edgeItems.filter((item) => item.points.length >= 2)
      .sort((a, b) => b.node.count - a.node.count || a.node.row - b.node.row)
      .map((item) => {
        const text = graphLabelText(item.node);
        return { key: item.id, text, width: textWidth(text) + 12, height: 18, points: item.points };
      });
    const { placed, dropped } = kit.placeLabels(requests, [...items.values()]);
    const labels = new Map(requests.filter((request) => placed.has(request.key)).map((request) => [request.key, { text: request.text, rect: placed.get(request.key) }]));

    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    const grow = (x, y, width = 0, height = 0) => {
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + width); maxY = Math.max(maxY, y + height);
    };
    for (const item of items.values()) grow(item.x, item.y, item.width, item.height);
    for (const label of labels.values()) grow(label.rect.x, label.rect.y, label.rect.width, label.rect.height);
    for (const item of edgeItems) for (const point of item.points) grow(point.x, point.y);
    const bounds = Number.isFinite(minX)
      ? { x: minX - 40, y: minY - 40, width: maxX - minX + 80, height: maxY - minY + 80 }
      : { x: 0, y: 0, width: 1, height: 1 };
    const done = performance.now();
    graphUi.timing = { layoutMs: laidOut - started, routeMs: routed - laidOut, labelMs: done - routed, totalMs: done - started };
    return {
      items,
      edges: edgeItems,
      edgeById: new Map(edgeItems.map((item) => [item.id, item])),
      labels,
      dropped,
      bounds,
      depth: graph.nodes.reduce((max, node) => Math.max(max, node.depth), 0),
    };
  }

  // The routes of a call path to its callees stay inside its own rows of the
  // gap between two columns (no card sits in a gap, and the rows of two call
  // paths of one column never interleave), so each fan is routed on its own:
  // the kit router compares every pair of routes it places, which a single
  // run over 1,500 edges made take seconds. The router gives every route of a
  // fan its own vertical lane; a gap has room for GRAPH_ROUTED_FAN of them, a
  // wider fan shares one trunk (H-V-H, like the kit's fallback past its grid
  // budget) instead of piling lanes on top of each other.
  const GRAPH_ROUTED_FAN = 8;
  function routeGraphEdges(items, edges) {
    const kit = graphKit();
    const fans = new Map();
    for (const edge of edges) {
      if (!fans.has(edge.from)) fans.set(edge.from, []);
      fans.get(edge.from).push(edge);
    }
    const routes = new Map();
    for (const [from, fan] of fans) {
      const source = items.get(from);
      if (fan.length > GRAPH_ROUTED_FAN) {
        const a = kit.nodePort(source, "right");
        const trunk = a.x + 18;
        for (const edge of fan) {
          const b = kit.nodePort(items.get(edge.to), "left");
          const points = Math.abs(a.y - b.y) < 0.01 ? [a, b] : [a, { x: trunk, y: a.y }, { x: trunk, y: b.y }, b];
          routes.set(edge.id, { points, a, b });
        }
        continue;
      }
      const local = new Map([[from, source]]);
      for (const edge of fan) local.set(edge.to, items.get(edge.to));
      for (const [id, route] of kit.routeEdges(local, fan)) routes.set(id, route);
    }
    return routes;
  }

  // ---------------------------------------------------------- graph chrome

  const GRAPH_FIT_ICON = '<svg viewBox="0 0 18 18" aria-hidden="true"><path d="M6.1 3.5H3.5v2.6M11.9 3.5h2.6v2.6M14.5 11.9v2.6h-2.6M6.1 14.5H3.5v-2.6"/><circle cx="9" cy="9" r="2.1"/></svg>';

  // The pane is built once and kept across views (the kit controller is
  // bound to its canvas); the other views replace it in #traceAltView and
  // the Graph view puts it back.
  function graphPane() {
    if (graphUi.pane) return graphUi.pane;
    const kit = graphKit();
    const pane = document.createElement("div");
    pane.id = "traceGraphPane";
    pane.className = "graphKitPane traceGraph";
    pane.innerHTML = '<canvas id="traceGraphCanvas" class="graphKit__canvas" tabindex="0" aria-label="Trace graph: one card per call path. Arrow keys move between call paths, Enter selects, + and - zoom, 0 fits, Escape closes the details."></canvas>'
      + '<div id="traceGraphBar" class="graphKitBar" aria-label="Trace graph controls">'
      + '<div class="graphKitGroup graphKitTools" role="group" aria-label="Zoom">'
      + '<button id="traceGraphZoomOut" class="graphKitTool" type="button" aria-label="Zoom out" title="Zoom out (-)">&minus;</button>'
      + `<button id="traceGraphFit" class="graphKitTool graphKitTool--icon" type="button" aria-label="Fit the graph to the view" title="Fit the graph to the view (0)">${GRAPH_FIT_ICON}</button>`
      + '<button id="traceGraphZoomIn" class="graphKitTool" type="button" aria-label="Zoom in" title="Zoom in (+)">+</button>'
      + "</div>"
      + `<div class="graphKitGroup traceGraph__colour">${pickerHtml("traceGraphMode", "Colour", GRAPH_MODES, view.graph.mode)}</div>`
      + "</div>"
      + '<div class="graphKitDock"><div id="traceGraphLegend" class="graphKitLegend" aria-label="Legend"></div>'
      + '<div class="graphKitStatus"><span id="traceGraphMeta" class="graphKitStatus__text" role="status"></span></div></div>'
      + '<canvas id="traceGraphMinimap" class="graphKitMinimap" width="180" height="110" aria-hidden="true" hidden></canvas>'
      + '<aside id="traceGraphPanel" class="graphKitPanel" aria-label="Call path details" hidden></aside>';
    graphUi.pane = pane;
    const select = pane.querySelector("#traceGraphMode");
    ctx.enhanceTraceSelect(select);
    select.addEventListener("change", () => {
      view.graph.mode = GRAPH_MODES.some(([value]) => value === select.value) ? select.value : "service";
      renderGraphLegend();
      graphUi.ctl?.scheduleDraw();
    });
    const canvas = pane.querySelector("#traceGraphCanvas");
    graphUi.ctl = kit.mount({
      canvas,
      view: graphUi.view,
      active: graphShown,
      draw: drawGraph,
      bounds: () => graphUi.layout?.bounds || null,
      minScale: graphMinimumScale,
      fit: fitGraph,
      hit: graphHitTest,
      onHover: (target) => { graphUi.hovered = target; },
      onClick: (target) => {
        if (target?.type === "node" || target?.type === "edge") selectGraphNode(target.id);
        else closeGraphPanel();
      },
      nodes: () => (graphUi.layout ? [...graphUi.layout.items.values()].map((item) => ({ id: item.node.id, x: item.x, y: item.y, width: item.width, height: item.height })) : []),
      selectedId: () => graphUi.selected,
      target: (id) => (graphUi.layout?.items.has(id) ? { type: "node", key: `node\u0000${id}`, id } : null),
      describe: describeGraphNode,
      onActivate: (id) => {
        selectGraphNode(id);
        graphPanel()?.querySelector("button[data-graph-span]")?.focus?.({ preventScroll: true });
      },
      onEscape: () => {
        if (!graphUi.selected) return false;
        closeGraphPanel();
        return true;
      },
      onViewChange: () => { graphUi.fitted = false; },
      onResize: () => { if (graphUi.layout && graphUi.fitted) fitGraph(); },
      panelRect: () => {
        const panel = graphPanel();
        return panel && !panel.hidden ? panel.getBoundingClientRect() : null;
      },
      toolbar: { zoomIn: pane.querySelector("#traceGraphZoomIn"), zoomOut: pane.querySelector("#traceGraphZoomOut"), fit: pane.querySelector("#traceGraphFit") },
    });
    kit.theme.onChange(() => {
      graphUi.fills.clear();
      if (graphShown()) graphUi.ctl.drawNow();
    });
    pane.addEventListener("click", onGraphActionClick);
    return pane;
  }

  const graphCanvas = () => graphUi.pane?.querySelector("#traceGraphCanvas") || null;
  const graphPanel = () => graphUi.pane?.querySelector("#traceGraphPanel") || null;

  function graphShown() {
    const alt = byId("traceAltView");
    return view.current === "graph" && !!graphUi.pane?.isConnected && !!alt && !alt.hidden;
  }

  function renderGraphMeta() {
    const meta = graphUi.pane?.querySelector("#traceGraphMeta");
    const graph = graphUi.graph;
    if (!meta || !graph) return;
    const spans = graph.roots.reduce((sum, root) => sum + subtreeCount(root), 0);
    const paths = graph.nodes.length;
    meta.textContent = `${paths} call path${paths === 1 ? "" : "s"} · ${spans} span${spans === 1 ? "" : "s"} · depth ${(graphUi.layout?.depth ?? 0) + 1}`;
  }

  function subtreeCount(node) {
    let total = node.count;
    for (const child of node.children) total += subtreeCount(child);
    return total;
  }

  function renderGraphLegend() {
    const legend = graphUi.pane?.querySelector("#traceGraphLegend");
    if (!legend) return;
    const kinds = new Set((graphUi.layout?.edges || []).map((edge) => edge.kind));
    const row = (marks, text) => `<span class="graphKitLegend__row">${marks}<span>${text}</span></span>`;
    const lines = [["sync", ""], ["async", " graphKitLegend__line--dashed"], ["db", " graphKitLegend__line--dotted"]]
      .filter(([kind]) => kind === "sync" || kinds.has(kind))
      .map(([kind, cls]) => `<i class="graphKitLegend__line graphKitLegend__line--thin graphKitLegend__line--muted${cls}"></i><span>${GRAPH_KIND_LABELS[kind]}</span>`).join("");
    const mode = view.graph.mode;
    const heat = mode === "time"
      ? row('<i class="traceGraphLegend__heat"></i>', `time: 0 \u2192 \u2265 ${GRAPH_TIME_HEAT_FULL}% of the trace`)
      : mode === "selftime" ? row('<i class="traceGraphLegend__heat"></i>', "self time: 0 \u2192 100% of its time") : "";
    legend.innerHTML = '<span class="traceGraphLegend__anatomy" aria-label="Card: service, operation, count / errors · average, time (% of the trace) · self time (% of its time)">'
      + '<b>service</b><span>operation</span><span>count / errors · avg</span><span>time (% of trace) · self (% of it)</span></span>'
      + row('<i class="graphKitLegend__dot"></i>', "errors on this call path")
      + `<span class="graphKitLegend__row traceGraphLegend__kinds">${lines}</span>`
      + row('<i class="traceGraphLegend__label">×N</i>', "spans of the callee")
      + heat;
  }

  // ---------------------------------------------------------- graph camera

  function graphOverviewScale() {
    const kit = graphKit();
    const area = kit.safeArea(graphCanvas());
    const bounds = graphUi.layout?.bounds;
    if (!bounds || !area.width || !area.height) return 1;
    return Math.max(0.02, Math.min(GRAPH_FIT_MAX, Math.min(area.width / bounds.width, area.height / bounds.height) * 0.92));
  }

  // Fit shows the whole graph in the area the chrome leaves free, never with
  // text below 11 px: a larger graph opens at the readable scale on the
  // selected call path, else on the root (top-left), and the minimap gives
  // the rest.
  function fitGraph() {
    const kit = graphKit();
    const canvas = graphCanvas();
    const layout = graphUi.layout;
    const box = canvas?.getBoundingClientRect();
    if (!kit || !layout || !box?.width || !box?.height) return;
    kit.foldLegendToFit(canvas, layout.bounds, { readableScale: GRAPH_READABLE_SCALE });
    const area = kit.safeArea(canvas);
    const overview = graphOverviewScale();
    const scale = Math.max(overview, GRAPH_READABLE_SCALE);
    const bounds = layout.bounds;
    const anchor = graphUi.selected ? layout.items.get(graphUi.selected) : null;
    const v = graphUi.view;
    v.scale = scale;
    if (scale > overview + 1e-9 && anchor) {
      v.offsetX = area.x + area.width / 2 - (anchor.x + anchor.width / 2) * scale;
      v.offsetY = area.y + area.height / 2 - (anchor.y + anchor.height / 2) * scale;
    } else if (scale > overview + 1e-9) {
      v.offsetX = area.x + 24 - bounds.x * scale;
      v.offsetY = area.y + 4 - bounds.y * scale;
    } else {
      const fitted = kit.fitTransform(bounds, box.width, box.height, { maxScale: GRAPH_FIT_MAX, minScale: scale, area });
      v.offsetX = fitted.offsetX;
      v.offsetY = fitted.offsetY;
    }
    kit.clampView(v, bounds, box.width, box.height);
    graphUi.fitScale = scale;
    graphUi.fitted = true;
    graphUi.ctl?.scheduleDraw();
  }

  function graphMinimumScale() {
    return Math.min(graphUi.fitScale || 0.06, graphOverviewScale());
  }

  // ---------------------------------------------------------- graph drawing

  function graphNodeHovered(id) {
    return graphUi.hovered?.type === "node" && graphUi.hovered.id === id;
  }

  function graphEdgeHighlighted(item) {
    if (graphUi.selected && item.to === graphUi.selected) return true;
    const hover = graphUi.hovered;
    if (!hover) return false;
    if (hover.type === "edge") return hover.id === item.id;
    return hover.type === "node" && (item.from === hover.id || item.to === hover.id);
  }

  function graphEdgeColor(item, highlighted) {
    const kit = graphKit();
    if (item.error) return kit.color("error");
    return highlighted ? kit.color("halo") : kit.color("edgeMuted");
  }

  function drawGraphCard(context, item, compact) {
    const kit = graphKit();
    const node = item.node;
    const selected = graphUi.selected === node.id;
    const hovered = graphNodeHovered(node.id);
    const heat = graphHeat(node) != null;
    const card = {
      radius: 10,
      halo: selected,
      fill: graphFill(node),
      border: selected || hovered ? kit.color("halo") : node.errors ? kit.color("error") : kit.color("border"),
      borderWidth: selected ? 2.4 : hovered || node.errors ? 1.8 : 1.2,
      strip: palette.resolve(palette.service(node.service)),
      status: node.errors ? "error" : null,
      rows: [],
    };
    if (compact) {
      const size = kit.compactTitleSize(graphUi.view.scale);
      if (size) card.rows.push({ text: node.service, size, weight: 600, y: Math.min(item.height - 10, 12 + size), fit: "full" });
    } else {
      card.rows.push(
        { text: node.service, size: 13, weight: 600, y: 21 },
        { text: node.operation, size: 12, weight: 400, y: 39, color: kit.color("text") },
        // On a heat fill the error red would not keep its contrast: the dot
        // and the border carry the errors there.
        { text: graphCountText(node), y: 57, color: node.errors && !heat ? kit.color("error") : kit.color("muted") },
        { text: graphTimeText(node), y: 74 },
      );
    }
    kit.drawCard(context, item, card);
  }

  function drawGraph(context, frame) {
    const kit = graphKit();
    const layout = graphUi.layout;
    const minimap = graphUi.pane?.querySelector("#traceGraphMinimap");
    if (!layout) {
      if (minimap) minimap.hidden = true;
      return false;
    }
    const v = graphUi.view;
    const compact = v.scale < GRAPH_READABLE_SCALE - 1e-6;
    // The world rectangle on screen (plus a margin): cards, edges and labels
    // outside it are skipped (a 1,500-node graph redraws on every pan frame).
    const margin = 40 / v.scale;
    const left = -v.offsetX / v.scale - margin;
    const top = -v.offsetY / v.scale - margin;
    const right = left + frame.width / v.scale + margin * 2;
    const bottom = top + frame.height / v.scale + margin * 2;
    const onScreen = (x, y, width, height) => !(x > right || x + width < left || y > bottom || y + height < top);
    context.save();
    context.translate(v.offsetX, v.offsetY);
    context.scale(v.scale, v.scale);
    for (const item of layout.edges) {
      const points = item.points;
      if (points.length < 2) continue;
      const from = layout.items.get(item.from);
      const to = layout.items.get(item.to);
      const x0 = Math.min(from.x, to.x);
      const y0 = Math.min(from.y, to.y);
      if (!onScreen(x0, y0, Math.max(from.x, to.x) + to.width - x0, Math.max(from.y, to.y) + to.height - y0)) continue;
      const highlighted = graphEdgeHighlighted(item);
      context.save();
      context.globalAlpha = highlighted ? 1 : 0.88;
      context.strokeStyle = graphEdgeColor(item, highlighted);
      context.lineWidth = item.width + (highlighted ? 1.2 : 0);
      context.lineJoin = "round";
      context.setLineDash(graphKindDash(item.kind));
      kit.strokePolyline(context, points);
      kit.drawArrowHead(context, points, 7 + item.width);
      context.restore();
    }
    for (const item of layout.items.values()) {
      if (onScreen(item.x, item.y, item.width, item.height)) drawGraphCard(context, item, compact);
    }
    graphUi.labelHits = [];
    if (!compact) {
      context.font = `600 12px ${kit.FONT}`;
      for (const item of layout.edges) {
        const label = layout.labels.get(item.id);
        if (!label) continue;
        const rect = label.rect;
        if (!onScreen(rect.x, rect.y, rect.width, rect.height)) continue;
        kit.drawLabel(context, rect, label.text, { highlighted: graphEdgeHighlighted(item), textColor: item.error ? kit.color("error") : null });
        graphUi.labelHits.push({ id: item.id, ...rect });
      }
    }
    context.restore();

    if (minimap) {
      const visible = kit.anyClipped(layout.items.values(), v, frame.width, frame.height) || compact;
      minimap.hidden = !visible;
      if (!minimap.hidden) {
        // The minimap's cards and edges are built once per layout, selection
        // and theme, not on every pan frame.
        const key = `${graphUi.selected || ""}\u0000${kit.color("error")}\u0000${kit.color("edgeMuted")}`;
        if (!layout.minimap || layout.minimap.key !== key) {
          layout.minimap = {
            key,
            nodes: [...layout.items.values()].map((item) => ({ x: item.x, y: item.y, width: item.width, height: item.height, alpha: item.node.id === graphUi.selected ? 1 : 0.62 })),
            edges: layout.edges.map((item) => ({ points: item.points, dash: graphKindDash(item.kind), width: 1, color: graphEdgeColor(item, false) })),
          };
        }
        kit.drawMinimap(minimap, {
          bounds: layout.bounds,
          nodes: layout.minimap.nodes,
          edges: layout.minimap.edges,
          view: v,
          width: frame.width,
          height: frame.height,
        });
      }
    }
    return false;
  }

  function graphKindDash(kind) {
    const dash = graphKit().DASH;
    return kind === "async" ? dash.message : kind === "db" ? dash.dotted : dash.solid;
  }

  function graphHitTest(clientX, clientY) {
    const kit = graphKit();
    const layout = graphUi.layout;
    const box = graphCanvas()?.getBoundingClientRect();
    if (!layout || !box) return null;
    const v = graphUi.view;
    const point = { x: (clientX - box.left - v.offsetX) / v.scale, y: (clientY - box.top - v.offsetY) / v.scale };
    for (const item of layout.items.values()) {
      if (kit.pointInRect(point, item)) return { type: "node", key: `node\u0000${item.node.id}`, id: item.node.id };
    }
    for (const hit of graphUi.labelHits) {
      if (kit.pointInRect(point, hit, 2 / v.scale)) return { type: "edge", key: `edge\u0000${hit.id}`, id: hit.id };
    }
    const tolerance = 6 / v.scale;
    let best = null;
    for (const item of layout.edges) {
      if (item.points.length < 2) continue;
      const distance = kit.distanceToPolyline(point, item.points);
      if (distance <= tolerance && (!best || distance < best.distance)) best = { item, distance };
    }
    return best ? { type: "edge", key: `edge\u0000${best.item.id}`, id: best.item.id } : null;
  }

  function describeGraphNode(id) {
    const node = graphUi.layout?.items.get(id)?.node;
    if (!node) return "";
    return `${node.service} ${node.operation}: ${fmt.count(node.count)} span${node.count === 1 ? "" : "s"}, ${fmt.count(node.errors)} error${node.errors === 1 ? "" : "s"}, ${fmt.duration(node.time)} (${sharePct(node.percent)} of the trace), self time ${sharePct(node.percentSelf)}. Enter selects it.`;
  }

  // ---------------------------------------------------------- graph panel

  // A click on a call path (or on the edge into it) recentres on it and
  // opens its panel; on the background, closes the panel.
  function selectGraphNode(id, { center = true } = {}) {
    const item = graphUi.layout?.items.get(id);
    if (!item) return;
    graphUi.selected = id;
    renderGraphPanel();
    if (center) graphUi.ctl?.centerOn(item);
    graphUi.ctl?.scheduleDraw();
  }

  // The floating detail panel shell (kit.panelShell: Escape through
  // ns.layers, focus back to the canvas).
  let graphPanelShell = null;
  function graphPanelCtl() {
    const panel = graphPanel();
    if (!graphPanelShell && panel) graphPanelShell = graphKit().panelShell(panel, { opener: () => graphCanvas(), onClose: () => { if (graphUi.selected) closeGraphPanel(); } });
    return graphPanelShell;
  }

  function closeGraphPanel() {
    graphUi.selected = null;
    graphPanelCtl()?.hide();
    graphUi.pane?.classList.remove("graphKitPane--panel");
    graphUi.ctl?.scheduleDraw();
  }

  function graphFragment(html) {
    const template = document.createElement("template");
    template.innerHTML = html;
    return template.content;
  }

  function graphNodeButton(node, extra = "") {
    return `<button type="button" class="graphKitPanel__link traceGraphPanel__path" data-graph-select="${esc(node.id)}" title="${esc(graphPathText(node))}"><span class="traceGraph__dot" style="background:${palette.service(node.service)}"></span>${esc(node.service)} <span>${esc(node.operation)}</span>${extra}</button>`;
  }

  function renderGraphPanel() {
    const kit = graphKit();
    const panel = graphPanel();
    const node = graphUi.layout?.items.get(graphUi.selected)?.node;
    if (!panel || !node) { closeGraphPanel(); return; }
    const traceStart = derived().cache.bounds.start;
    const body = kit.el("div", "graphKitPanel__body");
    body.append(kit.panelHeader({
      eyebrow: "Call path",
      title: node.service,
      dot: palette.service(node.service),
      subtitle: node.operation,
      onClose: () => { closeGraphPanel(); graphCanvas()?.focus?.({ preventScroll: true }); },
    }));
    const stat = (label, value, note = "", cls = "") => `<div><dt>${esc(label)}</dt><dd${cls ? ` class="${cls}"` : ""}>${esc(value)}${note ? `<small>${esc(note)}</small>` : ""}</dd></div>`;
    const errorSpan = node.spans.find((span) => isError(span));
    const spans = node.spans.slice().sort((a, b) => spanStart(a) - spanStart(b));
    const spanRows = spans.slice(0, GRAPH_PANEL_SPANS).map((span) => `<li><button type="button" class="traceGraphPanel__span${isError(span) ? " is-err" : ""}" data-graph-span="${esc(span.span_id)}" title="Show this span in the timeline"><span>+${esc(fmt.duration(Math.max(0, spanStart(span) - traceStart)))}</span><span>${esc(fmt.duration(spanDuration(span)))}</span><code>${esc(span.span_id)}</code></button></li>`).join("");
    const more = spans.length > GRAPH_PANEL_SPANS ? `<p class="graphKitPanel__note">+${spans.length - GRAPH_PANEL_SPANS} more in the timeline</p>` : "";
    const ancestors = [];
    for (let parent = node.parent; parent; parent = parent.parent) ancestors.unshift(parent);
    const children = node.children.slice().sort((a, b) => b.time - a.time);
    body.append(graphFragment('<dl class="graphKitPanel__stats">'
      + stat("Spans", fmt.count(node.count))
      + stat("Errors", fmt.count(node.errors), node.count ? fmt.percent(node.errors / node.count) : "", node.errors ? "is-err" : "")
      + stat("Avg", fmt.duration(node.time / Math.max(1, node.count)))
      + stat("Time", fmt.duration(node.time), `${sharePct(node.percent)} of the trace`)
      + stat("Self time", fmt.duration(node.selfTime), `${sharePct(node.percentSelf)} of its time`)
      + "</dl>"
      + '<div class="graphKitPanel__actions">'
      + `<button type="button" class="button button--primary button--small" data-graph-span="${esc(spans[0]?.span_id || "")}">${node.count > 1 ? "Show the first span in the timeline" : "Show in the timeline"}</button>`
      + (errorSpan && errorSpan !== spans[0] ? `<button type="button" class="button button--small" data-graph-span="${esc(errorSpan.span_id)}">Show the first error</button>` : "")
      + "</div>"
      + (node.count > 1 ? `<section class="graphKitPanel__section"><h3 class="graphKitPanel__sectionTitle">Spans <small>start · duration · span ID</small></h3><ul class="traceGraphPanel__spans">${spanRows}</ul>${more}</section>` : "")
      + (ancestors.length ? `<section class="graphKitPanel__section"><h3 class="graphKitPanel__sectionTitle">Called from</h3><ol class="traceGraphPanel__list">${ancestors.map((parent) => `<li>${graphNodeButton(parent)}</li>`).join("")}</ol></section>` : "")
      + `<section class="graphKitPanel__section"><h3 class="graphKitPanel__sectionTitle">Calls <small>spans · time</small></h3>`
      + (children.length
        ? `<ul class="traceGraphPanel__list">${children.map((child) => `<li>${graphNodeButton(child, `<small>×${esc(fmt.compact(child.count))} · ${esc(fmt.duration(child.time))}</small>`)}</li>`).join("")}</ul>`
        : '<p class="graphKitPanel__note">None</p>')
      + "</section>"));
    graphPanelCtl().show(body);
    graphUi.pane.classList.add("graphKitPane--panel");
  }

  function onGraphActionClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const span = target.closest("[data-graph-span]");
    if (span) {
      const id = String(span.getAttribute("data-graph-span") || "");
      if (id) ctx.focusSpanInTimeline(id, { push: true });
      return;
    }
    const select = target.closest("[data-graph-select]");
    if (select) selectGraphNode(String(select.getAttribute("data-graph-select") || ""));
  }

  // ---------------------------------------------------------- graph view

  function graphMeasure() {
    const context = graphCanvas()?.getContext?.("2d");
    if (!context) return null;
    context.font = `600 12px ${graphKit().FONT}`;
    return (text) => context.measureText(text).width;
  }

  function renderGraph(alt) {
    const kit = graphKit();
    const graph = graphTree();
    if (!kit) {
      alt.innerHTML = ns.uiState.errorHtml({ body: "The trace graph could not be drawn. Reload the page to try again." });
      return;
    }
    if (graph.nodes.length > GRAPH_NODE_LIMIT) {
      alt.innerHTML = ns.uiState.emptyHtml({
        title: "Too many call paths to draw",
        body: `This trace has ${graph.nodes.length} distinct call paths: too many to draw (limit ${GRAPH_NODE_LIMIT}). The Timeline, Statistics and Spans views show every span.`,
      });
      return;
    }
    const pane = graphPane();
    if (alt.firstElementChild !== pane || alt.childElementCount !== 1) alt.replaceChildren(pane);
    const select = pane.querySelector("#traceGraphMode");
    if (select && select.value !== view.graph.mode) {
      select.value = view.graph.mode;
      select.dispatchEvent(new Event("tracepicker-refresh"));
    }
    if (graphUi.graph !== graph) {
      // Another trace: a new layout, no selection, fitted.
      graphUi.graph = graph;
      graphUi.layout = computeGraphLayout(graph, graphMeasure());
      graphUi.hovered = null;
      graphUi.fitted = true;
      closeGraphPanel();
      renderGraphMeta();
    }
    renderGraphLegend();
    graphUi.ctl.size();
    if (graphUi.fitted) fitGraph();
    else graphUi.ctl.scheduleDraw();
  }

  // Turns of a route (its collinear fan anchors are not bends).
  function graphBends(points) {
    let bends = 0;
    for (let i = 1; i + 1 < points.length; i += 1) {
      const vertical = (a, b) => Math.abs(a.x - b.x) < 0.01;
      if (vertical(points[i - 1], points[i]) !== vertical(points[i], points[i + 1])) bends += 1;
    }
    return bends;
  }

  // Read-only geometry of the last drawn frame in client (CSS pixel)
  // coordinates: lets browser tests hover and click real call paths.
  function inspectGraph() {
    const box = graphCanvas()?.getBoundingClientRect();
    const v = graphUi.view;
    const toClient = (rect) => ({
      x: (box?.left || 0) + rect.x * v.scale + v.offsetX,
      y: (box?.top || 0) + rect.y * v.scale + v.offsetY,
      width: rect.width * v.scale,
      height: rect.height * v.scale,
    });
    const layout = graphShown() ? graphUi.layout : null;
    const minimap = graphUi.pane?.querySelector("#traceGraphMinimap");
    return {
      kit: true,
      scale: v.scale,
      offsetX: v.offsetX,
      offsetY: v.offsetY,
      fitScale: graphUi.fitScale,
      readableScale: GRAPH_READABLE_SCALE,
      gridSpacing: graphKit()?.GRID_SPACING,
      fitted: graphUi.fitted,
      mode: view.graph.mode,
      selected: graphUi.selected,
      hovered: graphUi.hovered ? { type: graphUi.hovered.type, id: graphUi.hovered.id } : null,
      keyboardId: graphUi.ctl?.keyboardId() || null,
      animating: !!graphUi.ctl?.animating(),
      minimapVisible: !!minimap && !minimap.hidden,
      timing: graphUi.timing ? { ...graphUi.timing } : null,
      nodes: layout ? [...layout.items.values()].map((item) => {
        const node = item.node;
        return {
          id: node.id, label: graphPathText(node), service: node.service, operation: node.operation, depth: node.depth, row: node.row,
          parent: node.parent?.id || null, count: node.count, errors: node.errors, status: node.errors ? "error" : null,
          countText: graphCountText(node), timeText: graphTimeText(node), heat: graphHeat(node),
          fill: graphFill(node), strip: palette.resolve(palette.service(node.service)), ...toClient(item),
        };
      }) : [],
      edges: layout ? layout.edges.map((item) => ({
        id: item.id, source: item.from, target: item.to, kind: item.kind, error: item.error, width: item.width,
        dash: graphKindDash(item.kind).slice(), bends: graphBends(item.points),
        orthogonal: item.points.every((point, i) => i === 0 || Math.abs(point.x - item.points[i - 1].x) < 0.01 || Math.abs(point.y - item.points[i - 1].y) < 0.01),
        points: item.points.map((point) => toClient({ x: point.x, y: point.y, width: 0, height: 0 })),
      })) : [],
      edgeLabels: (graphUi.labelHits || []).map((hit) => ({ id: hit.id, text: layout?.labels.get(hit.id)?.text || "", ...toClient(hit) })),
      edgeLabelsPlaced: layout ? layout.labels.size : 0,
      edgeLabelsDropped: layout ? layout.dropped.slice() : [],
    };
  }

  ns.traceGraph = { inspect: inspectGraph, state: () => graphUi };

  // ---------------------------------------------------------------- event markers

  // Events of a span grouped by bar position, rounded to 0.2 % of the view
  // (Jaeger's SpanBar): { key, ratio, events }. The waterfall may call it to
  // draw one marker per group.
  function eventGroups(span, viewStartNs, viewTotalNs) {
    const groups = new Map();
    for (const event of ctx.spanEventList(span)) {
      if (!Number.isFinite(event.ns)) continue;
      const ratio = (event.ns - viewStartNs) / Math.max(1, viewTotalNs);
      const key = Math.round(ratio * 500) / 500;
      if (!groups.has(key)) groups.set(key, { key, ratio: key, events: [] });
      groups.get(key).events.push(event);
    }
    return [...groups.values()];
  }

  function waterfallWindow() {
    const cache = ctx.activeTraceCache();
    const total = Math.max(1, cache.extent.end - cache.extent.start);
    const range = Array.isArray(ctx.model.traceViewRange) ? ctx.model.traceViewRange : [0, 1];
    const lo = Math.max(0, Math.min(1, Number(range[0] || 0)));
    const hi = Math.max(lo + 0.005, Math.min(1, Number(range[1] == null ? 1 : range[1])));
    return { start: cache.extent.start + total * lo, total: Math.max(1, total * (hi - lo)) };
  }

  // The open event popover (ns.popover.open: an ns.layers layer, so Escape,
  // a press outside, a scroll or a resize close it and the focus goes back
  // to the marker, or its row).
  let popover = null;

  function closeEventPopover() {
    const open = popover;
    popover = null;
    open?.close({ restoreFocus: false });
  }

  function openEventPopover(marker) {
    const row = marker.closest("[data-span-id]");
    const cache = ctx.activeTraceCache();
    const node = row ? cache.nodeById.get(String(row.getAttribute("data-span-id") || "")) : null;
    if (!node) return;
    const win = waterfallWindow();
    const groups = eventGroups(node.span, win.start, win.total);
    if (!groups.length) return;
    const markerRatio = parseFloat(marker.style.left) / 100;
    const markerKey = Math.round(markerRatio * 500) / 500;
    const group = groups.find((g) => g.key === markerKey)
      || groups.reduce((best, g) => (Math.abs(g.ratio - markerRatio) < Math.abs(best.ratio - markerRatio) ? g : best), groups[0]);
    closeEventPopover();
    const count = group.events.length;
    const html = `<header class="traceEventPopover__head"><b>${count} event${count === 1 ? "" : "s"}</b><span>${ctx.esc(node.span.service_name || "unknown")} · ${ctx.esc(node.span.span_name || "span")}</span><button type="button" class="closeCross closeCross--sm traceEventPopover__close" data-event-popover-close aria-label="Close" title="Close (Esc)">×</button></header><div class="traceEventPopover__list">${group.events.map((event) => ctx.eventItemHtml(event, cache.bounds.start, { open: count <= 3 })).join("")}</div><small class="traceSpanEvents__note">Event timestamps are relative to the start time of the full trace.</small>`;
    const open = ns.popover.open(marker, html, {
      className: "traceEventPopover",
      label: "Span events",
      returnFocus: marker,
      fallbackFocus: () => row,
      onClose: () => { if (popover === open) popover = null; },
    });
    popover = open;
    open.el.style.setProperty("--trace-service-color", palette.service(node.span.service_name));
    open.el.addEventListener("click", (event) => {
      if (event.target instanceof Element && event.target.closest("[data-event-popover-close]")) { open.close(); return; }
      ctx.spanDetailClick(event);
    });
  }

  // ---------------------------------------------------------------- events

  function initAltViewEvents() {
    const alt = byId("traceAltView");
    const tools = byId("traceViewTools");
    alt?.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      const statsSort = target.closest("[data-stats-sort]");
      if (statsSort) {
        const key = statsSort.getAttribute("data-stats-sort");
        if (view.stats.sortKey === key) view.stats.sortAsc = !view.stats.sortAsc;
        else { view.stats.sortKey = key; view.stats.sortAsc = key === "name"; }
        render();
        return;
      }
      const spansSort = target.closest("[data-spans-sort]");
      if (spansSort) {
        const key = spansSort.getAttribute("data-spans-sort");
        if (view.spans.sortKey === key) view.spans.sortAsc = !view.spans.sortAsc;
        else { view.spans.sortKey = key; view.spans.sortAsc = key !== "duration"; }
        render();
        return;
      }
      const spanRow = target.closest("[data-table-span]");
      if (spanRow) {
        ctx.focusSpanInTimeline(String(spanRow.getAttribute("data-table-span") || ""), { push: true });
        return;
      }
      const frame = target.closest("[data-flame-key]");
      if (frame) {
        const key = String(frame.getAttribute("data-flame-key") || "");
        view.flame.zoomKey = key === "0" ? "" : key;
        hideFlameTip();
        render();
      }
    });
    alt?.addEventListener("keydown", (event) => {
      const row = event.target instanceof Element ? event.target.closest("[data-table-span]") : null;
      if (row && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        ctx.focusSpanInTimeline(String(row.getAttribute("data-table-span") || ""), { push: true });
      }
    });
    alt?.addEventListener("mousemove", (event) => {
      const frame = event.target instanceof Element ? event.target.closest("[data-flame-key]") : null;
      if (!frame) { hideFlameTip(); return; }
      showFlameTip(frame, event.clientX, event.clientY);
    });
    alt?.addEventListener("mouseleave", hideFlameTip);
    tools?.addEventListener("change", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLSelectElement)) return;
      if (target.id === "traceStatsGroupBy") view.stats.groupBy = target.value;
      else if (target.id === "traceStatsSubGroup") view.stats.subGroup = target.value;
      else if (target.id === "traceStatsColorBy") view.stats.colorBy = target.value;
      else if (target.id === "traceSpansService") view.spans.service = target.value;
      else if (target.id === "traceSpansStatus") view.spans.status = target.value;
      else return;
      render();
    });
    ns.search.within(tools, "#traceSpansFilter", (value) => { view.spans.text = value; render(); }, { compact: true });
    tools?.addEventListener("click", (event) => {
      if (event.target instanceof Element && event.target.closest("[data-flame-reset]")) {
        view.flame.zoomKey = "";
        render();
      }
    });
  }

  // The flamegraph's pointer tooltip (ns.popover.follow).
  let flameTip = null;
  function showFlameTip(frame, x, y) {
    flameTip = flameTip || ns.popover.follow({ className: "traceFlame__tip", side: "bottom", align: "start", offset: 16 });
    const count = Number(frame.getAttribute("data-flame-count") || 1);
    flameTip.show({ x: x + 12, y }, `<b>${ctx.esc(frame.getAttribute("data-flame-name"))}</b><span>Duration: <strong>${ctx.esc(frame.getAttribute("data-flame-duration"))}</strong></span><span>${fmt.count(count)} span${count === 1 ? "" : "s"} · ${ctx.esc(frame.getAttribute("data-flame-share"))} of the trace</span>`, { html: true });
  }
  function hideFlameTip() { flameTip?.hide(); }

  function install(context) {
    ctx = context;
    const select = byId("traceViewSelect");
    if (select) {
      ctx.enhanceTraceSelect(select);
      select.addEventListener("change", () => setView(select.value, { url: "replace" }));
    }
    viewTabs = ns.tabs?.bind(byId("traceViewTabs"), { onSelect: (name) => { if (name !== view.current) setView(name, { url: "replace" }); } }) || null;
    initAltViewEvents();
    const waterfall = byId("traceWaterfall");
    // Event markers on the span bars open their group's popover instead of
    // toggling the span row.
    waterfall?.addEventListener("click", (event) => {
      const marker = event.target instanceof Element ? event.target.closest(".traceSpanEventMarker") : null;
      if (!marker || !waterfall.contains(marker)) return;
      event.preventDefault();
      event.stopPropagation();
      openEventPopover(marker);
    }, true);
    if (waterfall && typeof MutationObserver === "function") {
      const mark = ns.util.rafOnce(() => markFocusedSpan());
      new MutationObserver(() => {
        if (ctx.model.focusedSpanId) mark();
      }).observe(waterfall, { childList: true, subtree: true });
    }
    const detail = byId("traceDetail");
    if (detail) detail.dataset.traceView = "timeline";
  }

  ns.traceViews = { install, applyLocation, render, setView, showTimeline, onSpanToggled, markFocusedSpan, eventGroups, openEventPopover, closeEventPopover, selfTimeOf };
})();
