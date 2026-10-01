# Trace Explorer

ChDash can read OpenTelemetry traces stored by the OpenTelemetry Collector contrib ClickHouse exporter. The viewer follows the ClickHouse host selected in the UI and uses that host's `system_uri`.

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

Service/operation prefill is an existence query: it uses `LIMIT 1 BY` rather than counting every matching span. The old unbounded tag discovery stays removed; attribute keys and values are discovered by the capped facet queries below.

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

On the prefill only the tag filters apply, so the service/operation pickers list the pairs seen with those attributes; a tagged prefill reads the attribute maps and stops after 100 M rows read (`max_rows_to_read` with `read_overflow_mode = 'break'`), answering `estimated: true` with the pairs found so far. It is cached like the untagged prefill, per tag filter set.

In the UI the Tag / Value inputs (with an `=` / `!=` / `exists` / `missing` operator button) add a removable chip; a chip's operator toggles between `=` and `!=`. Values shown by the trace pages (span inspector Tags and Process attributes, the inspector's service, operation and status, the trace header's service and operation, the result list's service pills) open a menu: *Filter for this value*, *Exclude this value*, *Search only this* (replaces every filter, keeps the range and limit) and *Copy*. Applying one returns to the search page with the filter applied.

### Search state in the URL

The search page URL holds the whole search: `from` / `to` (relative expressions such as `now-6h` or absolute times, omitted for the default window), `status`, `service`, `operation`, the chip parameters above, `limit`, `sort` and `results=table`. Each search is a history entry (Back / Forward restore and re-run it), the page-load search keeps its URL, and a reload or a shared link opens the same search. Trace detail URLs (`/traces/<id>?span=…`) carry the same parameters, so *back to search* returns to the search the trace was opened from, also from a shared link.

## Service map

The Traces page has tabs above the search bar: *Search* (the result list) and *Service map* (`?tab=map` in the URL, next to the search parameters; other modules add tabs through `ChDash.traceTabs.register`). Every tab shares the time range, the filters and the chips; the Search button runs the selected tab's search.

`GET /api/traces/service_map` (same parameters as search, plus an optional `sample_factor`) returns the services of the traces matching the filters (a trace is on the map when one of its visible spans matches, as in the result list) and the calls between them:

- an **edge** `A -> B` counts the spans of service `B` whose parent span (same `TraceId`) belongs to another service `A`, with the error rate and the p50 / p95 / p99 of those child spans. That covers Client -> Server and Producer -> Consumer instrumentation (HyperDX joins those kinds) as well as flat traces whose root span's direct children run in other services (the OTel fixture has no Client span above a Server span, so a kind-based join finds nothing there). Calls inside one service are not edges;
- a **node** counts every visible span of the service (spans, errors, p50 / p95 / p99).

One query computes both with `GROUPING SETS ((caller, service), (service))` over a `LEFT ANY JOIN` of each span to its parent on `cityHash64(TraceId, ParentSpanId) = cityHash64(TraceId, SpanId)` (a 64-bit key instead of two strings: 0.45 s instead of 1.3 s on 10 minutes; `ANY` because the exporter may store a span twice), `max_execution_time = 30`, `service_allowlist` on both sides. The cost is bounded by two budgets:

