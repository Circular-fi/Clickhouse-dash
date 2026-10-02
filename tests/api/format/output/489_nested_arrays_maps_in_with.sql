WITH
    [[1, 2], [3, 4, 5], []]       AS `nested_numbers`,
    map('a', [1, 2], 'b', [3])    AS `keyed_arrays`,
    [('x', 1), ('y', 2)]          AS `pairs`
SELECT
    arrayFlatten(nested_numbers)  AS `flat_numbers`,
    keyed_arrays['a']             AS `first_list`,
    arrayMap(p -> p.2, pairs)     AS `pair_values`