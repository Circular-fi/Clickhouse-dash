ALTER TABLE anon.metrics_store
(
    DELETE WHERE event_date < toDate('2025-01-01')
)
SETTINGS mutations_sync = 2