from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / "api" / "query_types" / "check_query_types.py"
SPEC = importlib.util.spec_from_file_location("chdash_query_types_checks", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
query_types = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = query_types
SPEC.loader.exec_module(query_types)


def failed_result(message: str = "unimplemented 99") -> dict:
    return {
        "transport_ok": True,
        "outcome": {
            "success": False,
            "done": {"status": "error"},
            "errors": [{"error_code": "query_failed", "message": message}],
        },
    }


def successful_result() -> dict:
    return {
        "transport_ok": True,
        "outcome": {
            "success": True,
            "done": {"status": "finished"},
            "errors": [],
        },
    }


def test_source_failure_and_reference_success_is_product_regression() -> None:
    assert query_types.classify_failure(failed_result(), successful_result()) == "source_regression_vs_release"


def test_identical_source_and_reference_failure_is_shared_limitation() -> None:
    assert (
        query_types.classify_failure(failed_result("same"), failed_result("same"))
        == "shared_product_or_clickhouse_limitation"
    )


def test_transport_failure_is_not_misreported_as_product_regression() -> None:
    source = {"transport_ok": False, "exception": "connection refused", "outcome": {"success": False}}
    assert query_types.classify_failure(source, successful_result()) == "test_infrastructure_or_transport_error"


def test_sensitive_run_fields_are_redacted_from_reports() -> None:
    payload = {
        "query_id": "qid",
        "cancel_token": "secret",
        "nested": {"password": "secret", "value": 1},
    }
    assert query_types.redact_payload(payload) == {
        "query_id": "qid",
        "cancel_token": "<redacted>",
        "nested": {"password": "<redacted>", "value": 1},
    }


def test_partial_rows_followed_by_error_are_not_considered_success() -> None:
    outcome = query_types.summarize_events(
        [
            {"event": "result_meta", "data": {"columns": ["x"], "types": ["JSON"]}},
            {"event": "result_rows", "data": {"rows": [[{"a": 1}]]}},
            {"event": "error", "data": {"error_code": "query_failed", "message": "unimplemented 9"}},
            {"event": "done", "data": {"status": "error", "result_rows_returned": 1}},
        ]
    )
    assert outcome["success"] is False
    assert outcome["result_rows_parsed"] == 1
    assert outcome["errors"][0]["message"] == "unimplemented 9"


def test_sse_content_type_accepts_one_event_stream_value() -> None:
    import requests

    response = requests.Response()
    response.headers["Content-Type"] = "text/event-stream; charset=utf-8"
    assert query_types.validate_sse_content_type(response) == "text/event-stream; charset=utf-8"
    assert response.encoding == "utf-8"


def test_sse_content_type_rejects_duplicate_values() -> None:
    import requests
    import pytest

    response = requests.Response()
    response.headers["Content-Type"] = "text/event-stream; charset=utf-8, text/event-stream"
    with pytest.raises(RuntimeError, match="expected one value"):
        query_types.validate_sse_content_type(response)
