SELECT
    ranked_src.entity_key,
    ranked_src.entity_group,
    ranked_src.metric_value,
    ranked_src.metric_rank,
    ranked_src.group_total_metric_value
FROM
(
    SELECT
        union_src.entity_key,
        union_src.entity_group,
        union_src.metric_value,
        row_number() OVER (PARTITION BY union_src.entity_group ORDER BY union_src.metric_value DESC, union_src.entity_key ASC) AS metric_rank,
        sum(union_src.metric_value) OVER (PARTITION BY union_src.entity_group) AS group_total_metric_value
    FROM
    (
        SELECT
            entity_key,
            entity_group,
            metric_value
        FROM anon.metrics_store
        WHERE event_date = toDate('2026-01-01')
        UNION ALL
        SELECT
            entity_key,
            entity_group,
            metric_value
        FROM anon.metrics_store
        WHERE event_date = toDate('2026-01-02')
    ) AS union_src
) AS ranked_src
WHERE (ranked_src.metric_rank <= 3) AND (ranked_src.group_total_metric_value > 0)
ORDER BY
    ranked_src.entity_group ASC,
    ranked_src.metric_rank ASC,
    ranked_src.entity_key ASC
