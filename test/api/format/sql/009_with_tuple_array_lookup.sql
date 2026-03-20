WITH
    [
        ('entity_a', toDate('2026-01-01')),
        ('entity_b', toDate('2026-01-08')),
        ('entity_c', toDate('2026-01-15'))
    ]                                                             AS `plan_pairs`,
    arrayMin(arrayMap(item -> tupleElement(item, 2), plan_pairs)) AS `min_plan_date`
SELECT
    entity_key,
    event_date,
    metric_value
FROM anon.entity_metrics
PREWHERE event_date >= min_plan_date
WHERE arrayExists(
        item -> (
            entity_key = tupleElement(item, 1)
            AND event_date >= tupleElement(item, 2)
        ),
        plan_pairs
    )