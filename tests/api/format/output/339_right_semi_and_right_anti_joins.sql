SELECT r.entity_key
FROM anon.left_store AS l
SEMI RIGHT JOIN anon.right_store AS r
    ON l.entity_key = r.entity_key
UNION ALL
SELECT r.entity_key
FROM anon.left_store AS l
ANTI RIGHT JOIN anon.right_store AS r
    ON l.entity_key = r.entity_key