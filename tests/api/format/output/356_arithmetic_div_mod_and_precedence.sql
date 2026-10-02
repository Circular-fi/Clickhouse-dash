SELECT
    metric_value % 7                         AS `weekday_bucket`,
    intDiv(metric_value, 3)                  AS `integer_third`,
    metric_value % 5                         AS `remainder_five`,
    -metric_value * 2 + 1                    AS `shifted_negative`,
    (metric_value + 1) * (metric_value - 1)  AS `difference_of_squares`,
    metric_value - -metric_ratio             AS `minus_negative`,
    intDiv(metric_value, 10) * 10            AS `decade`
FROM anon.metrics_store