-- INPUT
SELECT
    base.number AS base_number,
    joined.key_value AS joined_key
FROM numbers(6) AS base
FULL OUTER JOIN (
    SELECT
        number AS key_value,
        number + 2 AS key_plus
    FROM numbers(5)
) AS joined
    ON base.number = joined.key_value
    AND base.number % 4 != 0
WHERE
    joined.key_plus > 2

SELECT
    base.number,
    joined.key_value
FROM numbers(9) AS base
ANY LEFT JOIN (
    SELECT number AS key_value
    FROM numbers(9)
) AS joined
    ON base.number = joined.key_value

-- EXPECTED
SELECT
    base.number       AS base_number,
    joined.key_value  AS joined_key
FROM numbers(6) AS base
FULL OUTER JOIN (
    SELECT
        number      AS key_value,
        number + 2  AS key_plus
    FROM numbers(5)
) AS joined
    ON base.number = joined.key_value
    AND base.number % 4 != 0
WHERE joined.key_plus > 2

SELECT
    base.number,
    joined.key_value
FROM numbers(9) AS base
ANY LEFT JOIN (
    SELECT
        number AS key_value
    FROM numbers(9)
) AS joined
    ON base.number = joined.key_value