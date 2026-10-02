CREATE TABLE anon.event_history
(
    `event_date`   Date,
    `entity_key`   String,
    `metric_value` Float64
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(event_date)
ORDER BY (entity_key, event_date)
TTL
    event_date + toIntervalDay(7) RECOMPRESS CODEC(ZSTD(9)),
    event_date + toIntervalDay(30) TO DISK 'warm_disk',
    event_date + toIntervalDay(180) TO VOLUME 'cold_volume',
    event_date + toIntervalDay(365)