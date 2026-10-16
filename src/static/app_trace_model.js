// This file gives the trace of a span list, with no page behind it (ARCH-F-155).
// It holds the tree of the spans, the critical path, the extent and the bounds of a trace.
// It also holds the durations on an axis and the sort of a list of traces.
// It holds the spans, events and links of a span as data, and the JSON text of a trace.
// The Node unit tests run this module in a bare context (tests/frontend/model/trace-model.test.cjs).

import { format } from "./app_format.js";

const fmt = format;

// Duration axis steps: 1-2-5 below a second. Above a second, the steps are clock-friendly: seconds, minutes, hours and days.
// So minute axes read 2 min, 5 min and 15 min.
const DURATION_AXIS_STEPS_NS = (() => {
  const steps = [];
  for (let decade = 1; decade < 1e9; decade *= 10) for (const m of [1, 2, 5]) steps.push(m * decade);
  for (const s of [1, 2, 5, 10, 15, 30]) steps.push(s * 1e9);
  for (const m of [1, 2, 5, 10, 15, 30]) steps.push(m * 60e9);
  for (const h of [1, 2, 3, 6, 12]) steps.push(h * 3600e9);
  for (const d of [1, 2, 5, 10, 30]) steps.push(d * 86400e9);
  return steps;
})();

// Jaeger's ['auto', 'auto'] duration domain: the data range, padded by 5 % on each side.
// A flat series is padded by 10 % of its value instead.
// The domain snaps to whole steps. So close percentiles do not flatten against a zero baseline.
// The step is the finest one whose labels all differ.
function durationAxis(minNsValue, maxNsValue, targetIntervals = 7) {
  let lo = Math.max(0, Number(minNsValue) || 0);
  let hi = Math.max(lo, Number(maxNsValue) || 0);
  if (!(hi > 0)) hi = 1;
  const pad = hi > lo ? (hi - lo) * 0.05 : Math.max(1, hi * 0.1);
  lo = Math.max(0, lo - pad);
  hi += pad;
  const last = DURATION_AXIS_STEPS_NS[DURATION_AXIS_STEPS_NS.length - 1];
  const first = DURATION_AXIS_STEPS_NS.findIndex((candidate) => (hi - lo) / candidate <= targetIntervals);
  for (let index = first < 0 ? DURATION_AXIS_STEPS_NS.length - 1 : first; index < DURATION_AXIS_STEPS_NS.length; index += 1) {
    const step = DURATION_AXIS_STEPS_NS[index];
    const axisMin = Math.floor(lo / step) * step;
    const axisMax = Math.max(axisMin + step, Math.ceil(hi / step) * step);
    const values = [];
    for (let i = 0; axisMin + i * step <= axisMax + step * 1e-6; i += 1) {
      const value = axisMin + i * step;
      values.push({ value, label: value ? fmt.duration(value) : "0" });
    }
    const distinct = new Set(values.map((tick) => tick.label)).size === values.length;
    if (distinct || step === last) return { axisMin, axisMax, values };
  }
  return { axisMin: 0, axisMax: last, values: [{ value: 0, label: "0" }, { value: last, label: fmt.duration(last) }] };
}

// Evenly spaced ticks over a window of `durationNs`. The window starts `offsetNs` after the trace start (a zoomed waterfall).
// The labels are offsets from the trace start, like Jaeger's.
// They never restart at 0.
function durationTicks(durationNs, count = 5, offsetNs = 0) {
  const duration = Math.max(1, Number(durationNs || 0));
  const offset = Math.max(0, Number(offsetNs || 0));
  const n = Math.max(2, Number(count || 5));
  const step = duration / (n - 1);
  return Array.from({ length: n }, (_, index) => {
    const ratio = index / (n - 1);
    const ns = offset + duration * ratio;
    return { ratio, ns, label: offset ? tickDurationLabel(ns, step) : fmt.duration(ns) };
  });
}

// fmt.duration, with the extra decimals that a deep zoom needs.
// Adjacent ticks then never read the same, for example "50.003 ms" and "50.005 ms".
function tickDurationLabel(ns, stepNs) {
  const text = fmt.duration(ns);
  const match = /^(\d+(?:\.(\d+))?) (µs|ms|s)$/.exec(text);
  if (!match || !(stepNs > 0)) return text;
  const factor = match[3] === "s" ? 1e9 : match[3] === "ms" ? 1e6 : 1e3;
  // One decimal below the step's leading digit. A 0.25 ms step reads 74.75.
  const needed = Math.min(6, Math.max(0, Math.ceil(-Math.log10(stepNs / factor)) + 1));
  return needed > (match[2] || "").length ? `${(ns / factor).toFixed(needed)} ${match[3]}` : text;
}

