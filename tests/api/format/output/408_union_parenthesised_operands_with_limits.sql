SELECT
    entity_key,
    metric_value
FROM anon.metrics_store
ORDER BY metric_value DESC
LIMIT 5
UNION ALL
SELECT
    entity_key,
    metric_value
FROM anon.archive_store
ORDER BY metric_value DESC
LIMIT 5