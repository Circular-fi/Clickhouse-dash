EXPLAIN PIPELINE header = 1
SELECT count()
FROM anon.metrics_store
WHERE entity_group = 'group_live'
SETTINGS max_threads = 2