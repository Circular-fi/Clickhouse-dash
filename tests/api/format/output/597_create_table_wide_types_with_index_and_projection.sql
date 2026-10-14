CREATE TABLE chdash_ui.wide_types
(
    `id`              UInt64,
    `created_on`      Date,
    `long_identifier_for_visual_overflow_testing` String,
    `nullable_number` Nullable(Int64),
    `decimal_value`   Decimal(18, 6),
    `tuple_value`     Tuple(code UInt16, name String),
    `nested_array`    Array(Tuple(k String, v UInt64)),
    `tags`            Map(String, String),
    `state`           Enum8('new' = 1, 'processed' = 2, 'failed' = 3),
    INDEX idx_wide_types_state    state           TYPE set(16) GRANULARITY 1,
    INDEX idx_wide_types_nullable nullable_number TYPE minmax  GRANULARITY 1,
    PROJECTION prj_wide_types_state
    (
        SELECT
            created_on,
            state,
            count()
        GROUP BY
            created_on,
            state
    )
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(created_on)
ORDER BY (created_on, id)
SETTINGS index_granularity = 8192