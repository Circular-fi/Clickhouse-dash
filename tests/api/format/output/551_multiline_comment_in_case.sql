SELECT
    CASE
        WHEN a = 1 THEN 'x' -- or 'y', when b
        ELSE 'z'
    END AS `v`
FROM t