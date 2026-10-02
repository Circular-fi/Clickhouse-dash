SELECT
    entity_group,
    sumIf(metric_value, metric_value > 0)    AS `positive_total`,
    countIf(is_error)                        AS `error_count`,
    first_value(metric_value) RESPECT NULLS  AS `first_including_nulls`
FROM anon.metrics_store
GROUP BY entity_group