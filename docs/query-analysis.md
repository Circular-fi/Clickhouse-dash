# Query profiling and on-demand analysis

## Execution modes

The primary **Run** action uses `mode=normal`. It keeps the existing native
ProfileEvents telemetry required by the live dashboard but does not enable
processor profiling and does not invoke the analysis endpoint.

**Run with profiling** uses `mode=profiling`. It requires no application authentication and sets the following values on the individual
`clickhouse::Query` object:

- `log_queries=1`
- `log_profile_events=1`
- `log_processors_profiles=1`
- `log_query_views=1`

The SQL text is not rewritten to append `SETTINGS`, and a profiled statement is
executed once. In multiquery mode each statement gets its own public/native
query IDs and its own settings.

## Query registry

Every run is associated with the bounded `QueryRegistry`: public query ID, host, native attempt IDs, run mode, terminal status, partial-execution flag, and bounded original SQL retained for the separately gated replay backend. There is no subject, token fingerprint, or per-user ownership check.

`POST /api/query/analysis` resolves a completed record by `query_id + host_id`. All callers of the panel share the permissions of that host's `runner_uri`.

The successful response is ordinary `application/json`. Span-heavy trace data is kept under `trace_compact` as positional JSON rather than repeated span objects. It uses dictionaries for host/trace/operation strings and local parent indexes instead of transporting real span IDs. Temporal data uses a fixed 3840-pixel (4K-width) LOD: exact span intervals are projected to pixel buckets, and leaf intervals that become indistinguishable at that resolution are merged. The tree structure itself is not sampled or pruned by this LOD.

Processor counters and their activity windows use `processors_compact`, a separate
versioned, lossless positional representation (`chdash.processors.json.v1`).
The normal response omits the expanded `processors` and `processor_trace_summary`
arrays. Debug requests (`include_original_trace=true`) retain those original
arrays alongside the compact blocks and `trace_spans_original` for diagnostics.

### Compact processor contract

| Field | Meaning |
| --- | --- |
| `strings` | Shared string dictionary, with the empty string at index 0. |
| `row_schema`, `rows` | Positional processor rows: host, initial/native query IDs, processor ID, parent IDs, plan metadata, name and seven counters. All `_ref` fields reference `strings`; parent references are a list of dictionary indexes. |
| `summary_origin_us` | Common origin for summary timestamps. |
| `summary_series_schema`, `summary_series` | One series per exact host/trace/query/parent/operation identity. Each series contains its five dictionary references and flat `windows`. |
| `summary_window_schema` | Repeated `[start_offset_us, finish_offset_us, active_time_us, event_count]` quadruples within each series. |
| `summary_row_count` | Number of summary windows, checked against the decoded series. |

Add the origin to each summary time offset. These values retain microsecond
precision and all recorded windows; the trace's 4K temporal LOD does **not**
apply to processor summaries. Processor IDs, parent IDs and plan IDs remain
exact decimal strings in the dictionary. Counters and offsets use JSON integers
up to `2^53 - 1`, then decimal strings up to UInt64 max. Large integer arithmetic
must therefore use an exact integer type before conversion for visualization.

The browser checks the format version, positional schemas, references, integer
ranges, window order and collection caps. A malformed compact block is an
explicit analysis error, even when a debug payload also contains legacy arrays.
Older object payloads remain readable when no compact block is present. Summary
iteration is restartable and does not retain another 65,536-row expanded array.

## Analysis lookup

Analyze is on demand. It performs a bounded lookup of the logs that ClickHouse
has already produced and never re-executes the business query:

- `system.query_log`
- `system.processors_profile_log`, when recorded
- `system.query_views_log`, when recorded

System logs are asynchronous, so `analysis.log_lookup_timeout_ms` controls a
short retry window. `analysis.flush_logs=false` is the default. When explicitly
enabled, `SYSTEM FLUSH LOGS` is a required precondition for the analysis lookup:
if the system account cannot flush the logs, the endpoint returns an explicit
`analysis_collection_failed` error instead of rendering a partial-looking
analysis. A failure to connect to the system context or to query the core
`system.query_log` is handled the same way.

The technical account is not an authorization source. Before names from system
logs are serialized, the backend rebuilds/reuses the same runner-scoped
`AllowedObjectSet` used by Explorer. Hidden databases, tables, views, and view
targets are omitted.

