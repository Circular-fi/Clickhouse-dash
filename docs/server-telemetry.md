# Server telemetry (OTLP)

ChDash can send the trace of each MCP request to an OpenTelemetry receiver, for example an OpenTelemetry Collector. This page tells what ChDash sends, how to configure it and what happens when the receiver is slow or down. The `telemetry` block of the configuration file controls it. The block applies the contract of the MCP servers (sections 7.4 and 7.5).

This page is about the export of the server. The live counters that the Query page shows in the browser are a different subject: refer to [telemetry.md](telemetry.md).

## What ChDash sends

When `telemetry.enabled` is `true`, ChDash sends these items:

- One SERVER span for each request that gets to `POST /mcp`. This includes a request that has no valid key, a request that the `Origin` check refuses and a request that the rate limit refuses.
- One CLIENT span for each ClickHouse statement of the call. The span is a child of the SERVER span. The statements of an API tool are children too, because the route of an API tool runs in the process.
- The call log `mcp.call` as an OTLP log record, when `telemetry.call_log` is `true` (the default). The JSON line of the log is always written. Refer to [mcp.md](mcp.md#call-log).
- One CLIENT span for each call to the PDP of the access of humans, when `access.mode` is `authzen` (refer to [The CLIENT span of the PDP](#the-client-span-of-the-pdp)).

ChDash sends no metric with OTLP. The metrics are on `GET /metrics` (refer to [operations.md](operations.md)).

## Configuration

```hcl
telemetry {
  enabled               = true
  otlp_endpoint         = "http://otel-collector:4318"
  service_name          = "chdash"
  export_interval       = "5s"
  export_timeout        = "10s"
  connect_timeout       = "2s"
  max_queue_size        = 2048
  max_export_batch_size = 512
  call_log              = true
}
```

[configuration-reference.md](configuration-reference.md#telemetry) gives the type, the default and the range of each key. These rules apply:

- The block is closed. An unknown attribute, an unknown block and an attribute that is in the block two times stop the start.
- `otlp_endpoint` is required when `enabled` is `true`. It has three forms: `otlp_endpoint = "http://..."` (the value is in the file), `otlp_endpoint_env = "VAR"` (the value is in the environment variable `VAR`) and `otlp_endpoint_file = "/path"` (the value is the content of the file, without its last line end). Give only one form. A variable that does not exist, an empty value and a file that ChDash cannot read stop the start.
- The endpoint is `http://host[:port][/path]`. ChDash sends the spans to `<endpoint>/v1/traces` and the log records to `<endpoint>/v1/logs`. The endpoint must not hold a user, a password, a query or a fragment.
- A duration is an integer and one unit: `ms`, `s`, `m` or `h` (for example `"500ms"` or `"15s"`). ChDash does not change a value to make it fit. A value outside its range stops the start, and the error gives the key, the range and the value.
- `max_export_batch_size` must be at most `max_queue_size`. `connect_timeout` must be at most `export_timeout`. Two values that do not agree stop the start.
- ChDash reads no `OTEL_*` environment variable. It has no OpenTelemetry SDK. To take the endpoint from such a variable, name it: `otlp_endpoint_env = "OTEL_EXPORTER_OTLP_ENDPOINT"`.
- When `enabled` is `true`, `mcp.enabled` is `false` and `access.mode` is `open`, ChDash starts and writes a warning: there is nothing to send.

`chdash --config <file> --print-config` shows each value that applies and its source. For `otlp_endpoint`, the source is `file`, `env:VAR` or `file:/path`.

## The protocol

ChDash uses OTLP/HTTP with the JSON encoding of OTLP. It does not use the protobuf encoding. Each export is one `POST` with `Content-Type: application/json`. A trace id and a span id are lower-case hexadecimal text, and a 64-bit integer is a string, as the OTLP JSON encoding tells.

ChDash has no TLS client. Thus the endpoint must use `http`, and an `https` endpoint stops the start. Send the data to a collector on the same host or in the same pod (a sidecar), and let that collector send it on with TLS. ChDash sends no authentication header and does not compress the body.

The resource of each item has these attributes:

| Attribute | Value |
| --- | --- |
| `service.name` | `telemetry.service_name`. |
| `service.version` | The version of ChDash. |
| `service.instance.id` | The name of the instance: `mcp.usage.instance`, else the host name of the machine. |

The instrumentation scope is `chdash`, with the version of ChDash.

## The SERVER span

The name of the span is `{mcp.method.name} {gen_ai.tool.name}`, for example `tools/call query_table`. If the request has no tool, the name is `{mcp.method.name}`, for example `tools/list`. A request that ChDash refuses before it reads the message has the name `request`.

| Attribute | Value |
| --- | --- |
| `mcp.method.name` | The JSON-RPC method, as in the call log. |
| `gen_ai.tool.name` | The tool of a `tools/call`. Absent for another method. |
| `gen_ai.operation.name` | `execute_tool` for a `tools/call`. |
| `mcp.protocol.version` | The protocol version of the request. Absent when the request names none. |
| `jsonrpc.request.id` | The JSON-RPC id of the request, as text. Absent for a notification. |
| `client.address` | The TCP peer address. |
| `error.type` | The `status` of the call log, when the call failed (for example `401`, `rpc_-32601` or `timeout`). Absent when the call succeeded. |
| `gen_ai.conversation.id` | `agent.run_id` of the baggage. |
| `agent.run_id`, `agent.caller`, `agent.on_behalf_of` | The three values of the baggage. |

An attribute without a value is absent. When the call failed, the status of the span is `ERROR` and its message is the `status` of the call log. The span has no `mcp.session.id`. It never has the arguments or the result of a tool.

The trace context of the request gives the trace and the parent of the span (refer to [mcp.md](mcp.md#trace-context)). ChDash reads it in `params._meta` first, and then in the `traceparent` and `baggage` headers. Without a valid context, the span starts a new trace. The `trace_id` and the `span_id` of the call log are the identifiers of this span.

If the flag `sampled` of `traceparent` is 0, ChDash sends no span for the request. The call log and its OTLP log record still have the identifiers.

## The child spans

Each ClickHouse statement of the call makes one CLIENT span. The parent of the span is the SERVER span.

| Attribute | Value |
| --- | --- |
| `db.system.name` | `clickhouse`. |
| `db.operation.name` | The first word of the statement: `SELECT`, `SHOW`, `DESCRIBE`, `EXPLAIN` and the other statement words. Absent when the first word is not a known statement word. |
| `server.address`, `server.port` | The ClickHouse server of the connection. |
| `db.response.status_code` | The code of the ClickHouse error, when the server sent one. |
| `error.type` | When the statement failed: the code of the ClickHouse error, `canceled` (the client went away), `connection` (a socket error) or `client` (a different error). |

The name of the span is `db.operation.name`, or `clickhouse` when the first word is not known. The span never has the text of the statement, its parameters or its rows. A statement that ChDash stops on purpose when it has enough rows (codes 394 and 735) is not a failure. ChDash keeps at most 256 statements for one call. It drops the others.

ChDash does not send the trace context to ClickHouse. Thus the spans that ClickHouse writes in `system.opentelemetry_span_log` are not in the trace of the call.

## The log record

The OTLP log record of a call has these properties:

- The event name and the body are `mcp.call`. The severity is `INFO` (9).
- The attributes are the fields of the JSON line `mcp.call` (refer to [mcp.md](mcp.md#call-log)), with the same names and values.
- `traceId` and `spanId` are the identifiers of the SERVER span.

The record never holds an argument of a tool, SQL, data or a token.

## The CLIENT span of the PDP

In the `authzen` mode of the access of humans ([access.md](access.md)), each call of ChDash to the PDP is one CLIENT span:

- The name is `POST /access/v1/evaluation` (one question) or `POST /access/v1/evaluations` (a batch).
- The parent is the span of the `traceparent` header of the request of the page or of the API. When the request has no `traceparent`, the span starts a trace. When the `traceparent` is not sampled, ChDash sends no span.
- The attributes are `http.request.method`, `server.address`, `server.port`, `url.path`, `authzen.evaluations` (the number of questions) and `http.response.status_code` when the PDP answered.
- A call that gives no valid answer (no answer before `pdp.timeout`, a status that is not 200, a body that is not an answer) has the status ERROR and `error.type` (the status, or `no_answer`).
- ChDash sends the context of this span to the PDP in the `traceparent` header of the call.

The span never has the subject, the token or the decisions. The log line `access.decision` has them ([access.md](access.md#logs-and-traces)).

## The queue and the batches

A request never waits for the export. It puts its items in a queue in memory and continues. Each signal (spans and log records) has its own queue. One thread sends the queues:

- It sends a batch when the queue holds `max_export_batch_size` items, or when the oldest item waited `export_interval`.
- One batch is at most `max_export_batch_size` items.
- When a queue holds `max_queue_size` items, ChDash drops a new item and counts it. The spans of one request go in the queue all together, or ChDash drops all of them.
- When the receiver answers 429, 502, 503 or 504, or does not answer, ChDash sends the batch again after 0.5 s and after 1 s more. After three failures, ChDash drops the batch and counts it. ChDash drops a batch at once when the receiver answers a different error (for example 400).
- One request to the receiver takes at most `export_timeout`. The connection takes at most `connect_timeout`.
- At the stop of the server, ChDash sends the items that wait. It sends them for at most `export_timeout`, and only in the time of the stop (`server.shutdown_timeout_ms`). Then it drops the remaining items and counts them.

When a batch fails, ChDash writes a line `telemetry.export_failed` to its log. It writes at most one line for each signal in each minute.

## Metrics

`GET /metrics` has these metric families when the export is on. The label `signal` is `spans` or `logs`.

| Metric | Type | Meaning |
| --- | --- | --- |
| `chdash_telemetry_exported_total{signal}` | counter | The items that the receiver accepted. |
| `chdash_telemetry_dropped_total{signal,reason}` | counter | The items that ChDash did not send. `reason` is `queue_full` (the queue was full), `export_failed` (the receiver did not accept the batch) or `shutdown` (the items that remained at the stop). |
| `chdash_telemetry_export_requests_total{signal,result}` | counter | The requests to the receiver. `result` is `ok` or `error`. A second attempt is one more request. |
| `chdash_telemetry_queue_items{signal}` | gauge | The items that wait in the queue. |

Monitor `chdash_telemetry_dropped_total`. If the `queue_full` value increases, the receiver is too slow or down. Increase `max_queue_size`, or repair the receiver.

## Tests

- `tests/native/telemetry_test.cpp` (CMake option `CHDASH_BUILD_TELEMETRY_TESTS`, target `chdash_telemetry_test`) tests the durations, the endpoint, the JSON of the two requests, the spans and the log record of a call, and the exporter against a fake OTLP receiver in the process: the batches, the interval, the queue that drops, the retries and the stop.
- `tests/native/config_test.cpp` tests the errors of the `telemetry` block.
- `tests/backend-functional/test_access.py` reads the CLIENT span of a call to the PDP (the compose services `chdash_access` and `access_otlp_receiver`).
- `tests/backend-functional/test_mcp_telemetry.py` calls a server that sends to a fake receiver (the compose services `chdash_mcp_telemetry` and `otlp_receiver`, with `tests/otel-fixture/otlp_receiver.py`). It reads the spans and the log records that the receiver got.
