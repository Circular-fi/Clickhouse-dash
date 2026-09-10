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
