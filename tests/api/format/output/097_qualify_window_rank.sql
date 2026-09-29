SELECT
    entity_key,
    metric_value,
    row_number() OVER (
        PARTITION BY entity_group
        ORDER BY metric_value DESC
    ) AS `group_rank`
FROM anon.metrics_store
WHERE metric_value > 0
QUALIFY group_rank <= 3