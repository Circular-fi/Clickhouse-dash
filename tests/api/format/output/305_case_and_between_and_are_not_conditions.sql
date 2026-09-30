-- CASE and BETWEEN keep their own AND
SELECT count()
FROM otel.traces
WHERE
    service_name = 'checkout'
    AND case when status_code = 'Error' and duration_ms > 1000 then 1 else 0 end = 1
    AND duration_ms between 10 and 20