- **rows read**: `EXPLAIN ESTIMATE` (primary index only) gives the spans of the window. Above 12 M spans only evenly spaced time slices of about 3 minutes (at most 48) holding about 12 M spans are read. Trace sampling alone does not bound this: every `TraceId` must still be read and hashed (the fixture's peak hour took 2.8 s with 1 trace in 10);
- **join size**: whole traces are kept with `cityHash64(TraceId) % N = 0` (HyperDX's sampling), `N = ceil(spans read / 3 M)`.

Counts are scaled by `N / time coverage`; the answer reports `sampled`, `sample_factor` (the scale), `sampling` (`trace_factor`, `time_coverage`, `slices`, `estimated_spans`) and `sampled_count` per node / edge. Error rates and durations come from the sampled spans. An edge whose parent span started before a slice's start is not counted (children usually start milliseconds after their parent). Measured on the ~2 B span fixture: 10 minutes 0.26–0.59 s (N = 2), 1 hour 0.30–0.64 s (7 slices, N = 4), 24 hours 0.39–0.77 s (13 slices), 7 days 0.37–0.84 s (20 slices).

The map is a layered directed graph (cycles broken for the ranking, barycentre ordering, left-to-right or top-down, whichever fits the view better): nodes take the service colour and grow with their spans, a red ring grows with their error rate (from 0.1 %), edges thicken with their calls and turn amber from 1 % and red from 5 % errors. Hover highlights the neighbours and shows the edge's p95 / calls; a click opens a side panel with the metrics, the busiest callers / callees, *Search this service* / *Search errors* (the Search tab with that service, and status Error) and *Focus map* (the service filter on the map). An edge's *Search calls A → B* searches the callee `B`. Wheel / drag / buttons zoom and pan, *Fit* (or `0`) fits the map; a `sampled ×N` badge explains the estimate.

## Attribute facets

The search page's sidebar (after HyperDX's search filters) lists the attribute keys of the spans matching the current range and filters, span (`S`) and resource (`R`) keys by the number of sampled spans carrying them. A key expands to its top values with counts; a value's checkbox adds or removes a `tag` chip, its exclude button a `tag_not` chip. Keys can be pinned to the top (stored in the browser), filtered by name and loaded 20 at a time; values load 10, then 50, 200 and 500. The sidebar folds into a rail (remembered; folded by default below 1100 px) and loads nothing while folded.

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

The caps bound every facet query: at most 3 M sampled spans, at most 50 M rows read from storage (a selective filter would otherwise scan the whole window looking for enough spans; the read cap stops like an exhausted source, so the aggregate still answers from what was read), at most 100 k distinct values grouped, and a 5 s time budget as the last resort. The answer says `estimated: true` whenever the scan did not read every row it would have read (the progress packets' `read_rows < total_rows_to_read`: the sample limit or the read cap stopped it) or hit the time budget; counts are then sample counts and the UI prefixes them with `≈`. Answers are cached for 60 s per host, minute-aligned range and filter set, like the prefill. Keys and values need `Map` attribute columns; a scope disabled by `traces.features` is left out of the keys and rejected for values.

Measured on the local fixture (about 2.0 B spans over 7 days, 11 to 18 M spans per hour, cold cache): medians of three requests through the API.

| Request | Median | Note |
| --- | --- | --- |
| keys, 1 h | 94 ms | 3 M sampled spans (estimated) |
| keys, 7 days | 123 ms | 3 M sampled spans (estimated) |
| keys, 7 days, one tag filter | 519 ms | the filter reads the span map |
| keys, 7 days, rare filter (tag + service + status) | 423 ms | stopped by the 50 M read cap, 2,274 spans sampled |
| values of a span key, 1 h / 7 days | 37 ms / 70 ms | |
| values of a resource key, 7 days, one tag filter | 860 ms | |
| tagged prefill, 1 h / 7 days | 134 ms / 889 ms | the 7-day scan stops at the 100 M read cap (estimated) |
| search, two tag filters (= and !=), 1 h / 7 days | 76 ms / 288 ms | `trace_index_filtered` |
| analytics counts, two tag filters, 1 h | 343 ms | span aggregation |

## Trace detail rendering

The detail page derives the span tree, trace bounds, per-service counts, start-ordered overview bars and parsed event markers once per loaded trace. Opening or closing a span inspector and folding or unfolding a branch patch only the affected rows; service filters and range changes re-render the waterfall from the cached data. Waterfall controls use delegated listeners on the persistent container. The query-analysis trace viewer mounts rows lazily: only rows visible under the initial fold are built, and a branch mounts its children the first time it is expanded.

## Direct TraceId URLs

A trace can be opened directly at:

```text
/traces/<trace-id>
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

### Service/operation prefill cache

`/api/traces/prefill` scans every span of the window (existence only, `LIMIT 1 BY ServiceName, SpanName`). The browser requests it on every time-range change and page load, so the server answers from a 60 s cache keyed by the minute-aligned superset of the requested range: requests made within the same minute share one scan, and the picker lists may include pairs seen up to one minute outside the exact range.

### Trace index assumptions

Index-driven search pages walk `otel_traces_trace_id_ts` newest-first in disjoint `Start` slices that are read completely (one row per trace per slice), so equal `Start` values never straddle a page and a trace with many index rows (one per exporter insert batch) costs one row per slice. `Start`/`End` may be `DateTime` or `DateTime64`. Like trace detail, search summaries and per-page span matching bound span timestamps by the trace's index rows (`[min(Start) - 1 s, max(End) + 1 s]`): this assumes every insert batch has its index row, which the exporter's materialized view guarantees for data inserted after the view exists. Backfill the index (or keep equal TTLs) if older spans predate it.

