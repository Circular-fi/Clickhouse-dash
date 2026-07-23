from __future__ import annotations

import os
from pathlib import Path


ROOT = Path(
    os.environ.get("TEST_REPOSITORY_ROOT", Path(__file__).resolve().parents[2])
).resolve()


def read(relative_path: str) -> str:
    return (ROOT / relative_path).read_text(encoding="utf-8")


def test_idle_native_clients_have_a_proactive_ttl_reaper() -> None:
    header = read("src/ch_client_pool.hpp")
    source = read("src/ch_client_pool.cpp")
    main = read("src/main.cpp")

    assert "std::chrono::steady_clock::time_point returned_at" in header
    assert "void reaper_loop();" in header
    assert "collect_expired_locked" in header
    assert "reaper_thread_ = std::thread" in source
    assert "now - entry.returned_at >= idle_ttl_" in source
    assert 'envi("CH_CLIENT_POOL_IDLE_TTL_MS", 60 * 1000)' in main


def test_reused_clients_are_validated_only_after_a_configurable_idle_period() -> None:
    source = read("src/ch_client_pool.cpp")
    main = read("src/main.cpp")

    assert "idle_for >= validate_after_idle_" in source
    assert "if (client && validate)" in source
    assert "client->Ping();" in source
    assert "validation_due && !entry.bounded_receive_timeout" in source
    assert "Never Ping such a" in source
    assert 'envi("CH_CLIENT_POOL_VALIDATE_AFTER_IDLE_MS", 15 * 1000)' in main


def test_compatibility_retries_use_distinct_native_query_ids() -> None:
    header = read("src/query_session.hpp")
    source = read("src/query_session.cpp")

    assert "std::vector<std::string> native_query_ids_;" in header
    assert 'native_id += "-attempt-";' in source
    assert "const std::string native_query_id = begin_native_query_attempt();" in source
    assert "clickhouse::Query q(effective_sql, native_query_id);" in source
    assert "cancel_native_query_ids_best_effort({failed_native_id}, true);" in source
    assert "cancel_native_query_ids_best_effort({native_query_id}, false);" in source
    assert "discard_query_connection();" in source
    assert "acquire_query_connection();" in source
    assert "reset_query_connection_best_effort" not in source


def test_cancel_targets_every_native_attempt_owned_by_the_session() -> None:
    header = read("src/query_session.hpp")
    session_source = read("src/query_session.cpp")
    api_source = read("src/api_query.cpp")

    assert "std::vector<std::string> native_query_ids() const;" in header
    assert "KILL QUERY WHERE query_id IN (" in session_source
    assert 'synchronous ? "SYNC" : "ASYNC"' in session_source
    assert "session->cancel_native_queries_best_effort(false);" in api_source


def test_health_runner_does_not_hold_a_system_socket_across_long_intervals() -> None:
    source = read("src/health_runner.cpp")

    assert "kMaxPersistentHealthClientIdleMs = 60 * 1000" in source
    assert "release_clients_before_wait" in source
    assert "for (auto& ctx : ctx_) ctx.client.reset();" in source
    assert "ping_jobs.clear();" in source


def test_health_is_measured_with_runner_credentials_and_recovers_stale_sockets() -> None:
    source = read("src/health_runner.cpp")
    header = read("src/health_runner.hpp")
    server = read("src/server.cpp")

    assert "init_jobs.push_back(InitJob{i, ctx_[i].spec.id, ctx_[i].spec.runner_uri})" in source
    assert "init_jobs.push_back(InitJob{i, ctx_[i].spec.id, ctx_[i].spec.system_uri})" not in source
    assert "job.client->ResetConnection();" in source
    assert "job.client->Ping();" in source
    assert "result.discard_client = true;" in source
    assert "if (result.discard_client) ctx.client.reset();" in source
    assert "same_credentials ? ctx.client" in source
    assert "One runner client per host" in header
    health_check = server.split("bool Server::health_check", 1)[1]
    assert "h.runner_uri" in health_check
    assert "h.system_uri" not in health_check.split("void Server::handle_healthz", 1)[0]


def test_cancel_fallback_matches_reaped_compatibility_attempts() -> None:
    source = read("src/api_query.cpp")

    assert 'qid + "-attempt-"' in source
    assert "startsWith(query_id" in source
    assert "query_id = '" in source


def test_native_clients_enable_kernel_keepalive_without_ping_before_every_query() -> None:
    source = read("src/ch_uri.cpp")

    assert "opt.TcpKeepAlive(true);" in source
    assert "SetPingBeforeQuery" not in source
