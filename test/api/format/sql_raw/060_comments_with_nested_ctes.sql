WITH
    toDate('2026-01-01') AS range_start,
    toDate('2026-01-31') AS range_end,
    (
        /*
            Aggregate metrics inside the requested date range.
            This block is intentionally nested to stress comment placement.
        */
        SELECT
            entity_key,
            sum(metric_value) AS total_metric_value
        FROM anon.metrics_store
        WHERE (event_date >= range_start) AND (event_date <= range_end)
        GROUP BY entity_key
    ) AS grouped_metrics
SELECT
    entity_key,
    total_metric_value
FROM grouped_metrics
WHERE total_metric_value > 0  -- keep only useful entities
ORDER BY
    total_metric_value DESC,
    entity_key ASC
