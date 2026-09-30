SELECT *
FROM otel.traces
WHERE
    timestamp >= toStartOfInterval(
        now() - toIntervalHour(3),
        toIntervalMinute(5)
    )
    AND timestamp < toStartOfInterval(now(), toIntervalMinute(5))
    AND service_name = 'checkout'