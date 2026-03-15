SELECT
    entity_key,
    metric_value
FROM anon.distributed_metrics
WHERE entity_key GLOBAL IN (
    SELECT entity_key
    FROM anon.reference_entities
    WHERE is_enabled = 1
)
