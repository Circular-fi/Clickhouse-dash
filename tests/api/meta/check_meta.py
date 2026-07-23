from __future__ import annotations

import os

import pytest
import requests


BASE_URL = os.environ.get("API_BASE_URL", "http://127.0.0.1:8080").rstrip("/")
SESSION = requests.Session()
SESSION.headers.update({"Accept": "application/json"})


def get_meta(types: str, host_id: str = "local") -> requests.Response:
    return SESSION.get(
        f"{BASE_URL}/api/meta",
        params={"host_id": host_id, "types": types},
        timeout=30,
    )


def test_metadata_uses_system_and_runner_credentials_by_catalog_scope() -> None:
    requested = (
        "data_types,databases,formats,functions,keywords,settings,"
        "table_functions,tables"
    )
    response = get_meta(requested)
    assert response.status_code == 200, response.text

    payload = response.json()
    assert payload.get("partial") is False
    assert payload.get("errors") == []
    data = payload.get("data") or {}

    for name in (
        "keywords",
        "functions",
        "table_functions",
        "formats",
        "settings",
        "data_types",
    ):
        assert data.get(name, {}).get("credential_scope") == "system", payload

    for name in ("databases", "tables"):
        assert data.get(name, {}).get("credential_scope") == "runner", payload

    assert data.get("keywords", {}).get("source") in {"clickhouse", "builtin"}
    assert data.get("keywords", {}).get("items")


def test_metadata_returns_partial_success_instead_of_discarding_valid_catalogs() -> None:
    response = get_meta("keywords,not_a_real_metadata_type")
    assert response.status_code == 200, response.text

    payload = response.json()
    assert payload.get("partial") is True
    assert payload.get("successful_type_count") == 1
    assert payload.get("data", {}).get("keywords", {}).get("items")
    assert any(
        error.get("type") == "not_a_real_metadata_type"
        and error.get("code") == "unsupported_type"
        for error in payload.get("errors") or []
    )


def test_metadata_rejects_a_request_with_only_unknown_catalogs() -> None:
    response = get_meta("not_a_real_metadata_type")
    assert response.status_code == 400, response.text
    payload = response.json()
    assert payload.get("successful_type_count") == 0


def test_metadata_keeps_runner_catalogs_when_system_credentials_fail() -> None:
    hosts_response = SESSION.get(f"{BASE_URL}/api/hosts", timeout=10)
    assert hosts_response.status_code == 200, hosts_response.text
    hosts = (hosts_response.json() or {}).get("hosts") or []
    partial_host = next((host for host in hosts if host.get("id") == "meta-partial"), None)
    if partial_host is None:
        pytest.skip("meta-partial test host is not enabled in the source configuration")
    assert partial_host.get("healthy") is True, partial_host

    requested = (
        "data_types,databases,formats,functions,keywords,settings,"
        "table_functions,tables"
    )
    response = get_meta(requested, host_id="meta-partial")
    assert response.status_code == 200, response.text

    payload = response.json()
    assert payload.get("partial") is True
    data = payload.get("data") or {}

    assert data.get("databases", {}).get("credential_scope") == "runner"
    assert data.get("tables", {}).get("credential_scope") == "runner"
    assert data.get("databases", {}).get("items")
    assert data.get("keywords", {}).get("credential_scope") == "system"
    assert data.get("keywords", {}).get("source") == "builtin"
    assert data.get("keywords", {}).get("items")

    failed_system_types = {
        error.get("type")
        for error in payload.get("errors") or []
        if error.get("credential_scope") == "system"
    }
    assert {"data_types", "formats", "functions", "settings", "table_functions"} <= failed_system_types
