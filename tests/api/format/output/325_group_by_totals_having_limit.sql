SELECT
    entity_group,
    uniqExact(entity_key) AS `distinct_keys`
FROM anon.metrics_store
GROUP BY entity_group WITH TOTALS
HAVING distinct_keys > 10
ORDER BY distinct_keys DESC
LIMIT 5
SETTINGS
    totals_mode          = 'after_having_exclusive',
    max_rows_to_group_by = 100000