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

When processor profiling exists, the **Pipeline** tab groups processors by native
query, plan step, plan-step name, and processor type so that a large pipeline does
not become hundreds of nearly identical cards. There is currently no Raw tab.

A normal Run cannot be analyzed. Analyze requires that the original statement was
executed with **Run with profiling**; otherwise the API returns
`analysis_not_enabled`. If the result preview limit stopped execution, the
analysis is marked partial.

The **Views** tab is present only when filtered `query_views_log` records exist for
that execution. **Distributed** is present only when correlated distributed child
queries exist. The browser does not infer either tab from a database name or static
cluster configuration.

The Analysis dialog uses a stable viewport-relative width, height, and top offset.
Its header and tab bar remain fixed while only the content region scrolls.

### Profiling phase trace

The Profiling tab no longer renders a flame graph. It renders a Jaeger-like
processor timeline with a time axis and one row per processor. Each row decomposes
ClickHouse's processor counters into:

- **Waiting for input** — `input_wait_elapsed_us`;
- **Working** — `elapsed_us - input_wait_elapsed_us - output_wait_elapsed_us`;
- **Waiting for output** — `output_wait_elapsed_us`.

ClickHouse's `processors_profile_log` exposes aggregate processor elapsed/wait
counters for this use, not a reliable absolute start timestamp for every processor.
The UI therefore does not fabricate span start times: rows share a zero origin and
their width is scaled against the longest processor. If the two wait counters sum
to more than elapsed because of accounting/rounding, they are proportionally
clamped so the derived working duration never becomes negative. Tooltips include
phase durations plus input/output rows and bytes.

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
