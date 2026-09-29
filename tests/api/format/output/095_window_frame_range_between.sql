SELECT
    entity_key,
    sum(metric_value) OVER (
        PARTITION BY entity_group
        ORDER BY event_timestamp ASC
        RANGE BETWEEN 3600 PRECEDING AND UNBOUNDED FOLLOWING
    ) AS `forward_sum`,
    count() OVER (
        ORDER BY event_timestamp ASC
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS `running_count`
FROM anon.metrics_store