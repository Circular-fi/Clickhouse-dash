SELECT
    entity_group,
    entity_key,
    metric_value
FROM anon.metrics_store
ORDER BY
    entity_group ASC,
    metric_value DESC
LIMIT 1, 2 BY entity_group
LIMIT 100