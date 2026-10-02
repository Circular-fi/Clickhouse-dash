SELECT
    arrayCumSum(daily_counts) AS `cumulative_counts`,
    arraySplit(
        (x, is_boundary) -> is_boundary,
        event_ids,
        boundary_flags
    ) AS `sessions`,
    arrayFirstIndex(x -> x > 100, daily_counts) AS `first_busy_day`,
    arrayCount(x -> x = 0, daily_counts) AS `idle_days`
FROM anon.daily_series