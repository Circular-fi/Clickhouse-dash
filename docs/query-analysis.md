# Query profiling and on-demand analysis

## Execution modes

The primary **Run** action uses `mode=normal`. It keeps the existing native ProfileEvents telemetry that the live dashboard needs. It does not enable processor profiling. It does not call the analysis endpoint.

**Run with profiling** uses `mode=profiling`. It needs no application authentication. It sets these values on the individual `clickhouse::Query` object:

- `log_queries=1`
- `log_profile_events=1`
- `log_processors_profiles=1`
- `log_query_views=1`

The dashboard does not rewrite the SQL text to append `SETTINGS`. It runs a profiled statement once. In multiquery mode, each statement has its own public query ID, its own native query ID and its own settings.

## Query registry

Every run is associated with the bounded `QueryRegistry`. A record contains these items:

- The public query ID.
- The host.
- The native attempt IDs.
- The run mode.
- The terminal status.
- The partial-execution flag.
- The bounded original SQL. The registry retains it for the separately gated replay backend.

There is no subject, no token fingerprint and no check of the ownership for each user.

`POST /api/query/analysis` resolves a completed record by `query_id + host_id`. All callers of the panel share the permissions of the `runner_uri` of that host.

The successful response is ordinary `application/json`. These rules apply to it:

- The response keeps the span-heavy trace data under `trace_compact` as positional JSON. It does not repeat span objects.
- It uses dictionaries for the host, trace and operation strings. It uses local parent indexes. It does not transport real span IDs.
- Temporal data uses a fixed LOD (level of detail) of 3840 pixels (4K width). The dashboard projects the exact span intervals to pixel buckets. It merges the leaf intervals that are not distinguishable at that resolution.
- This LOD does not sample or prune the tree structure itself.

The processor counters and their activity windows use `processors_compact`. It is a separate, versioned and lossless positional representation (`chdash.processors.json.v1`).
The normal response omits the expanded arrays `processors` and `processor_trace_summary`.
Debug requests (`include_original_trace=true`) retain those original arrays for diagnostics. The response also keeps the compact blocks and `trace_spans_original`.

### Compact processor contract

| Field | Meaning |
| --- | --- |
| `strings` | Shared string dictionary, with the empty string at index 0. |
| `row_schema`, `rows` | Positional processor rows: host, initial/native query IDs, processor ID, parent IDs, plan metadata, name and seven counters. All `_ref` fields reference `strings`; parent references are a list of dictionary indexes. |
| `summary_origin_us` | Common origin for summary timestamps. |
| `summary_series_schema`, `summary_series` | One series per exact host/trace/query/parent/operation identity. Each series contains its five dictionary references and flat `windows`. |
| `summary_window_schema` | Repeated `[start_offset_us, finish_offset_us, active_time_us, event_count]` quadruples within each series. |
| `summary_row_count` | Number of summary windows, checked against the decoded series. |

Add the origin to each summary time offset. These values keep the precision of one microsecond and all recorded windows. The 4K temporal LOD of the trace does **not** apply to processor summaries. Processor IDs, parent IDs and plan IDs stay exact decimal strings in the dictionary. Counters and offsets use JSON integers up to `2^53 - 1`. Above that value, they use decimal strings up to UInt64 max. Large integer arithmetic must therefore use an exact integer type before the conversion for visualization.

The browser checks these items:

- The format version.
- The positional schemas.
- The references.
- The integer ranges.
- The order of the windows.
- The collection caps.

A malformed compact block is an explicit analysis error. This is also true when a debug payload contains legacy arrays. Older object payloads stay readable when no compact block is present. The iteration of the summary can restart. It does not retain another expanded array of 65,536 rows.

## Analysis lookup

Analyze is on demand. It does a bounded lookup of the logs that ClickHouse already produced. It never runs the business query again. These are the logs:

- `system.query_log`
- `system.processors_profile_log`, when recorded
- `system.query_views_log`, when recorded

