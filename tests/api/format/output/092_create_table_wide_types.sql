CREATE TABLE chdash_ui.wide_types
(
    `id`                                          UInt64,
    `created_on`                                  Date,
    `long_identifier_for_visual_overflow_testing` String,
    `nullable_number`                             Nullable(Int64),
    `decimal_value`                               Decimal(18, 6),
    `tuple_value`                                 Tuple(
        code UInt16,
        name String
    ),
    `nested_array`                                Array(Tuple(
        k String,
        v UInt64
    )),
    `tags`                                        Map(String, String),
    `state`                                       Enum8('new' = 1, 'processed' = 2, 'failed' = 3)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(created_on)
ORDER BY (created_on, id)
SETTINGS index_granularity = 8192
