SELECT
    entity_key,
    metric_value,
    metric_ratio
FROM anon.metrics_store
WHERE (event_date >= toDate('2026-01-01')) AND (metric_value > 0)
ORDER BY
    metric_value DESC,
    entity_key ASC
LIMIT 50
