SELECT
    entity_key,
    metric_value
FROM anon.metrics_store
WHERE entity_key IN (
        SELECT entity_key
        FROM anon.reference_entities
        WHERE reference_group = 'priority_group'
    )