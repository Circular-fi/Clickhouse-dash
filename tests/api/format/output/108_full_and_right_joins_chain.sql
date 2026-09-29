SELECT
    a.entity_key,
    b.metric_value,
    c.region_key
FROM anon.a AS a
FULL OUTER JOIN anon.b AS b
    ON a.entity_key = b.entity_key
RIGHT JOIN anon.c AS c USING entity_key
LEFT JOIN anon.d AS d
    ON c.region_key = d.region_key
    OR c.fallback_key = d.region_key