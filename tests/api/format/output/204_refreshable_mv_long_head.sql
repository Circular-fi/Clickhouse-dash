CREATE MATERIALIZED VIEW IF NOT EXISTS anon.daily_entity_rollup_mv
REFRESH EVERY 1 HOUR OFFSET 5 MINUTE RANDOMIZE FOR 1 MINUTE
TO anon.daily_entity_rollup
AS
SELECT
    toDate(event_timestamp) AS `event_day`,
    entity_key,
    sum(metric_value) AS `total_metric`
FROM anon.metrics_store
GROUP BY
    event_day,
    entity_key