// Wall-clock time that is `offsetNs` after the epoch-ns instant `startNs`, in the local time of the browser.
// An example is 10:59:59.312.
// Microseconds appear when the tick step is below a millisecond.
// The offset is added to the sub-millisecond remainder of the start, not to the epoch value.
// A double holds the epoch value only to ~256 ns.
function wallClockLabel(startNs, offsetNs = 0, stepNs = Infinity) {
  if (!Number.isFinite(startNs) || !Number.isFinite(offsetNs)) return "";
  const startMs = Math.floor(startNs / 1e6);
  // Use whole nanoseconds. A view fraction like 0.49999999999999994 must not read one millisecond early.
  const withinNs = Math.round(Math.max(0, startNs - startMs * 1e6) + offsetNs);
  const ms = startMs + Math.floor(withinNs / 1e6);
  const base = fmt.time(ms, { precision: "ms", date: "never" });
  if (!(stepNs < 1e6)) return base;
  const micros = Math.max(0, Math.min(999, Math.floor((withinNs % 1e6) / 1e3)));
  return `${base}${String(micros).padStart(3, "0")}`;
}

function timestampToNs(value) {
  if (value == null || value === "") return NaN;
  const direct = Number(value);
  if (Number.isFinite(direct)) {
    const abs = Math.abs(direct);
    if (abs >= 1e17) return direct;
    if (abs >= 1e14) return direct * 1e3;
    if (abs >= 1e11) return direct * 1e6;
    if (abs >= 1e9) return direct * 1e9;
  }
  const raw = String(value).trim();
  if (!raw) return NaN;
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(?:Z|[+-]\d\d(?::?\d\d)?)?$/);
  if (match) {
    const fraction = (match[3] || "").slice(0, 9).padEnd(9, "0");
    const parsed = Date.parse(`${match[1]}T${match[2]}.${fraction.slice(0, 3)}Z`);
    if (Number.isFinite(parsed)) return parsed * 1e6 + Number(fraction.slice(3));
  }
  const parsed = Date.parse(raw.includes("T") ? raw : raw.replace(" ", "T") + "Z");
  return Number.isFinite(parsed) ? parsed * 1e6 : NaN;
}

function shortId(value, size = 7) {
  const s = String(value || "");
  return s.length <= size * 2 + 1 ? s : `${s.slice(0, size)}\u2026${s.slice(-size)}`;
}

function parseStartMs(value) {
  const direct = Number(value);
  if (Number.isFinite(direct) && direct > 10000000000) return direct;
  const raw = String(value || "").trim();
  if (!raw) return NaN;
  const normalized = raw.includes("T") ? raw : raw.replace(" ", "T");
  const withZone = /(?:Z|[+-]\d\d(?::?\d\d)?)$/i.test(normalized) ? normalized : `${normalized}Z`;
  const ms = Date.parse(withZone);
  return Number.isFinite(ms) ? ms : NaN;
}

// The services of a trace read in the order that they joined the trace.
// The order uses the earliest span start (offset from the trace start), then the name.
function orderByFirstSpan(stats) {
  return stats.sort((a, b) => (a.first_span_ns - b.first_span_ns) || (a.service < b.service ? -1 : a.service > b.service ? 1 : 0));
}

function unpackAnalytics(payload, previous = null) {
  const charts = Array.isArray(payload?.charts) ? payload.charts.map(String) : ["counts", "durations"];
  const hasDurations = charts.includes("durations");
  return {
    range: Array.isArray(payload?.range) ? payload.range.map(Number) : [0, 1],
    bucket_ms: Number(payload?.bucket_ms || 60000),
    quantile_bucket_ms: Number(payload?.quantile_bucket_ms || payload?.bucket_ms || 60000),
    trace_count_chart: Array.isArray(payload?.trace_count_chart) ? payload.trace_count_chart : [],
    trace_count_source: String(payload?.trace_count_source || "span_bounds"),
    has_durations: hasDurations,
    duration_quantiles: hasDurations
      ? (Array.isArray(payload?.duration_quantiles) ? payload.duration_quantiles : [])
      : (previous?.duration_quantiles || []),
  };
}

