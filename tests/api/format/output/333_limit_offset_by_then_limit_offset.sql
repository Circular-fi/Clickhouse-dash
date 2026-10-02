SELECT
    entity_group,
    entity_key,
    metric_value
FROM anon.metrics_store
ORDER BY metric_value DESC
LIMIT 1, 3 BY entity_group, region_code
LIMIT 10, 50