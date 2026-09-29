SELECT
    /* first column */ entity_key, -- trailing note
    metric_value
FROM /* source table */ anon.metrics_store
WHERE -- leading note
    metric_value > 0