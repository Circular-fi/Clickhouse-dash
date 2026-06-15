-- INPUT
SELECT
    entity_key,
    dictGet(
        'anon.entity_dictionary',
        'entity_label',
        tuple(entity_key)
    ) AS entity_label,
    dictGetOrDefault(
        'anon.entity_dictionary',
        'entity_group',
        tuple(entity_key),
        'unknown_group'
    ) AS entity_group
FROM anon.metrics_store

-- EXPECTED
SELECT
    entity_key,
    dictGet(
        'anon.entity_dictionary',
        'entity_label',
        tuple(entity_key)
    ) AS `entity_label`,
    dictGetOrDefault(
        'anon.entity_dictionary',
        'entity_group',
        tuple(entity_key),
        'unknown_group'
    ) AS `entity_group`
FROM anon.metrics_store
