SELECT
    formatDateTime(
        toStartOfInterval(timestamp, toIntervalMinute(5)),
        '%Y-%m-%d %H:%i'
    ) AS `bucket_label`,
    arrayStringConcat(
        arrayMap(x -> lower(x), splitByChar(',', tags)),
        ','
    ) AS `normalized_tags`
FROM otel.logs