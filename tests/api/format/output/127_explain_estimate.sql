EXPLAIN ESTIMATE
SELECT count()
FROM anon.metrics_store
WHERE event_date >= today() - 7