// Bucket starts lie on a regular grid, from the first to the last bucket.
// The value of each bucket is 0 or NaN where the answer has none.
function bucketGrid(buckets, bucketMs, empty) {
  const first = buckets[0][0];
  const count = Math.max(1, Math.min(20000, Math.round((buckets[buckets.length - 1][0] - first) / bucketMs) + 1));
  const starts = new Float64Array(count);
  for (let i = 0; i < count; i += 1) starts[i] = first + i * bucketMs;
  const slot = new Int32Array(buckets.length);
  buckets.forEach(([bucket], k) => { slot[k] = Math.max(0, Math.min(count - 1, Math.round((bucket - first) / bucketMs))); });
  return { starts, slot, empty };
}

// The list follows the sort picker. The table sorts by its column headers, in both directions.
// The table starts from the order of the picker.
const LIST_SORTS = {
  recent: { key: "start", dir: "desc" },
  longest: { key: "duration", dir: "desc" },
  shortest: { key: "duration", dir: "asc" },
  spans: { key: "spans", dir: "desc" },
};
const TABLE_COLUMNS = [
  { key: "name", label: "Name", numeric: false },
  { key: "services", label: "Services", numeric: true },
  { key: "spans", label: "Spans", numeric: true },
  { key: "errors", label: "Errors", numeric: true },
  { key: "duration", label: "Duration", numeric: true },
  { key: "start", label: "Start", numeric: true },
];

