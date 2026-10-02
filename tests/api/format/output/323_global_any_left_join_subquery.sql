SELECT
    l.entity_key,
    r.max_value
FROM anon.dist_left AS l
GLOBAL ANY LEFT JOIN
(
    SELECT
        entity_key,
        max(metric_value) AS `max_value`
    FROM anon.dist_right
    GROUP BY entity_key
) AS r USING entity_key
WHERE l.entity_key GLOBAL NOT IN (
        SELECT entity_key
        FROM anon.blocked_keys
    )