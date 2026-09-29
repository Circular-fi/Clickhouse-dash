WITH
    10 AS `row_limit`,
    'group_live' AS `target_group`,
    (
        SELECT max(event_date)
        FROM anon.metrics_store
    ) AS `last_day`,
    live_rows AS
    (
        SELECT
            entity_key,
            metric_value
        FROM anon.metrics_store
        WHERE
            entity_group = target_group
            AND event_date = last_day
    )
SELECT
    entity_key,
    metric_value
FROM live_rows
ORDER BY metric_value DESC
LIMIT row_limit