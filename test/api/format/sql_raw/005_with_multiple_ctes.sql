WITH
    toDate('2026-01-01') AS range_start,
    toDate('2026-01-31') AS range_end,
    (
        SELECT avg(metric_value)
        FROM anon.daily_metrics
        WHERE (event_date >= range_start) AND (event_date <= range_end)
    ) AS average_metric_value
SELECT
    account_key,
    event_date,
    metric_value,
    average_metric_value
FROM anon.daily_metrics
WHERE ((event_date >= range_start) AND (event_date <= range_end)) AND (metric_value >= average_metric_value)
ORDER BY
    event_date ASC,
    account_key ASC
