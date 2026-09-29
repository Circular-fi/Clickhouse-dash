SELECT
    caseWithExpression(
        entity_group,
        'group_a',
        1,
        'group_b',
        2,
        0
    ) AS `group_code`,
    multiIf(
        metric_value > 100, 'high',
        NULL
    ) AS `metric_tier`
FROM anon.metrics_store