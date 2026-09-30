SELECT
    number,
    toDate('2026-09-01') + number AS `day`
FROM numbers(30)
UNION ALL
SELECT
    number,
    today()
FROM numbers(1)