SELECT
    entity_group,
    entity_key,
    grouping(entity_group, entity_key)  AS `grouping_level`,
    sum(metric_value)                   AS `total_metric`
FROM anon.metrics_store
GROUP BY
    GROUPING SETS(
        (entity_group, entity_key),
        (entity_group),
        ()
    )