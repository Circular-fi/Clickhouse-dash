SELECT
    entity_key,
    metric_value,
    multiIf(
        metric_value >= 1000, 'critical',
        metric_value >= 500, 'high',
        metric_value >= 100, 'medium',
        metric_value >= 10, 'low',
        'minimal'
    ) AS `severity_label`
FROM anon.entity_metrics
