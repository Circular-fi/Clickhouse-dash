CREATE TABLE observability.log_lines
(
    `event_time` DateTime64(3),
    `msg`        String,
    `tags`       Array(String),
    `attributes` Map(String, String),
    INDEX idx_tags (tags)
        TYPE text(tokenizer = splitByNonAlpha)
        GRANULARITY 100000000,
    INDEX idx_attributes_keys mapKeys(attributes)
        TYPE text(tokenizer = array)
        GRANULARITY 100000000,
    INDEX idx_time event_time
        TYPE minmax
        GRANULARITY 1
)
ENGINE = MergeTree
ORDER BY event_time