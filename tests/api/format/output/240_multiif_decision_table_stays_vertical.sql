SELECT
    sum(
        multiIf(
            status >= 500, 5,
            status >= 400, 1,
            0
        )
    ) AS `penalty`,
    multiIf(
        latency_ms < 100, 'fast',
        latency_ms < 1000, 'normal',
        'slow'
    ) AS `latency_class`
FROM http.access_log
GROUP BY latency_class