SELECT
    toYear(event_date)   AS `event_year`,
    toMonth(event_date)  AS `event_month`,
    entity_group,
    count() AS `row_count`
FROM anon.metrics_store
GROUP BY
    event_year,
    event_month,
    entity_group WITH ROLLUP
ORDER BY
    event_year ASC,
    event_month ASC,
    entity_group ASC