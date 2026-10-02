SELECT entity_key
FROM anon.metrics_store
WHERE
    display_name IS NOT NULL
    AND parent_key IS NULL
    AND display_name NOT ILIKE '%test%'
    AND entity_key NOT LIKE 'tmp\\_%'
    AND lower(display_name) ILIKE 'prod-%'
    AND NOT (
        is_deleted
        OR is_hidden
    )