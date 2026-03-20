-- INPUT
SELECT
    entity_key,
    metric_value,
    multiIf(
        metric_value >= 1000, 'tier_enterprise',
        metric_value >= 100, 'tier_growth',
        metric_value >= 10, 'tier_starter',
        'tier_seed'
    ) AS metric_tier
FROM anon.entity_metrics
ORDER BY
    metric_value DESC,
    entity_key ASC

-- EXPECTED
SELECT
    entity_key,
    metric_value,
    multiIf(
        metric_value >= 1000, 'tier_enterprise',
        metric_value >= 100, 'tier_growth',
        metric_value >= 10, 'tier_starter',
        'tier_seed'
    ) AS `metric_tier`
FROM anon.entity_metrics
ORDER BY
    metric_value DESC,
    entity_key ASC
