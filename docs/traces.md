# Trace Explorer

ChDash can read the OpenTelemetry traces that the OpenTelemetry Collector contrib ClickHouse exporter stores. The viewer follows the ClickHouse host that the user selects in the UI. It uses the `system_uri` of that host.

## The Observability page

Traces, logs (`docs/logs.md`) and metrics (`docs/metrics.md`) are the three views of one page, `/observability`. The page switcher of every page lists it as **Observability**. Its header is the header of the other pages. The row under the header holds one tab for each enabled view (the view tabs of the Explorer: Left / Right, Home / End). While the Traces search is shown, the same row also holds the *Search* / *Services* / *Service map* tabs of the Traces view. They are after a separator. On a narrow window, the row scrolls sideways.

| URL | View |
| --- | --- |
| `/observability` | the first enabled view (Traces, Logs, Metrics), its query parameters kept |
| `/observability/traces?…` | trace search; `tab=services` / `tab=map` for the other Traces tabs |
| `/observability/traces/<trace-id>?span=…&tab=…` | one trace, a page of its own (`trace.html`, below): `tab=` its view (the former `view=` is an alias), with the search context it was opened from (its filters, not the search page's tab) |
| `/observability/logs?…` | the Logs explorer |
| `/observability/metrics?…` | the metrics browser |

Under that row, each view has its **filter bar** (`.obsFilterBar`, the filter bar component of `docs/ui-foundations.md`, "Filter bar", shared with the System sections). The filter bar has these parts, from left to right:

- The time range.
- The "Label · Value" pickers of the view, its free-text fields and its options.
- At the right end: the secondary actions (*Add panel* of Metrics) and the primary **Search**. The queries run on demand.

At 600 px and below, the filter bar folds into one summary line ("Sep 12 12:30 → 13:30 · 2 filters"). The summary line unfolds it. A search folds it again.

Each view keeps its own URL parameters. Its section lists them. `docs/ui-foundations.md`, "Routes", lists every route and parameter. A switch of views is a history entry. For this reason, Back / Forward return to the previous view as it was. A deep link opens the view and the sub-tab that it names. The filters of a view stay with it for the session. If the user switches away and back, the page restores them (its last URL) and keeps its results.

The **time range** and the **selected service** follow the user across views. When the user leaves a view, its range and its service become the shared context. The service is the Traces service picker, the Logs service when exactly one is picked, or the service of the active Metrics panel. The next view adopts whatever changed since it last showed them (Metrics opens the group of that service in its catalog). A link from one view to another (*Open trace* in a log record, a metrics exemplar) switches the view in place. It carries the shared context.

`traces.enabled`, `logs.enabled` and `metrics.enabled` each turn a view on. The page exists while at least one is on. Otherwise, `/observability` is `404`, like any unknown path. The tabs of the other views are hidden, and their URLs fall back to the first enabled view. The former pages `/traces`, `/logs` and `/metrics` are gone (`404`). The `/api/*` routes are unchanged.

The page loads only the view that it shows. These rules apply:

- The page starts with the markup, the modules and the stylesheet of its first view (`style.observability.<view>.css`). The shell ships the markup of every view for the first paint. The other views leave the document before any module runs.
- The markup and the modules of a view (`pages.observability.views` in `src/static/modules.json`) load once, the first time its tab is shown.
- When a second view shows, the page swaps in `style.observability.css` once it has loaded. This sheet has the rules of every view, in the cascade order of the sources.
- `tools/build_page_css.py` writes these sheets from `src/static/css/` at build time.

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

`service_allowlist` is enforced in the SQL that the backend generates. It applies to search and to direct TraceId URLs. `"*"` grants access to every service. You can mix exact names and glob patterns:

```hcl
service_allowlist = ["api", "test_*", "*_worker", "payments-*-consumer"]
```

`test_*` means every `ServiceName` that starts with `test_`. An empty list denies every service. If a trace crosses allowed services and denied services, the response contains only the allowed spans. The backend removes the hidden parent IDs from the response.

`highlighted_attributes` (optional, at most 32 distinct keys of 1 to 256 bytes) lists the attributes that the trace header shows as `key: value` chips. Each value comes from the root span (span attributes, then resource attributes). Otherwise, it comes from the first span in tree order that carries the key. The header leaves out keys that no span carries. A click on a chip copies its value. `/api/traces/meta` serves the list.

`linked_from_margin_minutes` (1 to 1440, default 60) bounds the "Linked from (other traces)" lookup that the next section describes.

## Span insights

The inline span inspector has the width of the waterfall (the left column keeps only the tree guides). Its Tags and Process sections read "Tags N". While they are closed, they show the first eight attributes as two-line cells (key, then value, mono) and "Show all N". "Show all N" opens the full table.

The view tabs keep their place on every view. The head of the Timeline (the service filters and the overview) sits under them and goes with the Timeline. On the search page, *Traces | Spans* heads the results toolbar, left of the results line, in both modes.

The span inspector adds these sections on top of the sections of Jaeger:

- **Exceptions.** The inspector shows events named `exception` first. They follow the OpenTelemetry semantic conventions: `exception.type`, `exception.message`, `exception.stacktrace`, `exception.escaped`. It also shows `exception.*` span attributes first. The type and the message are in red.
  - The inspector parses stack traces of Java/Kotlin, Python, Go, JavaScript (V8, Firefox/Safari), .NET and Ruby into frames. Library and runtime frames are dimmed.
  - It shows the five frames nearest the throw, with "Show all", a raw view and "Copy stack".
  - A stack without any recognised frame is shown as text.
  - A span can carry several exceptions.
  - Waterfall rows of such spans carry a marker. The trace header counts the exceptions (the button opens the first span).
- **Linked from (other traces).** The References section asks `GET /api/traces/linked_from?trace_id=&span_id=&start_ms=&end_ms=` when the user opens it. The request looks for spans of other traces whose `Links` point to this span. These rules apply to the scan:
  - It covers the own window of the trace (`start_ms`/`end_ms`, or the bounds of the trace index when omitted). The window is widened by `linked_from_margin_minutes` on each side, never more.
  - It uses `PREWHERE has(Links.TraceId, trace)`. When a span is given, it then uses `arrayExists` over the zipped `Links.TraceId`/`Links.SpanId`.
  - It applies the service allowlist, `ORDER BY Timestamp DESC LIMIT 101` (100 shown) and `max_execution_time = 15`.
  - The backend refuses it when `features.links` is off.
  - "Open linked trace" opens the linking span (`?span=`).
- **Surrounding context.** The "Context" button of the inspector opens a side panel. The panel lists spans of any trace around the start time of the span. The user can select these options:
  - The window: ±1 s, ±10 s, ±1 min or ±5 min.
  - The filter: Anything, Same service, Same host (`host.name`), Same pod (`k8s.pod.name`) or a custom attribute of the span.

  The request is `GET /api/traces/context?timestamp_ns=&window_ms=&filter=any|service|host|pod|attribute&service=&value=&attr_scope=&attr_key=&attr_value=&direction=around|older|newer&cursor_ns=&cursor_span_id=&limit=`. It reads only the window (`Timestamp` bounds, and the `ServiceName` primary-key prefix for "Same service"). It applies the service allowlist, `max_execution_time = 10` and at most 200 rows. `around` returns the spans nearest the anchor on each side, newest first. `older` and `newer` continue with a keyset cursor on `(Timestamp, SpanId)`. The filters for host, pod and attribute need Map attribute columns and the matching `features` flag. A row opens its span in its trace.

## Recommended ClickHouse projection indexes

Keep the official OpenTelemetry table definitions and sorting keys unchanged. For the large-trace workloads that ChDash benchmarked, add only these two lightweight projection indexes of ClickHouse 26.1+:

```sql
ALTER TABLE otel.otel_traces
    ADD PROJECTION IF NOT EXISTS prj_traceid INDEX TraceId TYPE basic;

ALTER TABLE otel.otel_traces_trace_id_ts
    ADD PROJECTION IF NOT EXISTS prj_start INDEX Start TYPE basic;
```

`prj_traceid` accelerates exact and `IN (...)` TraceId pruning after the search has selected candidate traces. `prj_start` gives the trace-id time index an access path that is oriented on time for the main search page. It preserves the base `(TraceId, Start)` ordering for direct trace lookup.

Do not add `prj_timestamp` by default. A benchmark on a local table with about 2.01 billion spans had the shape of production. In this benchmark, `prj_timestamp` consumed roughly 18.7 GiB. A scan of one hour by timestamp improved only from about 15 ms to 14 ms.

New parts populate projection indexes automatically. For historical parts, materialize only the projections that you actually add. On large production datasets, materialize them partition by partition. Do not rewrite all history at once.

The Trace Explorer is trace-index-first whenever no trace-duration filter is active. These rules apply:

- Unfiltered searches read the newest trace IDs directly from `otel_traces_trace_id_ts`.
- Filters for service, operation, status, tag and allowlist page the recent trace IDs. They test existence with `LIMIT 1 BY TraceId`, and they stop once enough result traces match. Then they aggregate only those selected traces.
- Duration filters keep the exact span-aggregation path, because they are trace-level predicates.

### Search SQL strategy

The search ranks traces by their newest index row (`ORDER BY Start DESC LIMIT 1 BY TraceId` over the window). It walks the index newest-first in bounded `Start` slices through `prj_start`, with keyset pagination. Each page continues at the last returned `Start` and drops the traces that it already saw. The OTel materialized view writes one index row for each insert batch. For this reason, a trace can reappear through an older row. A re-sort of the whole window with `OFFSET` for each page read ~25M index rows for each page on a 7-day window. Now a page costs roughly the rows that it returns. The first slice covers one minute. It widens ×4 whenever a slice runs dry. For this reason, sparse windows and data gaps take few queries.

Filtered searches test pages that start at 1,000 traces. When matches are rare, the page grows (up to 32,000) from the observed match rate. The traces that the search tests, and their order, are unchanged. The search tests at most the newest 64,000 traces. Then the span fallback below answers. The span match of each page reads only the index time bounds of the page. These are `min(Start)`/`max(End)` of the traces of the page, ±1 s like trace detail. The match does not probe every part of the window. Every span `Timestamp` lies inside the `[Start, End]` row of its insert batch.

Span-based ranking is used for duration filters, for a missing trace index, and for the cap of 64,000 traces. It first selects the result TraceIds with only `min`/`max` aggregates. Then it computes the full summary for those traces only. On windows longer than 80 minutes, the ranking scans the newest 1/16 of the window first:

- A trace whose first visible window span is inside that slice has all of its window spans in it. Its start, duration and filter match are exact.
- Traces with visible spans before the slice rank below all of those. The ranking removes them after an IN-list probe of the older part of the window.
- When the slice does not yield enough exact traces, it widens from the observed density. It ends with the plain whole-window query. For this reason, the result is always identical to one whole-window aggregation.

Broad service/operation filters match at least a quarter of the index rows of the window. The search probes this with a bounded `LIMIT`. It evaluates such filters as `HAVING countIf(filter) > 0`. It does not use an `IN` set of most traces. Status and tag filters always use the candidate `IN` set.

The result summary reads only the time range of the selected traces. It uses the exact span bounds for span-ranked traces, and the index bounds for index-selected traces. It aggregates the span and error counts of each service with `sumMap`. For this reason, the state and the payload of each trace are O(services). They are not one entry for each span. The backend caches for 60 s for each source whether the attribute columns are `Map` types (tag filters need this). It does not query `system.columns` on every tagged search. `/api/traces/meta` always reads it fresh.

Search results and global analytics are separate on purpose:

- `/api/traces/search` returns only the bounded result list. It never runs the aggregation for matching traces or duration percentiles.
- `/api/traces/analytics` computes the two graphs independently. It starts only after the browser has rendered the search results.
- Trace analytics are disabled by default. Set `traces.analytics = true` to show the graphs and to enable the analytics query.
- Both graphs are computed from the spans themselves (`max(Timestamp + Duration) - min(Timestamp)` for each trace). Broad service/operation filters use the same `HAVING countIf` form as search.
- The analytics do not use the trace index for durations, on purpose. The `trace_id_ts` materialized view of the OTel exporter stores `End = max(Timestamp)`, which is the start of the last span. It stores one row for each insert batch. For this reason, durations that come from the index are shorter than the real trace durations.

The service/operation prefill is an existence query. It uses `LIMIT 1 BY`. It does not count every matching span. It skips the granules of the pairs that it already knows (see "Service/operation prefill cache" below). The old unbounded tag discovery stays removed. The capped facet queries below discover the attribute keys and values.

The service/operation prefill is automatic. A change of the selected time range refreshes the discovered combinations. There is no manual Prefill button. Tag filters use exact equality only. There is no LIKE/ILIKE matching.

## Search filters

Every filter describes one span. A trace is listed when at least one of its visible spans matches all the filters (the semantics of Jaeger). `/api/traces/search`, `/api/traces/analytics`, `/api/traces/service_map`, `/api/traces/prefill` and the facet endpoints accept the same repeated parameters:

| Parameter | Meaning |
| --- | --- |
| `service`, `operation`, `status` | column equals (repeated: any of the values) |
| `service_not`, `operation_not`, `status_not` | column differs from every value |
| `tag=[scope:]key=value` | attribute equals |
| `tag_not=[scope:]key=value` | attribute absent or different |
| `tag_exists=[scope:]key`, `tag_missing=[scope:]key` | attribute key present / absent |

`scope` is `span:` (`SpanAttributes`), `resource:` (`ResourceAttributes`) or omitted (either map). The value is everything after the first `=`. These rules apply to the filters:

- Different keys are ANDed.
- Several `tag` values of one key match any of them. One attribute holds one value, so an AND would never match.
- Several `tag_not` values exclude all of them.
- The backend accepts at most 32 attribute filters, keys up to 512 bytes, and values up to 4096 bytes.
- The backend still accepts the older form `tag_scope` + `tag_key` + `tag_value` as one `tag`.

The backend builds the SQL on the server. Values reach it only through string quoting. The forms are `(mapContains(C, 'k') AND C['k'] IN ('v1', 'v2'))`, `NOT (...)` and `mapContains(C, 'k')`. An unscoped key gets one term for each usable map. These rules apply:

- Tag filters need `Map(String, String)` attribute columns. A JSON column answers `trace_tag_search_unsupported`.
- An attribute scope that `traces.features` hides answers `trace_filter_disabled`. For this reason, nobody can probe a disabled scope through filters.
- `service_allowlist` is ANDed to every query as before.
- Service and operation filters, positive or negated, are primary-key predicates. They can use the broad `HAVING countIf` form.
- Status and tag filters use the candidate `IN` set.
- Search keeps the index-first paths.

On the prefill, only the tag filters apply. For this reason, the service/operation pickers list the pairs that the backend saw with those attributes. A tagged prefill reads the attribute maps of the granules that it does not skip. It stays within the same read bounds as the untagged prefill (below). When a bound stopped it, it answers `estimated: true` with the pairs found so far. The backend caches it like the untagged prefill, for each tag filter set.

In the UI, the Tag / Value inputs have an operator button (`=` / `!=` / `exists` / `missing`). They add a removable chip. The operator of a chip toggles between `=` and `!=`. The trace pages show values in these places:

- The Tags and Process attributes of the span inspector.
- The service, operation and status of the inspector.
- The service and operation of the trace header.
- The service pills of the result list.

A click on such a value opens a menu:

- *Filter for this value*.
- *Exclude this value*.
- *Search only this* (replaces every filter, keeps the range and the limit).
- *Copy*.

When the user applies one of the first three, the page returns to the search page with the filter applied.

### Search state in the URL

The URL of the search page holds the whole search. These are the parameters:

- `from` / `to` (relative expressions such as `now-6h` or absolute times, omitted for the default window).
- `status`, `service`, `operation`.
- The chip parameters above.
- `min_duration_ms` / `max_duration_ms` (the trace duration chip, see the heatmap below).
- `limit`, `sort`, `results=table` and `duration_view=heatmap`.

Each search is a history entry (Back / Forward restore it and run it again). The search at page load keeps its URL. A reload or a shared link opens the same search. The URLs of trace pages (`/observability/traces/<id>?span=…`) carry the same parameters. For this reason, *back to search* returns to the search where the user opened the trace, also from a shared link.

One trace is a page of its own (`trace.html`, started by `app_trace_page.js`). It is not a pane of the Observability page. It has the page header. It has none of the Traces / Logs / Metrics tabs and none of the search. The server answers `/observability/traces/<id>` with it before the Observability catch-all. These rules apply to the navigation:

- The opening of a trace from the results is a page navigation. It can start from a row, a point of the charts, a span, or a Services or Logs link.
- The back arrow returns to the exact search entry where the user opened the trace. The browser restores that page as it was left, or runs the search again from its address. The user can also open a trace by its address or from another page. In this case, the back arrow returns to the search of the context that the address carries.
- Back / Forward inside the trace page (a span picked in a view, a linked trace) stay in its document.
- A trace whose address carries no time range returns to the range that the last Observability page of the tab showed. It widens from that range. This applies to a link from Logs or Metrics, and to a trace that the user opened by its id. The controller writes the range to the `sessionStorage` of the tab (`chdash.observability.context.v1`) when the page is left. The own range of the address wins when it has one.
- A filter that the user picks on a value of the trace (its service, operation, status or an attribute) opens the search page. The filter applies to the carried context.
- *Search a wider time range* on a missing trace opens the search over twice its range.

The right-click row menu of a Query (or Explorer) result offers *Open trace* and *Copy trace link*. It offers them when a cell of the row holds a trace id. A cell holds a trace id when it meets these conditions:

- Its raw value, trimmed, is exactly 32 hex digits (W3C trace-context).
- The value is not all zeros.
- The cell is in a `String` or `FixedString` column.

An id inside a longer text does not count. The menu lowers upper case. The trace opens in a new tab, so that the results stay. The row can also have a valid span id (16 hex digits, not all zeros) in a column named like `SpanId`, `span_id` or `spanId`. Then the link carries `?span=`, and the trace opens on that span. A row with several trace id columns gets one entry for each column, *Open trace (<column>)*. The entries appear only when the traces feature is enabled.

## Service map

The Traces view has tabs in the tab row above the search bar, after the view tabs. They are *Search* (the result list) and *Service map*. The URL has `?tab=map` next to the search parameters. Other modules add tabs through `ChDash.traceTabs.register`. Every tab shares the time range, the filters and the chips. The Search button runs the search of the selected tab.

`GET /api/traces/service_map` (same parameters as search, plus an optional `sample_factor`) returns the services of the traces that match the filters. A trace is on the map when one of its visible spans matches, as in the result list. The response also returns the calls between the services:

- An **edge** `A -> B` counts the spans of service `B` whose parent span (same `TraceId`) belongs to another service `A`. It gives the error rate and the p50 / p95 / p99 of those child spans. This covers the Client -> Server and Producer -> Consumer instrumentation (HyperDX joins those kinds). It also covers flat traces where the direct children of the root span run in other services. The OTel fixture has no Client span above a Server span, so a join by kind finds nothing there. Calls inside one service are not edges.
- A **node** counts every visible span of the service (spans, errors, p50 / p95 / p99).
- The **kind** of an edge is `async` when most of its child spans are `Consumer` spans or have a `Producer` parent (messaging). Otherwise, it is `sync`.

One query computes both. It uses `GROUPING SETS ((caller, service), (service))` over a `LEFT ANY JOIN` of each span to its parent on `cityHash64(TraceId, ParentSpanId) = cityHash64(TraceId, SpanId)`. The join uses a 64-bit key instead of two strings: 0.45 s instead of 1.3 s on 10 minutes. It uses `ANY` because the exporter can store a span twice. The query uses `max_execution_time = 30` and `service_allowlist` on both sides. Two budgets bound the cost:

- **rows read**: `EXPLAIN ESTIMATE` (primary index only) gives the spans of the window. Above 12 M spans, the query reads only evenly spaced time slices of about 3 minutes (at most 48) that hold about 12 M spans. Trace sampling alone does not bound this cost, because the query must still read and hash every `TraceId`. The peak hour of the fixture took 2.8 s with 1 trace in 10.
- **join size**: the query keeps whole traces with `cityHash64(TraceId) % N = 0` (the sampling of HyperDX), `N = ceil(spans read / 3 M)`.

The counts are scaled by `N / time coverage`. The answer reports these items:

- `sampled`.
- `sample_factor` (the scale).
- `sampling` (`trace_factor`, `time_coverage`, `slices`, `estimated_spans`).
- `sampled_count` for each node and edge.

Error rates and durations come from the sampled spans. An edge whose parent span started before the start of a slice is not counted (children usually start milliseconds after their parent). These are the measures on the fixture with about 2 B spans:

- 10 minutes: 0.26–0.59 s (N = 2).
- 1 hour: 0.30–0.64 s (7 slices, N = 4).
- 24 hours: 0.39–0.77 s (13 slices).
- 7 days: 0.37–0.84 s (20 slices).

The shared canvas graph kit (`app_graph_kit.js`) draws the map, like the Explorer graph. They share the same dot grid, cards, orthogonal edges, labels, toolbar, legend, status line, minimap, side panel and keyboard. They also share the same Fit and level of detail (see [Explorer, Graph rendering](explorer.md#graph-rendering)). These rules apply to the map:

- The map opens whole when it is readable as a whole. Otherwise, it opens at the readable scale on the selected service (or the entry point, the first service that nobody calls), with the minimap. Compact cards shrink to their title row.
- It is a layered left-to-right graph (`kit.layered`). A DFS breaks cycles for the columns. The order is barycentre ordering. One global row grid keeps the orthogonal routes straight. A call against the column order is routed from the left side of the callee back into the right side of the caller.
- Each service is a card with its name, `spans · error %` and `p95`. The card has a left strip in its Traces color (the color of the result list). It has a health dot from 0.1 % errors (a red border from 5 %).
- Edges are solid for synchronous calls, dashed for asynchronous messages and dotted for database / cache calls (`kind: "db"`, when a source provides it). They are grey, amber from 1 % and red from 5 % errors. They are slightly thicker with their calls. Every edge carries a `calls · p95` label.
- A hover outlines a service and its calls.
- A click recentres on the service and opens the side panel. The panel has these items:
  - The metrics.
  - The busiest callers / callees.
  - *Search this service* / *Search errors* (the Search tab with that service, and status Error).
  - *Focus map* (the service filter on the map).
- *Search calls A → B* of an edge searches the callee `B`.
- Wheel / drag / the `−` / fit / `+` tools and the `+` / `-` / `0` keys zoom and pan. Arrows move between services. Enter selects. Escape closes the panel.
- The status line counts services and calls, with a `sampled ×N` badge that explains the estimate.
- On phones (≤ 720 px), the map opens on the entry point and the services that it calls at 0.7 or more. The panel is a bottom sheet.

Dense maps are bounded. Consider a map where most services call most others (the newest hour of a fresh stack: 12 services, 132 call paths, every ordered pair). The layered layout is one row of columns, and every route detours around cards. The router took about 45 s of main thread for each render. The map now gives the A* searches of the router a budget of 160 k steps (`kit.routeEdges` `maxSteps` / `searchSteps`). Past the budget, the remaining calls get the cheap routes of the kit. A cheap route is the best clear one of a few H-V-H lanes and channels between or around card rows, scored like A* steps.

The layout is a generator that runs in slices of 40 ms of the main thread (`kit.runSliced`). For this reason, no task is long. The map keeps its positions and routes while the services and calls stay the same. This is also true for a new search of the same topology, and for the arrival of the web font. In Node, 12 / 132 lays out in about 90 ms instead of 41 s. 40 services / 600 call paths lay out in about 0.45 s instead of 14 minutes. Smaller maps (the 8-service and 120-service graphs of the spec) keep exactly the routes that they had. `inspect()` reports `layoutTiming` and `routeStats`.

Owning lanes made each A* step dearer. A near run is scored against the lines within `LANE_GAP` (12 px port spacing). For this reason, the same 160 k steps took 125–145 ms in the browser on 12 / 132. On a loaded host, they took more than the budget of 200 ms. The steps are cheaper again, with the same routes and labels to the last bit:

- The segment index answers each A* grid row and column from what it keeps of that line. It keeps the parallel segments by start, and the crossing ones by position. For this reason, the crossings of a step are one binary search.
- The conflict terms are added without a result object for each segment. They are sorted only when one is not a whole number.
- A link's conflict is not scored when the link could not improve its state even without it.
- The queue uses typed arrays.
- Cheap routes keep their hundreds of candidates as numbers and take the best few from a heap. The scoring of a candidate stops once it cannot win.
- Labels try their anchors one at a time against rectangles hashed by number.

These are the medians of 11 runs on the development host (Chromium, load about 3). 12 / 132 takes about 60 ms instead of 125 ms. 40 / 600 takes about 170 ms instead of 450 ms. No task is over 60 ms.

## Attribute facets

The sidebar of the search page follows the search filters of HyperDX. It lists the attribute keys of the spans that match the current range and filters. The keys are span (`S`) keys and resource (`R`) keys. They are ordered by the number of sampled spans that carry them. The sidebar has these functions:

- A key expands to its top values with counts.
- The checkbox of a value adds or removes a `tag` chip. Its exclude button adds a `tag_not` chip.
- The user can pin keys to the top (stored in the browser), filter them by name and load them 20 at a time. Values load 10, then 50, 200 and 500.
- The sidebar folds into a rail (remembered; folded by default below 1100 px). It loads nothing while it is folded.

The sidebar is the facets component (`app_facet_panel.js`, `ns.facetPanel`). The Logs **Fields** panel uses it too (`docs/logs.md`). The caps below (`src/facet_limits.hpp`) bound both.

`/api/traces/facets` returns the keys in one pass that reads only the key subcolumns of the maps:

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

`/api/traces/facet_values?scope=span|resource&key=…&limit=…` counts the values of one key in the same way. It uses a `GROUP BY` over `C['key']` of the sampled spans that have the key. It uses `sum(c) OVER ()` / `count() OVER ()` for the totals, and `max_rows_to_group_by = 100000, group_by_overflow_mode = 'any'`. The values query of a key leaves out the own filters of that key. In this way, its other values stay listed and the user can add them.

The caps bound every facet query:

- At most 3 M sampled spans.
- At most 50 M rows read from storage. A selective filter would otherwise scan the whole window to look for enough spans. The read cap stops like an exhausted source. For this reason, the aggregate still answers from what it read.
- At most 100 k distinct values grouped.
- A time budget of 5 s, as the last resort.

The answer says `estimated: true` when a bound actually stopped the scan. A bound can be one of these:

- The sample limit (the sampled spans reach 3 M).
- The read cap (the rows read reach it: `max_rows_to_read` with `read_overflow_mode = 'break'` stops the sources there).
- The time budget.
- The group-by cap for values.

The counts are then sample counts, and the UI prefixes them with `≈`. The `total_rows_to_read` of the progress packets is no signal. ClickHouse announces it before the attribute bloom indexes skip granules. For this reason, a selective tag read that completes reads far fewer rows than announced (85 k of 456 k on a rich hour). `read_rows_limit=<n>` lowers the read cap of one request (it never raises it). The answer reports the cap that it used. The backend caches the answers for 60 s for each host, minute-aligned range and filter set, like the prefill. Keys and values need `Map` attribute columns. A scope that `traces.features` disables is left out of the keys and rejected for values.

The measures used the local fixture (about 2.0 B spans over 7 days, 11 to 18 M spans for each hour, cold cache). They are medians of three requests through the API.

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

The *Trace duration* card has two modes. They follow the search heatmap and the event deltas of HyperDX. The modes are *Percentiles* (P50 / P90 / P95 / P99 plus the listed traces) and *Heatmap*. The browser remembers the choice. The search URL keeps it as `duration_view=heatmap`. The heatmap shows exactly the traces of the percentiles. These are the traces with at least one matching visible span. Each trace is at its first span start (x, the time buckets of the analytics, which start at the local midnight). It has its span-bounds duration (y, log scale). The color of a cell is its number of traces (8 sequential steps on a log scale). While the heatmap is shown, the page skips the percentiles request.

The user can drag a box over the heatmap. With the chart focused, the keyboard also works: arrow keys move, Shift + arrow keys extend, Enter compares, Escape clears. The drag opens the comparison panel below the charts. The panel shows the attributes that set the traces of the box apart. It shows paired bars for each value. The orange bar is the share of the traces of the box that have a span with the value. The gray bar is the same share for the baseline traces. The baseline is the other traces of the time range of the box (default) or all traces of that time range. These actions work in the panel:

- A click on a value adds it as a filter chip. Its exclude button adds a `!=` chip. `ServiceName`, `SpanName` and `StatusCode` become the service / operation / status filters.
- *Search traces in this box* searches the time range of the box with a trace duration filter. The filter is a removable `duration` chip, with `min_duration_ms` / `max_duration_ms` in the URL.

`GET /api/traces/heatmap` takes the analytics parameters (window, filters, `min_duration_ms` / `max_duration_ms`, `bucket_origin_ms`, `align_buckets`) plus `rows` (8–80, default 40). One pass counts the traces into fixed log2 bins, 32 per octave, for each time bucket. The server then takes the bin that holds the 1 % quantile as the lowest row, and the slowest bin as the top. It merges the fine bins into at most `rows` rows. The row edges (`y_edges_ns`) lie on fine-bin edges, so every count is exact. Traces faster than the lowest edge are counted in the lowest row (`below_min_count`). A separate `quantile(0.01)` / `max` pass would read the same spans a second time. The aggregation for each trace is the whole cost.

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

`GET /api/traces/deltas` takes the same parameters plus the box:

- `t0` / `t1` (trace start, epoch ms).
- `d0` / `d1` (trace duration, ms).
- `baseline=outside|all`.
- `sample` (traces per side, 100–2500, default 1000).

The query aggregates the time range of the box for each trace, like the heatmap. A box wider than 30 minutes is sampled as 6 evenly spread slices of 5 minutes. For this reason, the cost does not grow with the box. The query reads each slice with a margin of `clamp(2 × d1, 1 s, 5 min)` on both sides. In this way, it aggregates a box trace (no longer than `d1`) whole. The traces in the duration range form the selection. The others form the baseline. Each side is ordered by `cityHash64(TraceId)` (stable samples):

```sql
SELECT TraceId, in_box, count() OVER (PARTITION BY in_box) FROM (
  SELECT TraceId, duration_ns >= <d0> AND duration_ns <= <d1> AS in_box FROM (
    SELECT TraceId, min(Timestamp) AS trace_start, <duration> AS duration_ns FROM otel.otel_traces
    PREWHERE (<slice 1 + margins> OR …) WHERE <allowlist> [AND TraceId IN candidate_ids]
    GROUP BY TraceId HAVING (<trace_start in slice 1> OR …) [AND <duration filters>]))
ORDER BY in_box DESC, cityHash64(TraceId) LIMIT <sample> BY in_box
```

A second query expands only the spans of the sampled traces. It works in these steps:

- It uses `arrayJoin` over `ServiceName`, `SpanName`, `StatusCode` and the span / resource attribute maps. The values have at most 1 KiB. A scope that `traces.features` disables, or that is not stored as a `Map`, is left out.
- For each (scope, key, value), it counts the sampled traces of each side that have a span with it (`uniqExactIf(TraceId, side)`). For each key, it keeps the 40 values with the largest shares.

The server then ranks the keys like `eventDeltas.ts` of HyperDX:

- Keys that the query saw fewer than 5 times are hidden (`hidden_keys`).
- Identifier and timestamp keys are hidden. These are `…_id`, `uuid`, `timestamp`…, or keys with mostly hex values or long numeric values.
- High-cardinality keys are hidden. These are keys with more than 90 % unique values on both sides and more than 20 occurrences.
- The score of a key is the largest gap between the selection share and the baseline share of one of its values. It gets plus 2 points for OpenTelemetry semantic-convention keys (`http.route`, `db.system`, `service.version`…) and for the three columns.

The answer holds the top 20 keys with their 6 most different values. It contains `selection_pct` / `baseline_pct` (the share of the sampled traces of the side), the counts, and the sample and trace totals of both sides. With `baseline=all`, the baseline shares weigh both samples by the traces that they stand for. Both queries run with `max_execution_time = 30`.

The measures used the local fixture (about 2.0 B spans, 7 days). They went through the API on the shared test ClickHouse (other suites running). They are medians of three requests.

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

The Services tab sits between *Search* and *Service map* in the one tab registry of `app_trace_tabs.js`. The call is `register({ id, label, order, panelId, install, onSearch, onShow, onHide, available, params, writeParams, applyParams })`. `available(meta)` hides a tab that /api/traces/meta does not enable. `params` lists the view-only URL parameters of a tab. The search key leaves them out. The selected tab is in the URL (`?tab=services`) next to the search parameters. Every tab shares the search bar. The time range, the status / service / operation pickers and the filter chips apply to the Services view as well. The view needs `traces.analytics = true`, because it is a span aggregation like the analytics charts.

The view follows the services dashboard of HyperDX. It shows RED metrics of the **entry spans** of each service: `SpanKind IN ('Server', 'Consumer', 'SPAN_KIND_SERVER', 'SPAN_KIND_CONSUMER') OR ParentSpanId = ''`. The OTel exporter writes `Server` / `Consumer`. The fixture has `Server` roots and `Consumer` children. *Root spans* (`ParentSpanId = ''`) is the cheaper alternative (`svc_scope=root`). The search filters describe these spans themselves. `min_duration_ms` / `max_duration_ms` bound the own `Duration` of the span.

- The table lists these items for each service:
  - The rate (entry spans per second).
  - The error share (`StatusCode = 'Error'`).
  - P50 / P95 / P99 of `Duration`.
  - The share of the total time (`sum(Duration)`).
  - Sparklines of the rate (errors in red) and of the P95.

  Every column sorts (`svc_sort=<column>:<asc|desc>`, default total time descending).
- A row opens the service drawer (`svc=<name>`, Back / Forward and Escape close it). The drawer shows these items:
  - Charts of the request rate, the error rate and the P50 / P95 / P99 latency, with release markers.
  - The releases list.
  - The most time-consuming endpoints (service + `SpanName`, by `sum(Duration)`).
  - The slowest spans (they open their trace).
  - The database statements.
- An endpoint opens the Search tab with its service and operation. A P99 value (table, drawer, endpoints) searches that service (and operation) with the duration chip set to `≥ P99`. The chip is `min_duration_ms`, the same chip as in the heatmap. In Search, it is a trace duration filter. In Services, it is a bound on the own `Duration` of the entry span.
- Estimated answers carry a `≈ Estimated from N% of the window` badge and a *Compute exactly* button (`svc_exact=1`). An answer that the time budget stopped says *Partial*.

`GET /api/traces/services` takes the search filters, `bucket_origin_ms` / `align_buckets` (the count grid of the analytics: ~60 buckets for each range), `scope=entry|root`, `exact=1` and `detail=<service>`. One scan groups t-digest states by service, bucket and endpoint. The outer `GROUPING SETS` merge them into service totals, service buckets and endpoint totals:

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

The primary key `(ServiceName, SpanName, toDateTime(Timestamp))` makes a drill-down read only the granules of that service. Before the scan, `EXPLAIN ESTIMATE` (index only, a few ms) sizes the window. Above 150 M rows, the query samples the window **by time**. It uses one slice for each chart bucket, at a stable golden-ratio offset inside the bucket. The slices are sized to read about 50 M rows (at least 1 min). The query scales the counts back by the sampled share (for each bucket for the series, for each window for the totals). The percentiles come from the sampled spans. `exact=1` reads the whole window (still bounded by the budget of 25 s, then `partial: true`).

The drill-down adds two items:

- The 20 slowest entry spans of the same (sampled) window (`ORDER BY Duration DESC LIMIT 20`).
- The releases, after the release annotations of HyperDX. This is the first `Timestamp` of each `ResourceAttributes['service.version']` of the service in the whole window. The query reads it with the bloom filter key index and the facet caps (200 M rows read, `estimated` when stopped).

`GET /api/traces/services/db` (the database tab of HyperDX) groups spans of any kind that carry `db.query.text` or `db.statement`. The groups are `coalesce(nullif(SpanAttributes['db.query.text'], ''), SpanAttributes['db.statement'])` and service. Each group has the count, the errors, `sum(Duration)`, P95 and `db.system.name` / `db.system`. The route returns the 50 most time-consuming statements. It uses the caps in the style of the facets (200 M rows read, 100 k groups, 5 s; `estimated` when a cap stopped it). It needs a `Map` span attribute column (`supported: false` otherwise). The local fixture has neither database attributes nor `service.version`. For this reason, both are empty there (the UI tests mock them).

The measures went through the API on the local fixture. The fixture has about 2.0 B spans over 7 days. The densest day has 565 M spans, and the measured hour has 23 M spans. The measures are medians of three. Other test runs shared ClickHouse, with a load average of ~35.

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

On the densest day, the sampled span counts were within 1.5 % of the exact ones (the backend tests allow 15 % on the week).

## Spans mode

The *Traces | Spans* toggle of the search page (`mode=spans` in the URL) lists matching **spans** instead of traces. It follows the row search of HyperDX. The range, filters, chips and facets are the same, but they apply to each span: every listed span matches all of them. Spans mode adds a span kind picker (`kind`) and a span duration range (`span_min_duration_ms` / `span_max_duration_ms` in the URL). `min_duration_ms` / `max_duration_ms` stay trace durations there.

The table is virtualised (only the rows in view are rendered). It loads the next page by cursor when its end scrolls into view. The columns are:

- Time (local, with the exact UTC nanoseconds on hover).
- Service (with its color).
- Operation.
- Duration, with a bar relative to the longest listed span.
- Status.
- Kind.
- Attribute columns that the user chooses in the *Columns* picker (`span:key`, `resource:key` or `key` for either map; the browser keeps them).

Service, operation, status and attribute values open the click-to-filter menu. A row (or Enter) opens the span side panel. The panel shows these items:

- The identity.
- The status message.
- The exceptions.
- The Tags / Process attributes with filter actions.
- The events and links.
- *Open in trace* (`/observability/traces/<id>?span=<span id>` with the search context, so that Back returns to the same rows, selection and panel).

Up / Down move through the rows (also with the panel open). Escape closes the panel.

`GET /api/traces/spans` takes these parameters:

- The search filters (`start_ms` / `end_ms` or `lookback_minutes`, `service`, `operation`, `status`, the `*_not` and `tag*` parameters).
- `kind` (repeatable).
- `min_duration_ms` / `max_duration_ms` (the own `Duration` of the span).
- `limit` (default 100, at most 500).
- `columns=span:http.route,resource:host.name` (at most 20).
- `cursor`.

The rows are newest first. Each row has these fields:

- `timestamp`.
- `start_ns` (exact nanoseconds as text).
- `trace_id`, `span_id`.
- `parent_span_id` (empty with a restricted service allowlist, as in trace detail).
- `service_name`, `span_name`, `span_kind`.
- `duration_ns`, `status_code`, `status_message`.
- `attributes` (one value or `null` for each requested column).

The paging is a keyset on `(Timestamp, SpanId, TraceId)`. It never uses `OFFSET`. `(TraceId, SpanId)` is not unique (a span that is exported again has two timestamps). For this reason, the key starts with the timestamp. All exact copies of the last key of the page stay on that page. A page reads newest-first time slices of 15 min, 1 h, 6 h, then 24 h until it holds `limit` spans. A top-N over a slice costs about the rows that the slice holds. For this reason, a dense range answers from its first slice:

```sql
SELECT <span columns>, <attribute columns> FROM otel.otel_traces
PREWHERE Timestamp >= <slice start> AND Timestamp <= <slice end or cursor time>
     AND <allowlist> AND <service / operation (primary key), status, kind, duration>
WHERE 1 [AND (Timestamp, SpanId, TraceId) < cursor] <attribute filters>
ORDER BY Timestamp DESC, SpanId DESC, TraceId DESC LIMIT <remaining + 1>
SETTINGS max_execution_time = 20, timeout_overflow_mode = 'throw',
         max_rows_to_read = 1000000000, read_overflow_mode = 'throw'
```

The backend sizes each next slice from the cost rate that it saw so far. In this way, the page stays within a budget of 2 s. When the budget is spent, the page ends early. The response then has `incomplete: true`, `stop_reason: "time_budget"`, `searched_to_ns` and a cursor at the slice boundary. The next request resumes exactly there. The cursor also carries the slice width that the next page starts with. A slice guard (time or rows) after answered slices is also a resume point. On the first slice of a page, the backend retries it once, eight times narrower. The table continues budget-stopped empty pages on its own three times. Then it offers *Keep searching*.

`GET /api/traces/span?trace_id=…&span_id=…&timestamp_ns=…` returns one span with its attributes, events and links by its row key. The exact timestamp bounds the read to a few granules.

The measures used the local fixture (about 2.0 B spans over 7 days). They are server times, and medians of five requests:

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

The views of a trace are a tab row above the waterfall: *Timeline | Graph | Statistics | Spans | Flamegraph*. The row uses the in-content tab component (`app_ui_tabs.js`, with the look of the Logs *Results | Patterns* tabs). Arrow keys, Home and End move between the tabs. The view is the `?tab=` of the URL (omitted for the timeline; the former `?view=` is an alias, which the page rewrites on load). The page remembers the last view. Below 820 px, a *View* dropdown replaces the tabs.

The *Graph* view draws one card for each call path with the graph kit. The card shows these items: service, operation, `count / errors · avg`, and `time (% of the trace) · self`. The view opens like the service map, on the root call path (or the selected one). A compact card reads `service · operation` and the time of the path. It never shows the service alone.

The detail page derives these items once for each loaded trace: the span tree, the trace bounds, the counts for each service, the overview bars ordered by start, and the parsed event markers. These rules apply to updates:

- The opening or closing of a span inspector, and the folding or unfolding of a branch, patch only the affected rows.
- Service filters and range changes render the waterfall again from the cached data.
- The waterfall controls use delegated listeners on the persistent container.
- The query-analysis trace viewer mounts rows lazily. It builds only the rows that are visible under the initial fold. A branch mounts its children the first time that it is expanded.

## Direct TraceId URLs

A trace can be opened directly at:

```text
/observability/traces/<trace-id>
```

`max_lookback_minutes` does not limit a direct TraceId lookup. ChDash requires `trace_index_table` to resolve the timestamp window (one index pass yields both bounds). It then reads `otel_traces` only inside that bounded window. There is no TraceId fallback over all history. If the auxiliary table is unavailable or its lookup fails, the API returns an error. It does not scan `otel_traces`.

## Synthetic demo traces

`examples/generate_otel_traces.py` creates domain-neutral fixture data. The data stress the viewer with the complexity of a realistic distributed system. They are not tiny toy traces. The defaults are 10,000 traces with 60–90 spans each. The spans cover these items:

- HTTP ingress.
- Authentication.
- Kafka producers and consumers.
- Processing and enrichment workers.
- Cache calls.
- ClickHouse writes.
- Notification delivery.
- Nested and parallel branches.
- Events, links and occasional errors.

```bash
python3 examples/generate_otel_traces.py \
  --traces 100 \
  --seed 20260918 \
  --output-dir /tmp/chdash-otel
```

The repository test stack needs no manual import. The normal `docker compose up -d --build` starts ClickHouse and ChDash. It does not start the heavy OTEL fixture on purpose. Enable it explicitly with `docker compose --profile otel up -d --build otel_fixture` (or use the `test` profile for the full test stack). The initialization of ClickHouse creates the OTEL tables and the local projection indexes before the fixture data is inserted. `OTEL_FIXTURE_FORCE=1` truncates the existing tables and fills them again. It does not drop their projection definitions.

The generated services include `test_ingest`, `test_worker` and `test_enrichment`. For this reason, you can test this access-control case immediately:

```hcl
service_allowlist = ["test_*"]
```

### Rich fixture day (2026-09-12)

The bulk test fixture is flat (one level of spans, two attributes, no links or events). Next to it, `tests/otel-fixture/rich_fixture.py` (`OTEL_FIXTURE_RICH=1`, on in the test compose file) loads a deterministic e-commerce workload. The workload is on **2026-09-12 UTC** only. The bulk fixture never uses this day. The workload has these properties:

- About 40,700 traces and about 545 k spans through `api-gateway`, `frontend`, `checkout`, `payments`, `inventory`, `auth`, `search`, `recommendation` and `notification`.
- HTTP client/server pairs, gRPC, PostgreSQL / Redis / ClickHouse and Kafka spans (semantic-convention attributes).
- Producer → consumer links across traces.
- Errors deep in branches, with `exception` events in Java, Python, Go, JavaScript and .NET formats.
- `cache.miss` / `retry` events.
- Orphan spans.
- Batch traces of 2 k to 12 k spans.
- `service.version` releases at known times.
- Hosts and pods.
- A slow cohort (14:00–16:00, `feature.flag=new_pricing`) for the heatmap comparison.
- Correlated logs and metrics (exemplars that point at these spans).

Its index rows follow the view of the exporter: one row for each export batch of 5 s, `End` = the newest span *start* of the batch. `tests/README.md` ("Rich OTel dataset") describes the shape, the knobs and the idempotency. `tests/backend-functional/test_rich_fixture.py` checks these items on it: trace detail, search filters and orphans, linked-from, context presets, the service map, facets, the heatmap and deltas, trace logs and metrics exemplars.

### Service/operation prefill cache

`/api/traces/prefill` lists the (service, operation) pairs of the window (existence only, `LIMIT 1 BY ServiceName, SpanName`) without a read of every span. The sorting key of the table starts with `(ServiceName, SpanName)`. For this reason, a scan with `(ServiceName, SpanName) NOT IN (<known pairs>)` skips, through the primary index, every granule that holds only known pairs. It reads just the granules where a pair changes, and the granules of unknown pairs. The prefill works in two steps:

1. A seed scan of the newest 5 minutes of the window. Its pairs are usually most of the pairs of the window.
2. Scans of the whole window that exclude the known pairs. Each scan stops after 20 M rows read. The scans continue until one runs to its end (at most 8 scans, 100 M rows in all, a time budget of 5 s each).

A scan that ran to its end read everything that it did not exclude. For this reason, the list is exact. A bound can stop the last scan. A stopped scan can also find nothing new. In both cases, the answer is `estimated: true` and the list is a subset. The search page then no longer rules out a service / operation combination. `scan` reports the passes and the rows read. `read_rows_limit=<n>` lowers the bounds of one request.

These are the measures on the fixture with ~2 B spans (an hour that ends 2026-09-19 12:00 UTC, its day and its week). They show the same pairs before and now:

- Rows read: 11.5 M / 502 M / 1.79 B before, 1.4 M / 2.0 M / 3.8 M now.
- CPU-s: 0.19 / 5.8 / 20.8 before, 0.07 / 0.14 / 0.34 now.
- Query time: 18 / 378 / 1314 ms before, about 50 / 50 / 70 ms now.

The browser requests the prefill on every time-range change and page load. For this reason, the server answers from a cache of 60 s. The key of the cache is the minute-aligned superset of the requested range. Requests in the same minute share one scan. The picker lists can include pairs that the backend saw up to one minute outside the exact range.

### Trace index assumptions

Index-driven search pages walk `otel_traces_trace_id_ts` newest-first in disjoint `Start` slices. The search reads these slices completely (one row for each trace for each slice). For this reason, equal `Start` values never straddle a page. A trace with many index rows (one for each exporter insert batch) costs one row for each slice. `Start`/`End` can be `DateTime` or `DateTime64`.

Like trace detail, the search summaries and the span matching of each page bound the span timestamps. They use the index rows of the trace (`[min(Start) - 1 s, max(End) + 1 s]`). This assumes that every insert batch has its index row. The materialized view of the exporter guarantees this for data that the user inserted after the view exists. Backfill the index (or keep equal TTLs) if older spans predate it.
