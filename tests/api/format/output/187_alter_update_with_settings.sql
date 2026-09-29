ALTER TABLE anon.metrics_store
(
    UPDATE
        metric_value = 0
    WHERE
        entity_group = 'group_reset'
)
SETTINGS mutations_sync = 2