SELECT avg(metric_value) * any(_sample_factor) AS `estimated_total`
FROM anon.metrics_store
SAMPLE 1000000