WITH (
        SELECT max(metric_value)
        FROM anon.metrics_source
        WHERE metric_date >= toDate('2026-01-01')
    ) AS max_metric_value
SELECT
    entity_id,
    metric_value,
    max_metric_value,
    metric_value / nullIf(max_metric_value, 0) AS metric_ratio
FROM anon.metrics_source
WHERE metric_value > 0
ORDER BY
    metric_ratio DESC,
    entity_id ASC
LIMIT 100
