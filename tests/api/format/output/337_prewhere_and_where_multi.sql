SELECT
    entity_key,
    metric_value
FROM anon.metrics_store
PREWHERE
    event_date >= '2026-01-01'
    AND entity_group IN ('group_live', 'group_buffer')
WHERE
    metric_value > 0
    AND NOT is_deleted