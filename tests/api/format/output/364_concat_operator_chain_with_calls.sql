SELECT
    concat(
        entity_group,
        '/',
        entity_key,
        ':',
        toString(metric_value)
    ) AS `composite_label`,
    concat(
        upper(entity_group),
        '-',
        lpad(toString(entity_rank), 4, '0')
    ) AS `rank_label`
FROM anon.metrics_store