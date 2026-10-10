SELECT
    sum(a) OVER (
        PARTITION BY
            b -- , c or d
        ORDER BY e
    )
FROM t