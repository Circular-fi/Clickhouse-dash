ALTER TABLE anon.metrics_store
(
    MODIFY TTL
        event_date + toIntervalDay(30) TO VOLUME 'cold',
        event_date + toIntervalDay(180) TO DISK 'archive',
        event_date + toIntervalYear(1) WHERE entity_group = 'group_tmp'
)