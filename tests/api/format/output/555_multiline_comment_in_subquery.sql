SELECT a
FROM
(
    SELECT a
    FROM t -- where a > 0 or 1
)
WHERE a < 10