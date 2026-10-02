SELECT
    a.entity_key,
    b.region_code
FROM anon.left_store AS a, anon.region_store AS b
WHERE a.region_id = b.region_id