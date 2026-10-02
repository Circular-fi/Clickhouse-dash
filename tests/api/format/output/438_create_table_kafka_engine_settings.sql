CREATE TABLE anon.events_queue
(
    `raw_message` String
)
ENGINE = Kafka
SETTINGS
    kafka_broker_list   = 'broker-1:9092,broker-2:9092',
    kafka_topic_list    = 'events',
    kafka_group_name    = 'clickhouse_events',
    kafka_format        = 'JSONAsString',
    kafka_num_consumers = 4