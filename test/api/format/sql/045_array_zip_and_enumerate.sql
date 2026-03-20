SELECT
    entity_key,
    arrayZip(
        tag_values,
        arrayEnumerate(tag_values)
    ) AS `tag_pairs`,
    arrayMap(
        item -> item.1,
        arrayZip(
            tag_values,
            arrayEnumerate(tag_values)
        )
    ) AS `extracted_tags`
FROM anon.metrics_store