function traceName(trace) {
  return `${trace.root_service || "unknown"}: ${trace.root_operation || "trace"}`;
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function traceSortValue(trace, key) {
  if (key === "name") return traceName(trace).toLowerCase();
  if (key === "services") return (trace.service_stats || []).length;
  if (key === "spans") return Number(trace.span_count || 0);
  if (key === "errors") return Number(trace.error_count || 0);
  if (key === "duration") return Number(trace.duration_ns || 0);
  return Number(trace.start_ms || 0);
}

function sortTraces(rows, { key, dir }) {
  const sign = dir === "asc" ? 1 : -1;
  // Ties keep the newest trace first. Then the trace ID decides, in both directions.
  return rows.sort((a, b) => {
    const av = traceSortValue(a, key), bv = traceSortValue(b, key);
    const cmp = typeof av === "string" ? compareText(av, bv) : av - bv;
    return (cmp * sign) || (Number(b.start_ms || 0) - Number(a.start_ms || 0)) || compareText(a.trace_id, b.trace_id);
  });
}

// An all-zero parent ID is how some exporters write "no parent".
function parentSpanId(span) {
  const id = String(span?.parent_span_id || "");
  return /^0*$/.test(id) ? "" : id;
}

function buildTree(spans) {
  const nodes = (Array.isArray(spans) ? spans : []).map((span) => ({ span, children: [], depth: 0 }));
  const itemById = new Map(nodes.map((node) => [String(node.span.span_id || ""), node]));
  const roots = [];
  for (const node of nodes) {
    const parentId = parentSpanId(node.span);
    const parent = parentId ? itemById.get(parentId) : null;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  const cmp = (a, b) => Number(a.span.start_ns || 0) - Number(b.span.start_ns || 0) || String(a.span.span_id || "").localeCompare(String(b.span.span_id || ""));
  // This loop is iterative. A long parent chain must not exhaust the call stack.
  roots.sort(cmp);
  const stack = roots.map((root) => [root, 0]);
  while (stack.length) {
    const [node, depth] = stack.pop();
    node.depth = Math.min(32, depth);
    node.children.sort(cmp);
    for (const child of node.children) stack.push([child, depth + 1]);
  }
  return { nodes, roots };
}

// The code uses a single pass and does not spread arguments.
// Math.min(...list) throws a RangeError when a trace approaches ~100k spans. It also allocates two temporary arrays.
function spanExtent(spans) {
  let start = Infinity;
  let end = -Infinity;
  for (const s of spans) {
    const spanStart = Number(s.start_ns || 0);
    const spanEnd = spanStart + Number(s.duration_ns || 0);
    if (Number.isFinite(spanStart) && spanStart < start) start = spanStart;
    if (spanEnd > end) end = spanEnd;
  }
  return { start, end };
}

function traceBounds(spans) {
  const { start, end } = spanExtent(spans);
  if (!Number.isFinite(start)) return { start: 0, end: 1, duration: 1 };
  return { start, end, duration: Math.max(1, end - start) };
}

function isErrorSpan(span) {
  return String(span?.status_code || "").toLowerCase() === "error";
}

function spanKey(node) {
  return String(node?.span?.span_id || "");
}

// This block holds the structures that the views of one trace read. The code builds them once from the spans.
// These structures are the tree, the span of each ID, and the order of the waterfall.
// They also hold the spans with an error below them, the counts and the bounds.
// The caches of a view (events, decorations and critical path) are attached to it.
function createTraceCache(trace) {
  const spans = trace?.spans || [];
  const tree = buildTree(spans);
  const nodeById = new Map();
  const duplicateIds = new Set();
  const parentOf = new Map();
  for (const node of tree.nodes) {
    const id = String(node.span.span_id || "");
    if (nodeById.has(id)) duplicateIds.add(id);
    else nodeById.set(id, node);
    node.children.forEach((child, index) => {
      parentOf.set(child, node);
      child.isLast = index === node.children.length - 1;
    });
  }
  // Tree (waterfall) order with uncapped levels, like Jaeger's span list.
  const order = [];
  const stack = tree.roots.slice().reverse().map((node) => [node, 0]);
  while (stack.length) {
    const [node, level] = stack.pop();
    node.level = level;
    node.orderIndex = order.length;
    order.push(node);
    for (let i = node.children.length - 1; i >= 0; i -= 1) stack.push([node.children[i], level + 1]);
  }
  // Spans with an error span somewhere below them.
  const errorBelow = new Set();
  let maxLevel = 0;
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const node = order[i];
    if (node.level > maxLevel) maxLevel = node.level;
    const parent = parentOf.get(node);
    if (parent && (isErrorSpan(node.span) || errorBelow.has(node))) errorBelow.add(parent);
  }
  return {
    trace,
    spans,
    tree,
    nodeById,
    duplicateIds,
    parentOf,
    order,
    errorBelow,
    maxLevel,
    // Spans whose parent is not in the trace (Jaeger's orphan spans).
    orphanCount: tree.roots.filter((node) => parentSpanId(node.span)).length,
    errorCount: spans.filter(isErrorSpan).length,
    serviceCount: new Set(spans.map((span) => String(span.service_name || "unknown"))).size,
    extent: spanExtent(spans),
    bounds: traceBounds(spans),
    serviceStats: null,
    events: new Map(),
    decorations: new Map(),
    criticalPath: null,
  };
}

// --- Critical path (Jaeger's CriticalPath/index.ts) ------------------------
// From each root, follow the child that finishes last.
// On the way back, take the child that finished last before the child that returns started.
// A consumer child of a producer does not block it.
// Children are first clipped to their parent (sanitizeOverFlowingChildren).
// The code is iterative, so deep traces are safe.
function criticalPathSections(cache) {
  if (cache.criticalPath) return cache.criticalPath;
  const byNode = new Map();
  const kind = (node) => String(node?.span?.span_kind || "").toLowerCase();
  const blocking = (child, parent) => !(kind(parent).includes("producer") && kind(child).includes("consumer"));
  const add = (node, start, end) => {
    if (start === end) return;
    const list = byNode.get(node);
    if (list) list.push({ start, end });
    else byNode.set(node, [{ start, end }]);
  };
  for (const root of cache.tree.roots) {
    // Like Jaeger, a span with a missing parent (an orphan) gets no critical path.
    // Its subtree gets no critical path either.
    if (parentSpanId(root.span)) continue;
    // Pre-order over blocking descendants. Parents are clipped first.
    const list = [];
    const stack = [[root, null]];
    while (stack.length) {
      const [node, parent] = stack.pop();
      const start = Number(node.span.start_ns || 0);
      const cp = { node, parent, start, end: start + Number(node.span.duration_ns || 0), children: [], removed: false };
      if (parent) parent.children.push(cp);
      list.push(cp);
      for (let i = node.children.length - 1; i >= 0; i -= 1) {
        if (blocking(node.children[i], node)) stack.push([node.children[i], cp]);
      }
    }
    for (const cp of list) {
      const parent = cp.parent;
      if (!parent) continue;
      const drop = () => { cp.removed = true; parent.children = parent.children.filter((child) => child !== cp); };
      if (parent.removed) { cp.removed = true; continue; }
      if (cp.start >= parent.start) {
        if (cp.start >= parent.end) drop();
        else if (cp.end > parent.end) cp.end = parent.end;
      } else if (cp.end <= parent.start) {
        drop();
      } else {
        cp.start = parent.start;
        if (cp.end > parent.end) cp.end = parent.end;
      }
    }
    const lastFinishingChild = (cp, before) => {
      let best = null;
      for (const child of cp.children) {
        if (before != null && !(child.end < before)) continue;
        if (!best || child.end > best.end) best = child;
      }
      return best;
    };
    let current = list[0];
    let returning = null;
    for (let guard = list.length * 4 + 8; current && guard > 0; guard -= 1) {
      const child = lastFinishingChild(current, returning);
      const end = returning == null ? current.end : returning;
      if (child) {
        add(current.node, child.end, end);
        current = child;
        returning = null;
      } else {
        add(current.node, current.start, end);
        returning = current.start;
        current = current.parent;
      }
    }
  }
  cache.criticalPath = byNode;
  return byNode;
}

// A span's sections. A collapsed span shows the sections of its whole hidden subtree.
function criticalSectionsFor(cache, node, collapsed) {
  const byNode = criticalPathSections(cache);
  if (!collapsed) return byNode.get(node) || [];
  const merged = [];
  const order = cache.order;
  for (let i = node.orderIndex; i < order.length && (i === node.orderIndex || order[i].level > node.level); i += 1) {
    for (const section of byNode.get(order[i]) || []) merged.push({ ...section });
  }
  merged.sort((a, b) => a.start - b.start);
  const out = [];
  for (const section of merged) {
    const last = out[out.length - 1];
    if (last && section.start <= last.end) last.end = Math.max(last.end, section.end);
    else out.push(section);
  }
  return out;
}

function parseStructuredValue(raw) {
  if (raw == null) return null;
  if (typeof raw !== "string") return raw;
  const text = raw.trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) {}
  return null;
}

