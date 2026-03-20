-- INPUT
SELECT
    left_src.entity_key,
    left_src.metric_value,
    right_src.reference_value
FROM anon.left_metrics AS left_src
INNER JOIN anon.right_reference AS right_src
    ON left_src.entity_key = right_src.entity_key
    AND left_src.region_key = right_src.region_key
    AND right_src.is_active = 1
WHERE left_src.metric_value > 0

-- EXPECTED
SELECT
    left_src.entity_key,
    left_src.metric_value,
    right_src.reference_value
FROM anon.left_metrics AS `left_src`
INNER JOIN anon.right_reference AS `right_src`
    ON left_src.entity_key = right_src.entity_key
    AND left_src.region_key = right_src.region_key
    AND right_src.is_active = 1
WHERE left_src.metric_value > 0
