SELECT
    entity_key,
    arrayFilter(
        x -> x >= threshold_value AND x <= threshold_value * 2,
        metric_values
    ) AS `in_band_values`,
    arrayMap(
        x -> round(x / nullIf(baseline_value, 0), 3),
        metric_values
    ) AS `relative_values`
FROM anon.series_store