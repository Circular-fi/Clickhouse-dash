-- INPUT
SELECT /* inline comment */
    number /* weird comment */ AS value -- trailing comment
FROM numbers(3)
WHERE
    -- filter comment
    value % 2 = 0
/*
block comment spanning
lines
*/
ORDER BY value DESC -- order comment
LIMIT 1 -- limit comment

-- EXPECTED
SELECT
    /* inline comment */
    number /* weird comment */ AS value -- trailing comment
FROM numbers(3)
WHERE -- filter comment
    value % 2 = 0
/*
    block comment spanning
    lines
*/
ORDER BY value DESC -- order comment
LIMIT 1 -- limit comment