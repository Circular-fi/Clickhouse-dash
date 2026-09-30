SELECT
    toUnixTimestamp64Milli(
        toDateTime64(
            parseDateTimeBestEffortOrNull(
                JSONExtractString(log_attributes_json, 'event', 'occurred_at')
            ),
            3,
            'UTC'
        )
    ) AS `occurred_at_ms`
FROM otel.logs
WHERE severity_text = 'ERROR'