SELECT
    if(
        is_active,
        metric_value,
        0
    ) AS `active_metric`,
    entity_key IS NULL AS `missing_key`,
    -metric_value AS `negated`
FROM anon.metrics_store
WHERE
    entity_key NOT LIKE 'tmp_%'
    AND entity_group ILIKE 'group%'
    AND (
        metric_value < 10
        OR metric_value > 20
    )
    AND label IS NOT NULL