// The "Copy trace JSON" document is what /api/traces/trace returns for the open trace.
// The spans are ordered by start time, then by span ID. The document has a 2-space indent, as shown:
//   { trace_id, truncated, span_count, spans: [{ trace_id, span_id,
//     parent_span_id, service_name, span_name, span_kind, timestamp,
//     start_ns, duration_ns, status_code, status_message,
//     span_attributes?, resource_attributes?,
//     events?: [{ timestamp, name, attributes }],
//     links?: [{ trace_id, span_id, attributes }] }] }
// The endpoint sends attributes, events and links as JSON-encoded columns.
// This code decodes them. Events and links are zipped into one object each.
// Keys marked ? exist only when the endpoint returns them (per-feature columns).
// start_ns keeps the exact integer of the endpoint (see traceJsonExactStartNs).
const TRACE_JSON_SPAN_KEYS = ["trace_id", "span_id", "parent_span_id", "service_name", "span_name", "span_kind",
  "timestamp", "start_ns", "duration_ns", "status_code", "status_message"];
const TRACE_JSON_EXACT_NS = "\u0000exact-ns:";

// start_ns is an epoch in nanoseconds, above 2^53. The parsed JSON number loses its last digits.
// The span's `timestamp` string ends with the exact nanoseconds of its second.
// These nanoseconds restore the integer that the endpoint sent.
function traceJsonExactStartNs(span) {
  const rounded = Number(span.start_ns);
  const fraction = /\.(\d{9})$/.exec(String(span.timestamp || ""));
  if (!Number.isFinite(rounded) || Number.isSafeInteger(rounded) || !fraction) return null;
  const fractionNs = Number(fraction[1]);
  const exact = BigInt(Math.round((rounded - fractionNs) / 1e9)) * 1000000000n + BigInt(fractionNs);
  return Math.abs(Number(exact) - rounded) < 1e6 ? exact.toString() : null;
}

function traceJsonColumns(columns) {
  const lists = Object.entries(columns).map(([key, raw]) => {
    const value = parseStructuredValue(raw);
    return [key, Array.isArray(value) ? value : []];
  });
  const count = Math.max(0, ...lists.map(([, list]) => list.length));
  return Array.from({ length: count }, (_, index) => Object.fromEntries(lists.map(([key, list]) => [key, list[index] ?? null])));
}

