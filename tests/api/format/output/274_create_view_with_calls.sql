CREATE VIEW otel.error_routes AS
SELECT
    coalesce(
        nullIf(span_attributes['http.route'], ''),
        nullIf(span_attributes['url.path'], ''),
        span_name
    ) AS `route`,
    countIf(status_code = 'STATUS_CODE_ERROR') AS `errors`
FROM otel.traces
GROUP BY route