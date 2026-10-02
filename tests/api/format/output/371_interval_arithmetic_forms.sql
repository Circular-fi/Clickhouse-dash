SELECT
    now() - toIntervalMonth(3) AS `three_months_ago`,
    toDate('2026-01-31') + toIntervalMonth(1) AS `next_month`,
    event_timestamp + (toIntervalDay(1), toIntervalHour(2)) AS `shifted_time`,
    toIntervalDay(1) + toIntervalHour(6) AS `composite_interval`,
    plus(event_date, toIntervalWeek(2)) AS `two_weeks_later`,
    dateDiff('minute', start_time, end_time) AS `duration_minutes`,
    toStartOfInterval(event_timestamp, toIntervalMinute(15)) AS `quarter_hour`
FROM anon.events_store