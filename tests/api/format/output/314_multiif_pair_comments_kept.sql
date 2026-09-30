SELECT
    multiIf(
        duration_ms > 1000, 'slow', -- over a second
        duration_ms > 100, 'medium', -- over 100 ms
        'fast' -- everything else
    ) AS `speed`,
    coalesce(
        -- prefer the route attribute
        span_attributes['http.route'],
        span_name
    ) AS `route`
FROM otel.traces