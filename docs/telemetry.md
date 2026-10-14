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

The values in `result_rows` follow the contract in "Result values" below.

The server sends a `tick` every 250 ms while the query runs. The Query page ends a run in every case:

- `done` ends the run.
- A stream that ends after an `error` event and before `done` ends the run with that error.
- A stream that ends without `done` ends the run with the error "Connection lost". The server cancels a query when its stream is cut, so the message says to check the result before a second run.
- A stream that sends no event for 60 seconds ends the run as an error. A proxy that holds the response, or a half-open connection, cannot leave the run "running".
- A failure while the page draws the rows is reported in the console. The run still ends.

The host of a run is fixed when the run starts. Every statement of a batch, the history entry and the diagnostics use that host. The host picker is disabled while the run continues.

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

The table has 120,064 rows with `Tuple`, `Array` and `Map` columns. ClickHouse reads 42 MiB, and ChDash sends 37 MB of JSON. The times are medians on one host, with ClickHouse on the same host. The load of the host was 4 to 7. The browser is Chrome. The server figures come from nine runs, and the browser figures come from eight runs.

| Step | Before 2.17 | Now |
|---|---|---|
| ClickHouse alone (`clickhouse-client`, `query_duration_ms`) | 50 ms | 50 ms |
| Decoding of the columns in ChDash (`receive`) | 250 ms | 190 ms |
| JSON encoding in ChDash (`encode`) | 560 ms | 170 ms |
| Elapsed, the tile (the two steps now overlap) | 0.63 s | 0.22 s |
| System, `query_duration_ms` | 0.30 s | 0.09 s |
| From the click until the browser has every row | 1.5 s | 1.0 s |

Before 2.17, System was six times the time that ClickHouse needs alone. ClickHouse waited for ChDash to read, decode and encode. The `Map` columns made most of the encoding time: ChDash copied the keys and the values of each cell. The browser was the other half. The `EventSource` of Chrome needs about as long as the bytes need to arrive. The Query page now reads the stream with `fetch`. The rest of the browser time has three parts. The parsing of the events takes 200 ms. The layout and the paint of the table take about 300 ms. The code that fills the table rows takes the remainder.

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

## Result values

The `result_rows` events, the MCP rows, the Explorer preview and the JSON Lines of an export use one encoder (`src/json_clickhouse.hpp`). It writes each value exactly as ClickHouse stores it. It uses a form that `JSON.parse` in a browser does not change.

| ClickHouse type | JSON value | Example |
|---|---|---|
| `Int8` to `Int32`, `UInt8` to `UInt32` | number | `42` |
| `Int64`, `UInt64`, `Int128`, `UInt128`, `Int256`, `UInt256` | string of the digits | `"18446744073709551615"` |
| `Decimal32` to `Decimal128` | string of the digits, at the scale of the type | `"1.500"` for `toDecimal64(1.5, 3)` |
| `Float32`, `Float64` (finite) | number, with the fewest digits that read back as the same value | `0.1` for `toFloat32(0.1)` |
| NaN, +Inf, -Inf | string, as ClickHouse prints it | `"nan"`, `"inf"`, `"-inf"` |
| `Bool` | `true` or `false` | `true` |
| `String`, `FixedString` | string | `"007"` |
| `UUID`, `IPv4`, `IPv6`, `Enum` | string, as ClickHouse prints it | `"00000000-0000-0000-0000-000000000001"` |
| `Date`, `Date32` | string | `"2026-09-12"` |
| `DateTime`, `DateTime64` | string, ISO 8601 in UTC | `"2026-09-12T14:29:57.123Z"` |
| `Array`, `Tuple` | array | `[1, "x"]` |
| `Map` | array of `[key, value]` pairs, in the stored order | `[["10", 1], ["2", 2]]` |
| SQL `NULL` | `null` | `null` |

Reasons for these choices:

- A JSON number above 2^53 loses digits in a browser. `cityHash64(1)` is `10577349846663553072`, not `10577349846663553000`.
- NaN is not a SQL NULL. JSON has no NaN, so the encoder writes the text of ClickHouse.
- A JSON object merges equal keys, and JavaScript puts the keys that are numbers first. A list of pairs keeps every key and its order, whatever the key type.
- A String is text. A NUL byte stays in the value. A byte that is not UTF-8 becomes U+FFFD, so every event is valid UTF-8 JSON.

Two cases need the compatibility projection of `query.describe_mode` (the `transport_modes` of `result_meta` is `stringify`). The original type stays in `original_types`:

- A scalar that the native client cannot read (`Int256`, `UInt256`, `Decimal256`) is the text of `toString()`, for example `"115792089237316195423570985008687907853269984665640564039457584007913129639935"`.
- A structure that holds such a value, and the `JSON`, `Dynamic` and `Variant` types, are the JSON text of `toJSONString()`. The Query page parses this text without loss: a number that a double cannot keep stays its text, and the keys keep their order.

`Bool` is `true` or `false` when the type is known: through the compatibility projection and in the Explorer preview. The native client reads a `Bool` as `UInt8`, so a direct query shows the type `UInt8` and the value `1`.

### On the Query page

The Query page shows, copies and downloads these values as they arrive. It never turns a string into a number, it never parses a `String` value, and it never unescapes a value again.

- The table shows the text of each value: `10577349846663553072`, `nan`, `C:\new`, `007`. A `Map` reads as an object in its stored order, `{"10":1,"2":2}`. A structure reads as compact JSON.
- Copy cell copies that text. A structure is indented JSON. A NULL copies as nothing.
- Copy JSON, Download JSON, Copy row, Copy column and the row details use one serializer. Each row is an object (column: value). When two columns have the same name, each row is an array. A 64-bit integer, a Decimal and NaN stay strings. A `Map` and a named `Tuple` are objects.
- Copy CSV, Download CSV and `results.csv` of the Debug archive use one serializer. A field has quotes only when it needs them. A NULL is a bare `\N`, as in the CSV of ClickHouse. A text that is exactly `\N` has quotes. A structure is its compact JSON.
- Copy CSV gives the same text as Download CSV. Copy JSON gives the same values as Download JSON, without wrapping that says nothing: one row is its object (not a list of one), one column is the list of its values (not objects of one key), and one row of one column is the value itself. Download JSON always writes the list of objects, so a program reads one shape for every result.
- A numeric sort compares the digits of a `UInt64` or of a long `Decimal` exactly. `inf` and `-inf` sort as numbers, `nan` sorts with the NULLs.
