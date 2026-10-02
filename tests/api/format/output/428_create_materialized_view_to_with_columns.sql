CREATE MATERIALIZED VIEW IF NOT EXISTS anon.daily_rollup_mv
TO anon.daily_rollup
(
    `event_day`   Date,
    `entity_key`  String,
    `event_count` UInt64,
    `value_sum`   Float64
) AS
SELECT
    toDate(event_timestamp) AS `event_day`,
    entity_key,
    count()            AS `event_count`,
    sum(metric_value)  AS `value_sum`
FROM anon.events_store
GROUP BY
    event_day,
    entity_key