function traceJsonSpan(span) {
  const out = {};
  for (const key of TRACE_JSON_SPAN_KEYS) if (key in span) out[key] = span[key];
  const exactStart = "start_ns" in span ? traceJsonExactStartNs(span) : null;
  if (exactStart) out.start_ns = TRACE_JSON_EXACT_NS + exactStart;
  for (const key of ["span_attributes", "resource_attributes"]) {
    if (!(key in span)) continue;
    const value = parseStructuredValue(span[key]);
    out[key] = value == null ? span[key] : value;
  }
  if ("events_name" in span) {
    out.events = traceJsonColumns({ timestamp: span.events_timestamp, name: span.events_name, attributes: span.events_attributes });
  }
  if ("links_trace_id" in span) {
    out.links = traceJsonColumns({ trace_id: span.links_trace_id, span_id: span.links_span_id, attributes: span.links_attributes });
  }
  return out;
}

function traceJsonText(trace) {
  const text = (value) => String(value == null ? "" : value);
  const spans = (trace?.spans || []).slice().sort((a, b) => (Number(a.start_ns || 0) - Number(b.start_ns || 0))
    || text(a.timestamp).localeCompare(text(b.timestamp)) || text(a.span_id).localeCompare(text(b.span_id)));
  return JSON.stringify({
    trace_id: trace?.trace_id || "",
    truncated: trace?.truncated === true,
    span_count: spans.length,
    spans: spans.map(traceJsonSpan),
  }, null, 2).replace(/"start_ns": "\\u0000exact-ns:(\d+)"/g, '"start_ns": $1');
}

function attributeEntries(raw) {
  const value = raw && typeof raw === "object" ? raw : parseStructuredValue(raw);
  if (!value || Array.isArray(value) || typeof value !== "object") return [];
  return Object.entries(value).sort(([a], [b]) => String(a).localeCompare(String(b)));
}

function jsonList(raw) {
  const value = parseStructuredValue(raw);
  return Array.isArray(value) ? value : [];
}

// The events of a span are ordered by time. Then their position in the span decides.
function spanEventList(span) {
  const times = jsonList(span.events_timestamp);
  const names = jsonList(span.events_name);
  const attrs = jsonList(span.events_attributes);
  const count = Math.max(times.length, names.length, attrs.length);
  const events = Array.from({ length: count }, (_, index) => ({
    index,
    name: names[index] == null ? `Event ${index + 1}` : String(names[index]),
    time: times[index] == null ? "" : String(times[index]),
    ns: timestampToNs(times[index]),
    attributes: attrs[index] == null ? null : attrs[index],
  }));
  const key = (event) => (Number.isFinite(event.ns) ? event.ns : Infinity);
  return events.sort((a, b) => key(a) - key(b) || a.index - b.index);
}

function spanLinkList(span) {
  const traceIds = jsonList(span.links_trace_id);
  const spanIds = jsonList(span.links_span_id);
  const attrs = jsonList(span.links_attributes);
  const count = Math.max(traceIds.length, spanIds.length, attrs.length);
  return Array.from({ length: count }, (_, index) => ({
    traceId: String(traceIds[index] || ""),
    spanId: String(spanIds[index] || ""),
    attributes: attrs[index] == null ? null : attrs[index],
  }));
}

// The spans of the loaded trace that link to a span are shown as "linked from".
// This code uses only what the trace already holds. It computes the list once per trace.
function linkedFromList(cache, span) {
  if (!cache.linkedFrom) {
    cache.linkedFrom = new Map();
    const traceId = String(cache.trace?.trace_id || "");
    for (const other of cache.spans) {
      if (!other.links_span_id || other.links_span_id === "[]") continue;
      for (const link of spanLinkList(other)) {
        if (link.traceId && link.traceId !== traceId) continue;
        if (!cache.linkedFrom.has(link.spanId)) cache.linkedFrom.set(link.spanId, []);
        cache.linkedFrom.get(link.spanId).push({ traceId, spanId: String(other.span_id || ""), attributes: link.attributes });
      }
    }
  }
  return cache.linkedFrom.get(String(span.span_id || "")) || [];
}

function spanKindLabel(kind) {
  const text = String(kind || "").replace(/^SPAN_KIND_/i, "").trim();
  if (!text) return fmt.EMPTY;
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

export { LIST_SORTS, TABLE_COLUMNS, attributeEntries, bucketGrid, buildTree, createTraceCache, criticalSectionsFor, durationAxis, durationTicks, isErrorSpan, linkedFromList, orderByFirstSpan, parentSpanId, parseStartMs, parseStructuredValue, sortTraces, spanEventList, spanExtent, spanKey, spanKindLabel, spanLinkList, timestampToNs, traceBounds, traceJsonExactStartNs, traceJsonText, traceName, unpackAnalytics, wallClockLabel };
