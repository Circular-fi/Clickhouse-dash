SELECT
    tag_values[1]                 AS `first_tag`,
    tag_values[-1]                AS `last_tag`,
    arraySlice(tag_values, 2, 3)  AS `middle_tags`,
    [[1, 2], [3]]                 AS `nested_array`,
    []                            AS `empty_array`
FROM anon.metrics_store