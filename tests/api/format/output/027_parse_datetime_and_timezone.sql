SELECT
    entity_key,
    parseDateTimeBestEffort(event_timestamp_raw) AS `parsed_timestamp`,
    toTimeZone(
        parseDateTimeBestEffort(event_timestamp_raw),
        'UTC'
    ) AS `utc_timestamp`,
    toDate(parsed_timestamp) AS `event_date`
FROM anon.raw_events
