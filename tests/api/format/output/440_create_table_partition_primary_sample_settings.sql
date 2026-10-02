CREATE TABLE IF NOT EXISTS anon.visits ON CLUSTER analytics_cluster
(
    `visit_id`   UInt64,
    `user_id`    UInt64,
    `visit_date` Date,
    `region_id`  UInt32,
    `duration_s` UInt32
)
ENGINE = ReplicatedReplacingMergeTree('/ch/{shard}/v', '{replica}', visit_id)
PARTITION BY (toYYYYMM(visit_date), region_id % 4)
PRIMARY KEY (user_id, visit_date)
ORDER BY (user_id, visit_date, intHash32(visit_id))
SAMPLE BY intHash32(visit_id)
SETTINGS
    index_granularity       = 8192,
    min_bytes_for_wide_part = 10485760,
    storage_policy          = 'tiered'