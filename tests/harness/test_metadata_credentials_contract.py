from __future__ import annotations

import os
from pathlib import Path


ROOT = Path(
    os.environ.get("TEST_REPOSITORY_ROOT", Path(__file__).resolve().parents[2])
).resolve()


def read(relative_path: str) -> str:
    return (ROOT / relative_path).read_text(encoding="utf-8")


def test_global_metadata_uses_system_credentials_and_visible_objects_use_runner() -> None:
    source = read("src/api_meta.cpp")

    assert 'return type == "databases" || type == "tables" || type == "columns";' in source
    assert "MetaCredentialScope::System" in source
    assert "MetaCredentialScope::Runner" in source
    assert "host->system_uri.empty() ? host->runner_uri : host->system_uri" in source
    assert 'out.credential_scope = meta_credential_scope_name(scope);' in source


def test_keywords_have_a_version_compatible_builtin_fallback() -> None:
    source = read("src/api_meta.cpp")

    assert "load_builtin_keywords" in source
    assert 'out.source = "builtin";' in source
    assert "ClickHouse versions before 24.3" in source
    assert "Keep highlighting and parsing available even when the system account" in source


def test_metadata_serves_partial_results_without_turning_every_error_into_503() -> None:
    source = read("src/api_meta.cpp")

    assert 'w.Key("partial")' in source
    assert "successful_types > 0 && !errors.empty()" in source
    assert "successful_types == 0 && !errors.empty()" in source
    assert "res.status = request_error ? 400 : 503;" in source
    assert "res.status = 200;" in source


def test_compose_covers_runner_health_with_an_unavailable_system_account() -> None:
    compose = read("tests/docker-compose.yml")
    config = read("tests/config/CH_HOSTS.source.hcl")
    api_test = read("tests/api/meta/check_meta.py")

    assert "CH_HOSTS.source.hcl" in compose
    assert 'name       = "meta-partial"' in config
    assert 'runner_uri = "clickhouse://test:test@clickhouse:9000"' in config
    assert "invalid-system-password" in config
    assert "test_metadata_keeps_runner_catalogs_when_system_credentials_fail" in api_test
