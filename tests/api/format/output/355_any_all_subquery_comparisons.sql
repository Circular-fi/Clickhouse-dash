SELECT entity_key
FROM anon.metrics_store
WHERE
    metric_value > (
        SELECT max(*)
        FROM
        (
            SELECT metric_value
            FROM anon.baseline_store
        )
    )
    AND entity_group IN (
            SELECT entity_group
            FROM anon.active_groups
        )
    AND metric_ratio < (
        SELECT max(*)
        FROM
        (
            SELECT max_ratio
            FROM anon.limits
        )
    )