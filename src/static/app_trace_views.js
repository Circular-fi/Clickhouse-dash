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
  const STORAGE_KEY = "chdash.traceView";
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
  const fmt = (value) => ctx.formatDuration(value);

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
    try {
      const value = localStorage.getItem(STORAGE_KEY);
      return VIEWS.includes(value) ? value : "";
    } catch (_) {
      return "";
    }
  }

  function storeView(value) {
    try { localStorage.setItem(STORAGE_KEY, value); } catch (_) { /* storage is optional */ }
  }

  function updateParams(mutate, { push = false } = {}) {
    const url = new URL(window.location.href);
    mutate(url.searchParams);
    const next = `${url.pathname}${url.search}${url.hash}`;
    if (next === `${window.location.pathname}${window.location.search}${window.location.hash}`) return;
    if (push) window.history.pushState(window.history.state, "", next);
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

  function pickerHtml(id, label, options, value) {
    const opts = options.map(([v, text]) => `<option value="${esc(v)}"${v === value ? " selected" : ""}>${esc(text)}</option>`).join("");
    return `<label class="traceViewBar__field"><span class="traceViewBar__label">${esc(label)}</span><select id="${esc(id)}" class="traceViewBar__select">${opts}</select></label>`;
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

  function setView(name, { url = "replace", persist = true } = {}) {
    const next = VIEWS.includes(name) ? name : "timeline";
    view.current = next;
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
      alt.innerHTML = '<div class="tracesEmpty">No spans.</div>';
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
    if (key === "count") return String(value);
    if (key === "percent") return `${(Math.round(value * 100) / 100).toFixed(2)}%`;
    return fmt(value);
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
      const style = [row.service ? `--trace-service-color:${ctx.serviceColor(row.service)}` : "", heat(row)].filter(Boolean).join(";");
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
      `<label class="traceViewBar__field traceViewBar__field--search"><span class="traceViewBar__label">Filter</span><input id="traceSpansFilter" class="traceViewBar__input" type="search" placeholder="Service, operation or span ID" autocomplete="off" spellcheck="false"></label>`,
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
      return `<tr class="traceSpansTable__row${isError(span) ? " is-error" : ""}" data-table-span="${esc(span.span_id)}" tabindex="0" title="Show in the timeline"><td data-col="service"><span class="traceSpansTable__service" style="--trace-service-color:${ctx.serviceColor(span.service_name)}">${esc(span.service_name || "unknown")}</span></td><td data-col="operation">${esc(span.span_name || "span")}</td><td data-col="duration">${esc(fmt(spanDuration(span)))}</td><td data-col="start">${esc(fmt(Math.max(0, spanStart(span) - traceStart)))}</td><td data-col="status"><span class="traceSpansTable__status traceSpansTable__status--${esc(status.toLowerCase())}">${esc(status)}</span></td><td data-col="kind">${esc(ctx.spanKindLabel(span.span_kind))}</td><td data-col="id"><code>${esc(span.span_id)}</code></td></tr>`;
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
      const color = node.service ? ctx.serviceColor(node.service) : "";
      bars.push(`<div class="traceFlame__frame${ancestor ? " is-ancestor" : ""}${node === root ? " is-root" : ""}${node.errors ? " has-error" : ""}" data-flame-key="${esc(node.key)}" style="left:${left.toFixed(4)}%;width:${width.toFixed(4)}%;top:${row * 20}px${color ? `;--trace-service-color:${color}` : ""}" data-flame-name="${esc(node.name)}" data-flame-duration="${esc(fmt(node.duration))}" data-flame-count="${node.count}" data-flame-share="${share.toFixed(2)}"><span>${esc(node.name)}</span></div>`);
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
  // count / errors, total time (% of the trace), average and self time.
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
      parent, children: [], childByName: new Map(), count: 0, errors: 0, time: 0, selfTime: 0,
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

  const GRAPH_NODE_W = 260;
  const GRAPH_NODE_H = 48;
  const GRAPH_GAP_X = 22;
  const GRAPH_GAP_Y = 46;

  function graphLayout(graph) {
    let slot = 0;
    const place = (node, depth) => {
      node.depth = depth;
      if (!node.children.length) {
        node.slot = slot;
        slot += 1;
        return;
      }
      for (const child of node.children) place(child, depth + 1);
      node.slot = (node.children[0].slot + node.children[node.children.length - 1].slot) / 2;
    };
    for (const root of graph.roots) place(root, 0);
    const depth = graph.nodes.reduce((max, node) => Math.max(max, node.depth), 0);
    return {
      width: Math.max(1, slot) * (GRAPH_NODE_W + GRAPH_GAP_X) + GRAPH_GAP_X,
      height: (depth + 1) * (GRAPH_NODE_H + GRAPH_GAP_Y) + GRAPH_GAP_Y,
      x: (node) => GRAPH_GAP_X + node.slot * (GRAPH_NODE_W + GRAPH_GAP_X),
      y: (node) => GRAPH_GAP_Y / 2 + node.depth * (GRAPH_NODE_H + GRAPH_GAP_Y),
    };
  }

  function round2(value) { return Math.round(value * 100) / 100; }

  function renderGraph(alt) {
    toolsFor("graph", () => [
      pickerHtml("traceGraphMode", "Colour", [["service", "Service"], ["time", "Time"], ["selftime", "Self time"]], view.graph.mode),
      '<span class="traceGraph__legend" aria-label="Node legend"><span>Count / Errors</span><b>Service</b><span>Avg</span><span>Duration (%)</span><b>Operation</b><span>Self time (%)</span></span>',
    ].join(""));
    const graph = graphTree();
    if (graph.nodes.length > GRAPH_NODE_LIMIT) {
      alt.innerHTML = `<div class="tracesEmpty">This trace has ${graph.nodes.length} distinct call paths: too many to draw (limit ${GRAPH_NODE_LIMIT}).</div>`;
      return;
    }
    const layout = graphLayout(graph);
    const edges = [];
    const boxes = [];
    for (const node of graph.nodes) {
      const x = layout.x(node);
      const y = layout.y(node);
      if (node.parent) {
        const px = layout.x(node.parent) + GRAPH_NODE_W / 2;
        const py = layout.y(node.parent) + GRAPH_NODE_H;
        const cx = x + GRAPH_NODE_W / 2;
        const mid = (py + y) / 2;
        edges.push(`<path class="traceGraph__edge" d="M${px},${py} C${px},${mid} ${cx},${mid} ${cx},${y}"></path>`);
      }
      let background = "";
      if (view.graph.mode === "time") background = `--trace-graph-heat:${round2(Math.min(node.percent / 20, 1) * 100)}%`;
      else if (view.graph.mode === "selftime") background = `--trace-graph-heat:${round2(node.percentSelf)}%`;
      const style = `left:${x}px;top:${y}px;width:${GRAPH_NODE_W}px;height:${GRAPH_NODE_H}px;--trace-service-color:${ctx.serviceColor(node.service)}${background ? `;${background}` : ""}`;
      boxes.push(`<div class="traceGraph__node traceGraph__node--${view.graph.mode}${node.errors ? " has-error" : ""}" style="${style}" data-graph-node="${esc(`${node.service} ${node.operation}`)}" title="${esc(`${node.service} ${node.operation}`)}"><span class="traceGraph__count">${node.count} / ${node.errors}</span><b class="traceGraph__service">${esc(node.service)}</b><span class="traceGraph__avg">${esc(fmt(node.time / Math.max(1, node.count)))}</span><span class="traceGraph__time">${esc(fmt(node.time))} (${round2(node.percent)}%)</span><span class="traceGraph__op">${esc(node.operation)}</span><span class="traceGraph__self">${esc(fmt(node.selfTime))} (${round2(node.percentSelf)}%)</span></div>`);
    }
    alt.innerHTML = `<div class="traceGraph"><div class="traceGraph__canvas" style="width:${layout.width}px;height:${layout.height}px"><svg class="traceGraph__edges" width="${layout.width}" height="${layout.height}" aria-hidden="true">${edges.join("")}</svg>${boxes.join("")}</div></div>`;
  }

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

  let popover = null;
  let popoverCleanup = null;

  function closeEventPopover() {
    if (popoverCleanup) popoverCleanup();
    popoverCleanup = null;
    popover?.remove();
    popover = null;
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
    popover = document.createElement("div");
    popover.className = "traceEventPopover";
    popover.setAttribute("role", "dialog");
    popover.setAttribute("aria-label", "Span events");
    popover.style.setProperty("--trace-service-color", ctx.serviceColor(node.span.service_name));
    const count = group.events.length;
    popover.innerHTML = `<header class="traceEventPopover__head"><b>${count} event${count === 1 ? "" : "s"}</b><span>${ctx.esc(node.span.service_name || "unknown")} · ${ctx.esc(node.span.span_name || "span")}</span><button type="button" class="traceEventPopover__close" data-event-popover-close aria-label="Close">×</button></header><div class="traceEventPopover__list">${group.events.map((event) => ctx.eventItemHtml(event, cache.bounds.start, { open: count <= 3 })).join("")}</div><small class="traceSpanEvents__note">Event timestamps are relative to the start time of the full trace.</small>`;
    document.body.appendChild(popover);
    const rect = marker.getBoundingClientRect();
    const width = popover.offsetWidth;
    const height = popover.offsetHeight;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.left + rect.width / 2 - width / 2));
    const below = rect.bottom + 6;
    const top = below + height > window.innerHeight - 8 && rect.top - height - 6 > 8 ? rect.top - height - 6 : below;
    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(Math.max(8, top))}px`;
    const onDocClick = (event) => {
      if (popover && event.target instanceof Node && !popover.contains(event.target) && !event.target.closest?.(".traceSpanEventMarker")) closeEventPopover();
    };
    const onKey = (event) => { if (event.key === "Escape") closeEventPopover(); };
    const onScroll = (event) => { if (popover && !(event.target instanceof Node && popover.contains(event.target))) closeEventPopover(); };
    popover.addEventListener("click", (event) => {
      if (event.target instanceof Element && event.target.closest("[data-event-popover-close]")) { closeEventPopover(); return; }
      ctx.spanDetailClick(event);
    });
    document.addEventListener("click", onDocClick, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", closeEventPopover);
    popoverCleanup = () => {
      document.removeEventListener("click", onDocClick, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", closeEventPopover);
    };
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
      else if (target.id === "traceGraphMode") view.graph.mode = target.value;
      else return;
      render();
    });
    tools?.addEventListener("input", (event) => {
      if (!(event.target instanceof HTMLInputElement) || event.target.id !== "traceSpansFilter") return;
      view.spans.text = event.target.value;
      render();
    });
    tools?.addEventListener("click", (event) => {
      if (event.target instanceof Element && event.target.closest("[data-flame-reset]")) {
        view.flame.zoomKey = "";
        render();
      }
    });
  }

  let flameTip = null;
  function showFlameTip(frame, x, y) {
    if (!flameTip) {
      flameTip = document.createElement("div");
      flameTip.className = "traceFlame__tip";
      flameTip.setAttribute("role", "tooltip");
      document.body.appendChild(flameTip);
    }
    const count = Number(frame.getAttribute("data-flame-count") || 1);
    flameTip.innerHTML = `<b>${ctx.esc(frame.getAttribute("data-flame-name"))}</b><span>Duration: <strong>${ctx.esc(frame.getAttribute("data-flame-duration"))}</strong></span><span>${count} span${count === 1 ? "" : "s"} · ${ctx.esc(frame.getAttribute("data-flame-share"))}% of the trace</span>`;
    flameTip.hidden = false;
    const width = flameTip.offsetWidth;
    const height = flameTip.offsetHeight;
    flameTip.style.left = `${Math.round(Math.min(window.innerWidth - width - 8, x + 12))}px`;
    flameTip.style.top = `${Math.round(y + 16 + height > window.innerHeight ? y - height - 10 : y + 16)}px`;
  }
  function hideFlameTip() { if (flameTip) flameTip.hidden = true; }

  function install(context) {
    ctx = context;
    const select = byId("traceViewSelect");
    if (select) {
      ctx.enhanceTraceSelect(select);
      select.addEventListener("change", () => setView(select.value, { url: "replace" }));
    }
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
      let queued = false;
      new MutationObserver(() => {
        if (queued || !ctx.model.focusedSpanId) return;
        queued = true;
        requestAnimationFrame(() => { queued = false; markFocusedSpan(); });
      }).observe(waterfall, { childList: true, subtree: true });
    }
    const detail = byId("traceDetail");
    if (detail) detail.dataset.traceView = "timeline";
  }

  ns.traceViews = { install, applyLocation, render, setView, showTimeline, onSpanToggled, markFocusedSpan, eventGroups, openEventPopover, closeEventPopover, selfTimeOf };
})();
