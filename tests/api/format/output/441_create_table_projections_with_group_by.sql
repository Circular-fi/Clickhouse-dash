CREATE TABLE anon.page_views
(
    `view_time`   DateTime,
    `page_path`   String,
    `user_id`     UInt64,
    `duration_ms` UInt32,
    PROJECTION by_page
    (
        SELECT
            page_path,
            count(),
            sum(duration_ms)
        GROUP BY page_path
    ),
    PROJECTION by_user_time
    (
        SELECT *
        ORDER BY
            user_id,
            view_time
    )
)
ENGINE = MergeTree
ORDER BY view_time