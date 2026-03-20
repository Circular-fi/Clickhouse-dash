-- INPUT
SELECT
    entity_key AS entity_key_alias -- alias comment
FROM numbers(1)

SELECT
    metric_value AS total_metric_value /* alias comment */
FROM numbers(1)

-- EXPECTED
SELECT
    entity_key AS `entity_key_alias` -- alias comment
FROM numbers(1)

SELECT
    metric_value AS `total_metric_value` /* alias comment */
FROM numbers(1)