## Analysis UI

The Profiling dialog opens **Pipeline** first and mounts **Tracing** only when
selected. The header and time ruler stay visible while the rows scroll; the
ruler shares horizontal scrolling with the data.
Above 150 stages the Pipeline mounts only the visible rows plus six rows of
overscan on either side. Sorting and scrolling retain every model row; there is
no stage sampling. Timeline drawing is limited to the mounted rows. Processor
decoding, trace decoding and the Pipeline model are reused while switching tabs.
Closing the dialog releases the payload, caches, DOM and resize observers. A
response from an older opening cannot replace a newer query or refill a closed
dialog.

Pipeline groups processors by hostname, native query ID and plan step.
Processors without a plan step (`plan_step=0`) are separated by type. Source to
sink ordering follows `parent_ids`, scoped to the same host and query. Processor,
parent, plan-step and plan-group IDs are decimal strings in the analysis API so
UInt64 identities survive JavaScript parsing. Legacy safe integer IDs still work;
already-rounded large numeric IDs are reported and cannot form graph links.

### Costs and flow

- **Work Σ** sums `elapsed_us`, the active execution time of the processors.
  Input/output waits are separate counters and must not be subtracted from it.
  Parallel processor work can exceed query wall-clock time. The separate work
  bar and percentage show each stage's share of total recorded processor work,
  including stages with unavailable timing. They do not represent wall-clock
  positions. If processor collection is truncated, the shares describe only the
  retained processors. The stage order selector can rank rows by work without
  changing their original pipeline numbers or timestamps.
- **Input wait / Output wait** show the maximum observed wait on one processor.
- **Input / Output** sum the counters on stage entry / exit processors. This
  includes parallel lanes without counting sequential internal processors twice.
  Mixed internal/external ports, missing links or a truncated processor list make
  the boundary approximation explicit with `≈`; per-port counters are unavailable.
- Waiting-only stages remain visible. Unassigned processors are not all presented
  as one fictitious output stage. A table hint is shown only for a source-like
  stage when the query overview identifies one table.

