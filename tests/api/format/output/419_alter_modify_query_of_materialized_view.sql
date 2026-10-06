ALTER TABLE anon.daily_rollup_mv
    MODIFY QUERY
    SELECT
        toDate(event_timestamp) AS event_day,
        entity_key,
        count() AS event_count
    FROM anon.events_store
    GROUP BY
        event_day,
        entity_key