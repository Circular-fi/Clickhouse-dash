CREATE TABLE anon.labels
(
    `id`               UInt64,
    `名前`             String,
    `🚀_count`         UInt32,
    `café`             String,
    `description_text` String,
    INDEX `索引` `名前`
        TYPE bloom_filter
        GRANULARITY 1,
    INDEX idx_description_text description_text
        TYPE tokenbf_v1(512, 3, 0)
        GRANULARITY 4
)
ENGINE = MergeTree
ORDER BY id