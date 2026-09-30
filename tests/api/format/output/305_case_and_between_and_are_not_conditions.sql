-- CASE and BETWEEN keep their own AND
SELECT count()
FROM otel.traces
WHERE
    service_name = 'checkout'
    AND CASE
        WHEN status_code = 'Error' AND duration_ms > 1000 THEN 1
        ELSE 0
    END = 1
    AND duration_ms BETWEEN 10 AND 20