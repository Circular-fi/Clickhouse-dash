EXPLAIN indexes = 1, actions = 1
SELECT
    entity_key,
    sum(metric_value)
FROM anon.metrics_store
WHERE event_date = today()
GROUP BY entity_key