WITH
    toDate('2026-01-01') AS `range_start`,
    toDate('2026-01-31') AS `range_end`,
    (
        SELECT
            entity_key,
            entity_group,
            sum(metric_value) AS `total_metric_value`
        FROM anon.metrics_store
        WHERE
            event_date >= range_start
            AND event_date <= range_end
        GROUP BY
            entity_key,
            entity_group
    ) AS `grouped_metrics`,
    (
        SELECT
            entity_group,
            avg(total_metric_value) AS `avg_total_metric_value`
        FROM grouped_metrics
        GROUP BY entity_group
    ) AS `grouped_averages`
SELECT
    metrics_src.entity_key,
    metrics_src.entity_group,
    metrics_src.total_metric_value,
    grouped_averages.avg_total_metric_value,
    metrics_src.total_metric_value - grouped_averages.avg_total_metric_value AS `metric_delta`
FROM grouped_metrics AS `metrics_src`
INNER JOIN grouped_averages AS `grouped_averages`
    ON metrics_src.entity_group = grouped_averages.entity_group
WHERE
    metrics_src.total_metric_value > grouped_averages.avg_total_metric_value
    AND metrics_src.entity_key IN
    (
        SELECT
            entity_key
        FROM anon.metrics_store
        WHERE
            event_date >= range_start
            AND has(tag_values, 'priority')
    )
ORDER BY
    metric_delta DESC,
    metrics_src.entity_key ASC