System logs are asynchronous. For this reason, `analysis.log_lookup_timeout_ms` controls a short retry window. `SYSTEM FLUSH LOGS` is a server-wide operation that writes new system-log parts. ChDash avoids it as much as possible:

- `analysis.flush_logs=false` is the default. The dashboard never flushes. When ClickHouse did not yet publish the rows, the response sets `logs_pending` (query_log) or `profiling_logs_pending` (processor rows and OpenTelemetry spans of a profiling run). The browser then polls Analyze again with a bounded backoff (~20 s). It does this until the own flush interval of ClickHouse publishes the rows.
- With `analysis.flush_logs=true`, the dashboard still reads the logs first. It issues a flush only when the needed rows are missing. It issues at most one flush for each lookup and for each log group. Concurrent lookups share the flush. A flush that started after a caller needed the rows covers that caller.
- If that flush fails, the endpoint returns an explicit `analysis_collection_failed` error. It does not render an analysis that looks partial.
- Exports validate the privilege with `CHECK GRANT SYSTEM FLUSH LOGS`. They do not flush up front.
- The dashboard handles a failure to connect to the system context in the same way. It handles a failure to query the core `system.query_log` in the same way.

The technical account is not an authorization source. The backend serializes names from system logs only after this step. It rebuilds or reuses the same runner-scoped `AllowedObjectSet` that Explorer uses. The backend omits hidden databases, tables, views and view targets.

## Analysis UI

The Profiling dialog opens **Pipeline** first. It mounts **Tracing** only when the user selects it. The header and the time ruler stay visible while the rows scroll. The ruler shares the horizontal scrolling with the data.

Above 150 stages, the Pipeline mounts only the visible rows plus six rows of overscan on each side. Sorting and scrolling retain every row of the model. The dashboard does not sample the stages. The drawing of the timeline is limited to the mounted rows. The dashboard reuses the processor decoding, the trace decoding and the Pipeline model when the user switches tabs.

Closing the dialog releases the payload, the caches, the DOM and the resize observers. A response from an older opening cannot replace a newer query. It cannot refill a closed dialog.

Pipeline groups processors by hostname, native query ID and plan step. It separates by type the processors without a plan step (`plan_step=0`). The order from source to sink follows `parent_ids`, scoped to the same host and query. In the analysis API, the IDs of processors, parents, plan steps and plan groups are decimal strings. In this way, the UInt64 identities survive the parsing of JavaScript. Legacy safe integer IDs still work. The dashboard reports large numeric IDs that are already rounded. These IDs cannot form graph links.

### Costs and flow

- **Work Σ** is the sum of `elapsed_us`, the active execution time of the processors.
  - The waits for input and output are separate counters. Do not subtract them from this sum.
  - Parallel processor work can exceed the wall-clock time of the query.
  - The separate work bar and the percentage show the share of each stage in the total recorded processor work. This includes stages with unavailable timing. They do not represent wall-clock positions.
  - If the collection of processors is truncated, the shares describe only the retained processors.
  - The stage order is a segmented control (**Pipeline order** | **Most work**). It can rank the rows by work. It does not change their original pipeline numbers or timestamps.
- **Input wait / Output wait** show the maximum wait that the dashboard observed on one processor.
- **Input / Output** sum the counters on the processors at the entry and at the exit of a stage. This includes parallel lanes. It does not count sequential internal processors twice. The boundary is an approximation in these cases: mixed internal and external ports, missing links, or a truncated processor list. The dashboard shows the approximation explicitly with `≈`. Counters for each port are not available.
- Stages that only wait stay visible. The dashboard does not show all unassigned processors as one fictitious output stage. It shows a table hint only for a source-like stage, and only when the query overview identifies one table.

