CREATE TABLE anon.boundary
(
    `id`    UInt64,
    `point` Tuple(first_coordinate Float64, second_coordinate Float64)
)
ENGINE = MergeTree
ORDER BY id