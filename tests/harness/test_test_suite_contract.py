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


def test_the_backend_phase_runs_the_whole_directory_and_the_stack_provides_the_instances_it_needs():
    # Why: a file that run-all-tests.py does not name never runs in CI (19 of the 30 once did not). The phase takes the directory, and a
    # test that needs an instance of its own must find it in the environment of the `tests` service, or the phase stops (conftest.py).
    runner = read("tests/test-suite/run-all-tests.py")
    assert "str(ROOT / 'backend-functional')," in runner
    assert not re.search(r"'backend-functional' / 'test_", runner)
    conftest = read("tests/backend-functional/conftest.py")
    instances = re.search(r"STACK_INSTANCES = \((.*?)\)\n", conftest, re.S).group(1)
    names = re.findall(r'"([A-Z_]+_BASE_URL)"', instances)
    assert len(names) >= 6
    compose = read("tests/docker-compose.yml")
    tests_env = compose.split("\n  tests:\n", 1)[1].split("\nvolumes:\n", 1)[0]
    for name in names:
        assert re.search(rf"^      {name}: http://(\w+):8080$", tests_env, re.M), f"{name} is not in the environment of the tests service"
    for service in re.findall(r"^      (\w+_BASE_URL): http://(\w+):8080$", tests_env, re.M):
        assert re.search(rf"^  {service[1]}:$", compose, re.M), f"{service[0]} names a service that does not exist: {service[1]}"
    # Every skipif on a stack instance names a variable that the list covers.
    for path in (ROOT / "tests/backend-functional").glob("test_*.py"):
        for variable in re.findall(r'reason="([A-Z_]+_BASE_URL) is not set', path.read_text(encoding="utf-8")):
            assert variable in names or variable.startswith(("MCP_", "QUERY_LIBRARY_")), f"{path.name}: {variable} is not a stack instance and not listed as optional"
