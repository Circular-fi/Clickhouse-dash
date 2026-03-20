-- INPUT
SELECT
    entity_key,
    event_date,
    metric_value,
    entity_group
FROM anon.metrics_store AS base_src
WHERE
    exists(
        SELECT 1
        FROM anon.right_reference AS ref_src
        WHERE
            ref_src.entity_key = base_src.entity_key
            AND exists(
                SELECT 1
                FROM anon.metrics_store AS nested_src
                WHERE
                    nested_src.entity_key = ref_src.entity_key
                    AND nested_src.event_date >= toDate('2026-01-01')
                    AND (
                        nested_src.metric_value > 100
                        OR has(nested_src.tag_values, 'priority')
                    )
            )
    )
    AND (
        entity_group IN ['group_a', 'group_b']
        OR metric_value >= 1000
    )
    AND notEmpty(entity_key)
ORDER BY
    metric_value DESC,
    entity_key ASC
LIMIT 100

-- EXPECTED
SELECT
    entity_key,
    event_date,
    metric_value,
    entity_group
FROM anon.metrics_store AS base_src
WHERE
    exists(
        SELECT 1
        FROM anon.right_reference AS ref_src
        WHERE
            ref_src.entity_key = base_src.entity_key
            AND exists(
                SELECT 1
                FROM anon.metrics_store AS nested_src
                WHERE
                    nested_src.entity_key = ref_src.entity_key
                    AND nested_src.event_date >= toDate('2026-01-01')
                    AND (
                        nested_src.metric_value > 100
                        OR has(nested_src.tag_values, 'priority')
                    )
            )
    )
    AND (
        entity_group IN ['group_a', 'group_b']
        OR metric_value >= 1000
    )
    AND notEmpty(entity_key)
ORDER BY
    metric_value DESC,
    entity_key ASC
LIMIT 100
