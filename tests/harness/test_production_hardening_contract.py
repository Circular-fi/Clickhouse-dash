from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_stale_cache_entries_have_shared_lifetime_across_erase() -> None:
    source = (ROOT / "src/stale_cache.hpp").read_text()
    assert "std::unordered_map<Key, std::shared_ptr<Entry>> entries_;" in source
    assert "std::shared_ptr<Entry> entry;" in source
    assert "entry = it->second;" in source
    assert "auto& e = *entry;" in source
    assert "auto& e = entries_[key]" not in source


def test_external_dependencies_and_clickhouse_test_image_are_immutable_pins() -> None:
    cmake = (ROOT / "src/CMakeLists.txt").read_text()
    compose = (ROOT / "tests/docker-compose.yml").read_text()
    assert "9d6a7ee2c1aaeb1fd9ae15d14f06f487149d147f" in cmake
    assert "24b5e7a8b27f42fa16b96fc70aade9106cf7102f" in cmake
    assert "clickhouse/clickhouse-server:latest" not in compose
    assert "clickhouse:26.7.5.10@sha256:d0e74e9970998f92c0490c23345259a539550eff24f551dbe385d3cd29481f74" in compose


def test_examples_use_distinct_runner_and_system_users() -> None:
    for relative in ["config.example.hcl", "docs/configuration.md", "examples/docker-compose.config.yml"]:
        text = (ROOT / relative).read_text()
        assert "chdash_runner" in text
        assert "chdash_system" in text
        assert "clickhouse://internalsvc@clickhouse:9000" not in text


def test_release_workflow_handles_current_rapidjson_deleted_assignment_form() -> None:
    workflow = (ROOT / ".github/workflows/release.yaml").read_text()
    assert "GenericStringRef& operator=(const GenericStringRef& rhs) /* = delete */;" in workflow
    assert "GenericStringRef& operator=(const GenericStringRef& rhs) = delete;" in workflow
    assert "elif compatibility in text:" in workflow
