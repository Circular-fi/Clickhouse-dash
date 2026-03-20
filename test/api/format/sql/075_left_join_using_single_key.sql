SELECT
    src.entity_key,
    src.entity_group
FROM anon.metrics_store AS src
LEFT JOIN anon.reference_table USING entity_key
