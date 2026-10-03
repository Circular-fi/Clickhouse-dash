CREATE USER IF NOT EXISTS chdash_runner IDENTIFIED WITH plaintext_password BY 'runner_test';
CREATE USER IF NOT EXISTS chdash_system IDENTIFIED WITH plaintext_password BY 'system_test';

-- Re-running this file must converge to an exact security boundary even when a
-- persistent ClickHouse volume contains users from an older test fixture.
ALTER USER chdash_runner IDENTIFIED WITH plaintext_password BY 'runner_test';
ALTER USER chdash_system IDENTIFIED WITH plaintext_password BY 'system_test';
REVOKE ALL ON *.* FROM chdash_runner;
REVOKE ALL ON *.* FROM chdash_system;

-- The local runner is deliberately capable of normal DDL/DML used by the
-- integration suite, but it cannot cancel arbitrary server queries.
GRANT SELECT, INSERT, ALTER, CREATE, DROP, TRUNCATE, OPTIMIZE ON *.* TO chdash_runner;
GRANT SHOW DATABASES ON *.* TO chdash_runner;
GRANT SHOW TABLES ON *.* TO chdash_runner;
GRANT SHOW COLUMNS ON *.* TO chdash_runner;
GRANT SHOW DICTIONARIES ON *.* TO chdash_runner;

-- The technical account is deliberately narrow: system metadata/log reads and
-- query cancellation only.
GRANT SELECT ON system.* TO chdash_system;
GRANT SHOW DATABASES ON *.* TO chdash_system;
GRANT SHOW TABLES ON *.* TO chdash_system;
GRANT SHOW COLUMNS ON *.* TO chdash_system;
GRANT SHOW DICTIONARIES ON *.* TO chdash_system;
GRANT KILL QUERY ON *.* TO chdash_system;
GRANT SYSTEM FLUSH LOGS ON *.* TO chdash_system;
-- Trace Explorer reads OTEL tables through system_uri. The REVOKE ALL above
-- runs on every fixture reset (test runner + backend conftest), so the grant
-- must live here too: keeping it only in 03-otel-traces.sql (volume init)
-- silently broke Trace Explorer after the first test run.
GRANT SELECT ON otel.* TO chdash_system;

-- A runner that may read everything but system.query_log: the Monitoring
-- Queries section's "not granted" state (tests/config/explorer-monitoring-limits.hcl,
-- host "nolog"). The backend test re-applies these lines on a long-lived server.
CREATE USER IF NOT EXISTS chdash_runner_nolog IDENTIFIED WITH plaintext_password BY 'runner_nolog_test';
ALTER USER chdash_runner_nolog IDENTIFIED WITH plaintext_password BY 'runner_nolog_test';
REVOKE ALL ON *.* FROM chdash_runner_nolog;
GRANT SELECT ON *.* TO chdash_runner_nolog;
GRANT SHOW DATABASES ON *.* TO chdash_runner_nolog;
GRANT SHOW TABLES ON *.* TO chdash_runner_nolog;
GRANT SHOW COLUMNS ON *.* TO chdash_runner_nolog;
REVOKE SELECT ON system.query_log FROM chdash_runner_nolog;
