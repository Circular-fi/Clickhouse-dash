SELECT
    entity_group,
    entity_key,
    metric_value
FROM anon.grouped_metrics
ORDER BY
    entity_group ASC,
    metric_value DESC,
    entity_key ASC
LIMIT 3 BY entity_group