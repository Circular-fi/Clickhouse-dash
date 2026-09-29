SELECT
    a - (b - c)              AS `keep_right_minus`,
    a / (b * c)              AS `keep_right_div`,
    (a + b) * c              AS `keep_sum_factor`,
    a + (b + c)              AS `keep_right_plus`,
    a - b - c                AS `drop_left_minus`,
    a * b + c / d            AS `drop_products`,
    concat(concat(a, b), c)  AS `keep_concat`,
    -(1)                     AS `keep_negate_literal`,
    -(a + b)                 AS `keep_negate_sum`,
    a % b * c                AS `drop_modulo`,
    a * -b                   AS `drop_signed`,
    x IN (5)                 AS `keep_in_group`,
    (a + b) * c              AS `keep_nested`,
    arr[i + 1]               AS `drop_subscript`,
    (x + 1).1                AS `keep_member`
FROM t
WHERE
    (a > b) = (c > d)
    AND a + b > c - d