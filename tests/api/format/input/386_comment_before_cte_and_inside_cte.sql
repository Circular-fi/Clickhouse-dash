-- daily rollup
WITH daily AS (
    -- one row per entity and day
    SELECT entity_key, toDate(event_timestamp) AS event_day, count() AS event_count
    FROM anon.events_store
    GROUP BY entity_key, event_day
)
SELECT entity_key, max(event_count) AS peak_day_count -- peak
FROM daily
GROUP BY entity_key