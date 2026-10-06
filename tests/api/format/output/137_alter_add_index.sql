ALTER TABLE anon.metrics_store
    ADD INDEX IF NOT EXISTS idx_entity_key entity_key
        TYPE bloom_filter(0.01)
        GRANULARITY 4