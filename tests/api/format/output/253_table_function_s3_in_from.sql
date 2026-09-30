SELECT
    count()         AS `rows`,
    min(timestamp)  AS `first_seen`
FROM s3(
    'https://observability-archive.s3.eu-west-1.amazonaws.com/otel/logs/2026/09/*.parquet',
    'Parquet',
    'timestamp DateTime64(9), body String, severity_text LowCardinality(String)'
)
WHERE severity_text = 'ERROR'