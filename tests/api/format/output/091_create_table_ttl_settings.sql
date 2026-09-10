CREATE TABLE weather.ttl_observations
(
    `observed_at`   DateTime,
    `station_id`    String,
    `temperature_c` Float64
)
ENGINE = MergeTree
ORDER BY (station_id, observed_at)
TTL
    observed_at + toIntervalDay(30) RECOMPRESS CODEC(ZSTD(3)),
    observed_at + toIntervalDay(60) TO VOLUME 'warm',
    observed_at + toIntervalDay(365)
SETTINGS
    storage_policy          = 'tiered',
    min_rows_for_wide_part  = 0,
    min_bytes_for_wide_part = 0,
    index_granularity       = 256
