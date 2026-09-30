SELECT
    toStartOfInterval(timestamp, toIntervalMinute(5))  AS `bucket`,
    coalesce(nullIf(route, ''), 'unknown')             AS `route_label`,
    if(duration_ms > 1000, 'slow', 'quick')            AS `speed`,
    count()                                            AS `spans`
FROM otel.traces
GROUP BY
    bucket,
    route_label,
    speed