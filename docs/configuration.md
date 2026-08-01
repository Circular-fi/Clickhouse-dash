# Configuration reference verified from the source

The binary has two mutually exclusive configuration paths:

- `chdash --config /path/config.hcl` reads only that file. Application
  environment variables are not consulted, even when they are set.
- `chdash` without `--config` keeps the legacy environment behavior. `CH_HOSTS`
  remains required in this mode.

`--health` can be combined in either order, for example
`chdash --config /etc/clickhouse-dash/config.hcl --health`.

The full syntax is shown in [`config.example.hcl`](../config.example.hcl).
Unknown blocks, unknown attributes, duplicate attributes, and incorrect HCL
types are startup errors. Missing optional attributes retain their historical
defaults.

## Environment to HCL mapping and actual effect

The effects below follow the value from the loader to its consumer in the C++
source; they are not inferred from the previous README descriptions.

| Environment variable | HCL equivalent | Default | Effect in the code |
|---|---|---:|---|
| `LISTEN_HOST` | `server.listen_host` | `0.0.0.0` | Forms `AppConfig.listen`; `Server::run()` passes the host to the HTTP listener. |
| `LISTEN_PORT` | `server.listen_port` | `8080` | Forms `AppConfig.listen`; `Server::run()` passes the parsed port to the HTTP listener. |
| `CH_HOSTS` | `health` and `clickhouse` blocks | required | Parses the health settings and repeated hosts. `runner_uri` is used for health, user queries, formatting, and visibility-scoped metadata; `system_uri` is used for global metadata, cancellation, capability checks, and optional final query-log statistics. |
| `RESULT_PREVIEW_ROW_LIMIT` | `query.result_preview_row_limit` | `10000` | Stops emitting result rows at the limit, reports `result_limit_reached`, and marks the result as truncated. `0` means unlimited. Startup clamps it to `0..10000000`. |
| `QUERY_MAX_SQL_BYTES` | `query.max_sql_bytes` | `4194304` | Rejects `/api/query/run` SQL larger than this value with HTTP 413 before allocating a session. Startup clamps it to `1024..67108864`. It does not control the separate formatter limit. |
| `QUERY_DESCRIBE_MODE` | `query.describe_mode` | `auto` | Selects result-transport planning: `always` runs `DESCRIBE` first, `never` uses the fast native path, and `auto` describes likely complex results or retries a compatible query after a native decode failure. |
| `QUERY_FINAL_STATS_FROM_QUERY_LOG` | `query.final_stats_from_query_log` | `false` | After the result stream completes, optionally queries `system.query_log` up to five times to refine read-row, read-byte, and memory totals. It adds an extra system-account query. |
| `QUERY_FINAL_STATS_FLUSH_LOGS` | `query.final_stats_flush_logs` | `false` | When final query-log statistics are enabled, runs `SYSTEM FLUSH LOGS query_log` before each lookup attempt. It has no effect while final query-log statistics are disabled. |
| `QUERY_SAMPLE_INTERVAL_MS` | `query.sample_interval_ms` | `40` | Minimum interval between in-memory telemetry sample points. Each session clamps it to `10..1000` ms, and retains at most 512 points. |
| `QUERY_RESULT_BATCH_ROWS` | `query.result_batch_rows` | `1000` | Maximum rows encoded into one `result_rows` SSE event. Non-positive values become 1000 and values above 10000 become 10000. |
| `QUERY_RESULT_BATCH_BYTES` | `query.result_batch_bytes` | `262144` | Approximate encoded-byte threshold for one `result_rows` SSE event; one oversized row is still allowed. Each session clamps it to `16384..4194304`. |
| `QUERY_SSE_BATCH_EVENTS` | `query.sse_batch_events` | `8` | Maximum already-framed SSE events coalesced into one socket write. Each session clamps it to `1..64`. |
| `QUERY_SSE_BATCH_BYTES` | `query.sse_batch_bytes` | `262144` | Byte threshold for a coalesced SSE socket write. Each session clamps it to `16384..4194304`. |
| `QUERY_SSE_QUEUE_MAX_BYTES` | `query.sse_queue_max_bytes` | `8388608` | Bounds the per-query producer queue. When the browser/proxy is slower, the query thread waits until the stream drains data. A single event is always accepted into an empty queue. The value is clamped to at least the SSE write size and at most 128 MiB. |
| `QUERY_DESCRIBE_CACHE_ENTRIES` | `query.describe_cache_entries` | `256` | Maximum global cached compatibility plans keyed by SQL/schema identity. `0` disables the cache; each session caps it at 4096. |
| `QUERY_DESCRIBE_CACHE_TTL_MS` | `query.describe_cache_ttl_ms` | `60000` | Expiration time for cached compatibility plans. `0` disables the cache; each session caps it at one hour. |
| `CH_CLIENT_POOL_MAX_IDLE` | `client_pool.max_idle` | `4` | Maximum returned native clients retained per URI-and-timeout key. `0` makes every released client close; startup caps it at 64. |
| `CH_CLIENT_POOL_IDLE_TTL_MS` | `client_pool.idle_ttl_ms` | `60000` | Drops pooled sockets after this idle time, both during acquisition and in the reaper. `0` disables TTL expiry and prevents the pool reaper thread from starting. Startup caps it at 24 hours. |
| `CH_CLIENT_POOL_VALIDATE_AFTER_IDLE_MS` | `client_pool.validate_after_idle_ms` | `15000` | After this idle duration, bounded-timeout clients are pinged before reuse. Long-query clients have an unbounded receive timeout, so they are discarded and recreated instead of pinged. `0` disables this check. |
| `CH_CLIENT_POOL_REAPER_INTERVAL_MS` | `client_pool.reaper_interval_ms` | `5000` | Sleep interval of the background idle-client cleanup loop. Startup clamps it to `250..60000` ms. |
| `FORMAT_CACHE_MAX_ENTRIES` | `format_cache.max_entries` | `512` | LRU entry limit for deterministic formatted SQL results. `0` disables reads and writes. Startup caps it at 100000. |
| `FORMAT_CACHE_MAX_BYTES` | `format_cache.max_bytes` | `16777216` | Total approximate bytes allowed for formatting cache keys and values. Oversized entries are skipped and LRU entries are evicted to stay below the limit. `0` disables the cache. |
| `FORMAT_CACHE_TTL_MS` | `format_cache.ttl_ms` | `600000` | Lifetime of formatted SQL cache entries. `0` disables the cache; startup caps it at 24 hours. |
| `QUERY_SESSION_MAX_COUNT` | `query.session_max_count` | `256` | Rejects a new `/api/query/run` with HTTP 429 when the in-memory session map reaches this size. Startup clamps it to `1..100000`. |
| `QUERY_SESSION_ABANDONED_TTL_MS` | `query.session_abandoned_ttl_ms` | `60000` | Reaps a created query whose SSE consumer never attached after this age. Startup enforces at least 1000 ms. |
| `QUERY_SESSION_TERMINAL_TTL_MS` | `query.session_terminal_ttl_ms` | `30000` | Retains finished, failed, canceled, or truncated sessions for this long before reaping. `0` makes terminal sessions immediately eligible. |
| `QUERY_SESSION_REAPER_INTERVAL_MS` | `query.session_reaper_interval_ms` | `5000` | Controls how often the server scans sessions for abandoned or terminal entries. The server clamps it to `250..60000` ms. |

## Password files

Inside `clickhouse.host`, `password_file` applies to both `runner_uri` and
`system_uri`. `runner_password_file` and `system_password_file` override it per
role. The URI must contain the username but no password:

```hcl
clickhouse {
  host {
    name          = "local"
    runner_uri    = "clickhouse://internalsvc@clickhouse:9000"
    system_uri    = "clickhouse://internalsvc@clickhouse:9000"
    password_file = "/run/secrets/clickhouse_password"
  }
}
```

The file is read when a native ClickHouse client is created. One final LF or
CRLF is removed; other whitespace is preserved. A NUL byte, an unreadable file,
or combining a URI password with a password file causes client creation to
fail. Docker Compose can provide the file without exposing its value to the
application environment:

```yaml
services:
  clickhouse-dash:
    command: ["--config", "/etc/clickhouse-dash/config.hcl"]
    configs:
      - source: clickhouse_dash_config
        target: /etc/clickhouse-dash/config.hcl
    secrets:
      - source: clickhouse_password
        target: clickhouse_password

secrets:
  clickhouse_password:
    environment: CLICKHOUSE_PASSWORD
```