The counter definitions follow the [ClickHouse processor log documentation](https://clickhouse.com/docs/reference/system-tables/processors_profile_log).

### Measured times and estimated associations

The backend scans the complete OpenTelemetry trace that has a time bound. This scan does not depend on the cap of 10,000 detailed spans. The backend groups each exact processor operation into adaptive temporal buckets before it returns the summary. The browser assembles again the rows from the same processor instance. In this way, it retains the gaps between summary windows that do not overlap. The real gaps between periods of activity within a window are unknown.

The target is about 32K summary rows with a hard cap of 65,536 rows. Small and normal pipelines receive hundreds of temporal buckets for each processor. Very large pipelines give up some temporal resolution to keep the size of the payload bounded.

Each slice still carries these items:

- The first and last activity.
- The summed active time.
- The event count.
- The `query_id`, where the span exposes it.

The query IDs from root spans identify the attempt for the other operations in that trace. Missing traces from an earlier attempt cannot move a later trace to the wrong query. The dashboard can attribute legacy payloads without this mapping only when one query is present.

A processor family that is unique to a stage can use its measured activity slices. The dashboard does not estimate which stage it belongs to. When the same type occurs in several stages, the viewer compares the active-time counters with indexed cost buckets. These rules apply:

- A match must be within 25% with a minimum scale of 100µs.
- Competing stages within 0.05 normalized score are ambiguous.
- These thresholds are UI heuristics. They are not a guarantee of the identity in ClickHouse.
- The viewer marks accepted cost matches with `≈`, an explicit approximate marker.
- Candidates with equal cost or with incompatible cost stay unassigned.
- The viewer never attaches overflow instances arbitrarily to the busiest stage.

A stage marked `Timing unavailable` still has processor counters. But the dashboard cannot assign a processor span to it with confidence. There are two typical cases. The first case is a structural processor with zero work, for example a `Limit` that only waits. The second case is a duplicate processor family. In this case, the OpenTelemetry operation name does not expose the identity of the plan step. The association by counters stays ambiguous.

The default chart is a **work-density histogram over time**. It has a common height and a common color scale across the stages. Each summary window contributes its summed work divided by its duration from first to last. This is the average processor work. It is not CPU utilization, and it can exceed one for concurrent processors. The viewer does not treat the total number of processors in a stage as a capacity of simultaneous lanes.

For the rendering, the viewer spreads the work uniformly only inside its own summary window. It projects the work into at most 192 display cells for each row. This is an estimate at the reported summary resolution. It is not a reconstruction of individual processor calls or waits. The viewer retains the gaps between windows, subject to the pixel resolution. The contributions of overlaps are additive. Height and shade distinguish brief work that recurs from heavier processing across the same query duration. The viewer batches SVG paths into eight color levels. It does not create a DOM element for each call.

These items belong to the controls and the labels of the pipeline:

- The reading guide of the pipeline is folded under **How to read this**, beside the stage count. It explains the concurrency, the separate measures of time and work, the density scale and the summary resolution.
- The controls have these labels: *Full query*, *← Earlier*, *− Zoom out*, *+ Zoom in*, *Later →*, *Last 1%*. They and the focus of each stage share one time range across all rows.
- The subtitle of the dialog is the query id (mono). Then it shows the ClickHouse time and the session time, the rows read and the memory. For a query faster than the millisecond that query_log counts, the time is `<1 ms`.
- Every text of the dialog is 11 px or more.

The **Tracing** tab draws like the trace waterfall. It uses the same row height and bar (`--trace-row-h`, `--trace-bar-h`, `.traceSpanBar` in the color of the attempt). It uses muted duration labels. The labels have these positions:

- After the bar.
- Before the bar, from the middle of the time ruler.
- Inside a bar that ends past 88 %. This is the bar of the root, which the dashboard never cuts at the edge.

Under 600 px, a row has two lines: the operation over its bar. Both have the width of the dialog. The ruler labels 0, the middle and the end.

Zoom does not create more detailed measurements. The work counters and their shares stay totals for the whole query while the view is zoomed. The time labels increase their precision when the user views short ranges near the end of the query. The waits stay separate numeric maxima, because their temporal positions are not available.

Legacy payloads without `processor_trace_bucket_us` have only first and last envelopes. These are dashed, unfilled ranges. They never contribute to the activity histogram. A new run with profiling records the newer summary windows. Missing timing and partial collection are explicit. A blank area in an incomplete trace does not prove that the processor was idle.

Detailed Tracing keeps its separate 4K temporal LOD. ClickHouse frequently adds a trailing numeric instance suffix to the names of sibling operations (for example `ExpressionTransform_0`, `_1`, `_2`). The UI does these steps:

- It removes the repeated trailing `_N` suffixes.
- It merges the siblings recursively, only when they share the same logical parent.
- It retains their disjoint activity intervals and their descendants.
- It keeps different parents separate.
- It keeps a minimum visible width of two pixels for tiny events. This includes events at the right edge.

The cap of 10,000 detailed spans can be reached. Then the breadth-first retention keeps the structural parents. But the deepest processor leaves would otherwise be a chronological prefix only. In that case, Tracing replaces the processor leaf groups with the same time-bucketed summary of the full trace that Pipeline uses. It keeps the structural spans and the non-processor spans exact. A family that is missing from the summary can still use detailed spans if it belongs to one stage. The full summary determines the time ruler, even when the raw detailed leaves cover only the start of a query.

The API exposes the independent flags `processors_truncated` (10,000 rows) and `processor_trace_summary_truncated` (65,536 rows). It uses one extra sentinel row. `processor_trace_bucket_us` reports the width of the adaptive summary bucket that the run used. The availability and the errors of the summary are separate from the errors of the detailed trace. Pipeline shows the diagnostics of incomplete data and of the lookup together with the retained processor costs. It does not silently render a timeline that looks complete.

The model uses indexed identities, a cursor-based topological queue and sorted cost buckets with disjoint-set skipping. The grouping is O(P + E). The matching is O((P + S) log(P + S)), plus the sorting of intervals. P is the number of processor rows, E is the number of graph edges and S is the number of summary rows. The model does not scan all processors again for every span.

Run the deterministic model regressions without browser dependencies:

```bash
node --test tests/frontend/model/pipeline.test.cjs
node --test tests/frontend/model/processors-compact.test.cjs
```

They cover these cases: parallel and sequential flow, duplicate names, trace ownership, retries, hosts, UInt64 IDs, waits, incomplete summaries, graph cycles and configured caps.

To test the real round trip of the codec from C++ to JavaScript, do these steps:

1. Enable `-DCHDASH_BUILD_CODEC_TESTS=ON` in a CMake build.
2. Build the `chdash_processor_codec_test` target.
3. Set `PROCESSOR_JSON_DRIVER` to that executable when you run the compact-model test or the Python harness.

This checks every field, Unicode and NUL strings, large counters, identities and gaps. It includes the limits of 10,000 processors and 65,536 windows.

A normal Run cannot be analyzed. The user must run the original statement with **Run with profiling**. The dashboard marks a preview-limited execution as partial. Currently there is no Raw tab. Views and Distributed data stay available in the analysis response. They are not additional tabs in this dialog.

## Distributed scope

The current implementation reports the correlated distributed-child records that it finds in the system logs of the local replica. It labels the response `distributed_scope=local_replica`. It does not create totals for the whole cluster. A future extension for clusters can use `clusterAllReplicas`. This is possible when the cluster identity of the host and a safe system access to the whole cluster are explicitly resolvable.

## Deep Analyze backend

Deep Analyze is **not exposed in the current browser UI**. It is disabled by default (`analysis.allow_deep_analyze = false`). The Raw analysis tab is also removed. The separately gated backend implementation `/api/query/deep-analysis` is retained for future work and for explicit development configurations. It requires `allow_deep_analyze=true`. Normal deployments do not advertise it and do not call it.
