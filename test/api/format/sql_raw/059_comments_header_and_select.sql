/*
    Verifies leading block comments and inline comments in a simple projection.
    The formatter should preserve both comment kinds and keep clause indentation stable.
*/
SELECT
    entity_key,  -- stable identifier used for joins
    metric_value,
    metric_ratio -- ratio already normalized upstream
FROM anon.metrics_store
WHERE (event_date >= toDate('2026-01-01'))  -- lower bound for the reporting window
AND (metric_value > 0)
ORDER BY
    metric_value DESC,
    entity_key ASC
LIMIT 50
