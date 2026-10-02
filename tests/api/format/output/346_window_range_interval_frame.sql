SELECT
    entity_key,
    event_timestamp,
    count() OVER (
        PARTITION BY entity_key
        ORDER BY toUnixTimestamp(event_timestamp) ASC
        RANGE BETWEEN 3600 PRECEDING AND CURRENT ROW
    ) AS `events_last_hour`
FROM anon.events_store
WHERE event_date >= today() - 7