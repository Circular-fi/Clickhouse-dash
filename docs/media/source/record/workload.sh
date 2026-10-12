#!/bin/bash
# A believable workload for the System pages: a few query shapes, run several times as the video's runner user,
# then the query log is flushed so that the Queries page and the performance charts have rows in the last hour.
CH="docker exec -i chdash-tests-clickhouse clickhouse-client"
R="$CH -u dash_runner --password video_runner_pw"
run() { n=$1; shift; for i in $(seq 1 "$n"); do $R --log_comment=checkout-dashboard -q "$1" >/dev/null 2>&1; done; }
run 14 "SELECT ServiceName, count() AS spans, countIf(StatusCode = 'Error') AS errors FROM otel.otel_traces WHERE Timestamp >= '2026-09-12' AND Timestamp < '2026-09-13' GROUP BY ServiceName ORDER BY errors DESC"
run 9  "SELECT SpanName, quantile(0.99)(Duration) / 1e6 AS p99_ms FROM otel.otel_traces WHERE Timestamp >= '2026-09-12' AND Timestamp < '2026-09-13' AND ServiceName = 'payments' GROUP BY SpanName ORDER BY p99_ms DESC LIMIT 20"
run 11 "SELECT toStartOfHour(Timestamp) AS hour, count() AS spans FROM otel.otel_traces WHERE Timestamp > '2026-09-19' GROUP BY hour ORDER BY hour"
run 8  "SELECT database, table, sum(bytes_on_disk) AS bytes FROM system.parts WHERE active GROUP BY database, table ORDER BY bytes DESC LIMIT 10"
run 20 "SELECT city, avg(temperature_c) AS avg_temp FROM chdash_ui.weather_observations GROUP BY city ORDER BY avg_temp DESC LIMIT 10"
run 16 "SELECT station_id, max(temperature_c), min(temperature_c) FROM chdash_ui.weather_observations WHERE observed_at > '2020-01-01' GROUP BY station_id"
run 6  "SELECT Body FROM otel.otel_logs WHERE Timestamp >= '2026-09-12 15:00:00' AND Timestamp < '2026-09-12 16:00:00' AND SeverityText = 'ERROR' LIMIT 100"
run 5  "SELECT TraceId, count() AS spans FROM otel.otel_traces WHERE Timestamp >= '2026-09-12 14:00:00' AND Timestamp < '2026-09-12 16:00:00' GROUP BY TraceId ORDER BY spans DESC LIMIT 20"
docker exec chdash-tests-clickhouse clickhouse-client -u test --password test -q "SYSTEM FLUSH LOGS"
