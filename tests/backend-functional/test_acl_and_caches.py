"""The runner ACL (AclService) and the server caches (TtlCache), seen from the routes.

- A database whose only readable object is past the probe budget of the database list is listed (unverified), never
  hidden, and the answer says that the discovery was cut (acl_truncated). Opening it lists the readable object.
- The lineage of a view never names an ARRAY JOIN column or a table function as a neighbour, even when a table of the
  same name exists.
- Concurrent identical requests share one read: none of them fails because another one is still reading.
- The formatted output of the formatter is not a cache key of its own (a non-idempotent layout would hide).
- read_rows_limit is rounded down to 1, 2 or 5 times a power of ten (a few cache keys, not one per value).
"""

from __future__ import annotations

import concurrent.futures
import os
import time

import pytest
import requests

BASE_URL = os.environ.get("API_BASE_URL", "http://chdash_source:8080").rstrip("/")
CH_URL = os.environ.get("CLICKHOUSE_URL", "http://clickhouse:8123").rstrip("/")
CH_AUTH = (os.environ.get("CLICKHOUSE_USER", "test"), os.environ.get("CLICKHOUSE_PASSWORD", "test"))
RUNNER = "chdash_runner"


def get(path: str, **params) -> requests.Response:
    return requests.get(f"{BASE_URL}{path}", params=params, timeout=120)


def ch(sql: str) -> str:
    response = requests.post(CH_URL + "/", data=sql.encode(), auth=CH_AUTH, timeout=120)
    assert response.status_code == 200, (sql, response.text)
    return response.text


def catalog(**params) -> dict:
    response = get("/api/explorer/catalog", host_id="local", **params)
    assert response.status_code == 200, response.text
    return response.json()


def test_a_database_whose_readable_table_is_past_the_probe_budget_is_listed_not_hidden():
    # 400 objects are probed at most to decide whether a database is readable (AclService.max_objects_per_database).
    database = "chdash_acl_budget"
    hidden = [f"t{index:03d}" for index in range(400)]
    try:
        ch(f"DROP DATABASE IF EXISTS {database} SYNC")
        ch(f"CREATE DATABASE {database}")
        for name in hidden:
            ch(f"CREATE TABLE {database}.{name} (id UInt8) ENGINE = Null")
        ch(f"CREATE TABLE {database}.zz_readable (id UInt8) ENGINE = Memory")
        # SHOW on everything, SELECT on the last object only (in name order).
        ch(f"REVOKE SELECT ON {database}.* FROM {RUNNER}")
        ch(f"GRANT SELECT ON {database}.zz_readable TO {RUNNER}")

        listed = catalog(refresh="1")
        if ch(f"SELECT count() FROM system.grants WHERE user_name = '{RUNNER}' AND database = '{database}' "
              "AND is_partial_revoke").strip() == "0":
            pytest.skip("the runner grants were reset meanwhile (a fixture of a concurrent test run)")
        assert database in listed["databases"], "a database past the budget is listed, not hidden"
        assert listed["acl_truncated"] is True, listed.get("acl_truncated")

        branch = catalog(database=database, refresh="1")
        names = {table["name"] for table in branch["tables"] if table["database"] == database}
        assert names == {"zz_readable"}, names
        assert branch["acl_truncated"] is False
    finally:
        ch(f"DROP DATABASE IF EXISTS {database} SYNC")
        # Undo the partial revoke: the runner grants of 01-chdash-users.sql.
        ch(f"GRANT SELECT ON {database}.* TO {RUNNER}")
        get("/api/explorer/catalog", host_id="local", refresh="1")
    assert catalog(refresh="1")["acl_truncated"] is False


