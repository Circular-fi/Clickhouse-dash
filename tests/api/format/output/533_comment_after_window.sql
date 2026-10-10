SELECT
    sum(a) OVER (
        PARTITION BY b
        ORDER BY c
    )
FROM t -- , d rows between 1 preceding