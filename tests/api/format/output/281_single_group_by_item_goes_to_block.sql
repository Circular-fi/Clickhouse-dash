SELECT count() AS `spans`
FROM otel.traces
GROUP BY
    JSONExtractString(
        resource_attributes_json,
        'deployment.environment.name',
        'value',
        'fallback'
    )
ORDER BY toStartOfHour(min(timestamp)) ASC