CREATE TABLE anon.commented
(
    `id`    UInt64, -- the key
    `point` Tuple(x Float64, y Float64), -- where
    `a_long_column_name_that_goes_past_the_alignment_cap` String, -- free text
    `tags`  Map(String, String)
)
ENGINE = MergeTree
ORDER BY id