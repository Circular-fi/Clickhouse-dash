SELECT
    region_key,
    entity_group,
    sum(metric_value) AS total_metric_value
FROM anon.grouped_metrics
GROUP BY
    region_key,
    entity_group
    WITH CUBE
ORDER BY
    region_key ASC,
    entity_group ASC
