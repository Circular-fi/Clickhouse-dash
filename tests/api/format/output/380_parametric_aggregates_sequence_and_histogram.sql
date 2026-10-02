SELECT
    sequenceMatch('(?1)(?t<=3600)(?2)')(
        event_time,
        event_name = 'signup',
        event_name = 'purchase'
    ) AS `converted_within_hour`,
    sequenceCount('(?1).*(?2)')(
        event_time,
        event_name = 'view',
        event_name = 'cart'
    ) AS `view_cart_count`,
    histogram(10)(response_ms) AS `response_histogram`,
    topK(5)(entity_key) AS `top_entities`,
    quantileTDigest(0.95)(response_ms) AS `p95_response`
FROM anon.events_store
GROUP BY session_id