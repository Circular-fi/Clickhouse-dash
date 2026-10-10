SELECT
    k,
    count()
FROM t
GROUP BY k -- , other or more
ORDER BY k