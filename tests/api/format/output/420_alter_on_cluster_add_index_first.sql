ALTER TABLE anon.metrics_store ON CLUSTER analytics_cluster
(
    ADD INDEX IF NOT EXISTS idx_display_name lower(display_name)
        TYPE ngrambf_v1(4, 1024, 2, 0)
        GRANULARITY 2 FIRST
)