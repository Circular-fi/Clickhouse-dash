SELECT
    entity_key,
    metric_value - lagInFrame(metric_value) OVER (
        PARTITION BY entity_key
        ORDER BY event_date ASC
    ) AS `day_over_day`,
    100 * metric_value / sum(metric_value) OVER (
        PARTITION BY event_date
    ) AS `share_percent`
FROM anon.metrics_store