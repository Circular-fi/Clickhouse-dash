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

## What the times measure

A run has several times. They measure different things, so they are not equal. The table shows each time, where it appears, and the clock that measures it.

| Time | Where it appears | What it measures |
|---|---|---|
| **Elapsed** | Query page, the Elapsed tile. It is `elapsed_seconds` of the `done` event. | The time that ChDash needs from the start of the stream to its last event. It includes the connection, the wait for ClickHouse, the decoding of the columns, the JSON encoding and the wait for a slow browser. |
| **System** | Query page, under Elapsed, when Load execution stats is on. System > Queries shows the same figure as the duration of a run. | `query_duration_ms` of `system.query_log`. ClickHouse measures it. It ends when ClickHouse has sent its last block. |
| **The browser had every row** | The tooltip of the Elapsed tile. | The browser measures it from the click on Run until it has stored the last row. It includes the request, the parsing of the events and the work of the table. |
| **Analyze: ClickHouse and session** | The Analyze dialog. | The ClickHouse time is `query_duration_ms`. The session time is Elapsed. |

System is not the time that ClickHouse needs to compute the result. ClickHouse sends the blocks of a result to ChDash through the native protocol. It waits when ChDash has not read the previous blocks. For a large result, System contains this wait. A client that decodes slowly makes System longer. It is not a defect of ClickHouse.

The `done` event has the part `timing_ms`. It shows where the Elapsed time went:

| Field | Meaning |
|---|---|
| `receive` | The time inside the native client: ClickHouse that produces and sends the blocks, and the decoding of their columns. |
| `encode` | The time that ChDash needs to write the rows as JSON events. |
| `backpressure` | The time that ChDash waited because the browser had not read the events. |

`receive` and `encode` run at the same time for a result of more than one block. A thread encodes a block while the client decodes the next block. For this reason, their sum can be longer than Elapsed. The rest of Elapsed is the connection, `USE` and `DESCRIBE`. The Elapsed tile shows these parts in its tooltip.

### Example: `select * from chdash_ui.weather_buffer`

The table has 120,064 rows, with `Tuple`, `Array` and `Map` columns. ClickHouse reads 42 MiB and ChDash sends 37 MB of JSON. The times come from one host, a median of five runs, and the browser is Chrome.

| Step | Before 2.17 | Now |
|---|---|---|
| ClickHouse alone (`clickhouse-client`, `query_duration_ms`) | 50 ms | 50 ms |
| Decoding of the columns in ChDash (`receive`) | 240 ms | 190 ms |
| JSON encoding in ChDash (`encode`) | 480 ms | 150 ms |
| Elapsed, the tile (the two steps now overlap) | 0.7 s | 0.2 s |
| System, `query_duration_ms` | 0.45 s | 0.15 s |
| The browser has every row, from the click | 1.2 s | 0.55 s |

The `Map` columns made most of the encoding time before 2.17: ChDash copied the keys and the values of each cell. The browser stream was the other half: the `EventSource` of Chrome needs about as long as the bytes need to arrive. The Query page now reads the stream with `fetch`.

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
