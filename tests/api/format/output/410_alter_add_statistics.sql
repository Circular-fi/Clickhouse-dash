ALTER TABLE anon.metrics_store
ADD STATISTICS IF NOT EXISTS metric_value, metric_ratio TYPE tdigest, uniq