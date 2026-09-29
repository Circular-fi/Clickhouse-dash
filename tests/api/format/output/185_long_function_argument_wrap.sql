SELECT
    concat(
        entity_group,
        ':',
        entity_key,
        ':',
        toString(event_date),
        ':',
        toString(metric_value),
        ':',
        region_key
    ) AS `composite_key`,
    formatDateTime(
        event_timestamp,
        '%Y-%m-%d %H:%i:%S',
        'Europe/Paris'
    ) AS `local_time`
FROM anon.metrics_store