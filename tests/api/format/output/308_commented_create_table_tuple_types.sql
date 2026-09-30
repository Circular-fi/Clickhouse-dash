CREATE TABLE metrics_by_route
(
    `route`   String, -- normalized path
    `latency` Tuple(
        p50 Float64,
        p99 Float64
    ),
    `buckets` Array(Tuple(
        le Float64,
        n UInt64
    )),
    `tags`    Map(String, String)
)
ENGINE = MergeTree
ORDER BY route