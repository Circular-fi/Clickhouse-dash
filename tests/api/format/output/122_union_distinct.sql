SELECT entity_key
FROM anon.left_table
UNION DISTINCT
SELECT entity_key
FROM anon.right_table