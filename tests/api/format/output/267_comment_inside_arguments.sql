SELECT
    coalesce(
        span_attributes['http.route'], -- preferred when the router sets it
        span_name,
        'unknown'
    ) AS `route`
FROM otel.traces