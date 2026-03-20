-- INPUT
CREATE MATERIALIZED VIEW anon.metrics_store_mv
ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(event_date)
ORDER BY (entity_group, entity_key, event_date) AS
SELECT
    entity_group,
    entity_key,
    event_date,
    sum(metric_value)                   AS metric_value,
    sum(toUInt64(metric_ratio * 1000))  AS metric_ratio_scaled
FROM anon.metrics_store
GROUP BY
    entity_group,
    entity_key,
    event_date

-- EXPECTED
CREATE MATERIALIZED VIEW anon.metrics_store_mv
ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(event_date)
ORDER BY (entity_group, entity_key, event_date) AS `SELECT`
    entity_group,
    entity_key,
    event_date,
    sum(metric_value)                   AS `metric_value`,
    sum(toUInt64(metric_ratio * 1000))  AS `metric_ratio_scaled`
FROM anon.metrics_store
GROUP BY
    entity_group,
    entity_key,
    event_date
