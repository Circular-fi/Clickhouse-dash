SELECT
    toStartOfInterval(
        event_timestamp,
        toIntervalHour(1),
        'Europe/Berlin'
    ) AS `local_hour`,
    count() AS `event_count`
FROM anon.events_store
GROUP BY local_hour
ORDER BY local_hour ASC