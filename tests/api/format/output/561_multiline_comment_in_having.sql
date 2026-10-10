SELECT
    k,
    count() AS `c`
FROM t
GROUP BY k
HAVING c > 1 -- or c = 0, and k
ORDER BY c