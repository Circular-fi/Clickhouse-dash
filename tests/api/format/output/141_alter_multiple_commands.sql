ALTER TABLE anon.metrics_store
DROP COLUMN IF EXISTS legacy_value,
RENAME COLUMN old_label TO new_label,
MODIFY COLUMN `metric_value` Float64 CODEC(Gorilla, ZSTD(3)),
COMMENT COLUMN entity_key 'business key'