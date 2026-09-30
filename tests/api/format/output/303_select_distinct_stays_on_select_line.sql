SELECT DISTINCT
    service_name,
    span_name,
    toStartOfHour(timestamp) AS `hour`
FROM otel.traces
WHERE duration_ms > 1000