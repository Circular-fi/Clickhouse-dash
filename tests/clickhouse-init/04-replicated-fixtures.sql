-- Replicated fixtures on chdash_cluster (primary `clickhouse` + `clickhouse_replica`,
-- Keeper embedded in the primary). Re-applied on every fixture reset: DROP ... SYNC
-- also removes the Keeper metadata, so the two replicas always converge from scratch.
CREATE DATABASE IF NOT EXISTS chdash_repl ON CLUSTER chdash_cluster;

DROP TABLE IF EXISTS chdash_repl.replicated_events_all ON CLUSTER chdash_cluster SYNC;
DROP TABLE IF EXISTS chdash_repl.replicated_daily ON CLUSTER chdash_cluster SYNC;
DROP TABLE IF EXISTS chdash_repl.replicated_daily_mv ON CLUSTER chdash_cluster SYNC;
DROP TABLE IF EXISTS chdash_repl.replicated_events ON CLUSTER chdash_cluster SYNC;

CREATE TABLE chdash_repl.replicated_events ON CLUSTER chdash_cluster
(
    event_time DateTime,
    id UInt64,
    kind LowCardinality(String),
    value Float64
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/chdash_repl/replicated_events', '{replica}')
PARTITION BY toYYYYMM(event_time)
ORDER BY (kind, id);

CREATE TABLE chdash_repl.replicated_daily ON CLUSTER chdash_cluster
(
    day Date,
    kind LowCardinality(String),
    events UInt64
)
ENGINE = ReplicatedSummingMergeTree('/clickhouse/tables/{shard}/chdash_repl/replicated_daily', '{replica}')
ORDER BY (day, kind);

CREATE MATERIALIZED VIEW chdash_repl.replicated_daily_mv ON CLUSTER chdash_cluster
TO chdash_repl.replicated_daily
AS SELECT toDate(event_time) AS day, kind, count() AS events
FROM chdash_repl.replicated_events
GROUP BY day, kind;

CREATE TABLE chdash_repl.replicated_events_all ON CLUSTER chdash_cluster
AS chdash_repl.replicated_events
ENGINE = Distributed(chdash_cluster, chdash_repl, replicated_events, rand());

-- insert_quorum = 2 makes the INSERT return only once both replicas have the
-- part, so tests never observe a half-replicated fixture.
INSERT INTO chdash_repl.replicated_events
SELECT
    toDateTime('2026-09-01 00:00:00') + number * 60,
    number,
    ['click', 'view', 'buy'][number % 3 + 1],
    number / 3
FROM numbers(5000)
SETTINGS insert_quorum = 2;
