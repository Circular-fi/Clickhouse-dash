create table db.t (
a UInt8, -- , b String or c
b String -- default 'x', d
) engine = MergeTree order by a