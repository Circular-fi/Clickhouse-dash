SELECT
    entity_group,
    region_code,
    device_type,
    sum(metric_value) AS `total_value`
FROM anon.metrics_store
GROUP BY
    GROUPING SETS(
        (entity_group, region_code),
        (entity_group, device_type),
        (region_code),
        ()
    )
HAVING total_value > 0