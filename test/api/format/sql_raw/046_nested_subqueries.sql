SELECT
    outer_src.entity_key,
    outer_src.metric_value
FROM
(
    SELECT
        inner_src.entity_key,
        max(inner_src.metric_value) AS metric_value
    FROM
    (
        SELECT
            entity_key,
            metric_value
        FROM anon.metrics_store
        WHERE event_date >= toDate('2026-01-01')
    ) AS inner_src
    GROUP BY inner_src.entity_key
) AS outer_src
WHERE outer_src.metric_value > 0
ORDER BY
    outer_src.metric_value DESC,
    outer_src.entity_key ASC
