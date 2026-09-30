SELECT
    user_id,
    sequenceMatch('(?1).*(?2).*(?3)')(
        event_time,
        event_name = 'product_view',
        event_name = 'add_to_cart',
        event_name = 'checkout_completed'
    ) AS `converted`
FROM events.clickstream
GROUP BY user_id