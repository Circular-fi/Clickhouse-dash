SELECT
    tupleElement(pair_item, 1) AS `entity_key`,
    tupleElement(pair_item, 2) AS `score_value`
FROM
(
    SELECT
        arrayJoin(
            [
                ('key_a', 10),
                ('key_b', 20),
                ('key_c', 30)
            ]
        ) AS `pair_item`
)
ORDER BY
    score_value DESC,
    entity_key ASC
