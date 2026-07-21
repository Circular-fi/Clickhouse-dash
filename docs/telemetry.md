# Native TCP telemetry

ClickHouse Dash streams query telemetry over Server-Sent Events while the query itself runs through ClickHouse's native TCP protocol.

## Design rules

The dashboard exposes only values that ClickHouse reports for the query group. It does not infer an active thread count from per-thread profile rows, event frequency, CPU percentage, or any other proxy.

ClickHouse native `ProfileEvents` packets have a stable row schema:

```text
host_name, current_time, thread_id, type, name, value
```

The authoritative query-group aggregate uses `thread_id = 0`. Counter rows use `type = increment`; current-value rows use `type = gauge`.

The dashboard consumes these query-group metrics:

| Dashboard field | ClickHouse source | Semantics |
|---|---|---|
| CPU time | `UserTimeMicroseconds` + `SystemTimeMicroseconds` | Cumulative query CPU time |
| Scheduler wait | `OSCPUWaitMicroseconds` | Cumulative time runnable threads waited for CPU |
| I/O wait | `OSIOWaitMicroseconds` | Cumulative query I/O wait time |
| Current memory | `MemoryTrackerUsage` | Query memory gauge |
| Peak memory | `MemoryTrackerPeakUsage` | Query peak-memory gauge |
| Temporary data | `TemporaryDataOnDiskUsage` | Current compressed temporary-data gauge |
| Read rows/bytes | native progress packets | Cumulative query progress |
| Total rows to read | native progress packets | Progress denominator when ClickHouse can provide one |

Rates are derived only from monotonic ClickHouse counters and the client-side elapsed interval. A missing metric is encoded as JSON `null`; it is never replaced with zero or an estimate.

## SSE event contract

A query stream contains these event families:

| Event | Count contract | Purpose |
|---|---|---|
| `meta` | exactly one | Connection and telemetry-schema declaration |
| `result_meta` | zero or one | Result column names and types; absent for statements without a result set |
| `result_rows` | operational | Result batches; count depends on batch limits and row size |
| `tick` | operational | Telemetry snapshots; count depends on query duration and scheduling |
| `error` | zero or one | Terminal query error |
| `done` | exactly one | Terminal status and final counters |
| `keepalive` / `message` | optional | Transport-level compatibility events |

Only deterministic control-event counts are compared strictly between releases. Different `result_rows` counts are expected when batching changes, provided row order, row count, and row hash match. Different `tick` counts are expected when telemetry cadence or query duration changes. The stream does not emit an empty zero-value tick on connection; it emits periodic meaningful ticks and always emits one final tick before `done`.

## Telemetry schema version 2

The connected `meta` event declares the current telemetry schema:

```json
{
  "query_id": "...",
  "status": "connected",
  "telemetry": {
    "schema_version": 2,
    "source": "clickhouse_native_tcp",
    "metrics": [
      "progress",
      "read_rate",
      "cpu_time",
      "memory_tracker",
      "cpu_scheduler_wait",
      "io_wait",
      "temporary_data_on_disk"
    ]
  }
}
```

A `tick` is a named JSON object rather than an undocumented positional array:

```json
{
  "schema_version": 2,
  "elapsed_ms": 750,
  "progress": {
    "known": true,
    "percent_centi": 3577,
    "read_rows": 357721821,
    "read_bytes": 2861774568,
    "total_rows_to_read": 1000000000
  },
  "rates": {
    "read_rows_per_second": 607739705,
    "read_bytes_per_second": 4861917643
  },
  "profile": {
    "cpu_percent_centi": 11872,
    "memory_bytes": 685248,
    "peak_memory_bytes": 685248,
    "cpu_wait_percent_centi": 312,
    "io_wait_percent_centi": 0,
    "temporary_data_bytes": 0,
    "cpu_time_us": 89040,
    "cpu_wait_time_us": 2340,
    "io_wait_time_us": 0
  },
  "samples": null
}
```

Compact samples use this documented layout:

```text
[elapsed_ms, read_rows, read_bytes, cpu_percent_centi|null,
 memory_bytes|null, cpu_wait_percent_centi|null, io_wait_percent_centi|null]
```

The frontend still accepts the legacy positional tick format when viewing streams from an older release. Legacy inferred thread values are intentionally ignored.

## Non-finite floating-point values

JSON has no representation for NaN or infinity. ClickHouse HTTP JSON formats emit these values as `null` in the relevant compatibility mode. The native TCP result serializer follows the same safe rule:

- finite `Float32` and `Float64` values remain JSON numbers;
- NaN, positive infinity, and negative infinity become JSON `null`.

This guarantees that every `result_rows` event is valid JSON and prevents one non-finite cell from discarding the complete result batch in the browser.
