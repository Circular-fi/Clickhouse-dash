EXPLAIN SYNTAX
SELECT
    entity_key,
    sum(metric_value) AS total_metric_value
FROM anon.metrics_store
GROUP BY entity_key
ORDER BY total_metric_value DESC
LIMIT 10