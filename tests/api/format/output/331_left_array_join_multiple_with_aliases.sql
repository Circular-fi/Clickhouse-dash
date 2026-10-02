SELECT
    entity_key,
    tag_name,
    tag_value,
    tag_index
FROM anon.tagged_store
LEFT ARRAY JOIN
    tag_names AS tag_name,
    tag_values AS tag_value,
    arrayEnumerate(tag_names) AS tag_index
WHERE tag_value != ''