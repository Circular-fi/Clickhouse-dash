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


def test_release_build_restores_no_cache() -> None:
    # A cache written by another job (FetchContent objects, the Zig cache) must not reach the shipped binaries.
    assert "actions/cache" not in WORKFLOW
    assert "restore-keys" not in WORKFLOW
    zig = WORKFLOW.split("- name: Set up Zig (Linux musl toolchain)", 1)[1].split("- name: Create Zig musl CMake toolchain", 1)[0]
    assert "use-cache: false" in zig


def test_failed_release_build_uploads_diagnostics() -> None:
    assert "Last 300 build-log lines" in WORKFLOW
    assert "build-diagnostics-${{ matrix.goos }}-${{ matrix.goarch }}" in WORKFLOW
    assert "${{ env.BUILD_DIR }}/build.log" in WORKFLOW


def test_release_uses_native_macos_architecture_runners() -> None:
    assert "runner: macos-15-intel" in WORKFLOW
    assert "runner: macos-15" in WORKFLOW
    assert WORKFLOW.count("runner: macos-latest") == 0


def test_release_waits_for_the_tests_of_the_commit_it_builds() -> None:
    tests = WORKFLOW.split("  tests:\n", 1)[1].split("\n  build:\n", 1)[0]
    assert "uses: ./.github/workflows/ci.yml" in tests
    assert "ref: ${{ needs.prepare.outputs.sha }}" in tests
    build = WORKFLOW.split("\n  build:\n", 1)[1].split("\n  release:\n", 1)[0]
    assert "- tests" in build and "ref: ${{ needs.prepare.outputs.sha }}" in build
    ci = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
    assert "workflow_call:" in ci and "ref: ${{ inputs.ref }}" in ci


def test_every_shipped_binary_is_smoke_tested_and_linux_is_static_pie_with_canaries() -> None:
    step = WORKFLOW.split("- name: Smoke test the binary", 1)[1].split("- name: Package", 1)[0]
    assert "if:" not in step.split("run:", 1)[0]  # darwin too
    assert 'tests/smoke/check_release_binary.sh "${BUILD_DIR}/chdash"' in WORKFLOW
    assert WORKFLOW.index("tests/smoke/check_release_binary.sh") < WORKFLOW.index('strip "${BUILD_DIR}/chdash"')
    assert 'set(CMAKE_EXE_LINKER_FLAGS_INIT "-static -pie")' in WORKFLOW
    assert 'set(CMAKE_POSITION_INDEPENDENT_CODE ON CACHE BOOL "" FORCE)' in WORKFLOW
    check = (ROOT / "tests/smoke/check_release_binary.sh").read_text(encoding="utf-8")
    for text in ("INTERP", "(NEEDED)", "DYN", "__stack_chk_fail"):
        assert text in check, text


def test_only_the_publish_job_writes_and_no_third_party_action_holds_the_token() -> None:
    assert "\npermissions: {}\n" in WORKFLOW
    jobs = WORKFLOW.split("\njobs:\n", 1)[1]
    publish = jobs.split("\n  release:\n", 1)[1]
    others = jobs.split("\n  release:\n", 1)[0]
    assert "contents: write" not in others
    assert "contents: write" in publish and "environment: release" in publish
    assert "id-token: write" in publish and "attestations: write" in publish
    assert "actions/attest-build-provenance@" in publish
    # gh publishes the release; softprops/action-gh-release no longer gets the write token.
    assert "softprops/action-gh-release" not in WORKFLOW
    assert "gh release create" in publish and "--verify-tag" in publish
    # A manual run creates the tag after the build, on the tested commit, and an existing tag must point there.
    assert "git push" not in WORKFLOW
    assert 'the assets were built from ${SHA}' in publish


def test_the_release_tag_is_data_not_script_text() -> None:
    assert "INPUT_TAG: ${{ inputs.tag }}" in WORKFLOW
    for line in WORKFLOW.splitlines():
        if "${{ inputs.tag }}" in line:
            assert line.strip().startswith("INPUT_TAG:") or line.strip().startswith("group:"), line
