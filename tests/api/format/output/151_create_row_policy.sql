CREATE ROW POLICY live_only ON anon.metrics_store
FOR SELECT
USING entity_group = 'live'
TO analyst