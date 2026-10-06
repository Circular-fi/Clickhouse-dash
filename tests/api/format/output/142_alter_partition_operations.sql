ALTER TABLE anon.metrics_store
    DROP PARTITION 202512,
    MOVE PARTITION 202601 TO TABLE anon.metrics_archive