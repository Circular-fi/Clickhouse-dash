INSERT INTO anon.metrics_store
    (
        entity_key,
        event_date,
        event_timestamp,
        entity_group,
        metric_value,
        metric_ratio,
        tag_values,
        attr_map
    )
VALUES
    (
        'entity_a',
        toDate('2026-01-01'),
        toDateTime64('2026-01-01 00:00:00', 3, 'UTC'),
        'group_a',
        100,
        1.250000,
        ['tag_a', 'tag_b'],
        map('region', 'north', 'status', 'active')
    )
