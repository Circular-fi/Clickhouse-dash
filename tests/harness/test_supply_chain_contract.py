"""The supply chain of the build and the CI (SEC-010, SEC-019, SEC-021): pinned actions and dependencies, no
persisted token, no event text in a script, and the ThreadSanitizer and fuzz setups (ARCH-B-128)."""
import os
import re
from pathlib import Path

ROOT = Path(
    os.environ.get("TEST_REPOSITORY_ROOT", Path(__file__).resolve().parents[2])
).resolve()
WORKFLOWS = sorted((ROOT / ".github/workflows").glob("*.y*ml"))


def read(relative_path: str) -> str:
    return (ROOT / relative_path).read_text(encoding="utf-8")


def test_every_third_party_action_is_pinned_by_commit_sha_with_its_version() -> None:
    assert WORKFLOWS
    for workflow in WORKFLOWS:
        for line in workflow.read_text(encoding="utf-8").splitlines():
            match = re.search(r"uses:\s*(\S+)", line)
            if not match or match.group(1).startswith("./"):
                continue
            assert re.fullmatch(r"[\w.-]+/[\w./-]+@[0-9a-f]{40}", match.group(1)), (workflow.name, line)
            assert re.search(r"# v\d+\.\d+\.\d+$", line), (workflow.name, line)


def test_no_checkout_keeps_the_token_in_the_git_config() -> None:
    for workflow in WORKFLOWS:
        text = workflow.read_text(encoding="utf-8")
        steps = text.split("uses: actions/checkout@")[1:]
        for step in steps:
            block = step.split("\n      - ", 1)[0]
            assert "persist-credentials: false" in block, workflow.name


def test_no_expression_of_an_event_is_pasted_into_a_script() -> None:
    # Values a pull request or a dispatch controls reach a script through env:, never as text of the script.
    risky = ("github.head_ref", "github.base_ref", "inputs.", "steps.files.outputs.files", "github.event.")
    for workflow in WORKFLOWS:
        lines = workflow.read_text(encoding="utf-8").splitlines()
        in_run = False
        run_indent = 0
        for line in lines:
            stripped = line.lstrip()
            indent = len(line) - len(stripped)
            if stripped.startswith("run:"):
                in_run, run_indent = True, indent
                inline = stripped[4:]
                for name in risky:
                    assert "${{ " + name not in inline, (workflow.name, line)
                continue
            if in_run and stripped and indent <= run_indent:
                in_run = False
            if in_run:
                for name in risky:
                    assert "${{ " + name not in line, (workflow.name, line)


def test_dependabot_covers_actions_images_python_and_npm() -> None:
    config = read(".github/dependabot.yml")
    for ecosystem in ("github-actions", "docker", "pip", "npm"):
        assert f"package-ecosystem: {ecosystem}" in config, ecosystem
    for directory in ("/tests", "/tests/smoke", "/tests/otel-fixture", "/tests/frontend"):
        assert f"- {directory}\n" in config or f"directory: {directory}\n" in config, directory


def test_python_test_packages_are_installed_by_hash() -> None:
    docker = read("tests/Dockerfile.tests")
    assert "pip install --no-cache-dir --require-hashes -r /tmp/requirements.txt" in docker
    requirements = read("tests/requirements.txt")
    pins = re.findall(r"^([A-Za-z0-9_.-]+)==\S+ \\$", requirements, flags=re.M)
    assert {"pytest", "requests"} <= set(pins)
    # Every pinned package (the dependencies of the dependencies too) has its hashes.
    for name in pins:
        block = requirements.split(f"\n{name}==", 1)[1].split("\n    # via", 1)[0]
        assert "--hash=sha256:" in block, name
    assert "pytest==9.0.2" in read("tests/requirements.in")


def test_fuzz_targets_build_from_one_option_and_run_from_one_script() -> None:
    cmake = read("src/CMakeLists.txt")
    assert 'option(CHDASH_BUILD_FUZZERS "Build the libFuzzer targets of tests/fuzz (clang only)" OFF)' in cmake
    assert "target_compile_options(${name} PRIVATE -fsanitize=fuzzer)" in cmake
    for target in ("json_parse", "format", "mcp_sql", "user_sql_policy", "hcl"):
        assert f"chdash_add_fuzzer(chdash_fuzz_{target} ${{_FUZZ_DIR}}/fuzz_{target}.cpp" in cmake, target
        assert (ROOT / f"tests/fuzz/fuzz_{target}.cpp").is_file(), target
    kernels = sorted(path.stem for path in (ROOT / "src/wasm").glob("*.c"))
    for kernel in kernels:
        assert kernel in cmake.split("foreach(_kernel IN ITEMS", 1)[1].split(")", 1)[0], kernel
        source = read(f"tests/fuzz/fuzz_wasm_{kernel}.c")
        # The native runtime first: its guard keeps the kernel's own rt.h out.
        assert source.index('#include "wasm_native_rt.h"') < source.index(f'#include "../../src/wasm/{kernel}.c"'), kernel
    assert "#define CHDASH_WASM_RT_H" in read("tests/fuzz/wasm_native_rt.h")
    assert "#ifndef CHDASH_WASM_RT_H" in read("src/wasm/rt.h")
    docker = read("tests/Dockerfile.sanitize")
    assert "FROM toolchain AS fuzz" in docker and "-DCHDASH_BUILD_FUZZERS=ON" in docker
    assert 'ENTRYPOINT ["/work/tests/fuzz/run-fuzzers.sh"]' in docker
    assert os.access(ROOT / "tests/tools/fuzz.sh", os.X_OK) and os.access(ROOT / "tests/fuzz/run-fuzzers.sh", os.X_OK)
    runner = read("tests/fuzz/run-fuzzers.sh")
    assert "-max_total_time=" in runner and "-timeout=25" in runner and "crash-* leak-* timeout-* oom-*" in runner
    workflow = read(".github/workflows/sanitize.yml")
    assert "run: tests/tools/fuzz.sh 60" in workflow


def test_thread_sanitizer_runs_the_native_tests_the_backend_and_a_concurrent_load() -> None:
    script = read("tests/tools/sanitize.sh")
    assert '--build-arg "CHDASH_SANITIZE=$sanitizers"' in script
    assert "WARNING: ThreadSanitizer" in script and "SUMMARY: (Address|Undefined|Leak|Thread)Sanitizer" in script
    assert "load) run_load ;;" in script and "/repo/tests/sanitize/load.py" in script
    docker = read("tests/Dockerfile.sanitize")
    assert docker.count("TSAN_OPTIONS=halt_on_error=0:exitcode=25:second_deadlock_stack=1:suppressions=") == 2
    assert (ROOT / "tests/sanitize/tsan.supp").is_file()
    workflow = read(".github/workflows/sanitize.yml")
    tsan = workflow.split("\n  tsan:\n", 1)[1].split("\n  fuzz:\n", 1)[0]
    assert "CHDASH_SANITIZE: thread" in tsan
    for mode in ("native", "backend", "load"):
        assert f"run: tests/tools/sanitize.sh {mode}" in tsan, mode
