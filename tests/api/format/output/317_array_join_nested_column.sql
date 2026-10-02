SELECT
    entity_key,
    attributes.key_name,
    attributes.key_value
FROM anon.nested_store
ARRAY JOIN attributes
WHERE attributes.key_name LIKE 'http.%'