SELECT
    entity_key,
    event_date,
    metric_value
FROM anon.metrics_store
WHERE entity_group = 'group_live'
QUALIFY
    row_number() OVER (PARTITION BY entity_key ORDER BY event_date DESC) <= 3
    AND metric_value > avg(metric_value) OVER (
        PARTITION BY entity_key
    )
ORDER BY
    entity_key ASC,
    event_date DESC