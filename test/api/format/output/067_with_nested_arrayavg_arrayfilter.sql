WITH
    base AS
    (
        SELECT
            arrayAvg(
                arrayMap(
                    x -> toFloat64(x.metric),
                    arrayFilter(x -> x.scope = 'TEST_12345', column_1)
                )
            ) AS `tipshare`,
            arrayAvg(
                arrayMap(
                    x -> toFloat64(x.metric),
                    arrayFilter(x -> x.scope = 'TEST_123456', column_2.nested)
                )
            ) AS `rebate_x`
        FROM database_1.table_1
    )
SELECT
    tipshare,
    rebate_x
FROM base
