-- raw events landing table
CREATE TABLE ingest.raw_events
(
    `event_time` DateTime64(3),
    `service`    LowCardinality(String),
    `payload`    String
)
ENGINE = MergeTree
ORDER BY (service, event_time)
-- keep 30 days, see TTL migration