import os
from pathlib import Path


ROOT = Path(
    os.environ.get("TEST_REPOSITORY_ROOT", Path(__file__).resolve().parents[2])
).resolve()


def read(relative_path: str) -> str:
    return (ROOT / relative_path).read_text(encoding="utf-8")


def test_filesystem_etag_uses_a_fixed_width_timestamp() -> None:
    source = read("src/server.cpp")
    assert "duration_cast<std::chrono::nanoseconds>" in source
    assert "static_cast<std::int64_t>(nanoseconds.count())" in source
    assert "std::to_string(modified.time_since_epoch().count())" not in source


def test_third_party_headers_are_system_includes() -> None:
    cmake = read("src/CMakeLists.txt")
    assert "target_include_directories(chdash SYSTEM PRIVATE" in cmake


def test_runner_mounts_the_repository_read_only() -> None:
    compose = read("tests/docker-compose.yml")
    assert "source: ..\n        target: /repo\n        read_only: true" in compose
