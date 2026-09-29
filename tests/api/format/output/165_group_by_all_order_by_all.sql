SELECT
    entity_group,
    entity_key,
    count() AS `row_count`
FROM anon.metrics_store
GROUP BY ALL
ORDER BY ALL DESC