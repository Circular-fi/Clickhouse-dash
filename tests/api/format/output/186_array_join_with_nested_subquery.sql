SELECT
    entity_key,
    arrayJoin(
        arrayZip(
            tag_values,
            tag_weights
        )
    ) AS `tag_pair`,
    tag_pair.1 AS `tag_value`,
    tag_pair.2 AS `tag_weight`
FROM
(
    SELECT
        entity_key,
        tag_values,
        tag_weights
    FROM anon.metrics_store
    WHERE notEmpty(tag_values)
)