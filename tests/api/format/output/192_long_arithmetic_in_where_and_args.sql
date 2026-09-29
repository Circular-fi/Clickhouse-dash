SELECT
    entity_key,
    round(
        (score_a * weight_a + score_b * weight_b + score_c * weight_c)
            / (weight_a + weight_b + weight_c),
        4
    ) AS `rounded_score`,
    toUInt64(
        (metric_value - baseline_value)
        * 1000000
        / greatest(baseline_value, 1)
    ) AS `scaled_delta`
FROM anon.metrics_store
WHERE
    (metric_alpha * weight_alpha + metric_beta * weight_beta)
        / (weight_alpha + weight_beta) > minimum_threshold_value
    AND entity_group = 'group_live'
    AND (total_revenue_amount - total_refund_amount)
        * exchange_rate >= minimum_net_revenue_value