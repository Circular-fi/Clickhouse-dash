SELECT
    attributes['region']             AS `region`,
    mapKeys(attributes)              AS `attribute_keys`,
    mapContains(attributes, 'tier')  AS `has_tier`,
    map('a', 1, 'b', 2)['b']         AS `literal_lookup`
FROM anon.map_values
WHERE attributes['env'] = 'prod'