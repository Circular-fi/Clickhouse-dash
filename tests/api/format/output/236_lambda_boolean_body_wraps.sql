SELECT
    arrayFilter(
        s -> s.duration_ms > 250
            AND s.status = 'error'
            AND s.service NOT IN ('healthcheck', 'metrics-scraper'),
        spans
    ) AS `slow_error_spans`
FROM otel.trace_rollups