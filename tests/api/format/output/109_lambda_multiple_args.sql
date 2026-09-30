SELECT
    arrayMap(
        (price, quantity) -> price * quantity,
        prices,
        quantities
    ) AS `line_totals`,
    arrayFold((acc, x) -> acc + x, line_amounts, toUInt64(0)) AS `folded_total`
FROM anon.orders