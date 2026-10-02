SELECT
    entity_key,
    row_number() OVER base_window AS `row_index`,
    sum(metric_value) OVER (
        base_window
        ROWS BETWEEN 1 PRECEDING AND CURRENT ROW
    ) AS `pair_sum`,
    avg(metric_value) OVER trailing_week AS `trailing_avg`
FROM anon.metrics_store
WINDOW
    base_window AS (PARTITION BY entity_group ORDER BY event_date ASC),
    trailing_week AS (base_window ROWS BETWEEN 6 PRECEDING AND CURRENT ROW)