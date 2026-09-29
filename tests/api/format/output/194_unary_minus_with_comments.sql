-- negations
SELECT
    -x        AS `a1`,
    - -x      AS `a2`,
    a * -b    AS `a3`,
    a - b     AS `a4`,
    1e-5      AS `a5`,
    -(a + b)  AS `a6`,
    a - b     AS `a7`,
    -1        AS `a8`
FROM t
WHERE x = -1