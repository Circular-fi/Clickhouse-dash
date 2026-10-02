SELECT
    entity_key,
    metric_value,
    rank() OVER (
        PARTITION BY entity_group
        ORDER BY metric_value DESC
    ) AS `value_rank`,
    dense_rank() OVER (
        PARTITION BY entity_group
        ORDER BY metric_value DESC
    ) AS `dense_value_rank`,
    percent_rank() OVER (
        PARTITION BY entity_group
        ORDER BY metric_value DESC
    ) AS `value_percent_rank`,
    ntile(4) OVER (ORDER BY metric_value ASC) AS `value_quartile`
FROM anon.metrics_store