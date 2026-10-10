SELECT
    multiIf(
        a = 1, 'x', -- , a = 2, 'y'
        'z'
    )
FROM t