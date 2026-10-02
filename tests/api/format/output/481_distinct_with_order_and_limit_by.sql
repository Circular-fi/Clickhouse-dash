SELECT DISTINCT
    entity_group,
    entity_key
FROM anon.metrics_store
ORDER BY
    entity_group ASC,
    entity_key ASC
LIMIT 2 BY entity_group