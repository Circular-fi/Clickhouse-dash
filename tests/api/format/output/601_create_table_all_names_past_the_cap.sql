CREATE TABLE anon.long_names
(
    `a_column_name_of_more_than_thirty_two_characters` String,
    `another_column_name_of_more_than_thirty_three`    UInt64,
    `tuple_column_with_a_name_of_more_than_the_cap`    Tuple(x UInt8, y UInt8)
)
ENGINE = MergeTree
ORDER BY tuple()