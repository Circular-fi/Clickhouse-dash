SELECT
    entity_key,
    event_date,
    sum(metric_value) OVER (
        PARTITION BY entity_key
        ORDER BY event_date ASC
        ROWS BETWEEN 3 PRECEDING AND 3 FOLLOWING
    ) AS `centered_sum`,
    max(metric_value) OVER (
        PARTITION BY entity_key
        ORDER BY event_date ASC
        ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING
    ) AS `future_max`,
    min(metric_value) OVER (
        PARTITION BY entity_key
        ORDER BY event_date ASC
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS `running_min`
FROM anon.metrics_store