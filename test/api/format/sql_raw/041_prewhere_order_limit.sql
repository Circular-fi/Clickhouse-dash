SELECT
    entity_key,
    event_timestamp,
    metric_value
FROM anon.metrics_store
PREWHERE event_date >= toDate('2026-01-01')
WHERE entity_group = 'group_live'
ORDER BY
    event_timestamp DESC,
    entity_key ASC
LIMIT 50
