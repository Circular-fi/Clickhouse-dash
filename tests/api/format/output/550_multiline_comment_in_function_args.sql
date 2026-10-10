SELECT
    coalesce(
        a, -- or b, when null
        c
    )
FROM t