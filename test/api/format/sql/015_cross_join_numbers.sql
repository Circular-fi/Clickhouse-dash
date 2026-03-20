-- INPUT
SELECT
    seq.number                               AS sequence_value,
    concat('entity_', toString(seq.number))  AS entity_key
FROM numbers(10) AS seq
CROSS JOIN
(
    SELECT 1 AS anchor_value
) AS anchor_src
ORDER BY sequence_value ASC

-- EXPECTED
SELECT
    seq.number                               AS `sequence_value`,
    concat('entity_', toString(seq.number))  AS `entity_key`
FROM numbers(10) AS `seq`
CROSS JOIN
(
    SELECT 1 AS `anchor_value`
) AS `anchor_src`
ORDER BY sequence_value ASC
