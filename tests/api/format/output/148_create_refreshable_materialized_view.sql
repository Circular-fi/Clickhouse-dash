CREATE MATERIALIZED VIEW anon.daily_mv
REFRESH EVERY 1 HOUR OFFSET 5 MINUTE
TO anon.daily
AS
SELECT
    toDate(event_timestamp)  AS `event_day`,
    sum(metric_value)        AS `total_metric`
FROM anon.metrics_store
GROUP BY event_day