#!/bin/bash
# Init script of `clickhouse_replica` (its /docker-entrypoint-initdb.d, so it runs
# on the first start of an empty replica volume only): applies the chdash_cluster
# fixtures, 04-replicated-fixtures.sql, once Keeper answers both replicas.
#
# The primary's init cannot apply them: the image runs init scripts against a
# temporary server that listens on 127.0.0.1 only, so the embedded Keeper is not
# reachable at clickhouse:9181 (the address in replication.xml), and the replica
# only starts once the primary is healthy. ON CLUSTER DDL needs both.
#
# Here the replica's own temporary server is running: its DDL worker executes its
# half of each ON CLUSTER query. The SQL is sent to the primary, so the quorum
# INSERT is written there and this replica fetches the part over interserver HTTP
# (the primary cannot fetch from this replica while it listens on 127.0.0.1).
# The fixture reset of the test runner and of the backend conftest re-applies the
# same SQL file on every run.
set -euo pipefail

sql=/chdash-fixtures/04-replicated-fixtures.sql
timeout_seconds=${CHDASH_REPL_INIT_TIMEOUT:-180}
auth=(--user "${CLICKHOUSE_USER:-default}" --password "${CLICKHOUSE_PASSWORD:-}")
keeper_probe="SELECT count() FROM system.zookeeper WHERE path = '/'"

deadline=$((SECONDS + timeout_seconds))
until clickhouse-client --host clickhouse "${auth[@]}" --query "$keeper_probe" >/dev/null 2>&1 \
    && clickhouse-client --host 127.0.0.1 "${auth[@]}" --query "$keeper_probe" >/dev/null 2>&1; do
    if ((SECONDS >= deadline)); then
        echo >&2 "$0: Keeper did not answer both replicas within ${timeout_seconds}s"
        exit 1
    fi
    sleep 1
done

echo "$0: Keeper answers both replicas; applying $(basename "$sql") through the primary"
clickhouse-client --host clickhouse "${auth[@]}" --queries-file "$sql"
