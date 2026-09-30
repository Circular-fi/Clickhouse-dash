-- keep the latest row per key
SELECT DISTINCT ON (service_name, span_name)
    service_name,
    span_name,
    duration_ms
FROM otel.traces
ORDER BY timestamp desc