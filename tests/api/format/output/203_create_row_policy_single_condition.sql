CREATE ROW POLICY live_only_policy ON anon.metrics_store
FOR SELECT
USING entity_group = 'group_live'
TO analyst, reporting_role