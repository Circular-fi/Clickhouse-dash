SELECT entity_key
FROM anon.metrics_store
WHERE
    (
        (
            metric_value >= 10
            AND metric_value <= 20
        )
        AND (
            event_date < '2026-01-01'
            OR event_date > '2026-01-07'
        )
    )
    OR (
        (
            metric_ratio < 0.1
            OR metric_ratio > 0.9
        )
        AND entity_group != 'group_tmp'
    )