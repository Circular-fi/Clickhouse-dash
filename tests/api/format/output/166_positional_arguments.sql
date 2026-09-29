SELECT
    entity_group,
    entity_key,
    sum(metric_value)
FROM anon.metrics_store
GROUP BY
    1,
    2
ORDER BY 3 DESC
SETTINGS enable_positional_arguments = 1