SELECT arrayMap(outer_item -> arrayFilter(inner_item -> ((inner_item % 2) = 0), outer_item), [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12]]) AS even_number_groups
