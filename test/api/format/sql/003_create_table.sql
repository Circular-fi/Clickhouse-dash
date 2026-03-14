CREATE TABLE anon_table
(
    `anon_key`   String,
    `anon_value` UInt64
)
ENGINE = MergeTree
ORDER BY anon_key