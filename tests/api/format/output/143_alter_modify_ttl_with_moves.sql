ALTER TABLE anon.metrics_store
(
    MODIFY TTL
        event_date + toIntervalDay(30) TO VOLUME 'cold',
        event_date + toIntervalYear(1)
)