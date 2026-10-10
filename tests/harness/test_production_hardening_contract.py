from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_cache_entries_have_shared_lifetime_and_a_monotonic_clock() -> None:
    source = (ROOT / "src/ttl_cache.hpp").read_text()
    # A fetch, its waiters and a background refresh keep their entry alive; an entry is never removed while it is read.
    assert "std::unordered_map<Key, std::shared_ptr<Entry>> map_;" in source
    assert "const std::shared_ptr<Entry> entry = find_or_insert_locked(key, arrival);" in source
    assert "if (!e.refreshing && expired) it = erase_locked(it);" in source
    assert "it->second->refreshing) continue;" in source
    # TTLs and ages are measured on a monotonic clock, never on the wall clock.
    assert "typename Clock = std::chrono::steady_clock" in source
    assert "system_clock" not in source
    assert not (ROOT / "src/stale_cache.hpp").exists()


def test_external_dependencies_and_clickhouse_test_image_are_immutable_pins() -> None:
    cmake = (ROOT / "src/CMakeLists.txt").read_text()
    compose = (ROOT / "tests/docker-compose.yml").read_text()
    assert "9d6a7ee2c1aaeb1fd9ae15d14f06f487149d147f" in cmake
    assert "24b5e7a8b27f42fa16b96fc70aade9106cf7102f" in cmake
    # clickhouse-cpp v2.6.2 by commit: a tag can move.
    assert "001025cd72d904104c15657e85e0fb6b0ec58e14" in cmake
    assert "GIT_TAG        v" not in cmake
    assert "clickhouse/clickhouse-server:latest" not in compose
    assert "clickhouse:26.7.5.10@sha256:d0e74e9970998f92c0490c23345259a539550eff24f551dbe385d3cd29481f74" in compose


def test_examples_use_distinct_runner_and_system_users() -> None:
    for relative in ["config.example.hcl", "docs/configuration.md", "examples/docker-compose.config.yml"]:
        text = (ROOT / relative).read_text()
        assert "chdash_runner" in text
        assert "chdash_system" in text
        assert "clickhouse://internalsvc@clickhouse:9000" not in text


def test_rapidjson_is_patched_by_cmake_for_every_toolchain() -> None:
    # The patch is a step of FetchContent (not a step of the release workflow only): GCC 14 and clang with libc++
    # build a plain checkout too.
    cmake = (ROOT / "src/CMakeLists.txt").read_text()
    assert "PATCH_COMMAND  ${CMAKE_COMMAND} -P ${CMAKE_CURRENT_LIST_DIR}/PatchRapidJSON.cmake" in cmake
    patch = (ROOT / "src/PatchRapidJSON.cmake").read_text()
    assert "GenericStringRef& operator=(const GenericStringRef& rhs) /* = delete */;" in patch
    assert "GenericStringRef& operator=(const GenericStringRef& rhs) = delete;" in patch
    assert "{ s = rhs.s; length = rhs.length; }" in patch
    assert "message(FATAL_ERROR" in patch
    workflow = (ROOT / ".github/workflows/release.yaml").read_text()
    assert "Patch RapidJSON" not in workflow
    for docker in ("tests/Dockerfile.source", "tests/Dockerfile.sanitize", "tests/smoke/Dockerfile.release"):
        assert "PatchRapidJSON.cmake" in (ROOT / docker).read_text(), docker
