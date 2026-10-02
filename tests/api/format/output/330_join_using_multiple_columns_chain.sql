SELECT *
FROM anon.facts
INNER JOIN anon.dim_a USING (entity_key, event_date)
LEFT JOIN anon.dim_b USING entity_key
FULL OUTER JOIN anon.dim_c USING region_code
SETTINGS join_use_nulls = 1