ALTER TABLE anon.metrics_store
(
    ADD COLUMN IF NOT EXISTS
        `source_name` LowCardinality(String)
    AFTER entity_group
)