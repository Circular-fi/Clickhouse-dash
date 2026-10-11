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


def test_default_stack_skips_otel_fixture_and_builds_fresh_source():
    compose = read("tests/docker-compose.yml")
    assert "  clickhouse:\n" in compose
    assert "  otel_fixture:\n" in compose
    assert "  chdash_source:\n" in compose
    assert 'profiles: ["test"]' not in service_block(compose, "clickhouse")
    fixture = service_block(compose, "otel_fixture")
    assert 'profiles: ["otel", "test"]' in fixture
    assert 'restart: unless-stopped' in fixture
    assert "dockerfile: ./tests/otel-fixture/Dockerfile" in fixture
    source = service_block(compose, "chdash_source")
    assert "profiles:" not in source
    assert "pull_policy: build" in source
    assert "dockerfile: ./tests/Dockerfile.source" in source
    assert "condition: service_healthy" in source
    assert "otel_fixture:" not in source
    assert "http://127.0.0.1:8080/api/version" in source


def test_test_profile_enables_fixture_and_single_test_runner():
    compose = read("tests/docker-compose.yml")
    services = compose.split("services:\n", 1)[1].split("\nvolumes:\n", 1)[0]
    assert set(re.findall(r"^  ([A-Za-z0-9_]+):$", services, re.MULTILINE)) == {"clickhouse", "clickhouse_replica", "otel_fixture", "chdash_source", "chdash_embedded", "tests"}
    fixture = service_block(compose, "otel_fixture")
    assert 'profiles: ["otel", "test"]' in fixture
    tests = service_block(compose, "tests")
    assert 'profiles: ["test"]' in tests
    assert "otel_fixture:" in tests
    assert "dockerfile: Dockerfile.tests" in tests
    assert 'restart: "no"' in tests
    assert "frontend_tests:" not in compose
    assert "performance_tests:" not in compose
    assert "test_bundle:" not in compose
    assert "chdash_release:" not in compose
    assert "clickhouse_history:" not in compose


def test_the_embedded_build_is_a_service_of_the_test_profile_and_a_phase_of_the_runner():
    compose = read("tests/docker-compose.yml")
    embedded = service_block(compose, "chdash_embedded")
    # The production asset path: a target of the same Dockerfile, built with the files embedded and no ./static.
    assert 'profiles: ["test", "embedded"]' in embedded
    assert "dockerfile: ./tests/Dockerfile.source" in embedded and "target: runtime-embedded" in embedded
    assert "chdash-tests-embedded:local" in embedded
    dockerfile = read("tests/Dockerfile.source")
    stage = dockerfile.split("FROM alpine:3.20 AS runtime-embedded", 1)[1].split("\nFROM ", 1)[0]
    assert "COPY --from=builder-embedded /work/chdash /app/chdash" in stage and "/app/static" not in stage
    # The two builds differ in the embedded flag and in the static inputs only.
    builds = re.findall(r"-DCHDASH_BUILD_APP=ON.*?cp /work/build/chdash /work/chdash", dockerfile, re.S)
    assert len(builds) == 2
    assert builds[0].replace("-DCHDASH_EMBED_STATIC=OFF", "-DCHDASH_EMBED_STATIC=ON") == builds[1]
    tests = service_block(compose, "tests")
    assert "chdash_embedded:" in tests and "EMBEDDED_BASE_URL: http://chdash_embedded:8080" in tests
    runner = read("tests/test-suite/run-all-tests.py")
    assert "'frontend-embedded'" in runner and "embedded_env['FRONTEND_BASE_URL'] = embedded_url" in runner
    # The timing budgets run alone after the other browser tests (PW_PERF, playwright.config.js).
    assert "ff_env['PW_PERF'] = 'skip'" in runner and "timing_env['PW_PERF'] = 'only'" in runner


def test_single_test_container_runs_its_categories_and_builds_one_archive():
    runner = read("tests/test-suite/run-all-tests.py")
    for category in ["backend-functional", "frontend-functional", "frontend-timing", "performance", "design"]:
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
        "select_weather_buffer_120k",
    }
    for name, limits in expected["cases"].items():
        # A large result is budgeted on the JSON encoding time (the done event's timing_ms): a Python reader of 37 MB of rows makes the session wait, which the code does not control.
        median, p95 = ("encode_median_ms_max", "encode_p95_ms_max") if name == "select_weather_buffer_120k" else ("median_ms_max", "p95_ms_max")
        assert limits[median] > 0
        assert limits[p95] >= limits[median]
    assert '"select_literal"' in cases
    assert '"create_table"' in cases
    assert '"insert_1000_rows"' in cases
    assert '"select_weather_buffer_120k"' in cases and "encode_median_ms" in runner
    assert "expected_baseline_configured" in runner


def test_every_playwright_spec_is_run_by_the_official_runner():
    """A spec that no phase names never runs in CI: twelve of them once did not."""
    runner = read("tests/test-suite/run-all-tests.py")
    named = set(re.findall(r"specs/([a-z0-9-]+)\.spec\.js", runner))
    on_disk = {path.name[: -len(".spec.js")] for path in (ROOT / "tests/frontend/specs").glob("*.spec.js")}
    assert on_disk - named == set(), sorted(on_disk - named)
    assert named - on_disk == set(), sorted(named - on_disk)
