SELECT
    service_name,
    quantileExact(0.99)(duration_ms) AS `p99`
FROM otel.traces
GROUP BY service_name
HAVING
    quantileExact(0.99)(duration_ms) > 2 * quantileExact(0.5)(duration_ms)
    AND count() > 1000
ORDER BY quantileExact(0.99)(duration_ms) DESC