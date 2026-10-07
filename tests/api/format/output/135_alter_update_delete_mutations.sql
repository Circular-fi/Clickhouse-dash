ALTER TABLE anon.metrics_store
UPDATE
    metric_value = 0,
    metric_ratio = metric_ratio / 2
WHERE
    entity_group = 'group_reset'
    AND event_date < today()