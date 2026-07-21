CREATE VIEW anon.metrics_store_view AS
SELECT
    entity_key,
    event_date,
    metric_value,
    metric_ratio
FROM anon.metrics_store
WHERE metric_value > 0
