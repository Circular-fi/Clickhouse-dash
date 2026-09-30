SELECT
    l.trace_id,
    l.body,
    t.span_name
FROM otel.logs AS l
INNER JOIN otel.traces AS t
    ON t.trace_id = l.trace_id
    AND toStartOfMinute(t.timestamp) = toStartOfMinute(l.timestamp)
    AND lower(t.service_name) = lower(l.service_name)