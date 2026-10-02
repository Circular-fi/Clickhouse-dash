SELECT
    l.entity_key,
    coalesce(r.metric_value, /* missing */ 0) AS `metric_value`
FROM anon.left_store AS l
LEFT JOIN anon.right_store AS r
    ON l.entity_key = r.entity_key -- primary key
    OR l.alias_key = r.entity_key -- legacy alias