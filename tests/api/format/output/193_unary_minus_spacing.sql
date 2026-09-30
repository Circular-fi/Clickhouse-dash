SELECT
    -metric_value                       AS `negated`,
    -(metric_value + offset_value)      AS `negated_sum`,
    -(-metric_value)                    AS `double_negated`,
    metric_value * -scale_factor        AS `scaled`,
    -sum(metric_value)                  AS `negated_total`,
    multiIf(is_debit, -amount, amount)  AS `signed_amount`,
    arrayMap(x -> -x, raw_values)       AS `negated_values`,
    -1                                  AS `minus_one`,
    -(1)                                AS `negated_one`,
    2 - -1                              AS `three`,
    0.00001                             AS `epsilon`
FROM anon.metrics_store
WHERE metric_value > -threshold_value
ORDER BY -metric_value ASC