DELETE FROM anon.metrics_store
WHERE
    event_date < toDate('2025-01-01')
    AND entity_group = 'legacy_group'