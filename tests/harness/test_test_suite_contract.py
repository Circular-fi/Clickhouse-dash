"""The test suite keeps itself complete: nothing that exists is left out of the official run, and the budgets name real cases.

Why: a Playwright spec that no phase of tests/test-suite/run-all-tests.py names never runs in CI (twelve of them once did not), and a
performance budget for a case that was renamed silently measures nothing.
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def test_every_playwright_spec_is_run_by_the_official_runner():
    runner = read("tests/test-suite/run-all-tests.py")
    named = set(re.findall(r"specs/([a-z0-9-]+)\.spec\.js", runner))
    on_disk = {path.name[: -len(".spec.js")] for path in (ROOT / "tests/frontend/specs").glob("*.spec.js")}
    assert on_disk - named == set(), sorted(on_disk - named)
    assert named - on_disk == set(), sorted(named - on_disk)


def test_every_performance_budget_names_a_case_and_every_case_has_one():
    expected = json.loads(read("tests/performance/expected.json"))
    cases = json.loads(read("tests/performance/cases.json"))
    assert set(expected["cases"]) == {case["name"] for case in cases["cases"]}
    for name, limits in expected["cases"].items():
        # A large result is budgeted on the JSON encoding time (the done event's timing_ms), not on the Python reader.
        median, p95 = ("encode_median_ms_max", "encode_p95_ms_max") if name == "select_weather_buffer_120k" else ("median_ms_max", "p95_ms_max")
        assert limits[median] > 0
        assert limits[p95] >= limits[median]
