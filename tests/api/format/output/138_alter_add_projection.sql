ALTER TABLE anon.metrics_store
    ADD PROJECTION group_totals
    (
        SELECT
            entity_group,
            sum(metric_value)
        GROUP BY entity_group
    )