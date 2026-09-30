SELECT
    coalesce(
        nullIf(span_attributes['http.route'], ''),
        nullIf(span_attributes['url.path'], ''),
        span_name
    ) AS `route`
FROM otel.traces
WHERE service_name = 'frontend'