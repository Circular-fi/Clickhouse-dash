-- window around the incident
SELECT count()
FROM otel.traces
WHERE
    service_name = 'checkout'
    AND grid_timestamp_value
        BETWEEN start_ts - toIntervalSecond(window_seconds)
        AND end_ts_value_long
    AND x = 1