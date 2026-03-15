SELECT
    entity_key,
    metric_value,
    region_key,
    entity_group
FROM anon.metrics_store
WHERE ((region_key IN ['region_a', 'region_b']) OR (entity_group IN ['group_x', 'group_y', 'group_z'])) AND (metric_value > 0) AND notEmpty(entity_key) AND ((entity_group != 'group_blocked') OR (region_key = 'region_override'))
ORDER BY
    metric_value DESC,
    entity_key ASC
LIMIT 200
