WITH
    raw_events AS
    (
        SELECT
            entity_key,
            event_timestamp
        FROM anon.events_store
        WHERE event_date = today()
    ),
    sessionised AS
    (
        SELECT
            entity_key,
            count() AS `event_count`
        FROM raw_events
        GROUP BY entity_key
    ),
    ranked AS
    (
        SELECT
            entity_key,
            event_count,
            row_number() OVER (ORDER BY event_count DESC) AS `position`
        FROM sessionised
    )
SELECT *
FROM ranked
WHERE position <= 10