SELECT trace_id
FROM otel.trace_rollups
WHERE arrayExists(
        s -> s.status = 'error'
            AND s.duration_ms > 1000
            AND s.service_name = 'checkout',
        spans
    )