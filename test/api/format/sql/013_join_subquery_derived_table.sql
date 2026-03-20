-- INPUT
SELECT
    left_src.entity_key,
    left_src.metric_value,
    right_src.latest_event_date
FROM anon.entity_metrics AS left_src
INNER JOIN
(
    SELECT
        entity_key,
        max(event_date) AS latest_event_date
    FROM anon.entity_events
    GROUP BY entity_key
) AS right_src
    ON left_src.entity_key = right_src.entity_key
WHERE left_src.metric_value > 0
ORDER BY
    right_src.latest_event_date DESC,
    left_src.entity_key ASC

-- EXPECTED
SELECT
    left_src.entity_key,
    left_src.metric_value,
    right_src.latest_event_date
FROM anon.entity_metrics AS `left_src`
INNER JOIN
(
    SELECT
        entity_key,
        max(event_date) AS `latest_event_date`
    FROM anon.entity_events
    GROUP BY entity_key
) AS `right_src`
    ON left_src.entity_key = right_src.entity_key
WHERE left_src.metric_value > 0
ORDER BY
    right_src.latest_event_date DESC,
    left_src.entity_key ASC
