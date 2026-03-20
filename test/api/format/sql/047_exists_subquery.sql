-- INPUT
SELECT
    entity_key,
    metric_value
FROM anon.metrics_store AS base_src
WHERE exists(
        SELECT 1
        FROM anon.reference_entities AS ref_src
        WHERE
            ref_src.entity_key = base_src.entity_key
            AND ref_src.is_enabled = 1
    )
ORDER BY
    metric_value DESC,
    entity_key ASC

-- EXPECTED
SELECT
    entity_key,
    metric_value
FROM anon.metrics_store AS `base_src`
WHERE exists(
        SELECT 1
        FROM anon.reference_entities AS `ref_src`
        WHERE
            ref_src.entity_key = base_src.entity_key
            AND ref_src.is_enabled = 1
    )
ORDER BY
    metric_value DESC,
    entity_key ASC
