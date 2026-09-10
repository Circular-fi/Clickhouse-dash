CREATE DATABASE IF NOT EXISTS chdash_ui;

-- Deterministic synthetic weather fixture. Only generated meteorological data
-- is embedded in the test stack.
DROP DICTIONARY IF EXISTS chdash_ui.station_dictionary;
DROP VIEW IF EXISTS chdash_ui.weather_observation_quality_join;
DROP VIEW IF EXISTS chdash_ui.mild_weather_observations;
DROP VIEW IF EXISTS chdash_ui.valid_weather_observations;
DROP VIEW IF EXISTS chdash_ui.weather_buffer_city_mv;
DROP VIEW IF EXISTS chdash_ui.weather_buffer_alert_mv;
DROP VIEW IF EXISTS chdash_ui.weather_daily_summary_mv;
DROP TABLE IF EXISTS chdash_ui.weather_daily_summary;
DROP TABLE IF EXISTS chdash_ui.weather_buffer;
DROP TABLE IF EXISTS chdash_ui.weather_city_ingest_target;
DROP TABLE IF EXISTS chdash_ui.weather_alert_buffer;
DROP TABLE IF EXISTS chdash_ui.weather_alert_target;
DROP TABLE IF EXISTS chdash_ui.memory_weather;
DROP TABLE IF EXISTS chdash_ui.station_dictionary_source;
DROP TABLE IF EXISTS chdash_ui.wide_types;
DROP TABLE IF EXISTS chdash_ui.weather_observations;

