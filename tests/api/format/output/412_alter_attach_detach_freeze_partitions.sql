ALTER TABLE anon.metrics_store
    (DETACH PARTITION 202512),
    (ATTACH PARTITION 202512 FROM anon.metrics_staging),
    (FREEZE PARTITION 202601 WITH NAME 'before_migration'),
    (UNFREEZE PARTITION 202512 WITH NAME 'old_backup')