def test_lineage_never_names_an_array_join_column_or_a_table_function():
    database = "chdash_acl_lineage"
    try:
        ch(f"DROP DATABASE IF EXISTS {database} SYNC")
        ch(f"CREATE DATABASE {database}")
        ch(f"CREATE TABLE {database}.source (id UInt64, arr Array(UInt8)) ENGINE = MergeTree ORDER BY id")
        # Tables with the names of the array column and of the table function.
        ch(f"CREATE TABLE {database}.arr (id UInt64) ENGINE = MergeTree ORDER BY id")
        ch(f"CREATE TABLE {database}.numbers (number UInt64) ENGINE = MergeTree ORDER BY number")
        ch(f"CREATE VIEW {database}.joined AS SELECT id, item FROM {database}.source ARRAY JOIN arr AS item")
        ch(f"CREATE VIEW {database}.generated AS SELECT number FROM numbers(10)")

        def upstream(view: str) -> set[tuple[str, str]]:
            response = get("/api/explorer/table", host_id="local", database=database, table=view, refresh="1")
            assert response.status_code == 200, response.text
            return {(item["database"], item["table"]) for item in response.json()["dependencies"]
                    if item["relation"] == "upstream"}

        assert upstream("joined") == {(database, "source")}
        assert (database, "numbers") not in upstream("generated")
        # Nor downstream of the tables that carry those names.
        response = get("/api/explorer/table", host_id="local", database=database, table="arr", refresh="1")
        assert response.status_code == 200, response.text
        assert not [item for item in response.json()["dependencies"] if item["table"] == "joined"]
    finally:
        ch(f"DROP DATABASE IF EXISTS {database} SYNC")


def test_concurrent_identical_requests_share_one_read_and_none_fails():
    database = "chdash_acl_flight"
    try:
        ch(f"DROP DATABASE IF EXISTS {database} SYNC")
        ch(f"CREATE DATABASE {database}")
        for index in range(30):
            ch(f"CREATE TABLE {database}.t{index} (id UInt64) ENGINE = MergeTree ORDER BY id")
        # A key nobody asked for yet: the first request reads, the others wait for it (no 503 refresh_in_progress).
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            responses = list(pool.map(lambda _: get("/api/explorer/catalog", host_id="local", database=database),
                                      range(8)))
        assert [response.status_code for response in responses] == [200] * 8, [r.text for r in responses]
        generated = {response.json()["generated_at_ms"] for response in responses}
        assert len(generated) == 1, generated
        # refresh=1 from many clients at once: each waits for the read in progress, then shares the next one.
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            refreshed = list(pool.map(
                lambda _: get("/api/explorer/catalog", host_id="local", database=database, refresh="1"), range(8)))
        assert [response.status_code for response in refreshed] == [200] * 8, [r.text for r in refreshed]
    finally:
        ch(f"DROP DATABASE IF EXISTS {database} SYNC")


def format_sql(sql: str) -> requests.Response:
    response = requests.post(f"{BASE_URL}/api/format", json={"host_id": "local", "sql": sql}, timeout=60)
    assert response.status_code == 200, response.text
    return response


def test_the_formatted_output_is_not_a_cache_key_of_its_own():
    sql = f"select {time.time_ns()} as be2_probe, 1"
    first = format_sql(sql)
    pretty = first.json()["formatted_sql"]
    assert pretty != sql
    # The same text again: a hit.
    assert format_sql(sql).headers.get("X-Chdash-Format-Cache") == "hit"
    # The output is formatted again by the formatter (not answered from the entry of another text).
    again = format_sql(pretty)
    assert again.headers.get("X-Chdash-Format-Cache") == "miss"
    assert again.json()["formatted_sql"] == pretty


def _trace_window() -> tuple[int, int]:
    text = ch("SELECT toUnixTimestamp64Milli(max(Start)) FROM otel.otel_traces_trace_id_ts").strip()
    end_ms = int(text or 0)
    if end_ms <= 0:
        pytest.skip("OTEL fixture is empty")
    return end_ms - 3_600_000, end_ms + 1


@pytest.mark.parametrize("asked, used", [(1500, 1000), (200, 200), (999, 500), (7, 5), (1, 1)])
def test_read_rows_limit_is_rounded_down_to_a_few_cache_keys(asked: int, used: int):
    start_ms, end_ms = _trace_window()
    response = get("/api/traces/facets", host_id="local", start_ms=start_ms, end_ms=end_ms, read_rows_limit=asked)
    assert response.status_code == 200, response.text
    assert response.json()["read_rows_limit"] == used
