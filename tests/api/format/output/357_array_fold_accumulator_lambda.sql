SELECT
    entity_key,
    arrayFold(
        (acc, x) -> acc + x * x,
        metric_values,
        toFloat64(0)
    ) AS `sum_of_squares`,
    arrayFold(
        (acc, x) -> if(x > acc, x, acc),
        metric_values,
        -inf
    ) AS `running_max`
FROM anon.series_store