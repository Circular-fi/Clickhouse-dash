SELECT
    entity_key,
    map('label', entity_label, 'group', entity_group, 'region', region_key)  AS entity_map,
    mapContains(map('label', entity_label, 'group', entity_group), 'group')  AS has_group_key
FROM anon.entity_reference