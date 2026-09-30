INSERT INTO otel.service_hourly
SELECT
    service_name,
    toStartOfHour(timestamp)                    AS `hour`,
    countIf(status_code = 'STATUS_CODE_ERROR')  AS `errors`,
    quantilesTDigest(0.5, 0.9, 0.99)(
        duration_ns / 1000000
    ) AS `latency_ms_quantiles`
FROM otel.traces
WHERE timestamp >= toStartOfHour(now() - toIntervalHour(1))
GROUP BY
    service_name,
    hour