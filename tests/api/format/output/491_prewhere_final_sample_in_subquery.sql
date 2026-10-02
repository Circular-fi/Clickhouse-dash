SELECT
    entity_group,
    avg(metric_value) AS `avg_value`
FROM
(
    SELECT
        entity_group,
        metric_value
    FROM anon.metrics_store FINAL
    SAMPLE 1 / 10
    PREWHERE event_date = yesterday()
    WHERE metric_value IS NOT NULL
)
GROUP BY entity_group