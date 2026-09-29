INSERT INTO anon.metrics_copy(entity_key, metric_value)
SETTINGS async_insert = 1
SELECT
    entity_key,
    metric_value
FROM anon.metrics_store
WHERE metric_value > 0