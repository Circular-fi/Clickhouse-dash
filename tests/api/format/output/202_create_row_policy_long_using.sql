CREATE ROW POLICY IF NOT EXISTS tenant_isolation ON anon.metrics_store
AS RESTRICTIVE
FOR SELECT
USING
    tenant_id = currentUser()
    AND entity_group IN ('group_live', 'group_buffer')
    AND is_deleted = 0
TO analyst, reporting_role