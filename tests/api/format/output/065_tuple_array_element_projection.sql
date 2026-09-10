SELECT
    block,
    data[1].1   AS `station_id`,
    data[1].2   AS `sample_index`,
    data[1].3   AS `weather_codes`,
    data[1].4   AS `temperature_c`,
    data[1].11  AS `humidity_pct`,
    data[1].12  AS `wind_kph`,
    data[1].5   AS `precipitation_mm`,
    data[1].6   AS `pressure_hpa`,
    data[1].7   AS `visibility_km`,
    data[1].8   AS `id`,
    data[1].9   AS `station_index`,
    data[1].10  AS `cloud_cover_pct`,
    data[1].13  AS `feels_like_c`,
    data[1].14  AS `dew_point_c`,
    data[1].15  AS `sensor_flags`
FROM weather_blocks
