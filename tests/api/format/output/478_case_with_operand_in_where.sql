SELECT entity_key
FROM anon.metrics_store
WHERE caseWithExpression(
        entity_group,
        'group_live', metric_value > 0,
        'group_buffer', metric_value > 10,
        0
    ) = 1