SELECT
    toStartOfDay(event_timestamp)  AS `event_day`,
    count()                        AS `event_count`
FROM anon.events_store
WHERE event_timestamp >= '2026-01-01'
GROUP BY event_day
ORDER BY event_day ASC WITH FILL
    FROM toDateTime('2026-01-01')
    TO toDateTime('2026-02-01')
    STEP toIntervalDay(1)