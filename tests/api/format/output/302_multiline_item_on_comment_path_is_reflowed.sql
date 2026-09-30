-- tuple element of an exploded call
SELECT x
FROM
(
    SELECT
        metric_id,
        finalizeAggregation(
            samples_with_a_rather_long_name_for_this_example_state
        ).1 AS `timestamps`
    FROM t_resampled_timeseries_15_sec
)