Counter definitions follow the [ClickHouse processor log documentation](https://clickhouse.com/docs/reference/system-tables/processors_profile_log).

### Measured times and estimated associations

The backend scans the complete time-bounded OpenTelemetry trace independently
of the detailed 10,000-span cap. It groups each exact processor operation into
adaptive temporal buckets before returning the summary. Rows from the same
processor instance are reassembled in the browser. This retains gaps between
non-overlapping summary windows; the real gaps between periods of activity
within a window are unknown. The target is about 32K summary rows with a hard 65,536-row
cap: small/normal pipelines receive hundreds of temporal buckets per processor,
while very large pipelines trade temporal resolution for bounded payload size.
Each slice still carries first/last activity, summed active time, event count and,
where the span exposes it, `query_id`. Query IDs from root spans identify the
attempt for the other operations in that trace. Missing traces from an earlier
attempt cannot shift a later trace onto the wrong query. Legacy payloads without
this mapping are attributable only when a single query is present.

A processor family unique to a stage can use its measured activity slices
without estimating which stage it belongs to. When the same type occurs in
several stages, the viewer compares active-time counters with indexed cost
buckets. A match must be within 25% using a minimum 100µs scale; competing stages
within 0.05 normalized score are ambiguous. These thresholds are UI heuristics,
not a ClickHouse identity guarantee. Accepted cost matches are marked `≈` with
an explicit approximate marker. Equal-cost or incompatible candidates stay unassigned. Overflow
instances are never attached arbitrarily to the busiest stage. A stage marked
`Timing unavailable` still has processor counters, but no processor span can be assigned
to it confidently. Typical cases are zero-work structural processors (for
example a `Limit` that only waits) and duplicate processor families where the
OpenTelemetry operation name does not expose the plan-step identity and the
counter-based association remains ambiguous.

The default chart is a **work-density histogram over time** with a common height
and color scale across stages. Each summary window contributes its summed work
divided by its first-to-last duration. This is average processor work, not CPU
utilization, and can exceed one for concurrent processors. The total number of
processors in a stage is not treated as a simultaneous-lane capacity.

For rendering, work is spread uniformly only inside its own summary window and
projected into at most 192 display cells per row. This is an estimate at the
reported summary resolution, not a reconstruction of individual processor calls
or waits. Gaps between windows are retained subject to pixel resolution; overlap
contributions are additive. Height and shade distinguish recurring brief work
from heavier processing across the same query duration. SVG paths are batched
into eight color levels rather than creating a DOM element per call.

Full-query, zoom, pan, last-one-percent and per-stage focus controls share one
time range across all rows. Zoom does not invent more detailed measurements.
Work counters and their shares remain totals for the whole query while zoomed.
Time labels increase their precision when viewing short ranges near query end.
Waits stay separate numeric maxima because their temporal positions are absent.

Legacy payloads without `processor_trace_bucket_us` have first/last envelopes
only. These are dashed, unfilled ranges and never contribute to the activity
histogram. Rerunning with profiling records the newer summary windows. Missing
timing and partial collection are explicit; a blank area in an incomplete trace
does not prove that the processor was idle.

Detailed Tracing preserves its separate 4K temporal LOD. ClickHouse frequently
adds a trailing numeric instance suffix to sibling operation names (for example
`ExpressionTransform_0`, `_1`, `_2`). The UI removes repeated trailing `_N`
suffixes and recursively merges siblings only when they share the same logical
parent; their disjoint activity intervals and descendants are retained. Different
parents remain separate. Tiny events, including ones at the right edge, keep a
minimum visible width of two pixels. When the
10,000 detailed-span cap is reached, breadth-first retention keeps the structural
parents but the deepest processor leaves would otherwise be a chronological
prefix only. In that case Tracing replaces processor leaf groups with the same
full-trace time-bucketed summary used by Pipeline, while keeping structural and
non-processor spans exact. A family missing from the summary can still use
detailed spans if it belongs to one stage. The full summary determines the time
ruler even when raw detailed leaves only cover the start of a query.

The API exposes independent `processors_truncated` (10,000 rows) and
`processor_trace_summary_truncated` (65,536 rows) flags, using one extra sentinel
row. `processor_trace_bucket_us` reports the adaptive summary bucket width used
for the run. Summary availability/errors are separate from detailed trace errors.
Pipeline displays incomplete-data and lookup diagnostics alongside retained
processor costs rather than silently rendering an apparently complete timeline.

The model uses indexed identities, a cursor-based topological queue, and sorted
cost buckets with disjoint-set skipping. Grouping is O(P + E); matching is
O((P + S) log(P + S)), plus interval sorting, where P is processor rows, E is graph
edges and S is summary rows. It does not rescan all processors for every span.

Run the deterministic model regressions without browser dependencies:

```bash
node --test tests/frontend/model/pipeline.test.cjs
node --test tests/frontend/model/processors-compact.test.cjs
```

They cover parallel/sequential flow, duplicate names, trace ownership, retries,
hosts, UInt64 IDs, waits, incomplete summaries, graph cycles and configured caps.

For the actual C++-to-JavaScript codec round trip, enable
`-DCHDASH_BUILD_CODEC_TESTS=ON` in a CMake build and build the
`chdash_processor_codec_test` target. Set `PROCESSOR_JSON_DRIVER` to that
executable when running the compact-model test or the Python harness. This
checks every field, Unicode/NUL strings, large counters, identities and gaps,
including the 10,000-processor and 65,536-window limits.

A normal Run cannot be analyzed. The original statement must have been executed
with **Run with profiling**. A preview-limited execution is marked partial.
There is currently no Raw tab; Views and Distributed data remain available in
the analysis response but are not additional tabs in this dialog.

## Distributed scope

The current implementation reports correlated distributed-child records found
in the local replica's system logs and labels the response
`distributed_scope=local_replica`. It does not fabricate cluster-wide totals.
A future cluster-aware extension can use `clusterAllReplicas` once the host's
cluster identity and safe cluster-wide system access are explicitly resolvable.

## Deep Analyze backend

Deep Analyze is **not exposed in the current browser UI** and is disabled by
default (`analysis.allow_deep_analyze = false`). The Raw analysis tab is also
removed. The separately gated `/api/query/deep-analysis` backend implementation
is retained for future work and for explicit development configurations, but it
requires `allow_deep_analyze=true`; normal deployments do not advertise or invoke
it.
