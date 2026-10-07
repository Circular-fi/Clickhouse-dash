ALTER TABLE anon.metrics_store
MODIFY SETTING merge_with_ttl_timeout = 3600, ttl_only_drop_parts = 1