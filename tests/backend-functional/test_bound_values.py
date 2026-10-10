"""What a user writes in a filter reaches ClickHouse as a query parameter, never as SQL (Logs, Metrics, the logs of a trace).

A value with a quote mark, a backslash, a new line or an SQL tail must be one value: it matches nothing, it does not fail, and it does not
widen the answer. The ranges follow the time bounds of the fixture.
"""
from __future__ import annotations

import os

import pytest
import requests

BASE_URL = os.environ.get("API_BASE_URL", "http://chdash_source:8080").rstrip("/")
NASTY = ["o'brien", "back\\slash", "100%", "a_b", 'say "hi"', "`tick`", "line\nbreak", "x' OR '1'='1", "\\", "'", "') OR 1=1 --"]


def get(path: str, **params) -> requests.Response:
    return requests.get(f"{BASE_URL}{path}", params={"host_id": "local", **params}, timeout=120)


@pytest.fixture(scope="module")
def logs_window() -> dict:
    meta = get("/api/logs/meta")
    if meta.status_code != 200 or not meta.json().get("time_bounds") or meta.json().get("rows", 0) < 1000:
        pytest.skip("otel_logs is missing or empty")
    end = int(meta.json()["time_bounds"]["max_ms"])
    return {"start_ms": end - 30 * 60_000, "end_ms": end}


@pytest.fixture(scope="module")
def a_service(logs_window) -> str:
    return get("/api/logs/services", **logs_window).json()["services"][0]["name"]


@pytest.mark.parametrize("value", NASTY)
def test_a_service_filter_with_a_nasty_value_matches_nothing(logs_window, value):
    for path in ("/api/logs/search", "/api/logs/histogram", "/api/logs/facets", "/api/logs/patterns"):
        response = get(path, service=value, **logs_window)
        assert response.status_code == 200, (path, value, response.text)
    search = get("/api/logs/search", service=value, limit=5, **logs_window).json()
    assert search["rows"] == [], value


@pytest.mark.parametrize("value", NASTY)
def test_an_attribute_filter_with_a_nasty_value_matches_nothing(logs_window, value):
    for attr in (f"k={value}", f"ServiceName={value}", f"ServiceName!={value}", f"LogAttributes.k={value}"):
        response = get("/api/logs/search", attr=attr, limit=5, **logs_window)
        assert response.status_code == 200, (attr, response.text)
        if "!=" not in attr:
            assert response.json()["rows"] == [], attr


def test_a_negated_nasty_value_keeps_every_row(logs_window):
    everything = get("/api/logs/search", limit=20, **logs_window).json()["rows"]
    kept = get("/api/logs/search", attr="ServiceName!=x' OR '1'='1", limit=20, **logs_window).json()["rows"]
    assert [row["id"] for row in kept] == [row["id"] for row in everything]


@pytest.mark.parametrize("value", NASTY)
def test_a_body_term_with_a_nasty_value_is_a_search_not_sql(logs_window, value):
    for term in (value, f"-{value}x", f'"{value}"'):
        response = get("/api/logs/search", q=term, limit=5, **logs_window)
        assert response.status_code == 200, (term, response.text)
    positive = get("/api/logs/search", q=f'"{value}zz"', limit=5, **logs_window).json()
    assert positive["rows"] == [], value


@pytest.mark.parametrize("value", NASTY)
def test_a_field_key_with_a_nasty_value_is_a_key(logs_window, value):
    for scope in ("log", "resource", "scope"):
        response = get("/api/logs/facet_values", scope=scope, key=value, **logs_window)
        assert response.status_code == 200, (scope, value, response.text)
        assert response.json()["values"] == [], (scope, value)


def test_a_context_preset_with_a_nasty_value_matches_nothing(logs_window):
    first = get("/api/logs/search", limit=1, **logs_window).json()["rows"][0]
    tie = first["id"].split("-")[1]
    for value in NASTY:
        for preset, extra in (("service", {"service": value}), ("host", {"host": value})):
            response = get("/api/logs/context", ts_ns=first["ts_ns"], tie=tie, preset=preset, **extra)
            assert response.status_code == 200, (preset, value, response.text)
            assert response.json()["rows"] == [], (preset, value)


def test_the_logs_of_a_trace_take_nasty_ids_and_services_as_values(logs_window):
    bounds = {"start_ns": logs_window["start_ms"] * 1_000_000, "end_ns": logs_window["end_ms"] * 1_000_000}
    for value in NASTY:
        for params in ({"trace_id": value}, {"trace_id": "00ab", "service": value}, {"trace_id": "00ab", "span_id": value}):
            response = get("/api/traces/logs", **params, **bounds)
            assert response.status_code == 200, (params, response.text)
            assert response.json()["logs"] == [], params


@pytest.fixture(scope="module")
def a_metric() -> dict:
    meta = get("/api/metrics/meta")
    if meta.status_code != 200 or not meta.json().get("enabled") or not meta.json().get("time_bounds"):
        pytest.skip("metrics are not available")
    end = int(meta.json()["time_bounds"]["max_ms"])
    window = {"start_ms": end - 3_600_000, "end_ms": end}
    catalog = get("/api/metrics/catalog", **window).json()
    for service in catalog["services"]:
        for metric in service["metrics"]:
            if metric["kind"] == "gauge":
                return {"kind": "gauge", "service": service["name"], "metric": metric["name"], **window}
    pytest.skip("no gauge metric")


@pytest.mark.parametrize("value", NASTY)
def test_metric_filters_with_a_nasty_value_are_values(a_metric, value):
    plain = get("/api/metrics/series", **a_metric)
    assert plain.status_code == 200, plain.text
    for filters in ({"filter": f"k={value}"}, {"filter_not": f"k={value}"}, {"group_by": f"k{value}"}):
        response = get("/api/metrics/series", **a_metric, **filters)
        assert response.status_code == 200, (filters, response.text)
    # An exclusion of a value that nothing has keeps every point: the series is the plain one.
    excluded = get("/api/metrics/series", filter_not=f"k={value}", **a_metric).json()
    assert excluded["series"] == plain.json()["series"], value
    for path, extra in (("/api/metrics/attributes", {"key": value}), ("/api/metrics/attributes", {}), ("/api/metrics/exemplars", {})):
        response = get(path, filter=f"k={value}", **a_metric, **extra)
        assert response.status_code == 200, (path, value, response.text)


@pytest.mark.parametrize("value", NASTY)
def test_a_service_or_metric_name_with_a_nasty_value_is_a_name(a_metric, value):
    for field in ("service", "metric"):
        response = get("/api/metrics/series", **{**a_metric, field: value})
        assert response.status_code == 200, (field, value, response.text)
        assert response.json()["points"] == 0 and response.json()["series"] == [], (field, value)
