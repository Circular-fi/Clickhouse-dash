SELECT entity_key
FROM anon.metrics_store
WHERE
    (entity_group, region_code) IN (
        ('group_live', 'eu'),
        ('group_live', 'us'),
        ('group_buffer', 'eu')
    )
    AND (entity_key, event_date) NOT IN (
            SELECT
                entity_key,
                event_date
            FROM anon.excluded_pairs
        )
    AND region_code IN ('eu', 'us')