CREATE TABLE chdash_ui.weather_observations
(
    observed_at DateTime64(3),
    observation_date Date MATERIALIZED toDate(observed_at),
    id UInt64,
    station_id LowCardinality(String),
    city LowCardinality(String),
    quality_ok Bool,
    temperature_c Float64,
    humidity_pct UInt8,
    precipitation_mm Float64,
    notes Nullable(String),
    random_token String,
    sensor_packet Tuple(
        station Tuple(
            code String,
            coordinates Tuple(lat Float64, lon Float64),
            labels Array(String)
        ),
        reading Tuple(
            value Float64,
            unit String,
            diagnostics Tuple(samples Array(Float32), flags Array(String))
        )
    ),
    tags Array(String),
    metadata Map(String, String),

    INDEX idx_temperature temperature_c TYPE minmax GRANULARITY 1,
    INDEX idx_random_token random_token TYPE minmax GRANULARITY 1,
    INDEX idx_city city TYPE set(128) GRANULARITY 2,

    PROJECTION by_city_day
    (
        SELECT
            observation_date,
            city,
            count() AS observation_count,
            avg(temperature_c) AS average_temperature_c
        GROUP BY observation_date, city
    ),
    PROJECTION by_station_time
    (
        SELECT
            station_id,
            observed_at,
            id,
            temperature_c
        ORDER BY (station_id, observed_at, id)
    ),
    PROJECTION by_random_token
    (
        SELECT
            random_token,
            id,
            observed_at
        ORDER BY (random_token, id)
    )
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(observation_date)
ORDER BY (observation_date, station_id, observed_at, id)
TTL
    observed_at + INTERVAL 30 DAY RECOMPRESS CODEC(ZSTD(3)),
    observed_at + INTERVAL 60 DAY TO VOLUME 'warm',
    observed_at + INTERVAL 365 DAY DELETE
SETTINGS
    storage_policy = 'fixture_tiered',
    min_rows_for_wide_part = 0,
    min_bytes_for_wide_part = 0,
    index_granularity = 256;

CREATE TABLE chdash_ui.weather_daily_summary
(
    observation_date Date,
    city LowCardinality(String),
    observation_count AggregateFunction(count),
    average_temperature AggregateFunction(avg, Float64)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(observation_date)
ORDER BY (observation_date, city);

CREATE MATERIALIZED VIEW chdash_ui.weather_daily_summary_mv
TO chdash_ui.weather_daily_summary
AS
SELECT
    observation_date,
    city,
    countState() AS observation_count,
    avgState(temperature_c) AS average_temperature
FROM chdash_ui.weather_observations
GROUP BY observation_date, city;

-- Three independent inserts guarantee multiple active Wide parts while keeping
-- the generated dataset deterministic. The final table contains 120,000 rows
-- before the small Buffer exercise below.
INSERT INTO chdash_ui.weather_observations
    (observed_at, id, station_id, city, quality_ok, temperature_c, humidity_pct,
     precipitation_mm, notes, random_token, sensor_packet, tags, metadata)
SELECT
    toDateTime64('2026-09-01 00:00:00', 3) + toIntervalSecond(number),
    number,
    arrayElement(['WX-PAR-01', 'WX-REK-02', 'WX-LIS-03', 'WX-OSL-04', 'WX-ROM-05'], (number % 5) + 1),
    arrayElement(['Paris', 'Reykjavik', 'Lisbon', 'Oslo', 'Rome'], (number % 5) + 1),
    number % 11 != 0,
    round(-8.0 + (number % 6500) / 100.0, 2),
    toUInt8(20 + (number % 80)),
    round((number % 240) / 20.0, 2),
    if(number % 17 = 0, NULL, concat('synthetic-weather-note-', toString(number))),
    concat(hex(cityHash64(number)), '-', leftPad(toString(number % 10000), 4, '0')),
    tuple(
        tuple(
            arrayElement(['WX-PAR-01', 'WX-REK-02', 'WX-LIS-03', 'WX-OSL-04', 'WX-ROM-05'], (number % 5) + 1),
            tuple(48.0 + (number % 900) / 100.0, -9.0 + (number % 2800) / 100.0),
            ['synthetic', arrayElement(['urban', 'coastal', 'mountain'], (number % 3) + 1)]
        ),
        tuple(
            round(-8.0 + (number % 6500) / 100.0, 2),
            'celsius',
            tuple(
                [toFloat32(number % 13), toFloat32((number + 3) % 17), toFloat32((number + 7) % 19)],
                [arrayElement(['ok', 'calibration', 'battery'], (number % 3) + 1)]
            )
        )
    ),
    [arrayElement(['clear', 'cloudy', 'rain', 'snow'], (number % 4) + 1), 'synthetic-weather'],
    map('fixture', 'weather', 'batch', 'a', 'row', toString(number))
FROM numbers(40000);

INSERT INTO chdash_ui.weather_observations
    (observed_at, id, station_id, city, quality_ok, temperature_c, humidity_pct,
     precipitation_mm, notes, random_token, sensor_packet, tags, metadata)
SELECT
    toDateTime64('2026-09-02 00:00:00', 3) + toIntervalSecond(number),
    number + 40000,
    arrayElement(['WX-PAR-01', 'WX-REK-02', 'WX-LIS-03', 'WX-OSL-04', 'WX-ROM-05'], ((number + 1) % 5) + 1),
    arrayElement(['Paris', 'Reykjavik', 'Lisbon', 'Oslo', 'Rome'], ((number + 2) % 5) + 1),
    number % 13 != 0,
    round(-4.0 + (number % 5900) / 100.0, 2),
    toUInt8(15 + (number % 85)),
    round((number % 180) / 18.0, 2),
    if(number % 19 = 0, NULL, concat('synthetic-weather-note-', toString(number + 40000))),
    concat(hex(cityHash64(number + 40000)), '-', leftPad(toString(number % 10000), 4, '0')),
    tuple(
        tuple(
            arrayElement(['WX-PAR-01', 'WX-REK-02', 'WX-LIS-03', 'WX-OSL-04', 'WX-ROM-05'], ((number + 1) % 5) + 1),
            tuple(48.0 + (number % 900) / 100.0, -9.0 + (number % 2800) / 100.0),
            ['synthetic', arrayElement(['urban', 'coastal', 'mountain'], ((number + 1) % 3) + 1)]
        ),
        tuple(
            round(-4.0 + (number % 5900) / 100.0, 2),
            'celsius',
            tuple(
                [toFloat32(number % 11), toFloat32((number + 5) % 23), toFloat32((number + 9) % 29)],
                [arrayElement(['ok', 'humidity-check', 'wind-check'], (number % 3) + 1)]
            )
        )
    ),
    [arrayElement(['clear', 'wind', 'showers', 'fog'], (number % 4) + 1), 'synthetic-weather'],
    map('fixture', 'weather', 'batch', 'b', 'row', toString(number + 40000))
FROM numbers(40000);

INSERT INTO chdash_ui.weather_observations
    (observed_at, id, station_id, city, quality_ok, temperature_c, humidity_pct,
     precipitation_mm, notes, random_token, sensor_packet, tags, metadata)
SELECT
    toDateTime64('2026-09-03 00:00:00', 3) + toIntervalSecond(number),
    number + 80000,
    arrayElement(['WX-PAR-01', 'WX-REK-02', 'WX-LIS-03', 'WX-OSL-04', 'WX-ROM-05'], ((number + 3) % 5) + 1),
    arrayElement(['Paris', 'Reykjavik', 'Lisbon', 'Oslo', 'Rome'], ((number + 4) % 5) + 1),
    number % 7 != 0,
    round(-12.0 + (number % 7200) / 100.0, 2),
    toUInt8(10 + (number % 90)),
    round((number % 300) / 25.0, 2),
    if(number % 23 = 0, NULL, concat('synthetic-weather-note-', toString(number + 80000))),
    concat(hex(cityHash64(number + 80000)), '-', leftPad(toString(number % 10000), 4, '0')),
    tuple(
        tuple(
            arrayElement(['WX-PAR-01', 'WX-REK-02', 'WX-LIS-03', 'WX-OSL-04', 'WX-ROM-05'], ((number + 3) % 5) + 1),
            tuple(48.0 + (number % 900) / 100.0, -9.0 + (number % 2800) / 100.0),
            ['synthetic', arrayElement(['urban', 'coastal', 'mountain'], ((number + 2) % 3) + 1)]
        ),
        tuple(
            round(-12.0 + (number % 7200) / 100.0, 2),
            'celsius',
            tuple(
                [toFloat32(number % 7), toFloat32((number + 11) % 31), toFloat32((number + 13) % 37)],
                [arrayElement(['ok', 'pressure-check', 'sensor-check'], (number % 3) + 1)]
            )
        )
    ),
    [arrayElement(['clear', 'storm', 'snow', 'hail'], (number % 4) + 1), 'synthetic-weather'],
    map('fixture', 'weather', 'batch', 'c', 'row', toString(number + 80000))
FROM numbers(40000);

CREATE VIEW chdash_ui.valid_weather_observations AS
SELECT
    observed_at,
    id,
    station_id,
    city,
    temperature_c,
    humidity_pct,
    precipitation_mm,
    random_token,
    sensor_packet,
    tags,
    metadata
FROM chdash_ui.weather_observations
WHERE quality_ok;

CREATE VIEW chdash_ui.mild_weather_observations AS
SELECT *
FROM chdash_ui.valid_weather_observations
WHERE temperature_c BETWEEN 10 AND 24;

-- Lineage fixture: one ordinary View depends on both a persistent MergeTree
-- and another ordinary View through a JOIN. This verifies that query-time view
-- dependencies remain visible without being mistaken for insert-time flow.
CREATE VIEW chdash_ui.weather_observation_quality_join AS
SELECT
    source.id,
    source.observed_at,
    source.station_id,
    source.city,
    valid.temperature_c AS valid_temperature_c
FROM chdash_ui.weather_observations AS source
INNER JOIN chdash_ui.valid_weather_observations AS valid
    ON source.id = valid.id;

CREATE TABLE chdash_ui.memory_weather
(
    id UInt64,
    station_id String
)
ENGINE = Memory;

INSERT INTO chdash_ui.memory_weather VALUES
    (1, 'WX-PAR-01'), (2, 'WX-REK-02'), (3, 'WX-LIS-03');

-- Main Buffer feeds the large MergeTree. Two MVs subscribe to that same Buffer:
-- one writes directly to a MergeTree, the second writes to another Buffer.
CREATE TABLE chdash_ui.weather_city_ingest_target
(
    observed_at DateTime64(3),
    id UInt64,
    city LowCardinality(String),
    temperature_c Float64
)
ENGINE = MergeTree
ORDER BY (city, observed_at, id);

CREATE TABLE chdash_ui.weather_alert_target
(
    observed_at DateTime64(3),
    id UInt64,
    station_id LowCardinality(String),
    temperature_c Float64,
    severity LowCardinality(String)
)
ENGINE = MergeTree
ORDER BY (station_id, observed_at, id);

CREATE TABLE chdash_ui.weather_alert_buffer
(
    observed_at DateTime64(3),
    id UInt64,
    station_id LowCardinality(String),
    temperature_c Float64,
    severity LowCardinality(String)
)
ENGINE = Buffer(chdash_ui, weather_alert_target, 1, 60, 600, 100000, 1000000, 10485760, 104857600);

CREATE TABLE chdash_ui.weather_buffer
(
    observed_at DateTime64(3),
    id UInt64,
    station_id LowCardinality(String),
    city LowCardinality(String),
    quality_ok Bool,
    temperature_c Float64,
    humidity_pct UInt8,
    precipitation_mm Float64,
    notes Nullable(String),
    random_token String,
    sensor_packet Tuple(
        station Tuple(code String, coordinates Tuple(lat Float64, lon Float64), labels Array(String)),
        reading Tuple(value Float64, unit String, diagnostics Tuple(samples Array(Float32), flags Array(String)))
    ),
    tags Array(String),
    metadata Map(String, String)
)
ENGINE = Buffer(chdash_ui, weather_observations, 1, 60, 600, 100000, 1000000, 10485760, 104857600);

CREATE MATERIALIZED VIEW chdash_ui.weather_buffer_city_mv
TO chdash_ui.weather_city_ingest_target
AS
SELECT observed_at, id, city, temperature_c
FROM chdash_ui.weather_buffer;

CREATE MATERIALIZED VIEW chdash_ui.weather_buffer_alert_mv
TO chdash_ui.weather_alert_buffer
AS
SELECT
    observed_at,
    id,
    station_id,
    temperature_c,
    multiIf(temperature_c >= 35, 'hot', temperature_c <= -5, 'cold', 'normal') AS severity
FROM chdash_ui.weather_buffer;

INSERT INTO chdash_ui.weather_buffer
    (observed_at, id, station_id, city, quality_ok, temperature_c, humidity_pct,
     precipitation_mm, notes, random_token, sensor_packet, tags, metadata)
SELECT
    toDateTime64('2026-09-04 00:00:00', 3) + toIntervalSecond(number),
    number + 120000,
    arrayElement(['WX-PAR-01', 'WX-REK-02', 'WX-LIS-03', 'WX-OSL-04', 'WX-ROM-05'], (number % 5) + 1),
    arrayElement(['Paris', 'Reykjavik', 'Lisbon', 'Oslo', 'Rome'], (number % 5) + 1),
    1,
    round(-15.0 + (number % 6000) / 100.0, 2),
    toUInt8(25 + (number % 70)),
    round((number % 80) / 10.0, 2),
    concat('buffer-weather-note-', toString(number)),
    concat(hex(cityHash64(number + 120000)), '-buffer'),
    tuple(
        tuple('WX-BUF-01', tuple(50.0, 2.0), ['synthetic', 'buffer']),
        tuple(round(-15.0 + (number % 6000) / 100.0, 2), 'celsius', tuple([toFloat32(number % 5)], ['buffer']))
    ),
    ['buffer', 'synthetic-weather'],
    map('fixture', 'weather-buffer', 'row', toString(number))
FROM numbers(64);

CREATE TABLE chdash_ui.wide_types
(
    id UInt64,
    created_on Date,
    long_identifier_for_visual_overflow_testing String,
    nullable_number Nullable(Int64),
    decimal_value Decimal(18, 6),
    tuple_value Tuple(code UInt16, name String),
    nested_array Array(Tuple(k String, v UInt64)),
    tags Map(String, String),
    state Enum8('new' = 1, 'processed' = 2, 'failed' = 3),
    INDEX idx_wide_types_state state TYPE set(16) GRANULARITY 1,
    INDEX idx_wide_types_nullable nullable_number TYPE minmax GRANULARITY 1,
    PROJECTION prj_wide_types_state
    (
        SELECT
            created_on,
            state,
            count()
        GROUP BY
            created_on,
            state
    )
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(created_on)
ORDER BY (created_on, id)
SETTINGS index_granularity = 8192;

INSERT INTO chdash_ui.wide_types
SELECT
    number,
    toDate('2026-08-01') + toIntervalDay(number),
    concat('Synthetic responsive-layout value for row ', toString(number), ' — xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'),
    if(number % 4 = 0, NULL, toInt64(number) * -100),
    toDecimal64(number / 7, 6),
    tuple(toUInt16(number % 65535), concat('tuple-', toString(number))),
    [('alpha', number), ('beta', number + 1)],
    map('fixture', 'wide-types', 'row', toString(number)),
    CAST(arrayElement(['new', 'processed', 'failed'], (number % 3) + 1), 'Enum8(\'new\' = 1, \'processed\' = 2, \'failed\' = 3)')
FROM numbers(48);

CREATE TABLE chdash_ui.station_dictionary_source
(
    station_id String,
    display_name String,
    elevation_m UInt16
)
ENGINE = TinyLog;

INSERT INTO chdash_ui.station_dictionary_source VALUES
    ('WX-PAR-01', 'Paris synthetic station', 35),
    ('WX-REK-02', 'Reykjavik synthetic station', 61),
    ('WX-LIS-03', 'Lisbon synthetic station', 95),
    ('WX-OSL-04', 'Oslo synthetic station', 23),
    ('WX-ROM-05', 'Rome synthetic station', 21);

CREATE DICTIONARY chdash_ui.station_dictionary
(
    station_id String,
    display_name String DEFAULT '',
    elevation_m UInt16 DEFAULT 0
)
PRIMARY KEY station_id
SOURCE(CLICKHOUSE(
    HOST '127.0.0.1'
    PORT 9000
    USER 'chdash_runner'
    PASSWORD 'runner_test'
    DB 'chdash_ui'
    TABLE 'station_dictionary_source'
))
LIFETIME(MIN 0 MAX 0)
LAYOUT(COMPLEX_KEY_HASHED());

SYSTEM RELOAD DICTIONARY chdash_ui.station_dictionary;
