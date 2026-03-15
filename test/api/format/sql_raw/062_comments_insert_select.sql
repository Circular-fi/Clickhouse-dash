INSERT INTO anon.metrics_store SELECT
    entity_key,
    event_date,
    event_timestamp,
    entity_group,
    metric_value,
    metric_ratio,
    tag_values,
    attr_map
FROM anon.metrics_store
WHERE (event_date = toDate('2026-01-31')) AND (metric_value > 0)
