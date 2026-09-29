SELECT
    arrayFilter(
        x -> arrayExists(
            y -> y = x,
            allowed_values
        ),
        arrayMap(z -> lower(z), raw_values)
    ) AS `kept_values`,
    arraySort(
        (name, score) -> score,
        names,
        scores
    ) AS `sorted_names`
FROM anon.catalog