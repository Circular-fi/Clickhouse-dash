-- window around the incident
SELECT count()
FROM otel.traces
WHERE
    service_name = 'checkout'
    AND grid_timestamp_value
        between start_ts - toIntervalSecond(window_seconds)
        and end_ts_value_long
    AND x = 1