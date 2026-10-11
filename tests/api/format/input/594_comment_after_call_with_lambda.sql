SELECT
    arrayMap(x -> x + 1, [1, 2, 3]), -- the call fits
    map(1, 2)
FROM t