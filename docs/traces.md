# Trace Explorer

ChDash can read OpenTelemetry traces stored by the OpenTelemetry Collector contrib ClickHouse exporter. The viewer follows the ClickHouse host selected in the UI and uses that host's `system_uri`.

## The Observability pages

Traces, logs (`docs/logs.md`) and metrics (`docs/metrics.md`) are three pages of their own (`traces.html`, `logs.html`, `metrics.html`, one controller, `app_obs_page.js`), listed together as **Observability** in the page switcher of every page. Their header is the header of the other pages; the row under it links the enabled views (plain links: each is a page, the current one marked), and, on the Traces search, the Traces page's own *Search* / *Services* / *Service map* tabs after a separator on the same row. On a narrow window the row scrolls sideways.

| URL | View |
| --- | --- |
| `/observability` | the first enabled view (Traces, Logs, Metrics), its query parameters kept |
| `/observability/traces?…` | trace search; `tab=services` / `tab=map` for the other Traces tabs |
| `/observability/traces/<trace-id>?span=…&tab=…` | one trace, a page of its own (`trace.html`, below): `tab=` its view (the former `view=` is an alias), with the search context it was opened from (its filters, not the search page's tab) |
| `/observability/logs?…` | the Logs explorer |
| `/observability/metrics?…` | the metrics browser |

Under that row, each view has its **filter bar** (`.obsFilterBar`, the filter bar component of `docs/ui-foundations.md`, "Filter bar", shared with the System sections): the time range first on the left, the view's "Label · Value" pickers, its free-text fields and options, then at the right end its secondary actions (Metrics' *Add panel*) and the primary **Search** (the queries run on demand). At 600 px and below it folds into one summary line ("Sep 12 12:30 → 13:30 · 2 filters") that unfolds it; a search folds it again.

Each view keeps its own URL parameters (listed in its section; every route and parameter is in `docs/ui-foundations.md`, "Routes"); a deep link opens the view and sub-tab it names, and Back / Forward walk the browser's history, from page to page and, within a page, from one query string to the next. A view reached from another Observability page (the row, a link) opens on its last query string of this tab (its filters, as it left them) when its address has none.

The **time range** and the **selected service** follow the user from page to page: when a page is left, its range and service (the Traces service picker, the Logs service when exactly one is picked, the service of the active Metrics panel) are kept in the tab's `sessionStorage` (`chdash.observability.context.v1`, with the last query string of each view), and the next Observability page adopts whatever changed since it last showed them (Metrics opens that service's group of its catalog). A link from one view to another (*Open trace* in a log record, a metrics exemplar) is a plain link: it opens the page of that view and carries the shared context. A page opened from outside Observability (a typed address, a bookmark, another product page's switcher) opens as it is named.

`traces.enabled`, `logs.enabled` and `metrics.enabled` each turn a view on; `/observability` is `302` to the first enabled view (its query string kept, `404` when none is on), the links to the others are hidden and the address of a view that is off is `302` to the first enabled one too. The former pages `/traces`, `/logs` and `/metrics` are gone (`404`). The `/api/*` routes are unchanged.

Each page loads only its own markup, modules and stylesheet: `pages.traces`, `pages.logs` and `pages.metrics` in `src/static/modules.json` list the modules every view needs, then the view's own, and `style.traces.css`, `style.logs.css` and `style.metrics.css` are written from `src/static/css/` by `tools/build_page_css.py` at build time. A page that is not the Traces one never loads the trace modules, and the other way round.

## Configuration

```hcl
traces {
  enabled                  = true
  analytics                = false
  database                 = "otel"
  table                    = "otel_traces"
  trace_index_table        = "otel_traces_trace_id_ts"
  service_allowlist        = ["*"]
  default_lookback_minutes = 60
  max_lookback_minutes     = 10080
  search_limit             = 100
  max_spans_per_trace      = 10000
  highlighted_attributes   = ["service.version", "deployment.environment.name", "deployment.environment", "http.route", "user.id"]
  linked_from_margin_minutes = 60

  features {
    service_filter      = true
    operation_filter    = true
    status_filter       = true
    duration_filter     = true
    resource_attributes = true
    span_attributes     = true
    events              = true
    links               = true
  }
}
```

`service_allowlist` is enforced in backend-generated SQL and applies to search and direct TraceId URLs. `"*"` grants access to every service. Exact names and glob patterns may be mixed:

```hcl
service_allowlist = ["api", "test_*", "*_worker", "payments-*-consumer"]
```

`test_*` means every `ServiceName` starting with `test_`. An empty list denies every service. If a trace crosses allowed and denied services, only allowed spans are returned and hidden parent IDs are removed from the response.

`highlighted_attributes` (optional, at most 32 distinct keys of 1 to 256 bytes) lists the attributes shown as `key: value` chips in the trace header. Each value comes from the root span (span attributes, then resource attributes), else from the first span in tree order that carries the key; keys no span carries are left out. Clicking a chip copies its value. The list is served by `/api/traces/meta`.

`linked_from_margin_minutes` (1 to 1440, default 60) bounds the "Linked from (other traces)" lookup described below.

## Span insights

The inline span inspector spans the waterfall's width (the left column keeps
only the tree guides). Its Tags and Process sections read "Tags N" and, while
closed, show the first eight attributes as two-line cells (key, then value,
mono) and "Show all N", which opens the full table.

The view tabs keep their place on every view: the Timeline's own head (the
service filters and the overview) sits under them and goes with the Timeline.
On the search page, *Traces | Spans* heads the results toolbar, left of the
results line, in both modes.

The span inspector adds, on top of Jaeger's sections:

