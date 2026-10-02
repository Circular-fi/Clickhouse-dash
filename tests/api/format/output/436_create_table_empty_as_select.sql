CREATE TABLE anon.metrics_copy
ENGINE = MergeTree
ORDER BY entity_key
EMPTY AS
SELECT
    entity_key,
    metric_value
FROM anon.metrics_store