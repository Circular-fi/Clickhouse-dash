ALTER TABLE anon.metrics_store
    DROP COLUMN IF EXISTS legacy_flag,
    CLEAR COLUMN debug_payload IN PARTITION 202601,
    COMMENT COLUMN metric_value 'value in milliseconds',
    RENAME COLUMN IF EXISTS old_label TO display_label