-- INPUT
WITH
    cte_1 AS
    (
        SELECT col_1 AS col_2
        FROM schema_1.table_1
        WHERE
            col_3 = 'value_1'
            AND col_4 >= fn_1('value_1')
            AND col_5 = 'value_2'
        GROUP BY
            col_5,
            col_1
        HAVING agg_fn_1(col_6) > 10
    ),
    cte_2 AS
    (
        SELECT
            col_2,
            agg_fn_2(col_7)  AS col_8,
            agg_fn_3(col_9)  AS col_10,
            count()          AS col_11
        FROM schema_1.table_2
        WHERE
            col_3 = 'value_3'
            AND col_4 >= fn_1('value_3')
            AND col_2 IN (
                    SELECT col_2
                    FROM cte_1
                )
        GROUP BY col_2
        HAVING col_10 > 0.1
    ),
    (
        SELECT max(col_11)
        FROM cte_2
    ) AS col_12
SELECT
    *,
    (col_10 / col_8) * 100 AS col_13
FROM cte_2
WHERE col_11 >= ((col_12 * 2) / 3)
ORDER BY col_10 / col_8 DESC
LIMIT 10

-- EXPECTED
WITH
    cte_1 AS
    (
        SELECT col_1 AS col_2
        FROM schema_1.table_1
        WHERE
            col_3 = 'value_1'
            AND col_4 >= fn_1('value_1')
            AND col_5 = 'value_2'
        GROUP BY
            col_5,
            col_1
        HAVING agg_fn_1(col_6) > 10
    ),
    cte_2 AS
    (
        SELECT
            col_2,
            agg_fn_2(col_7)    AS `col_8`,
            agg_fn_3(col_9)    AS `col_10`,
            count()            AS `col_11`
        FROM schema_1.table_2
        WHERE
            col_3 = 'value_3'
            AND col_4 >= fn_1('value_3')
            AND col_2 IN (
                    SELECT col_2
                    FROM cte_1
                )
        GROUP BY col_2
        HAVING col_10 > 0.1
    ),
    (
        SELECT max(col_11)
        FROM cte_2
    ) AS `col_12`
SELECT
    *,
    (col_10 / col_8) * 100 AS `col_13`
FROM cte_2
WHERE col_11 >= ((col_12 * 2) / 3)
ORDER BY col_10 / col_8 DESC
LIMIT 10
