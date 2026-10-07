ALTER TABLE anon.metrics_store
UPDATE
    metric_value = metric_value * 1000,
    metric_unit = 'ms'
IN PARTITION 202601
WHERE
    metric_unit = 's'
    AND metric_value < 1000