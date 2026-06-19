SELECT
    entity_group,
    entity_key,
    metric_value,
    row_number() OVER (
        PARTITION BY entity_group
        ORDER BY
            metric_value DESC,
            entity_key ASC
    ) AS `group_rank`
FROM anon.grouped_metrics
ORDER BY
    entity_group ASC,
    group_rank ASC