- **Exceptions.** Events named `exception` (OpenTelemetry semantic conventions: `exception.type`, `exception.message`, `exception.stacktrace`, `exception.escaped`) and `exception.*` span attributes are shown first, type and message in red. Stack traces of Java/Kotlin, Python, Go, JavaScript (V8, Firefox/Safari), .NET and Ruby are parsed into frames (library and runtime frames dimmed); the five frames nearest the throw are shown, with "Show all", a raw view and "Copy stack". A stack without any recognised frame is shown as text. A span can carry several exceptions. Waterfall rows of such spans carry a marker, and the trace header counts the exceptions (the button opens the first span).
- **Linked from (other traces).** Opening the References section asks `GET /api/traces/linked_from?trace_id=&span_id=&start_ms=&end_ms=` for spans of other traces whose `Links` point to this span. The scan covers the trace's own window (`start_ms`/`end_ms`, or the trace index bounds when omitted) widened by `linked_from_margin_minutes` on each side, never more: `PREWHERE has(Links.TraceId, trace)` then `arrayExists` over the zipped `Links.TraceId`/`Links.SpanId` when a span is given, the service allowlist, `ORDER BY Timestamp DESC LIMIT 101` (100 shown) and `max_execution_time = 15`. It is refused when `features.links` is off. "Open linked trace" opens the linking span (`?span=`).
- **Surrounding context.** The inspector's "Context" button opens a side panel listing spans of any trace around the span's start time: ±1 s, ±10 s, ±1 min or ±5 min; Anything, Same service, Same host (`host.name`), Same pod (`k8s.pod.name`) or a custom attribute of the span. `GET /api/traces/context?timestamp_ns=&window_ms=&filter=any|service|host|pod|attribute&service=&value=&attr_scope=&attr_key=&attr_value=&direction=around|older|newer&cursor_ns=&cursor_span_id=&limit=` reads only the window (`Timestamp` bounds, the `ServiceName` primary-key prefix for "Same service"), with the service allowlist, `max_execution_time = 10` and at most 200 rows. `around` returns the spans nearest the anchor on each side, newest first; `older`/`newer` continue with a keyset cursor on `(Timestamp, SpanId)`. Host, pod and attribute filters need Map attribute columns and the matching `features` flag. A row opens its span in its trace.

## Recommended ClickHouse projection indexes

Keep the official OpenTelemetry table definitions and sorting keys unchanged. For the large-trace workloads benchmarked by ChDash, add only these two ClickHouse 26.1+ lightweight projection indexes:

```sql
ALTER TABLE otel.otel_traces
    ADD PROJECTION IF NOT EXISTS prj_traceid INDEX TraceId TYPE basic;

ALTER TABLE otel.otel_traces_trace_id_ts
    ADD PROJECTION IF NOT EXISTS prj_start INDEX Start TYPE basic;
```

`prj_traceid` accelerates exact and `IN (...)` TraceId pruning after search has selected candidate traces. `prj_start` gives the trace-id time index a time-oriented access path for the main search page while preserving its base `(TraceId, Start)` ordering for direct trace lookup.

Do not add `prj_timestamp` by default. On a production-shaped local benchmark with about 2.01 billion spans it consumed roughly 18.7 GiB while a one-hour timestamp scan improved only from about 15 ms to 14 ms.

New parts populate projection indexes automatically. For historical parts, materialize only the projections you actually add, preferably partition-by-partition on large production datasets rather than rewriting all history at once.

The Trace Explorer is trace-index-first whenever no trace-duration filter is active. Unfiltered searches read the newest trace IDs directly from `otel_traces_trace_id_ts`. Service, operation, status, tag, and allowlist filters page recent trace IDs, test existence with `LIMIT 1 BY TraceId`, stop once enough result traces match, and then aggregate only those selected traces. Duration filters keep the exact span-aggregation path because they are trace-level predicates.

### Search SQL strategy

Traces are ranked by their newest index row (`ORDER BY Start DESC LIMIT 1 BY TraceId` over the window). The index is walked newest-first in bounded `Start` slices through `prj_start` with keyset pagination: each page continues at the last returned `Start` and drops traces already seen (the OTel materialized view writes one index row per insert batch, so a trace can reappear through an older row). Re-sorting the whole window with `OFFSET` per page read ~25M index rows per page on a 7-day window; a page now costs roughly the rows it returns. The first slice covers one minute and widens ×4 whenever a slice runs dry, so sparse windows and data gaps take few queries.

