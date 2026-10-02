ALTER TABLE anon.metrics_store
    (MODIFY COLUMN `metric_value` Float64 CODEC(Gorilla, ZSTD(3))),
    (MODIFY COLUMN `display_name` String TTL event_date + toIntervalDay(90)),
    (MODIFY COLUMN `entity_group` REMOVE TTL)