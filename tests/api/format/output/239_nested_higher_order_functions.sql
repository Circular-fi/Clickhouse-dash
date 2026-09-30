SELECT
    arrayMap(
        attr -> concat(attr.1, '=', toString(attr.2)),
        arrayFilter(
            attr -> attr.2 != '' AND NOT startsWith(attr.1, 'internal.'),
            arrayZip(
                mapKeys(resource_attributes),
                mapValues(resource_attributes)
            )
        )
    ) AS `resource_labels`
FROM otel.logs