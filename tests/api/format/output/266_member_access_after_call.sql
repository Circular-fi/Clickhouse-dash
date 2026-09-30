SELECT
    argMax(tuple(status, message, updated_at), updated_at).1 AS `latest_status`,
    tupleElement(
        arrayJoin(
            arrayZip(
                mapKeys(resource_attributes),
                mapValues(resource_attributes)
            )
        ),
        1
    ) AS `attr_key`
FROM ops.incidents