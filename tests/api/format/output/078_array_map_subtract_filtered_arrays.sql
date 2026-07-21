SELECT
    arrayMap(
        x -> x.a + x.b,
        arrayFilter(
            x -> x.c = y.v
                AND x.d != 'EXCLUDED_VALUE',
            y.arr_1
        )
    )
    - arrayMap(
        x -> x.a,
        arrayFilter(
            x -> x.c = y.v
                AND x.d != 'EXCLUDED_VALUE',
            z.arr_2
        )
    )
FROM test
