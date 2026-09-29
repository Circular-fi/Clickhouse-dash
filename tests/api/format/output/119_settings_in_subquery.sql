SELECT count() AS `row_count`
FROM
(
    SELECT entity_key
    FROM anon.metrics_store
    WHERE metric_value > 0
    SETTINGS max_threads = 4
)
SETTINGS
    max_execution_time = 30,
    max_memory_usage   = 10000000000