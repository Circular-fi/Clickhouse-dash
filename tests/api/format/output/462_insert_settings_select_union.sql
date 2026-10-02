INSERT INTO anon.combined_keys
SETTINGS max_insert_threads = 4
SELECT entity_key
FROM anon.live_store
UNION ALL
SELECT entity_key
FROM anon.archive_store