SELECT entity_key
FROM anon.metrics_store
WHERE
    entity_key IN (anon.allowed_keys)
    AND (entity_group, region_code) GLOBAL IN (
            SELECT
                entity_group,
                region_code
            FROM anon.active_pairs
        )