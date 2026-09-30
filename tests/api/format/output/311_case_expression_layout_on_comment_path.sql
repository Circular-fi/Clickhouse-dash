-- classify spans
SELECT
    CASE
        WHEN status_code = 'Error' AND duration_ms > 1000 THEN 'slow error'
        WHEN status_code = 'Error' THEN 'error'
        ELSE 'ok'
    END AS `kind`,
    CASE http_method WHEN 'GET' THEN 'read' ELSE 'write' END AS `access`,
    count() AS `spans`
FROM otel.traces
GROUP BY
    kind,
    access