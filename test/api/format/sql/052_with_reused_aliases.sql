WITH
    toDate('2026-02-01')                AS `current_day`,
    current_day - toIntervalDay(7)      AS `previous_week_day`,
    current_day - toIntervalMonth(1)    AS `previous_month_day`
SELECT
    entity_key,
    metric_value,
    current_day,
    previous_week_day,
    previous_month_day
FROM anon.metrics_store
WHERE
    event_date >= previous_month_day
    AND event_date <= current_day