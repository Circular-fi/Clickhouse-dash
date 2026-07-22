# Native TCP telemetry

ClickHouse Dash executes queries through ClickHouse native TCP and streams results and telemetry to the browser with Server-Sent Events.

## Metrics

The dashboard keeps the original compact metric set:

- elapsed time;
- read progress when ClickHouse provides `total_rows_to_read`;
- rows read and rows per second;
- bytes read and bytes per second;
- CPU usage derived from query-group `UserTimeMicroseconds` and `SystemTimeMicroseconds` increments;
- current and peak query memory from `MemoryTrackerUsage` and `MemoryTrackerPeakUsage` gauges.

The former thread metric is removed. Native profile packets contain thread identifiers, but they do not provide a deterministic live active-thread count for the whole query. The dashboard does not infer one.

Rows and bytes come from native `Progress` packets. CPU and memory come only from the query-group `ProfileEvents` row (`thread_id = 0`). Missing CPU or memory values are represented by JSON `null` rather than guessed values.

The progress percentage is read progress. ClickHouse does not provide a deterministic denominator for later pipeline work such as aggregation, sorting, final projection, or result serialization, so the dashboard does not invent an overall query percentage.

## SSE event contract

| Event | Count contract | Purpose |
|---|---|---|
| `meta` | exactly one | Connection acknowledgement |
| `result_meta` | zero or one | Result columns and types |
| `result_rows` | operational | Result batches; count depends on batch size |
| `tick` | operational | Compact telemetry snapshot |
| `error` | zero or one | Terminal query error |
| `done` | exactly one | Terminal status and final read counters |
| `keepalive` / `message` | optional | Transport compatibility events |

`result_rows`, `tick`, `keepalive`, and `message` counts may differ between releases without changing query semantics. Tests compare rows, row order, hashes, columns, types, terminal status, and deterministic control events.

## Tick layout

A `tick` payload is a positional JSON array kept compatible with the original dashboard contract:

```text
[
  elapsed_ms,
  read_percent_centi,
  read_percent_known,
  read_rows_total,
  read_bytes_total,
  total_rows_to_read,
  read_rows_per_second,
  read_bytes_per_second,
  cpu_percent_centi|null,
  maximum_cpu_percent_centi|null,
  current_memory_bytes|null,
  peak_memory_bytes|null,
  null,
  null,
  samples|null
]
```

Positions 12 and 13 are reserved compatibility placeholders for the removed current and peak thread values. The source dashboard always sends `null` in both positions.

Compact samples use:

```text
[elapsed_ms, read_rows_total, read_bytes_total, cpu_percent_centi|null, memory_bytes|null]
```

Historical releases may append a sixth thread value to a sample. The current frontend ignores it.

## Non-finite floating-point values

JSON has no representation for NaN or infinity. The native result serializer emits JSON `null` for non-finite `Float32` and `Float64` values while preserving finite values as JSON numbers. This keeps every `result_rows` event valid JSON.
