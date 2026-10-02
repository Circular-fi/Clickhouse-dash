ALTER TABLE anon.metrics_store
(
    DELETE IN PARTITION ID '202601' WHERE entity_group = 'group_tmp'
)
SETTINGS mutations_sync = 2