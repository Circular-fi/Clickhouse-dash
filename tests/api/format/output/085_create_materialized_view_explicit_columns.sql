CREATE MATERIALIZED VIEW chdash_ui.weather_city_counts
(
    `city`  LowCardinality(String),
    `count` UInt64
)
ENGINE = SummingMergeTree
ORDER BY city AS
SELECT
    city,
    count() AS `count`
FROM chdash_ui.weather_observations
GROUP BY city
