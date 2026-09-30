CREATE TABLE ingest.raw_events
(
    event_time DateTime64(3), -- producer clock, UTC
    service LowCardinality(String), -- emitting service
    -- raw body, compressed
    payload String CODEC(ZSTD(3)), /* legacy */
    INDEX idx_service service TYPE set(100) GRANULARITY 4 -- low cardinality
)
ENGINE = MergeTree
ORDER BY (service, event_time)