Filtered searches test pages starting at 1,000 traces; when matches are rare the page grows (up to 32,000) from the observed match rate. The traces tested, and their order, are unchanged: at most the newest 64,000 traces are tested, then the span fallback below answers. Each page's span match reads only the page's index time bounds (`min(Start)`/`max(End)` of the page's traces, ±1 s like trace detail) instead of probing every part of the window: every span `Timestamp` lies inside the `[Start, End]` row of its insert batch.

Span-based ranking (duration filters, no trace index, or the 64,000-trace cap) first selects the result TraceIds with only `min`/`max` aggregates, then computes the full summary for those traces only. On windows longer than 80 minutes the ranking scans the newest 1/16 of the window first: a trace whose first visible window span is inside that slice has all of its window spans in it, so its start, duration and filter match are exact. Traces with visible spans before the slice rank below all of those and are removed after an IN-list probe of the older part of the window. When the slice does not yield enough exact traces it widens from the observed density, and ends with the plain whole-window query, so the result is always identical to one whole-window aggregation. Broad service/operation filters (matching at least a quarter of the window's index rows, probed with a bounded `LIMIT`) are evaluated as `HAVING countIf(filter) > 0` instead of an `IN` set of most traces; status and tag filters always use the candidate `IN` set.

The result summary reads only the selected traces' time range (exact span bounds for span-ranked traces, index bounds for index-selected ones) and aggregates per-service span/error counts with `sumMap`, so the per-trace state and payload are O(services) instead of one entry per span. Whether the attribute columns are `Map` types (needed by tag filters) is cached per source for 60 s instead of querying `system.columns` on every tagged search; `/api/traces/meta` always reads it fresh.

Search results and global analytics are intentionally separate. `/api/traces/search` returns only the bounded result list and never runs the matching-trace or duration-percentile aggregation. `/api/traces/analytics` computes the two graphs independently and starts only after the browser has rendered the search results. Trace analytics are disabled by default. Set `traces.analytics = true` to show the graphs and enable the analytics query. Both graphs are computed from the spans themselves (`max(Timestamp + Duration) - min(Timestamp)` per trace); broad service/operation filters use the same `HAVING countIf` form as search. The trace index is deliberately not used for durations: the OTel exporter's `trace_id_ts` materialized view stores `End = max(Timestamp)` — the start of the last span — and one row per insert batch, so index-derived durations underestimate real trace durations.

Service/operation prefill is an existence query: it uses `LIMIT 1 BY` rather than counting every matching span, and skips the granules of the pairs it already knows (see "Service/operation prefill cache" below). The old unbounded tag discovery stays removed; attribute keys and values are discovered by the capped facet queries below.

The service/operation prefill is automatic: changing the selected time range refreshes the discovered combinations. There is no manual Prefill button. Tag filters use exact equality only; there is no LIKE/ILIKE matching.

## Search filters

Every filter describes one span: a trace is listed when at least one of its visible spans matches all of them (Jaeger's semantics). `/api/traces/search`, `/api/traces/analytics`, `/api/traces/service_map`, `/api/traces/prefill` and the facet endpoints accept the same repeated parameters:

| Parameter | Meaning |
| --- | --- |
| `service`, `operation`, `status` | column equals (repeated: any of the values) |
| `service_not`, `operation_not`, `status_not` | column differs from every value |
| `tag=[scope:]key=value` | attribute equals |
| `tag_not=[scope:]key=value` | attribute absent or different |
| `tag_exists=[scope:]key`, `tag_missing=[scope:]key` | attribute key present / absent |

`scope` is `span:` (`SpanAttributes`), `resource:` (`ResourceAttributes`) or omitted (either map). The value is everything after the first `=`. Different keys are ANDed; several `tag` values of one key match any of them (one attribute holds one value, so an AND would never match) and several `tag_not` values exclude all of them. At most 32 attribute filters are accepted, keys up to 512 bytes, values up to 4096 bytes. The older `tag_scope` + `tag_key` + `tag_value` form is still accepted as one `tag`.

The SQL is built server-side: values reach it only through string quoting, as `(mapContains(C, 'k') AND C['k'] IN ('v1', 'v2'))`, `NOT (...)`, `mapContains(C, 'k')`, one term per usable map for an unscoped key. Tag filters need `Map(String, String)` attribute columns (a JSON column answers `trace_tag_search_unsupported`) and an attribute scope hidden by `traces.features` answers `trace_filter_disabled`, so a disabled scope cannot be probed through filters. `service_allowlist` is ANDed to every query as before. Service and operation filters, positive or negated, are primary-key predicates and may use the broad `HAVING countIf` form; status and tag filters use the candidate `IN` set. Search keeps the index-first paths.

On the prefill only the tag filters apply, so the service/operation pickers list the pairs seen with those attributes; a tagged prefill reads the attribute maps of the granules it does not skip, within the same read bounds as the untagged one (below), answering `estimated: true` with the pairs found so far when a bound stopped it. It is cached like the untagged prefill, per tag filter set.

In the UI the Tag / Value inputs (with an `=` / `!=` / `exists` / `missing` operator button) add a removable chip; a chip's operator toggles between `=` and `!=`. Values shown by the trace pages (span inspector Tags and Process attributes, the inspector's service, operation and status, the trace header's service and operation, the result list's service pills) open a menu: *Filter for this value*, *Exclude this value*, *Search only this* (replaces every filter, keeps the range and limit) and *Copy*. Applying one returns to the search page with the filter applied.

### Search state in the URL

The search page URL holds the whole search: `from` / `to` (relative expressions such as `now-6h` or absolute times, omitted for the default window), `status`, `service`, `operation`, the chip parameters above, `min_duration_ms` / `max_duration_ms` (the trace duration chip, see the heatmap below), `limit`, `sort`, `results=table` and `duration_view=heatmap`. Each search is a history entry (Back / Forward restore and re-run it), the page-load search keeps its URL, and a reload or a shared link opens the same search. Trace page URLs (`/observability/traces/<id>?span=…`) carry the same parameters, so *back to search* returns to the search the trace was opened from, also from a shared link.

One trace is a page of its own (`trace.html`, started by `app_trace_page.js`), not a pane of the Observability page: it has the page header but none of the Traces / Logs / Metrics tabs and none of the search, and the server answers `/observability/traces/<id>` with it before the Observability catch-all. Opening a trace from the results (a row, a point of the charts, a span, a Services or Logs link) is a page navigation; the back arrow returns to the very search entry the trace was opened from (the browser restores that page as it was left, or runs the search again from its address), or, for a trace opened by its address or from another page, to the search of the context the address carries. Back / Forward inside the trace page (a span picked in a view, a linked trace) stay in its document. A trace whose address carries no time range (a link from Logs or Metrics, a trace opened by its id) returns to, and widens from, the range the tab's last Observability page showed: the controller writes it to the tab's `sessionStorage` (`chdash.observability.context.v1`) when the page is left; the address's own range wins when it has one. A filter picked on a value of the trace (its service, operation, status or an attribute) opens the search page with that filter applied to the carried context, and *Search a wider time range* on a missing trace opens the search over twice its range.

From a Query (or Explorer) result, the right-click row menu offers *Open trace* and *Copy trace link* when a cell of the row holds a trace id: its raw value, trimmed, is exactly 32 hex digits (W3C trace-context), not all zeros, in a `String` or `FixedString` column (an id inside a longer text does not count; upper case is lowered). The trace opens in a new tab, so the results stay. When the row also has a valid span id (16 hex digits, not all zeros) in a column named like `SpanId`, `span_id` or `spanId`, the link carries `?span=` and the trace opens on that span. A row with several trace id columns gets one entry per column, *Open trace (<column>)*. The entries only appear when the traces feature is enabled.

## Service map

The Traces view has tabs in the tab row above the search bar, after the view tabs: *Search* (the result list) and *Service map* (`?tab=map` in the URL, next to the search parameters; other modules add tabs through `ChDash.traceTabs.register`). Every tab shares the time range, the filters and the chips; the Search button runs the selected tab's search.

`GET /api/traces/service_map` (same parameters as search, plus an optional `sample_factor`) returns the services of the traces matching the filters (a trace is on the map when one of its visible spans matches, as in the result list) and the calls between them:

- an **edge** `A -> B` counts the spans of service `B` whose parent span (same `TraceId`) belongs to another service `A`, with the error rate and the p50 / p95 / p99 of those child spans. That covers Client -> Server and Producer -> Consumer instrumentation (HyperDX joins those kinds) as well as flat traces whose root span's direct children run in other services (the OTel fixture has no Client span above a Server span, so a kind-based join finds nothing there). Calls inside one service are not edges;
- a **node** counts every visible span of the service (spans, errors, p50 / p95 / p99);
- an edge's **kind** is `async` when most of its child spans are `Consumer` spans or have a `Producer` parent (messaging), else `sync`.

One query computes both with `GROUPING SETS ((caller, service), (service))` over a `LEFT ANY JOIN` of each span to its parent on `cityHash64(TraceId, ParentSpanId) = cityHash64(TraceId, SpanId)` (a 64-bit key instead of two strings: 0.45 s instead of 1.3 s on 10 minutes; `ANY` because the exporter may store a span twice), `max_execution_time = 30`, `service_allowlist` on both sides. The cost is bounded by two budgets:

- **rows read**: `EXPLAIN ESTIMATE` (primary index only) gives the spans of the window. Above 12 M spans only evenly spaced time slices of about 3 minutes (at most 48) holding about 12 M spans are read. Trace sampling alone does not bound this: every `TraceId` must still be read and hashed (the fixture's peak hour took 2.8 s with 1 trace in 10);
- **join size**: whole traces are kept with `cityHash64(TraceId) % N = 0` (HyperDX's sampling), `N = ceil(spans read / 3 M)`.

Counts are scaled by `N / time coverage`; the answer reports `sampled`, `sample_factor` (the scale), `sampling` (`trace_factor`, `time_coverage`, `slices`, `estimated_spans`) and `sampled_count` per node / edge. Error rates and durations come from the sampled spans. An edge whose parent span started before a slice's start is not counted (children usually start milliseconds after their parent). Measured on the ~2 B span fixture: 10 minutes 0.26–0.59 s (N = 2), 1 hour 0.30–0.64 s (7 slices, N = 4), 24 hours 0.39–0.77 s (13 slices), 7 days 0.37–0.84 s (20 slices).

The map is drawn by the shared canvas graph kit (`app_graph_kit.js`), like the Explorer graph: the same dot grid, cards, orthogonal edges, labels, toolbar, legend, status line, minimap, side panel and keyboard, and the same Fit and level of detail (see [Explorer, Graph rendering](explorer.md#graph-rendering)): the whole map when it is readable as a whole, else the readable scale on the selected service (or the entry point, the first service nobody calls) with the minimap; compact cards shrink to their title row. It is a layered left-to-right graph (`kit.layered`: cycles broken by a DFS for the columns, barycentre ordering, one global row grid that keeps the orthogonal routes straight; a call against the column order is routed from the callee's left side back into the caller's right side). Each service is a card with its name, `spans · error %`, `p95`, a left strip in its Traces color (the color of the result list) and a health dot from 0.1 % errors (a red border from 5 %). Edges are solid for synchronous calls, dashed for asynchronous messages and dotted for database / cache calls (`kind: "db"`, when a source provides it); they are grey, amber from 1 % and red from 5 % errors, and slightly thicker with their calls. Every edge carries a `calls · p95` label. Hover outlines a service and its calls; a click recentres on the service and opens the side panel with the metrics, the busiest callers / callees, *Search this service* / *Search errors* (the Search tab with that service, and status Error) and *Focus map* (the service filter on the map). An edge's *Search calls A → B* searches the callee `B`. Wheel / drag / the `−` / fit / `+` tools and the `+` / `-` / `0` keys zoom and pan; arrows move between services, Enter selects, Escape closes the panel. The status line counts services and calls, with a `sampled ×N` badge that explains the estimate. On phones (≤ 720 px) the map opens on the entry point and the services it calls at 0.7 or more, and the panel is a bottom sheet.

Dense maps are bounded. When most services call most others (a fresh stack's newest hour: 12 services, 132 call paths, every ordered pair) the layered layout is one row of columns and every route detours around cards; the router took about 45 s of main thread per render. The map now gives the router's A* searches a budget of 160 k steps (`kit.routeEdges` `maxSteps` / `searchSteps`): past it the remaining calls get the kit's cheap routes (the best clear one of a few H-V-H lanes and channels between or around card rows, scored like A* steps). The layout is a generator run in 40 ms slices of the main thread (`kit.runSliced`), so no task is long, and its positions and routes are kept while the services and calls stay the same (a new search of the same topology, the web font arriving). In Node, 12 / 132 lays out in about 90 ms instead of 41 s, and 40 services / 600 call paths in about 0.45 s instead of 14 minutes; smaller maps (the spec's 8-service and 120-service graphs) keep exactly the routes they had. `inspect()` reports `layoutTiming` and `routeStats`.

Owning lanes (near runs scored against the lines within `LANE_GAP`, 12 px port spacing) made each A* step dearer, so the same 160 k steps took 125–145 ms in the browser on 12 / 132, and over the 200 ms budget on a loaded host. The steps are cheaper again, with the same routes and labels to the last bit: the segment index answers each A* grid row and column from what it keeps of that line (the parallel segments by start, and the crossing ones by position, so a step's crossings are one binary search), its conflict terms are added without a result object per segment and sorted only when one is not a whole number, a link's conflict is not scored when the link could not improve its state even without it, and the queue is typed arrays. Cheap routes keep their hundreds of candidates as numbers and take the best few from a heap, a candidate's scoring stops once it cannot win; labels try their anchors one at a time against rectangles hashed by number. Medians of 11 runs on the development host (Chromium, load about 3): 12 / 132 about 60 ms instead of 125 ms, 40 / 600 about 170 ms instead of 450 ms; no task over 60 ms.

## Attribute facets

The search page's sidebar (after HyperDX's search filters) lists the attribute keys of the spans matching the current range and filters, span (`S`) and resource (`R`) keys by the number of sampled spans carrying them. A key expands to its top values with counts; a value's checkbox adds or removes a `tag` chip, its exclude button a `tag_not` chip. Keys can be pinned to the top (stored in the browser), filtered by name and loaded 20 at a time; values load 10, then 50, 200 and 500. The sidebar folds into a rail (remembered; folded by default below 1100 px) and loads nothing while folded. The sidebar is the facets component (`app_facet_panel.js`, `ns.facetPanel`) the Logs **Fields** panel uses too (`docs/logs.md`), and the caps below (`src/facet_limits.hpp`) bound both.

`/api/traces/facets` returns the keys in one pass that reads only the maps' key subcolumns:

```sql
SELECT toString(sampled), toString(t.1), toString(t.2), toString(t.3) FROM (
  SELECT count() AS sampled,
         sumMap(sk, arrayResize([toUInt64(1)], length(sk), toUInt64(1))) AS sm,
         sumMap(rk, arrayResize([toUInt64(1)], length(rk), toUInt64(1))) AS rm
  FROM (SELECT SpanAttributes.keys AS sk, ResourceAttributes.keys AS rk FROM otel.otel_traces
        PREWHERE <window> WHERE <allowlist> <filters> LIMIT 3000000))
LEFT ARRAY JOIN arrayConcat(<('span', key, count) tuples>, <('resource', key, count) tuples>) AS t
SETTINGS max_execution_time = 5, timeout_overflow_mode = 'break',
         max_rows_to_read = 50000000, read_overflow_mode = 'break'
```

`/api/traces/facet_values?scope=span|resource&key=…&limit=…` counts one key's values the same way (`GROUP BY` over `C['key']` of the sampled spans having the key, `sum(c) OVER ()` / `count() OVER ()` for the totals, plus `max_rows_to_group_by = 100000, group_by_overflow_mode = 'any'`). A key's own filters are left out of its values query, so its other values stay listed and can be added.

The caps bound every facet query: at most 3 M sampled spans, at most 50 M rows read from storage (a selective filter would otherwise scan the whole window looking for enough spans; the read cap stops like an exhausted source, so the aggregate still answers from what was read), at most 100 k distinct values grouped, and a 5 s time budget as the last resort. The answer says `estimated: true` when a bound actually stopped the scan: the sample limit (the sampled spans reach 3 M), the read cap (the rows read reach it: `max_rows_to_read` with `read_overflow_mode = 'break'` stops the sources there), the time budget, or the group-by cap for values; counts are then sample counts and the UI prefixes them with `≈`. The progress packets' `total_rows_to_read` is no signal: ClickHouse announces it before the attribute bloom indexes skip granules, so a selective tag read completely reads far fewer rows than announced (85 k of 456 k on a rich hour). `read_rows_limit=<n>` lowers the read cap of one request (never raises it); the answer reports the cap it used. Answers are cached for 60 s per host, minute-aligned range and filter set, like the prefill. Keys and values need `Map` attribute columns; a scope disabled by `traces.features` is left out of the keys and rejected for values.

Measured on the local fixture (about 2.0 B spans over 7 days, 11 to 18 M spans per hour, cold cache): medians of three requests through the API.

| Request | Median | Note |
| --- | --- | --- |
| keys, 1 h | 94 ms | 3 M sampled spans (estimated) |
| keys, 7 days | 123 ms | 3 M sampled spans (estimated) |
| keys, 7 days, one tag filter | 519 ms | the filter reads the span map |
| keys, 7 days, rare filter (tag + service + status) | 423 ms | stopped by the 50 M read cap, 2,274 spans sampled |
| values of a span key, 1 h / 7 days | 37 ms / 70 ms | |
| values of a resource key, 7 days, one tag filter | 860 ms | |
| tagged prefill, 1 h / 7 days | 79 ms / 101 ms | 1.4 M / 3.4 M rows read, exact (before the skip scan: 107 ms / 634 ms, the 7-day scan stopped at a 100 M read cap) |
| search, two tag filters (= and !=), 1 h / 7 days | 76 ms / 288 ms | `trace_index_filtered` |
| analytics counts, two tag filters, 1 h | 343 ms | span aggregation |

## Duration heatmap and attribute comparison

The *Trace duration* card has two modes (after HyperDX's search heatmap and event deltas): *Percentiles* (P50 / P90 / P95 / P99 plus the listed traces) and *Heatmap*. The choice is remembered in the browser and kept in the search URL as `duration_view=heatmap`. The heatmap shows exactly the traces of the percentiles: traces with at least one matching visible span, each at its first span start (x, the analytics' time buckets starting at local midnight) with its span-bounds duration (y, log scale); a cell's colour is its number of traces (8 sequential steps on a log scale). While the heatmap is shown the percentiles request is skipped.

Dragging a box over the heatmap (or, with the chart focused: arrow keys to move, Shift + arrow keys to extend, Enter to compare, Escape to clear) opens the comparison panel below the charts: for the attributes that set the box's traces apart, paired bars with the share of the box's traces (orange) and of the baseline traces (gray) having a span with each value. The baseline is the other traces of the box's time range (default) or all traces of that time range. A value click adds it as a filter chip (its exclude button a `!=` chip; `ServiceName`, `SpanName` and `StatusCode` become the service / operation / status filters); *Search traces in this box* searches the box's time range with a trace duration filter (a removable `duration` chip, `min_duration_ms` / `max_duration_ms` in the URL).

`GET /api/traces/heatmap` takes the analytics parameters (window, filters, `min_duration_ms` / `max_duration_ms`, `bucket_origin_ms`, `align_buckets`) plus `rows` (8–80, default 40). One pass counts the traces into fixed log2 bins, 32 per octave, per time bucket; the server then takes the bin holding the 1 % quantile as the lowest row and the slowest bin as the top and merges the fine bins into at most `rows` rows. Row edges (`y_edges_ns`) lie on fine-bin edges, so every count is exact, and traces faster than the lowest edge are counted in the lowest row (`below_min_count`). A separate `quantile(0.01)` / `max` pass would read the same spans a second time: the per-trace aggregation is the whole cost.

```sql
WITH [candidate_ids AS (SELECT TraceId FROM otel.otel_traces PREWHERE <window> WHERE <allowlist> <filters> LIMIT 1 BY TraceId),]
trace_durations AS (
  SELECT min(Timestamp) AS trace_start,
         toInt64(max(toUnixTimestamp64Nano(Timestamp) + toInt64(Duration))) - toInt64(min(toUnixTimestamp64Nano(Timestamp))) AS duration_ns
  FROM otel.otel_traces PREWHERE <window> WHERE <allowlist> [AND TraceId IN (SELECT TraceId FROM candidate_ids)]
  GROUP BY TraceId [HAVING <duration filters> | HAVING countIf(1 <broad service / operation filters>) > 0])
SELECT <origin> + intDiv(toUnixTimestamp64Milli(trace_start) - <origin>, <bucket>) * <bucket> AS bucket_ms,
       toInt32(floor(log2(greatest(duration_ns, 1)) * 32)) AS fine_bin, count()
FROM trace_durations GROUP BY bucket_ms, fine_bin
SETTINGS max_execution_time = 55
```

`GET /api/traces/deltas` takes the same parameters plus the box: `t0` / `t1` (trace start, epoch ms), `d0` / `d1` (trace duration, ms), `baseline=outside|all` and `sample` (traces per side, 100–2500, default 1000). The box's time range is aggregated per trace like the heatmap; a box wider than 30 minutes is sampled as 6 evenly spread 5-minute slices, so the cost does not grow with the box. Each slice is read with a margin of `clamp(2 × d1, 1 s, 5 min)` on both sides, so a box trace (no longer than `d1`) is aggregated whole. Traces in the duration range form the selection, the others the baseline, each side ordered by `cityHash64(TraceId)` (stable samples):

```sql
SELECT TraceId, in_box, count() OVER (PARTITION BY in_box) FROM (
  SELECT TraceId, duration_ns >= <d0> AND duration_ns <= <d1> AS in_box FROM (
    SELECT TraceId, min(Timestamp) AS trace_start, <duration> AS duration_ns FROM otel.otel_traces
    PREWHERE (<slice 1 + margins> OR …) WHERE <allowlist> [AND TraceId IN candidate_ids]
    GROUP BY TraceId HAVING (<trace_start in slice 1> OR …) [AND <duration filters>]))
ORDER BY in_box DESC, cityHash64(TraceId) LIMIT <sample> BY in_box
```

A second query expands the sampled traces' spans only: `arrayJoin` over `ServiceName`, `SpanName`, `StatusCode` and the span / resource attribute maps (values up to 1 KiB; a scope disabled by `traces.features` or not stored as a `Map` is left out), counting per (scope, key, value) the sampled traces of each side having a span with it (`uniqExactIf(TraceId, side)`), and per key its 40 values with the largest shares. The server then ranks the keys like HyperDX's `eventDeltas.ts`: keys seen fewer than 5 times, identifier / timestamp keys (`…_id`, `uuid`, `timestamp`…, or mostly hex / long numeric values) and high-cardinality keys (more than 90 % unique values on both sides with more than 20 occurrences) are hidden (`hidden_keys`); a key's score is the largest gap between the selection and baseline shares of one of its values, plus 2 points for OpenTelemetry semantic-convention keys (`http.route`, `db.system`, `service.version`…) and the three columns. The answer holds the top 20 keys with their 6 most different values: `selection_pct` / `baseline_pct` (share of the side's sampled traces), the counts, and the sample and trace totals of both sides. With `baseline=all` the baseline shares weigh both samples by the traces they stand for. Both queries run with `max_execution_time = 30`.

Measured on the local fixture (about 2.0 B spans, 7 days), through the API on the shared test ClickHouse (other suites running): medians of three requests.

| Request | Median | Note |
| --- | --- | --- |
| heatmap, 1 h | 677 ms | 92,916 traces, span aggregation |
| heatmap, 24 h | 6.5 s | 1.9 M traces |
| heatmap, 7 days | 35 s | 18 M traces; the same cost as the 7-day percentiles (one run took 50 s under load) |
| heatmap, 24 h, one service (broad) | 6.9 s | `HAVING countIf` form |
| heatmap, 24 h, `status=Error` | 7.8 s | candidate traces |
| heatmap, 24 h, one tag filter | 12 s (5.2 s to 18.6 s) | candidate traces |
| deltas, 20-minute box | 415 ms | 1,000 + 1,000 sampled traces |
| deltas, 24-hour box | 494 ms | 6 × 5-minute slices |
| deltas, 7-day box | 593 ms | 6 × 5-minute slices |

## Services view

The Services tab sits between *Search* and *Service map* in the one tab registry of `app_trace_tabs.js` (`register({ id, label, order, panelId, install, onSearch, onShow, onHide, available, params, writeParams, applyParams })`: `available(meta)` hides a tab /api/traces/meta does not enable, `params` lists a tab's view-only URL parameters, left out of the search key). The selected tab is in the URL (`?tab=services`) next to the search parameters, and every tab shares the search bar: the time range, the status / service / operation pickers and the filter chips apply to the Services view as well. The view needs `traces.analytics = true` (it is a span aggregation like the analytics charts).

After HyperDX's services dashboard, the view shows RED metrics of each service's **entry spans**: `SpanKind IN ('Server', 'Consumer', 'SPAN_KIND_SERVER', 'SPAN_KIND_CONSUMER') OR ParentSpanId = ''` (the OTel exporter writes `Server` / `Consumer`; the fixture has `Server` roots and `Consumer` children). *Root spans* (`ParentSpanId = ''`) is the cheaper alternative (`svc_scope=root`). The search filters describe these spans themselves; `min_duration_ms` / `max_duration_ms` bound the span's own `Duration`.

- The table lists per service the rate (entry spans per second), the error share (`StatusCode = 'Error'`), P50 / P95 / P99 of `Duration`, the share of the total time (`sum(Duration)`) and sparklines of the rate (errors in red) and of the P95; every column sorts (`svc_sort=<column>:<asc|desc>`, default total time descending).
- A row opens the service drawer (`svc=<name>`, Back / Forward and Escape close it): request rate, error rate and P50 / P95 / P99 latency charts with release markers, the releases list, the most time-consuming endpoints (service + `SpanName`, by `sum(Duration)`), the slowest spans (open their trace) and the database statements.
- An endpoint opens the Search tab with its service and operation; a P99 value (table, drawer, endpoints) searches that service (and operation) with the duration chip set to `≥ P99` (`min_duration_ms`, the same chip as the heatmap's: a trace duration filter in Search, a bound on the entry span's own `Duration` in Services).
- Estimated answers carry a `≈ Estimated from N% of the window` badge and a *Compute exactly* button (`svc_exact=1`); an answer stopped by the time budget says *Partial*.

`GET /api/traces/services` takes the search filters, `bucket_origin_ms` / `align_buckets` (the analytics count grid: ~60 buckets per range), `scope=entry|root`, `exact=1` and `detail=<service>`. One scan groups t-digest states by service, bucket and endpoint; the outer `GROUPING SETS` merge them into service totals, service buckets and endpoint totals:

```sql
SELECT grouping(b, op), svc, b, op, sum(c), sum(e), quantilesTDigestMerge(0.5, 0.95, 0.99)(st), sum(s) FROM (
  SELECT ServiceName AS svc, <origin> + intDiv(toUnixTimestamp64Milli(Timestamp) - <origin>, <bucket>) * <bucket> AS b,
         SpanName AS op,  -- '' outside the drill-down
         count() AS c, countIf(StatusCode = 'Error') AS e,
         quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS st, sum(Duration) AS s
  FROM otel.otel_traces
  PREWHERE <window or time slices> AND <entry spans>
  WHERE <allowlist> <filters> [AND ServiceName = <detail>]
  GROUP BY svc, b, op)
GROUP BY GROUPING SETS ((svc), (svc, b), (svc, op))
SETTINGS max_execution_time = 25, timeout_overflow_mode = 'break',
         max_rows_to_group_by = 200000, group_by_overflow_mode = 'any'
```

The primary key `(ServiceName, SpanName, toDateTime(Timestamp))` makes a drill-down read only that service's granules. Before the scan, `EXPLAIN ESTIMATE` (index only, a few ms) sizes the window: above 150 M rows the window is **sampled by time** — one slice per chart bucket at a stable golden-ratio offset inside it, sized to read about 50 M rows (at least 1 min) — and counts are scaled back by the sampled share (per bucket for the series, per window for the totals); percentiles come from the sampled spans. `exact=1` reads the whole window (still bounded by the 25 s budget, then `partial: true`). The drill-down adds the 20 slowest entry spans of the same (sampled) window (`ORDER BY Duration DESC LIMIT 20`) and releases (after HyperDX's release annotations): the first `Timestamp` of each `ResourceAttributes['service.version']` of the service in the whole window, read with the bloom filter key index and the facet caps (200 M rows read, `estimated` when stopped).

`GET /api/traces/services/db` (HyperDX's database tab) groups spans of any kind carrying `db.query.text` or `db.statement` by `coalesce(nullif(SpanAttributes['db.query.text'], ''), SpanAttributes['db.statement'])` and service: count, errors, `sum(Duration)`, P95 and `db.system.name` / `db.system`, the 50 most time-consuming statements, with the facet-style caps (200 M rows read, 100 k groups, 5 s; `estimated` when a cap stopped it). It needs a `Map` span attribute column (`supported: false` otherwise). The local fixture has neither database attributes nor `service.version`, so both are empty there (the UI tests mock them).

Measured through the API on the local fixture (about 2.0 B spans over 7 days, densest day 565 M spans, 23 M spans in the measured hour; medians of three, ClickHouse shared with other test runs, load average ~35):

| Request | Median | Note |
| --- | --- | --- |
| all services, 1 h | 0.60 s (0.1 s idle) | exact, 23 M rows |
| one service's detail, 1 h | 0.72 s | exact, with slowest spans and releases |
| all services, densest 24 h | 0.68 s | sampled: 8.8 % of the window |
| all services, densest 24 h, `exact=1` | 2.23 s | 565 M rows |
| root spans, densest 24 h | 0.52 s | sampled |
| one service's detail, 24 h | 1.38 s | exact, 49 M rows |
| all services, 7 days | 0.90 s | sampled: 2.5 % of the window |
| one service's detail, 7 days | 2.92 s | sampled: 30 % (172 M rows) |
| all services, 7 days, `exact=1` | 14.2 s | 2.0 B rows |
| database statements, 1 h / 7 days | 0.08 s / 0.16 s | the key index skips every granule |

On the densest day the sampled span counts were within 1.5 % of the exact ones (the backend tests allow 15 % on the week).

## Spans mode

The search page's *Traces | Spans* toggle (`mode=spans` in the URL) lists matching **spans** instead of traces (after HyperDX's row search). The range, filters, chips and facets are the same, but they apply per span: every listed span matches all of them. Spans mode adds a span kind picker (`kind`) and a span duration range (`span_min_duration_ms` / `span_max_duration_ms` in the URL; `min_duration_ms` / `max_duration_ms` there stay trace durations).

The table is virtualised (only the rows in view are rendered) and loads the next page by cursor when its end scrolls into view. Columns: time (local, exact UTC nanoseconds on hover), service (with its colour), operation, duration with a bar relative to the longest listed span, status, kind, and attribute columns chosen in the *Columns* picker (`span:key`, `resource:key` or `key` for either map; kept in the browser). Service, operation, status and attribute values open the click-to-filter menu. A row (or Enter) opens the span side panel: identity, status message, exceptions, Tags / Process attributes with filter actions, events and links, and *Open in trace* (`/observability/traces/<id>?span=<span id>` with the search context, so Back returns to the same rows, selection and panel). Up / Down move through the rows (also with the panel open), Escape closes the panel.

`GET /api/traces/spans` takes the search filters (`start_ms` / `end_ms` or `lookback_minutes`, `service`, `operation`, `status`, the `*_not` and `tag*` parameters), plus `kind` (repeatable), `min_duration_ms` / `max_duration_ms` (the span's own `Duration`), `limit` (default 100, at most 500), `columns=span:http.route,resource:host.name` (at most 20) and `cursor`. Rows are newest first: `timestamp`, `start_ns` (exact nanoseconds as text), `trace_id`, `span_id`, `parent_span_id` (empty with a restricted service allowlist, as in trace detail), `service_name`, `span_name`, `span_kind`, `duration_ns`, `status_code`, `status_message` and `attributes` (one value or `null` per requested column).

Paging is a keyset on `(Timestamp, SpanId, TraceId)`, never `OFFSET`: `(TraceId, SpanId)` is not unique (a re-exported span has two timestamps), so the key starts with the timestamp, and exact copies of the page's last key are all kept on that page. A page reads newest-first time slices of 15 min, 1 h, 6 h, then 24 h until it holds `limit` spans (a top-N over a slice costs about the rows the slice holds, so a dense range answers from its first slice):

```sql
SELECT <span columns>, <attribute columns> FROM otel.otel_traces
PREWHERE Timestamp >= <slice start> AND Timestamp <= <slice end or cursor time>
     AND <allowlist> AND <service / operation (primary key), status, kind, duration>
WHERE 1 [AND (Timestamp, SpanId, TraceId) < cursor] <attribute filters>
ORDER BY Timestamp DESC, SpanId DESC, TraceId DESC LIMIT <remaining + 1>
SETTINGS max_execution_time = 20, timeout_overflow_mode = 'throw',
         max_rows_to_read = 1000000000, read_overflow_mode = 'throw'
```

Each next slice is sized from the cost rate seen so far so the page stays within a 2 s budget; once the budget is spent the page ends early with `incomplete: true`, `stop_reason: "time_budget"`, `searched_to_ns` and a cursor at the slice boundary, and the next request resumes exactly there. The cursor also carries the slice width the next page starts with. A slice guard (time or rows) after answered slices is a resume point too; on a page's first slice it is retried once eight times narrower. The table continues budget-stopped empty pages on its own three times, then offers *Keep searching*.

`GET /api/traces/span?trace_id=…&span_id=…&timestamp_ns=…` returns one span with its attributes, events and links by its row key; the exact timestamp bounds the read to a few granules.

Measured on the local fixture (about 2.0 B spans over 7 days), server time, medians of five requests:

| Request | Median | Slices |
| --- | --- | --- |
| 1 h unfiltered, 100 spans (next page) | 50 ms (14 ms) | 15 min |
| 1 h unfiltered, 500 spans, 2 attribute columns | 56 ms | 15 min |
| 7 days unfiltered, 100 spans | 25 ms | 15 min |
| 7 days, service + operation | 15 ms | 15 min |
| 7 days, status = Error | 21 ms | 15 min |
| 7 days, status = Error + tag, 500 spans (next page) | 224 ms (181 ms) | 15 min, 1 h, 6 h |
| 7 days, tag + kind + span duration | 33 ms | 15 min |
| 7 days, a tag matching nothing | 50 ms | the whole range (skip indexes) |

## Trace detail rendering

The views of a trace are a tab row above the waterfall, *Timeline | Graph | Statistics | Spans | Flamegraph*: the in-content tab component (`app_ui_tabs.js`, the Logs *Results | Patterns* tabs' look; arrow keys, Home and End move between them). The view is the URL's `?tab=` (omitted for the timeline; the former `?view=` is an alias, rewritten on load) and the last one is remembered; below 820 px a *View* dropdown replaces the tabs. The *Graph* view draws one card per call path (service, operation, `count / errors · avg`, `time (% of the trace) · self`) with the graph kit; it opens like the service map, on the root call path (or the selected one), and a compact card reads `service · operation` and the path's time, never the service alone.

The detail page derives the span tree, trace bounds, per-service counts, start-ordered overview bars and parsed event markers once per loaded trace. Opening or closing a span inspector and folding or unfolding a branch patch only the affected rows; service filters and range changes re-render the waterfall from the cached data. Waterfall controls use delegated listeners on the persistent container. The query-analysis trace viewer mounts rows lazily: only rows visible under the initial fold are built, and a branch mounts its children the first time it is expanded.

## Direct TraceId URLs

A trace can be opened directly at:

```text
/observability/traces/<trace-id>
```

Direct TraceId lookup is not limited by `max_lookback_minutes`. ChDash requires `trace_index_table` to resolve the timestamp window (one index pass yields both bounds) and then reads `otel_traces` only inside that bounded window. There is no all-history TraceId fallback. If the auxiliary table is unavailable or its lookup fails, the API returns an error instead of scanning `otel_traces`.

## Synthetic demo traces

`examples/generate_otel_traces.py` creates domain-neutral fixture data intended to stress the viewer with realistic distributed-system complexity rather than tiny toy traces. Defaults are 10,000 traces with 60–90 spans each across HTTP ingress, authentication, Kafka producers/consumers, processing and enrichment workers, cache calls, ClickHouse writes, notification delivery, nested/parallel branches, events, links, and occasional errors.

```bash
python3 examples/generate_otel_traces.py \
  --traces 100 \
  --seed 20260918 \
  --output-dir /tmp/chdash-otel
```

For the repository test stack no manual import is required. The normal `docker compose up -d --build` starts ClickHouse and ChDash but intentionally does not start the heavy OTEL fixture. Enable it explicitly with `docker compose --profile otel up -d --build otel_fixture` (or use the `test` profile for the full test stack). ClickHouse initialization creates the OTEL tables and local projection indexes before fixture data is inserted. `OTEL_FIXTURE_FORCE=1` truncates and repopulates the existing tables without dropping their projection definitions.

The generated services include `test_ingest`, `test_worker`, and `test_enrichment`, so this access-control case is immediately testable:

```hcl
service_allowlist = ["test_*"]
```

### Rich fixture day (2026-09-12)

The bulk test fixture is flat (one level of spans, two attributes, no links or events). Next to it, `tests/otel-fixture/rich_fixture.py` (`OTEL_FIXTURE_RICH=1`, on in the test compose file) loads a deterministic e-commerce workload on **2026-09-12 UTC** only, a day the bulk fixture never uses: ~40,700 traces / ~545 k spans through `api-gateway`, `frontend`, `checkout`, `payments`, `inventory`, `auth`, `search`, `recommendation` and `notification`, with HTTP client/server pairs, gRPC, PostgreSQL / Redis / ClickHouse and Kafka spans (semantic-convention attributes), producer → consumer links across traces, errors deep in branches with `exception` events in Java, Python, Go, JavaScript and .NET formats, `cache.miss` / `retry` events, orphan spans, batch traces of 2 k to 12 k spans, `service.version` releases at known times, hosts and pods, a slow cohort (14:00–16:00, `feature.flag=new_pricing`) for the heatmap comparison, and correlated logs and metrics (exemplars pointing at these spans). Its index rows follow the exporter's view: one row per 5 s export batch, `End` = the newest span *start* of the batch. Shape, knobs and idempotency: `tests/README.md` ("Rich OTel dataset"); `tests/backend-functional/test_rich_fixture.py` checks trace detail, search filters and orphans, linked-from, context presets, the service map, facets, the heatmap and deltas, trace logs and metrics exemplars on it.

### Service/operation prefill cache

`/api/traces/prefill` lists the (service, operation) pairs of the window (existence only, `LIMIT 1 BY ServiceName, SpanName`) without reading every span. The table's sorting key starts with `(ServiceName, SpanName)`, so a scan with `(ServiceName, SpanName) NOT IN (<known pairs>)` skips, through the primary index, every granule holding only known pairs and reads just the granules where a pair changes, plus those of unknown pairs:

1. a seed scan of the newest 5 minutes of the window, whose pairs are usually most of the window's;
2. scans of the whole window that exclude the known pairs, each stopped after 20 M rows read, until one runs to its end (at most 8, 100 M rows in all, a 5 s time budget each).

A scan that ran to its end read everything it did not exclude, so the list is exact; when a bound stopped the last scan (or a stopped scan found nothing new) the answer is `estimated: true` and the list is a subset, and the search page then no longer rules a service / operation combination out. `scan` reports the passes and rows read; `read_rows_limit=<n>` lowers the bounds of one request. On the ~2 B-span fixture (an hour ending 2026-09-19 12:00 UTC, its day and its week): 11.5 M / 502 M / 1.79 B rows read and 0.19 / 5.8 / 20.8 CPU-s before, 1.4 M / 2.0 M / 3.8 M rows and 0.07 / 0.14 / 0.34 CPU-s now (18 / 378 / 1314 ms of query time before, about 50 / 50 / 70 ms now), with the same pairs.

The browser requests it on every time-range change and page load, so the server answers from a 60 s cache keyed by the minute-aligned superset of the requested range: requests made within the same minute share one scan, and the picker lists may include pairs seen up to one minute outside the exact range.

### Trace index assumptions

Index-driven search pages walk `otel_traces_trace_id_ts` newest-first in disjoint `Start` slices that are read completely (one row per trace per slice), so equal `Start` values never straddle a page and a trace with many index rows (one per exporter insert batch) costs one row per slice. `Start`/`End` may be `DateTime` or `DateTime64`. Like trace detail, search summaries and per-page span matching bound span timestamps by the trace's index rows (`[min(Start) - 1 s, max(End) + 1 s]`): this assumes every insert batch has its index row, which the exporter's materialized view guarantees for data inserted after the view exists. Backfill the index (or keep equal TTLs) if older spans predate it.

