SELECT
    groupArrayResample(30, 75, 30)(
        entity_name,
        entity_age
    ) AS `names_by_age_band`,
    countResample(30, 75, 30)(entity_name, entity_age) AS `count_by_age_band`,
    avgResample(0, 100, 10)(metric_value, metric_score) AS `avg_by_score_band`
FROM anon.people_store