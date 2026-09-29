SELECT
    entity_key, -- stable key, used FROM joins AND exports
    metric_value -- ratio, not normalized OR rounded
FROM anon.metrics_store
WHERE
    metric_value > 0 -- keep rows, even when ORDER BY is set
    AND entity_group = 'live'
ORDER BY metric_value DESC