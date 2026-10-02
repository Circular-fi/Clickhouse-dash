WITH RECURSIVE
    counter AS
    (
        SELECT 1 AS `step_number`
        UNION ALL
        SELECT step_number + 1
        FROM counter
        WHERE step_number < 10
    )
SELECT sum(step_number) AS `total_steps`
FROM counter