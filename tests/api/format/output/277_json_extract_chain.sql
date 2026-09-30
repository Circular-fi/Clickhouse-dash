SELECT
    JSONExtractString(
        JSONExtractRaw(log_attributes_json, 'http'),
        'request',
        'headers',
        'user-agent'
    ) AS `user_agent`,
    JSONExtractUInt(log_attributes_json, 'http', 'status') AS `status`
FROM otel.logs