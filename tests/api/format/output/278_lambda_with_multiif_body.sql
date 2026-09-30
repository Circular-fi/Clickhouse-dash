SELECT
    arrayMap(
        x -> multiIf(
            x < 100, 'quick',
            x < 1000, 'ok',
            'slow'
        ),
        durations
    ) AS `classes`,
    arrayMap(x -> if(x < 100, 'quick', 'slow'), durations) AS `coarse_classes`
FROM otel.trace_rollups