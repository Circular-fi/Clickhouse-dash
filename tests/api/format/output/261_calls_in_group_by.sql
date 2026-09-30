SELECT count() AS `spans`
FROM otel.traces
GROUP BY
    service_name,
    toStartOfInterval(timestamp, toIntervalMinute(15)),
    JSONExtractString(
        resource_attributes_json,
        'deployment.environment.name',
        'value'
    )