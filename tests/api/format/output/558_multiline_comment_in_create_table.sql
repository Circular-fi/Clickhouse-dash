CREATE TABLE db.t
(
    `a` UInt8, -- , b String or c
    `b` String -- default 'x', d
)
ENGINE = MergeTree
ORDER BY a