SELECT
    entity_key,
    rank() OVER w                    AS `metric_rank`,
    lagInFrame(metric_value) OVER w  AS `previous_metric`
FROM anon.metrics_store
WINDOW w AS (PARTITION BY entity_group ORDER BY metric_value DESC)