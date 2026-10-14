CREATE TABLE anon.deep
(
    `id`           UInt64,
    `short_nested` Tuple(a Tuple(b UInt8, c UInt8), d UInt8),
    `long_nested`  Tuple(
        first Tuple(alpha UInt64, beta String, gamma Float64),
        second Tuple(delta UInt64, epsilon String)
    ),
    `tail`         String
)
ENGINE = MergeTree
ORDER BY id