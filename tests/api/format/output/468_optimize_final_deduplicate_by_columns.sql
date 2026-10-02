OPTIMIZE TABLE anon.metrics_store ON CLUSTER analytics_cluster PARTITION 202601
FINAL
DEDUPLICATE BY
    entity_key,
    event_date,
    metric_value