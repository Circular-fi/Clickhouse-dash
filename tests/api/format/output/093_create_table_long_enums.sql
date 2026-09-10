CREATE TABLE chdash_ui.enum_format
(
    `id`        UInt64,
    `operation` Enum16(
        'Close' = -11,
        'Error' = -1,
        'Watch' = 0,
        'Create' = 1,
        'Remove' = 2,
        'Exists' = 3,
        'Get' = 4,
        'Set' = 5
    ),
    `errors`    Map(
        Enum8(
            'ZNOWATCHER' = -121,
            'ZNOTREADONLY' = -119,
            'ZSESSIONMOVED' = -118,
            'ZNOTHING' = -117,
            'ZCLOSING' = -116,
            'ZAUTHFAILED' = -115
        ),
        UInt32
    )
)
ENGINE = MergeTree
ORDER BY id
