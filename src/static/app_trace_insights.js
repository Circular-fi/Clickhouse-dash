(() => {
  "use strict";
  // Span insights on the trace page: exceptions with parsed stack traces,
  // highlighted attributes in the trace header, spans of other traces that
  // link to a span ("linked from", /api/traces/linked_from) and the
  // surrounding context of a span (/api/traces/context, a side panel).
  // app_traces.js calls install(ctx) with its model and helpers at init.
  const ns = window.ChDash;
  if (!ns) return;
  const { byId, $, $$ } = ns.dom;

  let ctx = null;
  const esc = (value) => ctx.esc(value);
  const fmt = ns.format;
  const palette = ns.palette;

  // ------------------------------------------------------------ exceptions
  // OTel semantic conventions: an event named "exception" with
  // exception.type / exception.message / exception.stacktrace /
  // exception.escaped, or the same keys as span attributes.

  const EXCEPTION_FRAMES_SHOWN = 5;
  const EXCEPTION_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.2 1.5 3.5 9h4l-1 5.5L12.5 7h-4z"/></svg>';
  const exceptionsBySpan = new WeakMap();

  function attrObject(raw) {
    const value = raw && typeof raw === "object" ? raw : ctx.parseStructuredValue(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  const text = (value) => (value == null ? "" : typeof value === "string" ? value : JSON.stringify(value));
  const truthy = (value) => value === true || /^(true|1)$/i.test(String(value == null ? "" : value).trim());

  function exceptionFrom(attrs, source, event = null) {
    const type = text(attrs["exception.type"]).trim();
    const message = text(attrs["exception.message"]).trim();
    const stacktrace = text(attrs["exception.stacktrace"]).replace(/\s+$/, "");
    if (!type && !message && !stacktrace) return null;
    return {
      type, message, stacktrace, source,
      escaped: attrs["exception.escaped"] == null ? null : truthy(attrs["exception.escaped"]),
      ns: event ? event.ns : NaN,
      time: event ? event.time : "",
      stack: stacktrace ? parseStackTrace(stacktrace) : null,
    };
  }

  // Cheap pre-check before any JSON is parsed (waterfall rows, trace header).
  function mayHaveException(span) {
    return String(span?.events_name || "").includes('"exception"') || String(span?.span_attributes || "").includes('"exception.');
  }

  function spanExceptions(span) {
    if (!span) return [];
    let list = exceptionsBySpan.get(span);
    if (list) return list;
    list = [];
    if (mayHaveException(span)) {
      for (const event of ctx.spanEventList(span)) {
        if (event.name !== "exception") continue;
        const found = exceptionFrom(attrObject(event.attributes), "event", event);
        list.push(found || { type: "", message: "", stacktrace: "", source: "event", escaped: null, ns: event.ns, time: event.time, stack: null });
      }
      const attrs = attrObject(span.span_attributes);
      const fromAttrs = exceptionFrom(attrs, "attributes");
      // Some SDKs copy the recorded exception onto the span as well.
      if (fromAttrs && !list.some((item) => item.type === fromAttrs.type && item.message === fromAttrs.message)) list.push(fromAttrs);
    }
    exceptionsBySpan.set(span, list);
    return list;
  }

  function exceptionTitle(item) {
    return [item.type, item.message].filter(Boolean).join(": ") || "Exception";
  }

  // --- Stack trace parsing: Java/Kotlin, Python, Go, JavaScript (V8 and
  // Firefox/Safari), .NET and Ruby. Unparsed lines stay as text rows; a stack
  // without any recognised frame is shown as preformatted text.
  const FRAME_PATTERNS = [
    // .NET: "at Ns.Type.Method(String arg) in /src/File.cs:line 42"
    { format: "dotnet", re: /^\s*at\s+(.+?\(.*?\))\s+in\s+(.+?):line\s+(\d+)\s*$/, map: (m) => ({ fn: m[1], file: m[2], line: m[3] }) },
    // V8: "at fn (file:1:2)", "at file:1:2", "at async fn (file:1:2)"
    { format: "javascript", re: /^\s*at\s+(?:(.+?)\s+\()?((?:[^()\s]|\s(?!\())+?):(\d+):(\d+)\)?\s*$/, map: (m) => ({ fn: m[1] || "<anonymous>", file: m[2], line: m[3], col: m[4] }) },
    // Java: "at com.acme.Type.method(Type.java:42)", "(Native Method)", "(Unknown Source)"
    {
      format: "java",
      re: /^\s*at\s+([\w$.<>\/-]+)\(((?:[^():\s]+(?::\d+)?)|Native Method|Unknown Source)\)\s*(?:~?\[.*\])?\s*$/,
      map: (m) => {
        const loc = /^(.*?):(\d+)$/.exec(m[2]);
        return { fn: m[1], file: loc ? loc[1] : m[2], line: loc ? loc[2] : "" };
      },
    },
    // .NET without a location: "at Ns.Type.Method(String arg)"
    { format: "dotnet", re: /^\s*at\s+([\w$.`<>\[\],]+\(.*\))\s*$/, map: (m) => ({ fn: m[1], file: "", line: "" }) },
    // Firefox / Safari: "fn@file:1:2"
    { format: "javascript", re: /^\s*([^@\s]*)@(.+?):(\d+):(\d+)\s*$/, map: (m) => ({ fn: m[1] || "<anonymous>", file: m[2], line: m[3], col: m[4] }) },
    // Python: 'File "/app/x.py", line 10, in handler'
    { format: "python", re: /^\s*File "([^"]+)", line (\d+)(?:, in (.+?))?\s*$/, map: (m) => ({ fn: m[3] || "", file: m[1], line: m[2] }) },
    // Ruby: "app/x.rb:10:in `method'" (also "from ...")
    { format: "ruby", re: /^\s*(?:from\s+)?(.+?):(\d+):in\s+[`'](.+)'\s*$/, map: (m) => ({ fn: m[3], file: m[1], line: m[2] }) },
  ];
  // Go: a function line, then "\t/path/file.go:12 +0x1d".
  const GO_LOCATION = /^\s+(\S+\.go):(\d+)(?:\s+\+0x[0-9a-fA-F]+)?\s*$/;
  const GO_FUNCTION = /^(?:created by\s+)?([\w./*()\[\]{}-]+?)(?:\(.*\))?(?:\s+in goroutine \d+)?\s*$/;
  const CAUSE_LINE = /^\s*(?:Caused by:|Suppressed:|--->|During handling of the above exception|The above exception was the direct cause)/;
  const OMITTED_LINE = /^\s*\.\.\.\s*\d+\s+(?:more|common frames omitted)\s*$/;
  const LIBRARY_FRAME = /node_modules|site-packages|dist-packages|\/usr\/lib\/|\/lib\/python\d|<frozen |^node:|^internal\/|\/go\/pkg\/mod\/|\/usr\/local\/go\/|^(?:java|javax|jdk|sun|kotlin|kotlinx|scala|org\.springframework|org\.apache)\.|^(?:System|Microsoft)\.|^runtime\.|\/gems\//;

  const FORMAT_LABELS = { java: "Java", python: "Python", go: "Go", javascript: "JavaScript", dotnet: ".NET", ruby: "Ruby" };

  function parseStackTrace(raw) {
    const lines = String(raw || "").replace(/\r\n?/g, "\n").split("\n");
    const rows = [];
    const counts = {};
    let frames = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line.trim()) continue;
      // Go pairs a function line with the location line after it.
      const goLoc = i + 1 < lines.length ? GO_LOCATION.exec(lines[i + 1]) : null;
      const goFn = goLoc && !/^\s/.test(line) ? GO_FUNCTION.exec(line.trim()) : null;
      if (goFn) {
        // The argument words go; a method receiver "(*T)" stays.
        const fn = line.trim().replace(/\s+in goroutine \d+$/, "").replace(/\([^()]*\)$/, "");
        rows.push(frameRow("go", { fn, file: goLoc[1], line: goLoc[2] }, `${line}\n${lines[i + 1]}`));
        counts.go = (counts.go || 0) + 1;
        frames += 1;
        i += 1;
        continue;
      }
      let matched = null;
      for (const pattern of FRAME_PATTERNS) {
        const m = pattern.re.exec(line);
        if (m) { matched = frameRow(pattern.format, pattern.map(m), line); break; }
      }
      if (matched) {
        // Python: the source line printed under a frame belongs to it.
        if (matched.format === "python" && i + 1 < lines.length && /^\s{4,}\S/.test(lines[i + 1]) && !FRAME_PATTERNS[5].re.test(lines[i + 1])) {
          matched.code = lines[i + 1].trim();
          matched.raw += `\n${lines[i + 1]}`;
          i += 1;
        }
        counts[matched.format] = (counts[matched.format] || 0) + 1;
        frames += 1;
        rows.push(matched);
        continue;
      }
      if (CAUSE_LINE.test(line)) rows.push({ kind: "cause", text: line.trim() });
      else if (OMITTED_LINE.test(line)) rows.push({ kind: "omitted", text: line.trim() });
      else rows.push({ kind: "text", text: line.trim() });
    }
    const format = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
    // Python prints the most recent call last; the others first.
    return { format, frames, rows, innermostLast: format === "python" };
  }

  function frameRow(format, { fn = "", file = "", line = "", col = "" }, raw) {
    const fnText = String(fn || "").trim();
    const fileText = String(file || "").trim();
    return { kind: "frame", format, fn: fnText, file: fileText, line: String(line || ""), col: String(col || ""), raw, library: LIBRARY_FRAME.test(fileText) || LIBRARY_FRAME.test(fnText) };
  }

  function frameHtml(row, hidden) {
    const hide = hidden ? " hidden" : "";
    if (row.kind !== "frame") return `<li class="traceStack__row traceStack__row--${row.kind}"${hide}>${esc(row.text)}</li>`;
    const loc = [row.file, row.line, row.col].filter(Boolean).join(":");
    return `<li class="traceStack__row traceStack__frame${row.library ? " is-library" : ""}"${hide} data-stack-frame${row.library ? ' title="Library or runtime frame"' : ""}><code class="traceStack__fn">${esc(row.fn || "<anonymous>")}</code>${loc ? `<span class="traceStack__loc">${esc(loc)}</span>` : ""}${row.code ? `<code class="traceStack__code">${esc(row.code)}</code>` : ""}</li>`;
  }

  // The frames nearest the throw stay visible: the first N (or the last N
  // for Python). Text rows (the exception line, "Caused by:", "... N more")
  // always show.
  function stackHtml(item, spanId, index) {
    const stack = item.stack;
    if (!stack) return "";
    const showAll = ctx.sectionOpen(spanId, `exception-all:${index}`);
    const raw = ctx.sectionOpen(spanId, `exception-raw:${index}`) || !stack.frames;
    const frameIndexes = stack.rows.map((row, i) => (row.kind === "frame" ? i : -1)).filter((i) => i >= 0);
    const keep = new Set(stack.innermostLast ? frameIndexes.slice(-EXCEPTION_FRAMES_SHOWN) : frameIndexes.slice(0, EXCEPTION_FRAMES_SHOWN));
    const hiddenCount = frameIndexes.length - keep.size;
    const rowsHtml = stack.rows.map((row, i) => frameHtml(row, !showAll && row.kind === "frame" && !keep.has(i))).join("");
    const format = FORMAT_LABELS[stack.format] || "";
    const order = stack.frames ? (stack.innermostLast ? "most recent call last" : "most recent call first") : "";
    const meta = stack.frames
      ? `${stack.frames} frame${stack.frames === 1 ? "" : "s"}${format ? ` · ${format}` : ""} · ${order}`
      : "Stack trace";
    const toggle = hiddenCount > 0 && !raw
      ? `<button type="button" class="traceStack__button" data-stack-toggle="${index}" aria-expanded="${showAll ? "true" : "false"}">${showAll ? "Show fewer frames" : `Show all ${stack.frames} frames`}</button>`
      : "";
    const rawButton = stack.frames ? `<button type="button" class="traceStack__button" data-stack-raw="${index}" aria-pressed="${raw ? "true" : "false"}">${raw ? "Frames" : "Raw"}</button>` : "";
    return `<div class="traceStack" data-stack-format="${esc(stack.format || "text")}">
      <div class="traceStack__bar"><span class="traceStack__meta">${esc(meta)}</span>${toggle}${rawButton}<button type="button" class="traceStack__button" data-stack-copy="${index}">Copy stack</button></div>
      ${raw ? `<pre class="traceStack__raw">${esc(item.stacktrace)}</pre>` : `<ol class="traceStack__rows">${rowsHtml}</ol>${hiddenCount > 0 && !showAll ? `<small class="traceStack__hidden">${hiddenCount} more frame${hiddenCount === 1 ? "" : "s"} hidden</small>` : ""}`}
    </div>`;
  }

  function exceptionSectionHtml(span, bounds) {
    const list = spanExceptions(span);
    if (!list.length) return "";
    const id = String(span.span_id || "");
    const items = list.map((item, index) => {
      const offset = Number.isFinite(item.ns) && bounds ? fmt.duration(Math.max(0, item.ns - bounds.start)) : "";
      const badges = [
        item.escaped === true ? ns.badge.html("escaped", { tone: "error", shape: "pill", className: "traceException__badge", title: "exception.escaped: the exception left the span" }) : "",
        item.source === "attributes" ? ns.badge.html("span attributes", { shape: "pill", className: "traceException__badge is-muted", title: "Read from the span attributes (exception.*)" }) : "",
        offset ? `<span class="traceException__time" title="${esc(item.time || "")}">at ${esc(offset)}</span>` : "",
      ].join("");
      return `<article class="traceException__item" data-exception-index="${index}">
        <div class="traceException__title">${EXCEPTION_ICON}<strong class="traceException__type">${esc(item.type || "Exception")}</strong>${badges}</div>
        ${item.message ? `<p class="traceException__message">${esc(item.message)}</p>` : ""}
        ${stackHtml(item, id, index)}
      </article>`;
    }).join("");
    return `<section class="traceException" data-span-section="exception" aria-label="Exceptions"><header class="traceException__head"><b>${list.length === 1 ? "Exception" : "Exceptions"}</b>${list.length > 1 ? `<span class="traceJaegerGroup__count">(${list.length})</span>` : ""}</header>${items}</section>`;
  }

  function exceptionBadgeHtml(span) {
    if (!mayHaveException(span)) return "";
    const list = spanExceptions(span);
    if (!list.length) return "";
    const label = list.length === 1 ? `Exception: ${exceptionTitle(list[0])}` : `${list.length} exceptions: ${list.map(exceptionTitle).join("; ")}`;
    return `<span class="traceSpanRow__exception" data-span-exception title="${esc(label)}" aria-label="${esc(label)}">${EXCEPTION_ICON}</span>`;
  }

  // Trace header: the spans with exceptions (count and the first one's
  // type), a button that focuses the first of them.
  const traceExceptionCache = new WeakMap();
  function traceExceptionSummary(cache) {
    let summary = traceExceptionCache.get(cache);
    if (summary) return summary;
    const spans = [];
    let count = 0;
    for (const node of cache.order) {
      if (!mayHaveException(node.span)) continue;
      const list = spanExceptions(node.span);
      if (!list.length) continue;
      spans.push({ span: node.span, list });
      count += list.length;
    }
    summary = { spans, count };
    traceExceptionCache.set(cache, summary);
    return summary;
  }

  function traceExceptionTagHtml(cache) {
    const { spans, count } = traceExceptionSummary(cache);
    if (!count) return "";
    const first = spans[0];
    const types = [...new Set(spans.flatMap((entry) => entry.list.map((item) => item.type || "Exception")))];
    const title = `${count} exception${count === 1 ? "" : "s"} in ${spans.length} span${spans.length === 1 ? "" : "s"}: ${types.join(", ")}. Click to open the first one.`;
    return ns.badge.html("", { tag: "button", tone: "error", size: "md", className: "tracePageHeader__exceptions", title, attrs: { "data-trace-exceptions": first.span.span_id }, html: `${EXCEPTION_ICON}<span>${count} exception${count === 1 ? "" : "s"}</span><small>${esc(types[0])}${types.length > 1 ? ` +${types.length - 1}` : ""}</small>` });
  }

  // ------------------------------------------------ highlighted attributes
  // traces.highlighted_attributes: each key from the root span (span
  // attributes, then resource attributes), else from the first span in tree
  // order that carries it.

  const highlightCache = new WeakMap();

  function lookupAttribute(span, key) {
    const needle = JSON.stringify(key);
    for (const column of ["span_attributes", "resource_attributes"]) {
      const raw = span?.[column];
      if (!raw || (typeof raw === "string" && !raw.includes(needle))) continue;
      const attrs = attrObject(raw);
      if (Object.prototype.hasOwnProperty.call(attrs, key)) {
        const value = text(attrs[key]);
        if (value !== "") return value;
      }
    }
    return null;
  }

  function traceHighlights(cache) {
    const keys = Array.isArray(ctx.model.meta?.highlighted_attributes) ? ctx.model.meta.highlighted_attributes : [];
    const cached = highlightCache.get(cache);
    if (cached && cached.keys === keys) return cached.list;
    const root = cache.tree.roots[0]?.span || null;
    const list = [];
    for (const key of keys) {
      let value = root ? lookupAttribute(root, key) : null;
      let from = value != null ? root : null;
      if (value == null) {
        for (const node of cache.order) {
          value = lookupAttribute(node.span, key);
          if (value != null) { from = node.span; break; }
        }
      }
      if (value != null) list.push({ key, value, span: from, root: from === root });
    }
    highlightCache.set(cache, { keys, list });
    return list;
  }

  function renderHighlights(cache) {
    const host = byId("traceHighlights");
    if (!host) return;
    const list = cache ? traceHighlights(cache) : [];
    host.hidden = !list.length;
    host.innerHTML = list.map((item) => {
      const origin = item.root ? "root span" : `${item.span?.service_name || "unknown"}::${item.span?.span_name || "span"}`;
      const title = `${item.key}: ${item.value} (from the ${item.root ? "" : "span "}${origin}). Click to copy the value.`;
      return `<button type="button" class="traceHighlight" data-trace-highlight="${esc(item.key)}" data-highlight-value="${esc(item.value)}" title="${esc(title)}"><span class="traceHighlight__key">${esc(item.key)}</span><span class="traceHighlight__value">${esc(item.value)}</span></button>`;
    }).join("");
  }

  // ----------------------------------------------------------- linked from

  const linkedFromState = new Map();
  const linkKey = (traceId, spanId) => `${traceId}\u001f${spanId}`;

  function linksEnabled() {
    return ctx.model.meta?.features?.links !== false;
  }

  function linkedFromRemoteHtml(span, cache) {
    if (!linksEnabled()) return "";
    const traceId = String(cache.trace?.trace_id || "");
    const spanId = String(span.span_id || "");
    const state = linkedFromState.get(linkKey(traceId, spanId));
    if ((!state || state.status === "idle") && ctx.sectionOpen(spanId, "references")) queueMicrotask(() => { void loadLinkedFrom(spanId); });
    return `<div class="traceLinkedFrom" data-linked-from-span="${esc(spanId)}">${linkedFromBodyHtml(state, cache)}</div>`;
  }

  function windowText(range) {
    if (!Array.isArray(range) || range.length !== 2) return "";
    return fmt.range(Number(range[0]), Number(range[1]));
  }

  function linkedFromBodyHtml(state, cache) {
    const margin = Number(ctx.model.meta?.linked_from_margin_minutes || 60);
    const head = (extra = "") => `<div class="traceLinkedFrom__head"><b>Linked from (other traces)</b>${extra}</div>`;
    if (!state || state.status === "idle") {
      return `${head()}<p class="traceLinkedFrom__note">Spans of other traces whose links point to this span, searched within ±${fmt.duration.fromSeconds(margin * 60)} of this trace. <button type="button" class="traceLinkedFrom__load" data-linked-from-load>Search</button></p>`;
    }
    if (state.status === "loading") return `${head('<span class="traceLinkedFrom__status" role="status">Searching\u2026</span>')}`;
    if (state.status === "error") {
      return `${head()}<p class="traceLinkedFrom__note is-error">${esc(state.error)} <button type="button" class="traceLinkedFrom__load" data-linked-from-load>Retry</button></p>`;
    }
    const rows = state.rows || [];
    const scope = `between ${windowText(state.range)} (±${fmt.duration.fromSeconds(Number(state.margin || margin) * 60)} around this trace)`;
    if (!rows.length) return `${head('<span class="traceJaegerGroup__count">(0)</span>')}<p class="traceLinkedFrom__note" data-linked-from-empty>No span of another trace links here ${esc(scope)}.</p>`;
    const items = rows.map((row) => {
      const attrs = ctx.parseStructuredValue(row.link_attributes);
      const attrTable = Array.isArray(attrs) && attrs.some((a) => ctx.attributeEntries(a).length)
        ? `<div class="traceSpanRefs__attrs">${attrs.map((a) => ctx.renderAttributeTable(a, "")).join("")}</div>` : "";
      const whenMs = Math.floor(Number(row.start_ns) / 1e6);
      const error = String(row.status_code || "").toLowerCase() === "error";
      return `<li class="traceLinkedFrom__item" data-linked-from-trace="${esc(row.trace_id)}">${ns.badge.html("linked from", { tone: "accent", shape: "pill", className: "traceSpanRefs__kind traceSpanRefs__kind--linked-from" })}<span class="traceSpanRefs__main"><span class="traceSpanRefs__svc" style="--trace-service-color:${palette.service(row.service_name)}">${esc(row.service_name || "unknown")}</span><small class="traceSpanRefs__op">${esc(row.span_name || "span")}</small>${error ? ns.badge.statusHtml("Error") : ""}<small class="traceSpanRefs__ids"><span>TraceID: <code>${esc(row.trace_id)}</code></span><span>SpanID: <code>${esc(row.span_id)}</code></span><span><time title="${esc(fmt.timeTitle(whenMs))}">${esc(fmt.time(whenMs))}</time> · ${esc(fmt.duration(row.duration_ns))}</span></small></span><a class="traceSpanRefs__open traceJaegerLink__trace" href="${esc(ctx.spanTraceUrl(row.trace_id, row.span_id))}" data-linked-trace="${esc(row.trace_id)}" data-linked-span="${esc(row.span_id)}" title="Open the linking span in its trace">Open linked trace</a>${attrTable}</li>`;
    }).join("");
    const more = state.truncated ? `<p class="traceLinkedFrom__note">Showing the newest ${fmt.count(rows.length)} linking spans.</p>` : "";
    return `${head(`<span class="traceJaegerGroup__count">(${rows.length}${state.truncated ? "+" : ""})</span>`)}<ul class="traceSpanRefs__list traceLinkedFrom__list">${items}</ul>${more}`;
  }

  function patchLinkedFrom(spanId) {
    const cache = ctx.activeTraceCache();
    const traceId = String(cache.trace?.trace_id || "");
    const state = linkedFromState.get(linkKey(traceId, spanId));
    $$(".traceLinkedFrom[data-linked-from-span]").forEach((el) => {
      if (el.getAttribute("data-linked-from-span") === spanId) el.innerHTML = linkedFromBodyHtml(state, cache);
    });
  }

  async function loadLinkedFrom(spanId, { force = false } = {}) {
    if (!linksEnabled()) return;
    const cache = ctx.activeTraceCache();
    const traceId = String(cache.trace?.trace_id || "");
    if (!traceId || !spanId) return;
    const key = linkKey(traceId, spanId);
    const current = linkedFromState.get(key);
    if (current && !force && (current.status === "loading" || current.status === "done")) return;
    linkedFromState.set(key, { status: "loading" });
    patchLinkedFrom(spanId);
    const { start, end } = cache.extent;
    const params = { trace_id: traceId, span_id: spanId };
    if (Number.isFinite(start) && Number.isFinite(end)) {
      params.start_ms = Math.floor(start / 1e6);
      params.end_ms = Math.ceil(end / 1e6);
    }
    try {
      const payload = await ns.api.getTraceLinkedFrom(ctx.currentHost(), params);
      linkedFromState.set(key, { status: "done", rows: payload?.rows || [], truncated: !!payload?.truncated, range: payload?.range, margin: payload?.margin_minutes });
    } catch (error) {
      linkedFromState.set(key, { status: "error", error: ns.util.errorText(error) });
    }
    if (String(ctx.activeTraceCache().trace?.trace_id || "") === traceId) patchLinkedFrom(spanId);
  }

  // Loads when the References section opens (a section rendered open loads
  // from linkedFromRemoteHtml).
  function onSectionToggle(spanId, key, open) {
    if (key === "references" && open) void loadLinkedFrom(String(spanId || ""));
  }

  // -------------------------------------------------- surrounding context

  const CONTEXT_WINDOWS = [[1000, "±1 s"], [10000, "±10 s"], [60000, "±1 min"], [300000, "±5 min"]];
  const CONTEXT_FILTERS = [
    ["any", "Anything"],
    ["service", "Same service"],
    ["host", "Same host"],
    ["pod", "Same pod"],
    ["attribute", "Custom attribute"],
  ];
  const CONTEXT_PAGE = 50;
  const context = {
    open: false,
    anchor: null,
    windowMs: 60000,
    filter: "service",
    attribute: "",
    rows: [],
    hasNewer: false,
    hasOlder: false,
    loading: "",
    error: "",
    elapsedMs: NaN,
    returnFocus: null,
  };

  function panel() {
    let el = byId("traceContextPanel");
    if (el) return el;
    el = document.createElement("aside");
    el.id = "traceContextPanel";
    // The detail panel shell's head and close button (ns.detailPanel), in a
    // drawer over the trace under the page chrome.
    el.className = "uiDetail traceContextPanel";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "false");
    el.setAttribute("aria-labelledby", "traceContextTitle");
    el.tabIndex = -1;
    el.hidden = true;
    document.body.appendChild(el);
    el.addEventListener("click", onPanelClick);
    el.addEventListener("change", onPanelChange);
    el.addEventListener("keydown", (event) => {
      // Escape goes on to ns.layers (the panel is a layer).
      if (event.key === "Escape") return;
      // The trace page's shortcuts (a/d, arrows, [ ]) are not for the panel.
      event.stopPropagation();
    });
    // Up / Down between spans, Enter / Space open one (ns.rovingRows).
    ns.table.rovingRows(el, { rows: "tr[data-context-span]", onOpen: (row) => openContextRow(row) });
    return el;
  }

  function anchorAttributes(span) {
    const out = [];
    for (const [scope, column] of [["span", "span_attributes"], ["resource", "resource_attributes"]]) {
      for (const [key, value] of ctx.attributeEntries(span[column])) {
        const valueText = text(value);
        if (valueText.length > 4096) continue;
        out.push({ scope, key, value: valueText });
      }
    }
    return out;
  }

  function openContext(spanId, trigger = null) {
    const cache = ctx.activeTraceCache();
    const span = cache.nodeById.get(String(spanId || ""))?.span;
    if (!span) return;
    const resource = attrObject(span.resource_attributes);
    context.anchor = {
      traceId: String(cache.trace?.trace_id || ""),
      spanId: String(span.span_id || ""),
      service: String(span.service_name || ""),
      name: String(span.span_name || ""),
      timestamp: String(span.timestamp || ""),
      ns: ctx.exactStartNs(span),
      host: text(resource["host.name"]),
      pod: text(resource["k8s.pod.name"]),
      attributes: anchorAttributes(span),
    };
    if (context.filter === "host" && !context.anchor.host) context.filter = "service";
    if (context.filter === "pod" && !context.anchor.pod) context.filter = "service";
    if (context.filter === "service" && !context.anchor.service) context.filter = "any";
    context.attribute = context.anchor.attributes[0] ? `${context.anchor.attributes[0].scope}\u001f${context.anchor.attributes[0].key}` : "";
    if (context.filter === "attribute" && !context.attribute) context.filter = "service";
    context.open = true;
    context.returnFocus = trigger;
    const el = panel();
    el.hidden = false;
    // An ns.layers layer: Escape closes it, the focus goes back to its trigger.
    contextLayer = ns.layers.push({ el, name: "traceContext", docked: true, opener: trigger, onDismiss: () => closeContext() });
    document.body.classList.add("has-trace-context");
    void loadContext("around");
    el.focus({ preventScroll: true });
  }

  let contextLayer = null;
  function closeContext() {
    context.open = false;
    ns.util.latest.cancel("traces.context");
    // The layer gives the focus back to the trigger (when it was in the panel).
    const layer = contextLayer;
    contextLayer = null;
    layer?.close();
    const el = byId("traceContextPanel");
    if (el) { el.hidden = true; el.replaceChildren(); }
    document.body.classList.remove("has-trace-context");
    context.returnFocus = null;
  }

  function contextParams() {
    const a = context.anchor;
    const params = { timestamp_ns: a.ns, window_ms: context.windowMs, filter: context.filter };
    if (context.filter === "service") params.service = a.service;
    else if (context.filter === "host") params.value = a.host;
    else if (context.filter === "pod") params.value = a.pod;
    else if (context.filter === "attribute") {
      const [scope, key] = context.attribute.split("\u001f");
      const found = a.attributes.find((item) => item.scope === scope && item.key === key);
      params.attr_scope = scope;
      params.attr_key = key;
      params.attr_value = found ? found.value : "";
    }
    return params;
  }

  async function loadContext(direction) {
    if (!context.anchor) return;
    const req = ns.util.latest("traces.context");
    const params = { ...contextParams(), direction, limit: CONTEXT_PAGE };
    if (direction === "older" || direction === "newer") {
      const edge = direction === "older" ? context.rows[context.rows.length - 1] : context.rows[0];
      if (!edge) return;
      params.cursor_ns = edge.start_ns_text;
      params.cursor_span_id = edge.span_id;
    } else {
      context.rows = [];
      context.hasNewer = false;
      context.hasOlder = false;
    }
    context.loading = direction;
    context.error = "";
    renderContext();
    try {
      const payload = await ns.api.getTraceContext(ctx.currentHost(), params, { signal: req.signal });
      if (!req.isCurrent()) return;
      const rows = payload?.rows || [];
      if (direction === "older") context.rows = context.rows.concat(rows);
      else if (direction === "newer") context.rows = rows.concat(context.rows);
      else context.rows = rows;
      if ("has_newer" in payload) context.hasNewer = !!payload.has_newer;
      if ("has_older" in payload) context.hasOlder = !!payload.has_older;
      context.elapsedMs = Number(payload?.elapsed_ms);
    } catch (error) {
      if (!req.isCurrent()) return;
      context.error = ns.util.errorText(error);
    }
    context.loading = "";
    renderContext();
    if (direction === "around") $("#traceContextPanel tr.is-anchor")?.scrollIntoView?.({ block: "center" });
  }

  function signedOffset(row) {
    try {
      const delta = BigInt(row.start_ns_text) - BigInt(context.anchor.ns);
      const n = Number(delta);
      if (n === 0) return "0";
      return `${n > 0 ? "+" : "\u2212"}${fmt.duration(Math.abs(n))}`;
    } catch (_) {
      return "";
    }
  }

  // The local time of day of a span start, to the millisecond.
  function clockText(row) {
    const ms = Math.floor(Number(row.start_ns) / 1e6);
    return Number.isFinite(ms) ? fmt.time(ms, { precision: "ms", date: "never" }) : String(row.timestamp || "");
  }

  function renderContext() {
    const el = byId("traceContextPanel");
    if (!el || !context.open || !context.anchor) return;
    const a = context.anchor;
    // The window and filter rows: shared segmented controls (app_ui_segmented.js).
    const windowsHtml = ns.segmented.html(CONTEXT_WINDOWS.map(([ms, label]) => ({ value: ms, label })), { attr: "contextWindow", value: context.windowMs, size: "compact", label: "Time window", className: "traceContextSeg" });
    const unavailable = {
      service: a.service ? "" : "This span has no service name",
      host: a.host ? "" : "This span has no host.name resource attribute",
      pod: a.pod ? "" : "This span has no k8s.pod.name resource attribute",
      attribute: a.attributes.length ? "" : "This span has no attributes",
    };
    const describe = { any: "Every span in the window", service: `service = ${a.service}`, host: `host.name = ${a.host}`, pod: `k8s.pod.name = ${a.pod}`, attribute: "The attribute picked below" };
    const filtersHtml = ns.segmented.html(CONTEXT_FILTERS.map(([value, label]) => ({ value, label, disabled: !!unavailable[value], title: unavailable[value] || describe[value] })),
      { attr: "contextFilter", value: context.filter, size: "compact", label: "Filter", className: "traceContextSeg traceContextSeg--filters" });
    const attributePickerHtml = context.filter === "attribute"
      ? `<label class="traceContextPanel__attr"><span>Attribute</span><select data-context-attribute>${a.attributes.map((item) => {
          const value = `${item.scope}\u001f${item.key}`;
          return `<option value="${esc(value)}"${value === context.attribute ? " selected" : ""}>${esc(`${item.scope === "resource" ? "resource" : "span"} · ${item.key} = ${item.value.length > 60 ? `${item.value.slice(0, 60)}\u2026` : item.value}`)}</option>`;
        }).join("")}</select></label>`
      : "";
    const rowsHtml = context.rows.map((row) => {
      const anchor = row.span_id === a.spanId && row.trace_id === a.traceId;
      const sameTrace = row.trace_id === a.traceId;
      const status = String(row.status_code || "Unset");
      const error = status.toLowerCase() === "error";
      return `<tr class="traceContextRow${anchor ? " is-anchor is-selected" : ""}${error ? " is-error" : ""}" data-context-trace="${esc(row.trace_id)}" data-context-span="${esc(row.span_id)}" tabindex="-1" title="${esc(`Open ${row.service_name}::${row.span_name} in ${sameTrace ? "this trace" : `trace ${row.trace_id}`}`)}">
        <td class="num traceContextRow__offset">${esc(signedOffset(row))}</td>
        <td class="num traceContextRow__time">${esc(clockText(row))}</td>
        <td class="traceContextRow__service" style="--trace-service-color:${palette.service(row.service_name)}"><i class="serviceSwatch" aria-hidden="true"></i>${esc(row.service_name || "unknown")}</td>
        <td class="traceContextRow__op">${esc(row.span_name || "span")}${sameTrace && !anchor ? ns.badge.html("this trace", { shape: "pill", className: "traceContextRow__same", title: "Span of the open trace" }) : ""}</td>
        <td class="num traceContextRow__duration">${esc(fmt.duration(row.duration_ns))}</td>
        <td class="traceContextRow__status">${ns.badge.statusHtml(status)}</td>
      </tr>`;
    }).join("");
    const pageButtonHtml = (direction, label, shown) => (shown
      ? `<button type="button" class="button button--small traceContextPanel__more" data-context-more="${direction}"${context.loading ? " disabled" : ""}>${context.loading === direction ? "Loading\u2026" : label}</button>`
      : "");
    const filterLabel = CONTEXT_FILTERS.find(([value]) => value === context.filter)?.[1] || "";
    const windowLabel = CONTEXT_WINDOWS.find(([ms]) => ms === context.windowMs)?.[1] || "";
    const statusHtml = context.error
      ? `<p class="traceContextPanel__error" role="alert">${esc(context.error)} <button type="button" class="button button--small" data-context-retry>Retry</button></p>`
      : context.loading === "around"
        ? '<p class="traceContextPanel__status" role="status">Loading spans\u2026</p>'
        : context.rows.length
          ? `<p class="traceContextPanel__status" role="status" data-context-summary>${fmt.count(context.rows.length)} span${context.rows.length === 1 ? "" : "s"} · ${esc(windowLabel)} · ${esc(filterLabel)}${Number.isFinite(context.elapsedMs) ? ` · ${fmt.duration.fromMs(context.elapsedMs)}` : ""}</p>`
          : `<p class="traceContextPanel__status" role="status" data-context-summary>No spans ${esc(windowLabel)} around this span (${esc(filterLabel)}).</p>`;
    el.innerHTML = `<header class="uiDetail__head traceContextPanel__head">
        <div class="uiDetail__titles traceContextPanel__title"><h2 id="traceContextTitle" class="uiDetail__title">Surrounding context</h2><span class="uiDetail__subtitle" title="${esc(fmt.timeTitle(Math.floor(Number(a.ns) / 1e6)))}"><b style="--trace-service-color:${palette.service(a.service)}"><i class="serviceSwatch" aria-hidden="true"></i>${esc(a.service || "unknown")}</b> ${esc(a.name)} · ${esc(clockText({ timestamp: a.timestamp, start_ns: Number(a.ns) }))}</span></div>
        <button type="button" class="closeCross uiDetail__close" data-context-close aria-label="Close surrounding context" title="Close (Esc)">×</button>
      </header>
      <div class="traceContextPanel__controls">
        ${windowsHtml}
        ${filtersHtml}
        ${attributePickerHtml}
      </div>
      ${statusHtml}
      <div class="traceContextPanel__body">
        ${pageButtonHtml("newer", "Load newer", context.hasNewer)}
        ${context.rows.length ? `<table class="traceContextTable dataTable dataTable--compact"><thead><tr><th scope="col" class="num" title="Start time relative to this span">Offset</th><th scope="col" class="num">Time</th><th scope="col">Service</th><th scope="col">Operation</th><th scope="col" class="num">Duration</th><th scope="col">Status</th></tr></thead><tbody>${rowsHtml}</tbody></table>` : ""}
        ${pageButtonHtml("older", "Load older", context.hasOlder)}
      </div>`;
  }

  function openContextRow(row) {
    const traceId = String(row.getAttribute("data-context-trace") || "");
    const spanId = String(row.getAttribute("data-context-span") || "");
    if (!traceId || !spanId) return;
    if (traceId === String(ctx.model.activeTrace?.trace_id || "") && ctx.focusSpanInTimeline(spanId, { push: true })) return;
    ctx.model.pendingSpanId = spanId;
    void ctx.loadTrace(traceId, { push: true });
  }

  function onPanelClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest("[data-context-close]")) { closeContext(); return; }
    const win = target.closest("[data-context-window]");
    if (win) {
      context.windowMs = Number(win.getAttribute("data-context-window"));
      void loadContext("around");
      return;
    }
    const filter = target.closest("[data-context-filter]");
    if (filter && !filter.disabled) {
      context.filter = String(filter.getAttribute("data-context-filter"));
      void loadContext("around");
      return;
    }
    const more = target.closest("[data-context-more]");
    if (more) { void loadContext(String(more.getAttribute("data-context-more"))); return; }
    if (target.closest("[data-context-retry]")) { void loadContext("around"); return; }
    const row = target.closest("tr[data-context-span]");
    if (row) openContextRow(row);
  }

  function onPanelChange(event) {
    const select = event.target instanceof HTMLSelectElement ? event.target : null;
    if (!select?.matches("[data-context-attribute]")) return;
    context.attribute = select.value;
    void loadContext("around");
  }

  // --------------------------------------------------------- inspector events

  function copyStack(button) {
    const card = button.closest("[data-inspector-span]");
    const span = ctx.activeTraceCache().nodeById.get(String(card?.getAttribute("data-inspector-span") || ""))?.span;
    const item = spanExceptions(span)[Number(button.getAttribute("data-stack-copy"))];
    if (!item) return;
    const header = exceptionTitle(item);
    const body = item.stacktrace && !item.stacktrace.includes(item.type || "\u0000") ? `${header}\n${item.stacktrace}` : (item.stacktrace || header);
    ctx.copyText(body, button);
  }

  // Clicks inside the inline span inspector; true when handled.
  function handleInspectorClick(event, target) {
    const contextButton = target.closest("[data-span-context]");
    if (contextButton) {
      event.preventDefault();
      event.stopPropagation();
      openContext(contextButton.getAttribute("data-span-context"), contextButton);
      return true;
    }
    const load = target.closest("[data-linked-from-load]");
    if (load) {
      event.preventDefault();
      event.stopPropagation();
      const spanId = load.closest("[data-linked-from-span]")?.getAttribute("data-linked-from-span");
      if (spanId) void loadLinkedFrom(spanId, { force: true });
      return true;
    }
    const copy = target.closest("[data-stack-copy]");
    if (copy) { event.preventDefault(); event.stopPropagation(); copyStack(copy); return true; }
    const toggle = target.closest("[data-stack-toggle], [data-stack-raw]");
    if (toggle) {
      event.preventDefault();
      event.stopPropagation();
      const card = toggle.closest("[data-inspector-span]");
      const spanId = String(card?.getAttribute("data-inspector-span") || "");
      const span = ctx.activeTraceCache().nodeById.get(spanId)?.span;
      const raw = toggle.hasAttribute("data-stack-raw");
      const index = Number(toggle.getAttribute(raw ? "data-stack-raw" : "data-stack-toggle"));
      const key = `${raw ? "exception-raw" : "exception-all"}:${index}`;
      ctx.setSectionOpen(spanId, key, !ctx.sectionOpen(spanId, key));
      const item = spanExceptions(span)[index];
      const holder = toggle.closest(".traceStack");
      if (item && holder) {
        holder.outerHTML = stackHtml(item, spanId, index);
        $(`[data-exception-index="${index}"] [data-stack-${raw ? "raw" : "toggle"}]`, card)?.focus({ preventScroll: true });
      }
      return true;
    }
    return false;
  }

  function handleHeaderClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const exceptions = target.closest("[data-trace-exceptions]");
    if (exceptions) {
      event.preventDefault();
      ctx.focusSpanInTimeline(String(exceptions.getAttribute("data-trace-exceptions") || ""), { push: true });
      return;
    }
    const chip = target.closest("[data-trace-highlight]");
    if (chip) {
      event.preventDefault();
      ctx.copyText(chip.getAttribute("data-highlight-value") || "", chip);
    }
  }

  // A newly loaded trace keeps the context panel on its anchor; host changes
  // and "back to search" close it.
  function onTraceChanged(trace) {
    if (!trace && context.open) closeContext();
  }

  function install(appCtx) {
    ctx = appCtx;
    byId("traceDetailHeader")?.addEventListener("click", handleHeaderClick);
    window.addEventListener("chdash:host-changed", () => { linkedFromState.clear(); if (context.open) closeContext(); });
  }

  ns.traceInsights = {
    install,
    parseStackTrace,
    spanExceptions,
    exceptionSectionHtml,
    exceptionBadgeHtml,
    traceExceptionTagHtml,
    renderHighlights,
    linkedFromRemoteHtml,
    onSectionToggle,
    handleInspectorClick,
    openContext,
    closeContext,
    onTraceChanged,
  };
})();
