SELECT
    event_minute,
    entity_key,
    metric_value
FROM anon.metrics_store
ORDER BY
    entity_key ASC WITH FILL,
    event_minute ASC WITH FILL STEP 60 STALENESS 600
INTERPOLATE (`metric_value` AS metric_value)