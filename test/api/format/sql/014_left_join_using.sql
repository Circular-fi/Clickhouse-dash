-- INPUT
SELECT
    base_src.entity_key,
    base_src.metric_value,
    ref_src.reference_label,
    ref_src.reference_group
FROM anon.base_metrics AS base_src
LEFT JOIN anon.reference_entities AS ref_src USING entity_key
ORDER BY base_src.entity_key ASC

-- EXPECTED
SELECT
    base_src.entity_key,
    base_src.metric_value,
    ref_src.reference_label,
    ref_src.reference_group
FROM anon.base_metrics AS `base_src`
LEFT JOIN anon.reference_entities AS `ref_src` USING entity_key
ORDER BY base_src.entity_key ASC
