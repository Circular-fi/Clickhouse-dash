ALTER TABLE anon.metrics_store
ADD COLUMN `region` LowCardinality(String) DEFAULT '' AFTER entity_group,
MODIFY ORDER BY (entity_group, entity_key, region)