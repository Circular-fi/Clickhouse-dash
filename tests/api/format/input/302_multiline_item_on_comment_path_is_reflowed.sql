-- tuple element of an exploded call
select x from (
    select
        metric_id,
        finalizeAggregation(
            samples_with_a_rather_long_name_for_this_example_state
        ).1 as timestamps
    from t_resampled_timeseries_15_sec
)