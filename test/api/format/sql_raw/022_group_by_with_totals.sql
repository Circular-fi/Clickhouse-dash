SELECT
    entity_group,
    avg(metric_value) AS average_metric_value,
    count() AS row_count
FROM anon.grouped_metrics
GROUP BY entity_group
    WITH TOTALS
ORDER BY
    average_metric_value DESC,
    entity_group ASC
