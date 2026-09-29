CREATE MATERIALIZED VIEW anon.snapshot_mv REFRESH AFTER 30 MINUTE APPEND TO anon.snapshots AS
SELECT
    now()    AS `snapshot_time`,
    count()  AS `row_count`
FROM anon.metrics_store