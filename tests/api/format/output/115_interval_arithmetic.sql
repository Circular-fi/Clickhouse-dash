SELECT
    now() - toIntervalDay(1)             AS `yesterday`,
    event_timestamp + toIntervalHour(2)  AS `shifted_timestamp`,
    toStartOfInterval(
        event_timestamp,
        toIntervalMinute(15)
    ) AS `quarter_hour`,
    dateDiff(
        'day',
        start_date,
        end_date
    ) AS `day_span`
FROM anon.metrics_store
WHERE event_timestamp >= now() - toIntervalDay(7)