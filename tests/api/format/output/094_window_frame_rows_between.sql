SELECT
    entity_key,
    event_date,
    avg(metric_value) OVER (
        PARTITION BY entity_key
        ORDER BY event_date ASC
        ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
    ) AS `moving_avg_7d`
FROM anon.metrics_store