SELECT
    service_name, -- one row per service
    timeSeriesInstantRateToGrid(start_ts, end_ts, step_seconds, window_seconds)(timestamps, values) AS rate_series,
    toStartOfWeek(toDate('2026-09-24'), 1) /* ISO week */
FROM metrics.resampled