-- INPUT
SELECT
    entity_key,
    sum(metric_value) AS total_metric_value
FROM anon.metrics_store
GROUP BY entity_key
ORDER BY total_metric_value DESC
LIMIT 100
SETTINGS max_threads = 4, max_block_size = 65536

-- EXPECTED
SELECT
    entity_key,
    sum(metric_value) AS `total_metric_value`
FROM anon.metrics_store
GROUP BY entity_key
ORDER BY total_metric_value DESC
LIMIT 100
SETTINGS max_threads = 4, max_block_size = 65536
