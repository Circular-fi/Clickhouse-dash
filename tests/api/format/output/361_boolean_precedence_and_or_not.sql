SELECT entity_key
FROM anon.metrics_store
WHERE
    (
        NOT is_deleted
        AND (
            entity_group = 'group_live'
            OR (
                entity_group = 'group_buffer'
                AND metric_value > 0
            )
        )
    )
    OR (
        NOT (
            metric_ratio > 1
            OR metric_ratio < 0
        )
        AND is_active
    )