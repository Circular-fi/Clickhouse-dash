SELECT
    service_name,
    count() OVER (
        PARTITION BY service_name, deployment_environment
        ORDER BY timestamp ASC
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS `running_spans`,
    lagInFrame(duration_ms, 1, 0) OVER (
        PARTITION BY service_name
        ORDER BY timestamp ASC
    ) AS `previous_duration_ms`
FROM otel.traces