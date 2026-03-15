SELECT
    filtered_src.entity_group,
    filtered_src.entity_key,
    filtered_src.metric_value,
    filtered_src.metric_ratio
FROM
(
    SELECT
        ranked_src.entity_group,
        ranked_src.entity_key,
        ranked_src.metric_value,
        ranked_src.metric_ratio,
        ranked_src.metric_rank
    FROM
    (
        SELECT
            entity_group,
            entity_key,
            metric_value,
            metric_ratio,
            row_number() OVER (
                PARTITION BY entity_group
                ORDER BY
                    metric_value DESC,
                    entity_key ASC
            ) AS metric_rank
        FROM anon.metrics_store
        PREWHERE event_date >= toDate('2026-01-01')
        WHERE metric_ratio > 0
    ) AS ranked_src
    WHERE ranked_src.metric_rank <= 10
) AS filtered_src
ORDER BY
    filtered_src.entity_group ASC,
    filtered_src.metric_value DESC,
    filtered_src.entity_key ASC
LIMIT 2 BY filtered_src.entity_group
LIMIT 20
