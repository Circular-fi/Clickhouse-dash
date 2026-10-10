from __future__ import annotations

import os
from pathlib import Path
import config_keys


ROOT = Path(
    os.environ.get("TEST_REPOSITORY_ROOT", Path(__file__).resolve().parents[2])
).resolve()


def read(relative_path: str) -> str:
    return (ROOT / relative_path).read_text(encoding="utf-8")


def test_idle_native_clients_have_a_proactive_ttl_reaper() -> None:
    header = read("src/ch_client_pool.hpp")
    source = read("src/ch_client_pool.cpp")
    config = read("src/config.cpp")

    assert "std::chrono::steady_clock::time_point returned_at" in header
    assert "void reaper_loop();" in header
    assert "collect_expired_locked" in header
    assert "reaper_thread_ = std::thread" in source
    assert "now - entry.returned_at >= idle_ttl_" in source
    assert config_keys.row("client_pool", "idle_ttl_ms")["field"] == "c.client_pool_idle_ttl_ms"


def test_reused_clients_are_validated_only_after_a_configurable_idle_period() -> None:
    source = read("src/ch_client_pool.cpp")
    config = read("src/config.cpp")

    assert "idle_for >= validate_after_idle_" in source
    assert "if (client && validate)" in source
    assert "client->Ping();" in source
    assert "validation_due && !entry.bounded_receive_timeout" in source
    assert "Never Ping such a" in source
    assert config_keys.row("client_pool", "validate_after_idle_ms")["field"] == "c.client_pool_validate_after_idle_ms"


def test_compatibility_retries_use_distinct_native_query_ids() -> None:
    header = read("src/query_session.hpp")
    source = read("src/query_session.cpp")

    assert "std::vector<std::string> native_query_ids_;" in header
    assert 'native_id += "-attempt-";' in source
    assert "const std::string native_query_id = begin_native_query_attempt();" in source
    assert "clickhouse::Query q(effective_sql, native_query_id);" in source
    assert "cancel_native_query_ids_best_effort({failed_native_id}, true);" in source
    assert "discard_query_connection();" in source
    assert "acquire_query_connection();" in source
    assert "reset_query_connection_best_effort" not in source


def test_cancel_targets_every_native_attempt_owned_by_the_session() -> None:
    header = read("src/query_session.hpp")
    session_source = read("src/query_session.cpp")
    api_source = read("src/api_query.cpp")

    assert "std::vector<std::string> native_query_ids() const;" in header
    assert 'std::string where = "query_id IN (";' in session_source
    assert '"KILL QUERY WHERE " + where + (synchronous ? " SYNC" : " ASYNC")' in session_source
    assert "kill = session->cancel_native_queries_best_effort(false);" in api_source


def test_health_runner_does_not_hold_a_system_socket_across_long_intervals() -> None:
    source = read("src/health_runner.cpp")
    ping = source.split("void HealthRunner::ping_loop(size_t index) {", 1)[1].split("void HealthRunner::audit_loop() {", 1)[0]
    audit = source.split("void HealthRunner::audit_loop() {", 1)[1]

    assert "kMaxPersistentHealthClientIdleMs = 60 * 1000" in source
    assert "if (interval_ms > kMaxPersistentHealthClientIdleMs) client.reset();" in ping
    # The audit opens its connections for one audit and closes them before it waits.
    assert "runner.reset();" in audit and "system.reset();" in audit


def test_health_is_measured_with_runner_credentials_and_recovers_stale_sockets() -> None:
    source = read("src/health_runner.cpp")
    header = read("src/health_runner.hpp")
    main = read("src/main.cpp")
    ping = source.split("void HealthRunner::ping_loop(size_t index) {", 1)[1].split("void HealthRunner::audit_loop() {", 1)[0]

    # One ping thread per host, with the runner credentials (the system user is only audited).
    assert "client = make_client_from_uri(spec.runner_uri, timeout, timeout, timeout, &err);" in ping
    assert "system_uri" not in ping
    assert "client->ResetConnection();" in ping
    assert "client->Ping();" in ping
    assert "if (!ok) client.reset();" in ping
    assert "same_credentials ? runner :" in source
    assert "One runner client per host" in header
    assert "for (size_t i = 0; i < hosts_.size(); ++i) threads_.emplace_back([this, i] { ping_loop(i); });" in source
    # --health asks the running server (GET /livez): it never builds a Server nor connects to ClickHouse.
    probe = main.split("int probe_liveness(const chdash::AppConfig& cfg) {", 1)[1].split("\n}\n", 1)[0]
    assert 'client.Get("/livez")' in probe and "runner_uri" not in probe and "Server" not in probe


def test_health_threads_wake_on_stop_and_the_audit_never_blocks_a_ping() -> None:
    source = read("src/health_runner.cpp")
    header = read("src/health_runner.hpp")
    stop = source.split("void HealthRunner::stop() {", 1)[1].split("\n}\n", 1)[0]
    # The flag is written under the lock of the waits before the notification: no wake-up is lost.
    assert stop.index("std::lock_guard<std::mutex> lk(mu_);") < stop.index("stop_ = true;") < stop.index("cv_.notify_all();")
    # The audit runs in a thread of its own, with its own connections, a time budget and the stop checked between queries.
    assert "if (!hosts_.empty()) threads_.emplace_back([this] { audit_loop(); });" in source
    assert "static constexpr int64_t kAuditBudgetMs = 60 * 1000;" in header
    assert "const AuditBudget budget{&stop_flag_, steady_clock::now() + milliseconds(kAuditBudgetMs)};" in source
    check = source.split("static bool check_grant(", 1)[1].split("\n}\n", 1)[0]
    assert "if (budget.exhausted()) return false;" in check
    assert "std::async" not in source


def test_cancel_fallback_matches_reaped_compatibility_attempts() -> None:
    source = read("src/api_query.cpp")

    assert 'qid + "-attempt-"' in source
    assert "startsWith(query_id" in source
    assert '"query_id = " + qid_quoted' in source
    assert "sql::quote_string(qid)" in source


def test_native_clients_enable_kernel_keepalive_without_ping_before_every_query() -> None:
    source = read("src/ch_uri.cpp")

    assert "opt.TcpKeepAlive(true);" in source
    assert "SetPingBeforeQuery" not in source

def test_json_native_serialization_mismatch_is_retryable_in_auto_mode() -> None:
    source = read("src/query_session.cpp")
    assert 'icontains(msg, "unsupported json serialization version")' in source
    assert 'icontains(msg, "output_format_native_write_json_as_string")' in source
    assert "should_retry_with_describe_after_direct_path_error(msg)" in source
    assert "const bool can_retry_without_emitted_rows = rows_returned == 0" in source
    assert "meta_sent = false;" in source
