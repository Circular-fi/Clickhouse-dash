CREATE TABLE anon.names
(
    `id`                             UInt64,
    `event_date`                     Date,
    `short_name`                     String,
    `a_name_of_exactly_thirty_chars` String,
    `a_very_long_column_name_that_goes_past_the_alignment_cap_of_the_names` UInt8,
    `payload`                        String
)
ENGINE = MergeTree
ORDER BY id