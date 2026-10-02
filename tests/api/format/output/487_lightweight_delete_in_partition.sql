DELETE FROM anon.metrics_store ON CLUSTER analytics_cluster IN PARTITION 202601
WHERE
    entity_group = 'group_tmp'
    AND metric_value = 0