SELECT
    arrayMap(
        x -> arrayMap(
            y -> arrayFilter(
                z -> z > y AND z < x + 100 AND z % 7 != 0,
                bucket_values
            ),
            bucket_lower_bounds
        ),
        bucket_upper_bounds
    ) AS `nested_buckets`
FROM metrics.histograms