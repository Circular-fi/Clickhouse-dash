-- What a long-lived test server has and a fresh one (CI, empty volume) does not.
-- Init scripts run once, on an empty volume; nothing here is a fixture to reset.

-- The performance phase's database. The Explorer object-table spec lists it
-- (with a synthetic catalog) in the frontend phase, which runs before that one.
CREATE DATABASE IF NOT EXISTS chdash_perf;

-- ClickHouse creates its log tables at their first flush. ChDash detects
-- query_log, processors_profile_log and opentelemetry_span_log once at start
-- (then every 10 minutes) and hides Run with profiling while they are missing.
SYSTEM FLUSH LOGS;
