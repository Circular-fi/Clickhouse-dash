EXPLAIN actions = 1, header = 1
SELECT
    entity_group,
    count() AS row_count
FROM anon.metrics_store
WHERE metric_value > 0
GROUP BY entity_group