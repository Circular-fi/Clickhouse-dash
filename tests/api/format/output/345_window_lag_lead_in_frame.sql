SELECT
    entity_key,
    event_date,
    metric_value,
    lagInFrame(metric_value, 1, 0) OVER w  AS `previous_value`,
    leadInFrame(metric_value) OVER w       AS `next_value`,
    nth_value(metric_value, 2) OVER w      AS `second_value`,
    first_value(metric_value) OVER w       AS `first_seen_value`,
    last_value(metric_value) OVER w        AS `last_seen_value`
FROM anon.metrics_store
WINDOW w AS (
    PARTITION BY entity_key
    ORDER BY event_date ASC
    ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
)