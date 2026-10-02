CREATE TABLE anon.log_records
(
    `event_time`  DateTime64(3),
    `trace_id`    String,
    `message`     String,
    `status_code` UInt16,
    `attributes`  Map(String, String),
    INDEX idx_trace   trace_id    TYPE bloom_filter(0.01)         GRANULARITY 4,
    INDEX idx_message message     TYPE tokenbf_v1(32768, 3, 0)    GRANULARITY 1,
    INDEX idx_ngram   message     TYPE ngrambf_v1(3, 65536, 2, 0) GRANULARITY 1,
    INDEX idx_status  status_code TYPE set(100)                   GRANULARITY 2,
    INDEX idx_time    event_time  TYPE minmax                     GRANULARITY 1
)
ENGINE = MergeTree
ORDER BY event_time