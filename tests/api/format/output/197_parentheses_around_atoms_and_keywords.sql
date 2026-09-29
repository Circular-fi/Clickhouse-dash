SELECT
    x >= a + b AND (x <= c + d)  AS `r`,
    NOT (a + b)                  AS `n`,
    intDiv(a, b) * c             AS `d`,
    a % b + 1                    AS `m`,
    CAST(x, 'Int32') + 1         AS `c`,
    t.1.2                        AS `tt`,
    if(a, b, c) + 1              AS `tern`,
    [a + b, c * d]               AS `arr`,
    map(
        'k', a + b
    ) AS `mp`,
    (a + b) IS NULL AS `isn`,
    (a + b) IN (1, 2) AS `inn`,
    -(a) AS `neg`
FROM t