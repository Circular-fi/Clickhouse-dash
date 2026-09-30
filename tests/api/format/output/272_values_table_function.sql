SELECT
    k,
    sum(w) AS `total`
FROM values(
    'k String, w UInt64',
    ('checkout', 1),
    ('payments', 1),
    ('inventory', 5),
    ('checkout', 1),
    ('shipping', 10)
)
GROUP BY k