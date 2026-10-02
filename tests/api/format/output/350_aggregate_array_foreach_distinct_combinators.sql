SELECT
    sumArray(metric_values)            AS `total_of_arrays`,
    avgForEach(metric_values)          AS `elementwise_avg`,
    countDistinct(entity_key)          AS `distinct_entities`,
    groupArrayDistinct(entity_group)   AS `groups_seen`,
    uniqArrayIf(tag_names, is_active)  AS `active_tags`
FROM anon.series_store