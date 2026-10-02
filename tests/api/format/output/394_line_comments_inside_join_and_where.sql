SELECT
    l.entity_key,
    r.metric_value
FROM anon.left_store AS l -- left side
INNER JOIN anon.right_store AS r -- right side
    ON l.entity_key = r.entity_key -- equality join
WHERE
    r.metric_value > 0 -- only positive
    AND l.is_active -- active rows
ORDER BY r.metric_value DESC