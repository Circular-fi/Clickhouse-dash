SELECT
    metric_value   AS `ascending_rank`,
    asset_key      AS `asset_id`,
    snapshot_date  AS `as_of`,
    entity_key     AS `astro`
FROM anon.metrics_store