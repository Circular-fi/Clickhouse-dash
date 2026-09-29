SELECT
    l.entity_key,
    r.region_key
FROM anon.left_table AS l
ANY INNER JOIN anon.right_table AS r
    ON l.entity_key = r.entity_key