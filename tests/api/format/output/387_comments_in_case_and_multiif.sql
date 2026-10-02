SELECT
    multiIf(
        metric_value > 100, 'high', -- above threshold
        metric_value > 10, 'medium', -- middle band
        'low'
    ) AS `value_band`,
    CASE
        WHEN is_deleted THEN 'deleted' -- soft deleted
        WHEN is_hidden THEN 'hidden'
        ELSE 'visible'
    END AS `visibility`
FROM anon.metrics_store