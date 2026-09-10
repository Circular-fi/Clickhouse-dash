SELECT
    entity_key,
    metric_value,
    multiIf(
        metric_value >= 1000, 'temp_extreme',
        metric_value >= 100, 'temp_warm',
        metric_value >= 10, 'temp_mild',
        'temp_cold'
    ) AS `temperature_band`
FROM anon.entity_metrics
ORDER BY
    metric_value DESC,
    entity_key ASC
