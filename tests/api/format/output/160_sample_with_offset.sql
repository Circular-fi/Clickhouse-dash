SELECT
    entity_key,
    count() AS `sampled_rows`
FROM anon.metrics_store
SAMPLE 1 / 10 OFFSET 1 / 2
GROUP BY entity_key