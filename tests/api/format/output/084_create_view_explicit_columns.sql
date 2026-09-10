CREATE VIEW chdash_ui.mild_weather_observations
(
    `observed_at`      DateTime64(3),
    `id`               UInt64,
    `station_id`       LowCardinality(String),
    `city`             LowCardinality(String),
    `temperature_c`    Float64,
    `humidity_pct`     UInt8,
    `precipitation_mm` Float64,
    `tags`             Array(String),
    `metadata`         Map(String, String)
) AS
SELECT
    observed_at,
    id,
    station_id,
    city,
    temperature_c,
    humidity_pct,
    precipitation_mm,
    tags,
    metadata
FROM chdash_ui.valid_weather_observations
WHERE
    temperature_c >= 10
    AND temperature_c <= 24