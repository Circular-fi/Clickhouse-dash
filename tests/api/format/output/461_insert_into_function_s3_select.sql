INSERT INTO FUNCTION s3(
    'https://archive-bucket.s3.eu-west-1.amazonaws.com/exports/metrics_{_partition_id}.parquet',
    'Parquet'
) PARTITION BY toYYYYMM(event_date)
SELECT
    entity_key,
    event_date,
    metric_value
FROM anon.metrics_store
WHERE event_date < today() - 365