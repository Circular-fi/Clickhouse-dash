SELECT
    mapApply(
        (k, v) -> (k, v * 2),
        map('checkout', 1, 'payments', 2)
    ) AS `doubled`,
    arrayMap(
        (name, ts) -> (name, toStartOfMinute(ts)),
        events_name,
        events_timestamp
    ) AS `minute_events`,
    arrayFold(
        (acc, x) -> (acc.2, acc.2 + acc.1),
        range(10),
        (toInt64(1), toInt64(0))
    ).1 AS `fib`
FROM otel.traces