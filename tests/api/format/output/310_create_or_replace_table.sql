CREATE OR REPLACE TABLE if_exists_demo ON CLUSTER default
(
    `id`    UInt64,
    `point` Tuple(
        x Float64,
        y Float64
    )
)
ENGINE = MergeTree
ORDER BY id