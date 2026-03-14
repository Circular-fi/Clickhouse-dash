SELECT
    entity_key,
    coalesce(primary_label, fallback_label, 'unknown_label')  AS resolved_label,
    nullIf(metric_value, 0)                                   AS non_zero_metric,
    coalesce(metric_value / nullIf(metric_limit, 0), 0)       AS usage_ratio
FROM anon.entity_limits