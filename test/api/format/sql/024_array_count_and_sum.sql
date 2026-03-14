SELECT
    entity_key,
    arrayCount(item -> item > 10, metric_values)         AS high_value_count,
    arraySum(arrayMap(item -> item * 2, metric_values))  AS doubled_value_sum
FROM anon.array_metrics
ORDER BY
    high_value_count DESC,
    entity_key ASC