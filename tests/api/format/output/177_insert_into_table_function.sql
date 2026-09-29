INSERT INTO FUNCTION file('metrics.parquet', 'Parquet')
SELECT
    entity_key,
    metric_value
FROM anon.metrics_store