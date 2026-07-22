import os
from pathlib import Path


def repository_root() -> Path:
    configured = os.environ.get("TEST_REPOSITORY_ROOT")
    candidates = []
    if configured:
        candidates.append(Path(configured))
    candidates.append(Path(__file__).resolve().parents[2])

    for candidate in candidates:
        workflow = candidate / ".github/workflows/release.yaml"
        if workflow.is_file():
            return candidate

    checked = ", ".join(str(candidate) for candidate in candidates)
    raise RuntimeError(f"Could not locate the repository root; checked: {checked}")


ROOT = repository_root()
WORKFLOW = (ROOT / ".github/workflows/release.yaml").read_text(encoding="utf-8")


def test_release_build_parallelism_is_bounded_on_every_target() -> None:
    assert WORKFLOW.count("build_jobs: 2") == 4
    assert 'cmake --build "${BUILD_DIR}" --target chdash --parallel "${BUILD_JOBS}"' in WORKFLOW
    assert "getconf _NPROCESSORS_ONLN" not in WORKFLOW


def test_release_cache_does_not_restore_cmake_configuration() -> None:
    cache_block = WORKFLOW.split("- name: Cache FetchContent sources and builds", 1)[1].split(
        "- name: Configure (Linux musl static)", 1
    )[0]
    assert "CMakeCache.txt" not in cache_block
    assert "fetchcontent_dir" in cache_block


def test_failed_release_build_uploads_diagnostics() -> None:
    assert "Last 300 build-log lines" in WORKFLOW
    assert "build-diagnostics-${{ matrix.goos }}-${{ matrix.goarch }}" in WORKFLOW
    assert "${{ env.BUILD_DIR }}/build.log" in WORKFLOW


def test_release_uses_native_macos_architecture_runners() -> None:
    assert "runner: macos-15-intel" in WORKFLOW
    assert "runner: macos-15" in WORKFLOW
    assert WORKFLOW.count("runner: macos-latest") == 0
