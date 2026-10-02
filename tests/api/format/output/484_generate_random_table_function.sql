SELECT *
FROM generateRandom(
    'entity_key String, metric_value Float64, tags Array(String)',
    42,
    10,
    2
)
LIMIT 5