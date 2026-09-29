WITH RECURSIVE
    counter AS
    (
        SELECT 1 AS `n`
        UNION ALL
        SELECT n + 1
        FROM counter
        WHERE n < 10
    )
SELECT sum(n) AS `total`
FROM counter