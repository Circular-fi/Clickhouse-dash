SELECT
    k,
    count()
FROM t
WHERE x = 1 -- GROUP BY k HAVING count() > 1