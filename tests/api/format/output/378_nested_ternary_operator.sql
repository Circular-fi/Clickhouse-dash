SELECT
    if(
        metric_value > 100,
        'high',
        if(metric_value > 10, 'medium', if(metric_value > 0, 'low', 'none'))
    ) AS `value_band`,
    if(is_active, metric_value, 0) AS `active_value`
FROM anon.metrics_store