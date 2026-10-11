"""Policy of the CI and release workflows and of the test stack's dependencies: what must hold whatever the jobs do.

Why a file read: these are the rules that make the build trustworthy (nothing unpinned, no token left behind, no event text in a
script, the release builds only the commit that was tested, only the publish job writes). The jobs themselves are the tests of the
build; their flags and names are not asserted here. The smoke test and the sanitizer repros run for real in test_release_smoke.py and
test_sanitizer_repros.py, the dangling-capture check in test_build_flags_contract.py.
"""
import os
import re
from pathlib import Path

ROOT = Path(os.environ.get("TEST_REPOSITORY_ROOT", Path(__file__).resolve().parents[2])).resolve()
WORKFLOWS = sorted((ROOT / ".github/workflows").glob("*.y*ml"))
RELEASE = (ROOT / ".github/workflows/release.yaml").read_text(encoding="utf-8")


def read(relative_path: str) -> str:
    return (ROOT / relative_path).read_text(encoding="utf-8")


def test_every_third_party_action_is_pinned_by_commit_sha_with_its_version():
    assert WORKFLOWS
    for workflow in WORKFLOWS:
        for line in workflow.read_text(encoding="utf-8").splitlines():
            match = re.search(r"uses:\s*(\S+)", line)
            if not match or match.group(1).startswith("./"):
                continue
            assert re.fullmatch(r"[\w.-]+/[\w./-]+@[0-9a-f]{40}", match.group(1)), (workflow.name, line)
            assert re.search(r"# v\d+\.\d+\.\d+$", line), (workflow.name, line)


def test_no_checkout_keeps_the_token_in_the_git_config():
    for workflow in WORKFLOWS:
        steps = workflow.read_text(encoding="utf-8").split("uses: actions/checkout@")[1:]
        for step in steps:
            assert "persist-credentials: false" in step.split("\n      - ", 1)[0], workflow.name


def test_no_expression_of_an_event_is_pasted_into_a_script():
    # Values a pull request or a dispatch controls reach a script through env:, never as text of the script.
    risky = ("github.head_ref", "github.base_ref", "inputs.", "steps.files.outputs.files", "github.event.")
    for workflow in WORKFLOWS:
        in_run, run_indent = False, 0
        for line in workflow.read_text(encoding="utf-8").splitlines():
            stripped = line.lstrip()
            indent = len(line) - len(stripped)
            if stripped.startswith("run:"):
                in_run, run_indent = True, indent
                assert not any("${{ " + name in stripped[4:] for name in risky), (workflow.name, line)
                continue
            if in_run and stripped and indent <= run_indent:
                in_run = False
            if in_run:
                assert not any("${{ " + name in line for name in risky), (workflow.name, line)


def test_the_release_builds_the_commit_that_was_tested_and_smoke_tests_every_binary_before_publishing():
    tests = RELEASE.split("  tests:\n", 1)[1].split("\n  build:\n", 1)[0]
    assert "uses: ./.github/workflows/ci.yml" in tests and "ref: ${{ needs.prepare.outputs.sha }}" in tests
    build = RELEASE.split("\n  build:\n", 1)[1].split("\n  release:\n", 1)[0]
    assert "- tests" in build and "ref: ${{ needs.prepare.outputs.sha }}" in build
    smoke = RELEASE.index("- name: Smoke test the binary")
    assert RELEASE.index("- name: Verify and strip the Linux binary") < smoke < RELEASE.index("- name: Upload release asset")
    assert "if:" not in RELEASE[smoke:RELEASE.index("run:", smoke)]  # the macOS binaries too


def test_a_release_build_restores_no_cache():
    # Why: a cache written by another job (FetchContent objects, the Zig cache) must not reach the shipped binaries.
    assert "actions/cache" not in RELEASE and "restore-keys" not in RELEASE
    zig = RELEASE.split("- name: Set up Zig (Linux musl toolchain)", 1)[1].split("- name: Create Zig musl CMake toolchain", 1)[0]
    assert "use-cache: false" in zig


def test_only_the_publish_job_writes_and_no_third_party_action_holds_the_token():
    assert "\npermissions: {}\n" in RELEASE
    jobs = RELEASE.split("\njobs:\n", 1)[1]
    publish = jobs.split("\n  release:\n", 1)[1]
    others = jobs.split("\n  release:\n", 1)[0]
    assert "contents: write" not in others
    assert "contents: write" in publish and "environment: release" in publish
    assert "softprops/action-gh-release" not in RELEASE and "git push" not in RELEASE


def test_the_release_tag_is_data_not_script_text():
    assert "INPUT_TAG: ${{ inputs.tag }}" in RELEASE
    for line in RELEASE.splitlines():
        if "${{ inputs.tag }}" in line:
            assert line.strip().startswith(("INPUT_TAG:", "group:")), line


def test_the_release_smoke_image_builds_with_the_same_toolchain_and_flags_as_the_release():
    # Why: ARCH-B-131: a smoke test of a binary built another way proves nothing about the one that ships.
    docker = read("tests/smoke/Dockerfile.release")
    version = re.search(r"version: (\d+\.\d+\.\d+)\n\s+use-cache: false", RELEASE).group(1)
    assert f"ARG ZIG_VERSION={version}" in docker
    for line in ('exec zig cc -target "${ZIG_TARGET}" -static "$@"', 'exec zig c++ -target "${ZIG_TARGET}" -static "$@"',
                 'set(CMAKE_EXE_LINKER_FLAGS_INIT "-static -pie")', "-DCMAKE_BUILD_TYPE=Release", "-DCHDASH_EMBED_STATIC=ON", "check_release_binary.sh"):
        assert line in RELEASE and line in docker, line


def test_the_dependencies_of_the_build_are_immutable_pins():
    # Why: a tag moves and a latest image changes under the build; a commit SHA or a digest does not.
    cmake = read("src/CMakeLists.txt")
    tags = re.findall(r"GIT_TAG\s+(\S+)", cmake)
    assert tags and all(re.fullmatch(r"[0-9a-f]{40}", tag) for tag in tags), tags
    compose = read("tests/docker-compose.yml")
    assert "clickhouse/clickhouse-server:latest" not in compose
    for image in re.findall(r"image:\s*(clickhouse:\S+)", compose):
        assert "@sha256:" in image, image


def test_python_test_packages_are_installed_by_hash():
    assert "pip install --no-cache-dir --require-hashes -r /tmp/requirements.txt" in read("tests/Dockerfile.tests")
    requirements = read("tests/requirements.txt")
    pins = re.findall(r"^([A-Za-z0-9_.-]+)==\S+ \\$", requirements, flags=re.M)
    assert {"pytest", "requests"} <= set(pins)
    for name in pins:
        block = requirements.split(f"\n{name}==", 1)[1].split("\n    # via", 1)[0]
        assert "--hash=sha256:" in block, name


def test_dependabot_covers_actions_images_python_and_npm():
    config = read(".github/dependabot.yml")
    for ecosystem in ("github-actions", "docker", "pip", "npm"):
        assert f"package-ecosystem: {ecosystem}" in config, ecosystem
