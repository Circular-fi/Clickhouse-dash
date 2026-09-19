from pathlib import Path
import json
import re

ROOT = Path(__file__).resolve().parents[2]


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def service_block(compose: str, service: str) -> str:
    block = compose.split(f"  {service}:\n", 1)[1]
    match = re.search(r"\n  [A-Za-z0-9_]+:\n", block)
    return block[: match.start()] if match else block


def test_default_stack_has_clickhouse_otel_seed_and_fresh_source_build():
    compose = read("tests/docker-compose.yml")
    assert "  clickhouse:\n" in compose
    assert "  otel_fixture:\n" in compose
    assert "  chdash_source:\n" in compose
    assert 'profiles: ["test"]' not in service_block(compose, "clickhouse")
    fixture = service_block(compose, "otel_fixture")
    assert "profiles:" not in fixture
    assert 'restart: unless-stopped' in fixture
    assert "dockerfile: ./tests/otel-fixture/Dockerfile" in fixture
    source = service_block(compose, "chdash_source")
    assert "profiles:" not in source
    assert "pull_policy: build" in source
    assert "dockerfile: ./tests/Dockerfile.source" in source
    assert "condition: service_healthy" in source
    assert "http://127.0.0.1:8080/api/version" in source


def test_test_profile_adds_exactly_one_profile_scoped_test_service():
    compose = read("tests/docker-compose.yml")
    services = compose.split("services:\n", 1)[1].split("\nvolumes:\n", 1)[0]
    assert set(re.findall(r"^  ([A-Za-z0-9_]+):$", services, re.MULTILINE)) == {"clickhouse", "otel_fixture", "chdash_source", "tests"}
    tests = service_block(compose, "tests")
    assert 'profiles: ["test"]' in tests
    assert "dockerfile: Dockerfile.tests" in tests
    assert 'restart: "no"' in tests
    assert "frontend_tests:" not in compose
    assert "performance_tests:" not in compose
    assert "test_bundle:" not in compose
    assert "chdash_release:" not in compose
    assert "clickhouse_history:" not in compose


def test_single_test_container_runs_four_explicit_categories_and_builds_one_archive():
    runner = read("tests/test-suite/run-all-tests.py")
    for category in ["backend-functional", "frontend-functional", "performance", "design"]:
        assert category in runner
    assert "chdash-test-review.zip" in runner
    assert "build_archive" in runner
    assert "frontend-functional" in runner and "specs/functional.spec.js" in runner
    assert "specs/design.spec.js" in runner
    assert "specs/accessibility.spec.js" in runner


def test_performance_expected_baseline_is_configured_after_first_feedback():
    expected = json.loads(read("tests/performance/expected.json"))
    cases = read("tests/performance/cases.json")
    runner = read("tests/performance/run.py")
    assert expected["schema_version"] == 1
    assert expected["baseline"] == "first-local-docker-run-2026-09-05"
    assert set(expected["cases"]) == {
        "select_literal",
        "select_numbers_100k",
        "create_table",
        "insert_1000_rows",
        "select_inserted_aggregate",
    }
    for limits in expected["cases"].values():
        assert limits["median_ms_max"] > 0
        assert limits["p95_ms_max"] >= limits["median_ms_max"]
    assert '"select_literal"' in cases
    assert '"create_table"' in cases
    assert '"insert_1000_rows"' in cases
    assert "expected_baseline_configured" in runner
