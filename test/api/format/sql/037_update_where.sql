ALTER TABLE anon.metrics_store
(
    UPDATE
        metric_ratio = 0.000000,
        tag_values = arrayDistinct(tag_values)
    WHERE
        entity_group = 'group_cleanup'
        AND metric_value = 0
)
