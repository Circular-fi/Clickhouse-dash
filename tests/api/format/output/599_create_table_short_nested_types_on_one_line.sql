CREATE TABLE anon.shapes
(
    `id`       UInt64,
    `point`    Tuple(x Float64, y Float64),
    `pair`     Tuple(UInt8, String),
    `segments` Array(Tuple(a UInt32, b UInt32)),
    `by_name`  Map(String, Tuple(count UInt64, total Float64)),
    `maybe`    Nullable(Tuple(lo Int32, hi Int32)),
    `plain`    String
)
ENGINE = MergeTree
ORDER BY id