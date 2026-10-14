CREATE TABLE anon.wide_shapes
(
    `id`       UInt64,
    `location` Tuple(
        latitude Float64,
        longitude Float64,
        altitude Nullable(Int32),
        accuracy_in_meters Float32
    ),
    `history`  Array(Tuple(
        observed_at DateTime64(3, 'UTC'),
        source LowCardinality(String),
        value Float64,
        flags Array(UInt8)
    )),
    `small`    Tuple(a UInt8, b UInt8)
)
ENGINE = MergeTree
ORDER BY id