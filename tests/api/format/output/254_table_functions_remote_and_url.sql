SELECT *
FROM remote(
    'clickhouse-{01..06}.prod.internal:9000',
    otel,
    traces,
    'readonly',
    ''
) AS t
INNER JOIN url(
    'https://status.example.com/api/v2/incidents.json',
    'JSONEachRow',
    'id String, service String, status String'
) AS i
    ON t.service_name = i.service
WHERE t.timestamp > now() - toIntervalHour(1)
SETTINGS input_format_skip_unknown_fields = 1