# Trace Explorer

ChDash can read OpenTelemetry traces stored by the OpenTelemetry Collector contrib ClickHouse exporter. The viewer follows the ClickHouse host selected in the UI and uses that host's `system_uri`.

## Configuration

```hcl
traces {
  enabled                  = true
  database                 = "otel"
  table                    = "otel_traces"
  trace_index_table        = "otel_traces_trace_id_ts"
  service_allowlist        = ["*"]
  default_lookback_minutes = 60
  max_lookback_minutes     = 10080
  search_limit             = 100
  max_spans_per_trace      = 10000

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

The Trace Explorer is trace-index-first whenever no trace-duration filter is active. Unfiltered searches read the newest trace IDs directly from `otel_traces_trace_id_ts`. Service, operation, status, tag, and allowlist filters page recent trace IDs in batches of 1,000, test existence with `LIMIT 1 BY TraceId`, stop once enough result traces match, and then aggregate only those selected traces through `prj_traceid`. The global charts use the same existence semantics and `trace_index_table` bounds instead of grouping the full span table repeatedly. Duration filters keep the exact span-aggregation fallback because they are trace-level predicates. Duration quantiles on the index path use `Start`/`End`, so deployments should populate `End` as the trace end if exact trace-duration quantiles are required.

Service/operation prefill and tag discovery are also existence queries: they use `LIMIT 1 BY` rather than counting every matching span. The API keeps the legacy count fields for compatibility, but discovery does not rank values by frequency.

## Recommended ClickHouse projection indexes

Keep the official OpenTelemetry table definitions and sorting keys unchanged. For the large-trace workloads benchmarked by ChDash, add only these two ClickHouse 26.1+ lightweight projection indexes:

```sql
ALTER TABLE otel.otel_traces
    ADD PROJECTION IF NOT EXISTS prj_traceid INDEX TraceId TYPE basic;

ALTER TABLE otel.otel_traces_trace_id_ts
    ADD PROJECTION IF NOT EXISTS prj_start INDEX Start TYPE basic;
```

New parts populate these projections automatically. If the tables already contain historical data, materialize the existing parts once:

```sql
ALTER TABLE otel.otel_traces
    MATERIALIZE PROJECTION prj_traceid;

ALTER TABLE otel.otel_traces_trace_id_ts
    MATERIALIZE PROJECTION prj_start;
```

`MATERIALIZE PROJECTION` is a mutation and is asynchronous by default. Add `SETTINGS mutations_sync=1` to either statement when an operator explicitly wants the command to wait for completion. On very large production tables, materializing partition-by-partition is safer than rewriting all historical parts in one mutation.

`prj_traceid` accelerates exact and `IN (...)` TraceId pruning after search has selected candidate traces. `prj_start` gives the trace-id time index a time-oriented access path for the main search page while preserving its base `(TraceId, Start)` ordering for direct trace lookup.

Do not add `prj_timestamp` by default. On a production-shaped local benchmark with about 2.01 billion spans it consumed roughly 18.7 GiB while a one-hour timestamp scan improved only from about 15 ms to 14 ms.

The Trace Explorer is trace-index-first whenever no trace-duration filter is active. Unfiltered searches read the newest trace IDs directly from `otel_traces_trace_id_ts`. Service, operation, status, tag, and allowlist filters page recent trace IDs in batches of 1,000, test existence with `LIMIT 1 BY TraceId`, stop once enough result traces match, and then aggregate only those selected traces through `prj_traceid`. The global charts use the same existence semantics and `trace_index_table` bounds instead of grouping the full span table repeatedly. Duration filters keep the exact span-aggregation fallback because they are trace-level predicates. Duration quantiles on the index path use `Start`/`End`, so deployments should populate `End` as the trace end if exact trace-duration quantiles are required.

Service/operation prefill and tag discovery are also existence queries: they use `LIMIT 1 BY` rather than counting every matching span. The API keeps the legacy count fields for compatibility, but discovery does not rank values by frequency.

## Direct TraceId URLs

A trace can be opened directly at:

```text
/traces/<trace-id>
```

Direct TraceId lookup is not limited by `max_lookback_minutes`. ChDash first uses `trace_index_table` to resolve the timestamp window. If that auxiliary table is unavailable, it performs an exact all-history lookup for the TraceId, restricted by `service_allowlist`, and then reads the trace through the recovered time window.

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
