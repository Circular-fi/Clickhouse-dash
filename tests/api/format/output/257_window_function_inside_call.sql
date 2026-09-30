SELECT
    round(
        avg(duration_ms) OVER (
            PARTITION BY service_name
            ORDER BY timestamp ASC
            ROWS BETWEEN 10 PRECEDING AND CURRENT ROW
        ),
        2
    ) AS `smoothed_duration_ms`
FROM otel.traces