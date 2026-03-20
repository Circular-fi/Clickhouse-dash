SELECT
    merged.entity_key,
    sum(merged.metric_value) AS `total_metric_value`
FROM
(
    SELECT
        entity_key,
        metric_value
    FROM anon.segment_a_metrics
    UNION ALL
    SELECT
        entity_key,
        metric_value
    FROM anon.segment_b_metrics
    UNION ALL
    SELECT
        entity_key,
        metric_value
    FROM anon.segment_c_metrics
) AS `merged`
GROUP BY merged.entity_key
ORDER BY
    total_metric_value DESC,
    merged.entity_key ASC