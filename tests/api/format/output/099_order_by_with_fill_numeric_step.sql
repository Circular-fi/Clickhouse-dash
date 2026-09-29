SELECT
    intDiv(metric_value, 10) * 10  AS `bucket`,
    count()                        AS `bucket_count`
FROM anon.metrics_store
GROUP BY bucket
ORDER BY bucket ASC WITH FILL STEP 10