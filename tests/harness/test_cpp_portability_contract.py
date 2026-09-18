import os
import hashlib
import shutil
import subprocess
from pathlib import Path

import pytest


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


def test_embedded_assets_refresh_on_edit_addition_and_removal(tmp_path: Path) -> None:
    cmake = shutil.which("cmake")
    if cmake is None:
        pytest.skip("CMake is required for the embedded asset rebuild test")
    assets = tmp_path / "assets"
    assets.mkdir()
    script = assets / "app.js"
    script.write_text("initial", encoding="utf-8")
    (tmp_path / "CMakeLists.txt").write_text(
        'cmake_minimum_required(VERSION 3.20)\n'
        'project(asset_rebuild NONE)\n'
        f'include("{ROOT / "src/EmbedStatic.cmake"}")\n'
        'chdash_embed_directory("${CMAKE_SOURCE_DIR}/assets" '
        '"${CMAKE_BINARY_DIR}/assets.cpp" "${CMAKE_BINARY_DIR}/assets.hpp" fixture)\n'
        'add_custom_target(check_assets ALL DEPENDS "${CMAKE_BINARY_DIR}/assets.cpp")\n',
        encoding="utf-8",
    )
    build = tmp_path / "build"

    def run(*args: str) -> None:
        subprocess.run([cmake, *args], check=True, capture_output=True, text=True, timeout=30)

    run("-S", str(tmp_path), "-B", str(build))
    script.write_text("updated content", encoding="utf-8")
    run("--build", str(build))
    generated = build / "assets.cpp"
    assert hashlib.sha256(script.read_bytes()).hexdigest() in generated.read_text()
    added = assets / "new.css"
    added.write_text("body { color: blue; }", encoding="utf-8")
    run("--build", str(build))
    assert '"new.css"' in generated.read_text()
    added.unlink()
    run("--build", str(build))
    assert '"new.css"' not in generated.read_text()
