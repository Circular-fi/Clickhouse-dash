# Native TCP telemetry

ClickHouse Dash runs queries through ClickHouse native TCP. It sends the results and telemetry to the browser with Server-Sent Events.

## Metrics

The dashboard keeps the original compact set of metrics:

- Elapsed time.
- Read progress, when ClickHouse gives `total_rows_to_read`.
- Rows read and rows per second.
- Bytes read and bytes per second.
- CPU usage. The dashboard calculates it from the increments of the query-group `UserTimeMicroseconds` and `SystemTimeMicroseconds` events.
- Current and peak query memory. The dashboard reads them from the `MemoryTrackerUsage` and `MemoryTrackerPeakUsage` gauges.

The dashboard no longer has the thread metric. Native profile packets contain thread identifiers. They do not give a deterministic count of the active threads of the whole query while it runs. The dashboard does not infer a count.

Rows and bytes come from native `Progress` packets. CPU and memory come only from the query-group `ProfileEvents` row (`thread_id = 0`). If a CPU or memory value is not available, the dashboard sends JSON `null`. It does not guess a value.

The progress percentage is the read progress. ClickHouse does not give a deterministic denominator for the later work of the pipeline. This work includes aggregation, sorting, final projection and result serialization. For this reason, the dashboard does not invent an overall percentage for the query.

## SSE event contract

| Event | Count contract | Purpose |
|---|---|---|
| `meta` | exactly one | Connection acknowledgement |
| `result_meta` | zero or one | Result columns and types |
| `result_rows` | operational | Result batches. The count depends on the batch size |
| `tick` | operational | Compact telemetry snapshot |
| `error` | zero or one | Terminal query error |
| `done` | exactly one | Terminal status and final read counters |
| `keepalive` / `message` | optional | Transport compatibility events |

The counts of `result_rows`, `tick`, `keepalive` and `message` can be different between releases. This does not change the query semantics. The tests compare these items:

- Rows.
- Row order.
- Hashes.
- Columns.
- Types.
- Terminal status.
- Deterministic control events.

## Tick layout

A `tick` payload is a positional JSON array. It stays compatible with the original dashboard contract:

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

Positions 12 and 13 are reserved placeholders for compatibility. They replace the removed values for the current and peak threads. The source dashboard always sends `null` in both positions.

Compact samples use this layout:

```text
[elapsed_ms, read_rows_total, read_bytes_total, cpu_percent_centi|null, memory_bytes|null]
```

Historical releases can add a sixth thread value to a sample. The current frontend ignores this value.

## Non-finite floating-point values

JSON has no representation for NaN or infinity. The native result serializer sends JSON `null` for non-finite `Float32` and `Float64` values. It keeps finite values as JSON numbers. For this reason, every `result_rows` event is valid JSON.
