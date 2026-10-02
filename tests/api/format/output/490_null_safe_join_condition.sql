SELECT
    l.entity_key,
    r.metric_value
FROM anon.left_store AS l
LEFT JOIN anon.right_store AS r
    ON isNotDistinctFrom(l.parent_key, r.parent_key)
    AND l.region_code = r.region_code