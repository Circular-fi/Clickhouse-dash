SELECT
    parseDateTime64BestEffortOrNull(
        log_attributes['event.time']
    ) AS `event_time_from_attributes`,
    formatDateTime(
        event_time,
        '%Y-%m-%d %H:%i:%S',
        'Europe/Paris'
    ) AS `local_event_time`
FROM otel.logs