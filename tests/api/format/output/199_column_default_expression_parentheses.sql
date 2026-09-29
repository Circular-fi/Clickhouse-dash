CREATE TABLE t
(
    `a` UInt32,
    `b` UInt32 DEFAULT (a + 1) * 2,
    `c` UInt32 MATERIALIZED (a * b) + 1
)
ENGINE = MergeTree
PARTITION BY a % 10
ORDER BY (a)
TTL toDateTime(a) + toIntervalDay(1 + 2)