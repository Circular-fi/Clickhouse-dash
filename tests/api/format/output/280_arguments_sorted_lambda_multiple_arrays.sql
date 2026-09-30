SELECT
    arraySort((name, score) -> score, names, scores) AS `sorted_names`,
    arrayFold((acc, x) -> acc + x, line_amounts, toUInt64(0)) AS `folded_total`,
    arrayReduce(
        'sum',
        arrayMap((b, c) -> b * c, bucket_bounds, bucket_counts)
    ) AS `weighted_total`
FROM billing.invoice_lines