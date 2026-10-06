ALTER TABLE anon.metrics_store
    MATERIALIZE PROJECTION group_totals,
    MATERIALIZE INDEX idx_entity_key IN PARTITION 202601