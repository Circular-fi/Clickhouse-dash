CREATE MATERIALIZED VIEW IF NOT EXISTS anon.entity_hourly_rollup_mv
TO anon.entity_hourly_rollup_target
AS
SELECT
    toStartOfHour(event_timestamp) AS `event_hour`,
    entity_key,
    count() AS `event_count`
FROM anon.metrics_store
GROUP BY
    event_hour,
    entity_key