SELECT
    left_src.entity_key,
    left_src.metric_value,
    right_src.region_key
FROM anon.entity_metrics AS left_src
INNER JOIN anon.right_reference AS right_src ON (left_src.entity_key = right_src.entity_key) AND (right_src.is_enabled = 1)
WHERE ((left_src.metric_value > 0) OR (right_src.region_key = 'region_override')) AND notEmpty(left_src.entity_key)
ORDER BY
    left_src.metric_value DESC,
    left_src.entity_key ASC
