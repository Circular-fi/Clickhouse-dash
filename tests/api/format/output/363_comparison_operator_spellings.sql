SELECT entity_key
FROM anon.metrics_store
WHERE
    metric_value = 1
    AND metric_ratio != 0.5
    AND entity_group != 'group_tmp'
    AND event_date >= today() - 30
    AND event_date <= today()
    AND isNotDistinctFrom(parent_key, NULL)