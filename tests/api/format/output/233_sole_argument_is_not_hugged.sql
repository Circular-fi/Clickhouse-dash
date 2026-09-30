SELECT
    sipHash64(
        concat(
            toString(user_id),
            '|',
            session_id,
            '|',
            toString(toStartOfHour(event_time))
        )
    ) AS `session_bucket_key`
FROM events.page_views