SELECT
    l.entity_key,
    l.metric_value
FROM anon.left_table AS l
SEMI LEFT JOIN anon.right_table AS r USING entity_key