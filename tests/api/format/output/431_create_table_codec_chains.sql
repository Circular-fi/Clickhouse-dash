CREATE TABLE anon.sensor_readings
(
    `sensor_id`     UInt32 CODEC(T64, LZ4),
    `reading_time`  DateTime CODEC(DoubleDelta, ZSTD(1)),
    `reading_value` Float64 CODEC(Gorilla, ZSTD(3)),
    `counter_value` UInt64 CODEC(Delta(8), LZ4HC(9)),
    `raw_payload`   String CODEC(ZSTD(19)),
    `flags`         UInt8 CODEC(NONE)
)
ENGINE = MergeTree
ORDER BY (sensor_id, reading_time)