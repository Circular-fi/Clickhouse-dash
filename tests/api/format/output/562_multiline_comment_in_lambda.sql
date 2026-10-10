SELECT
    arrayFilter(
        x -> x > 0, -- or x < 0, y
        arr
    )
FROM t