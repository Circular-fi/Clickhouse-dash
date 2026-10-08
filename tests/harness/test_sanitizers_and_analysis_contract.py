"""Sanitizers, clang-tidy and the release smoke test: the files, the flags and the workflows (2.17.0)."""
import os
import re
import stat
import subprocess
import sys
import textwrap

import pytest
from pathlib import Path

ROOT = Path(
    os.environ.get("TEST_REPOSITORY_ROOT", Path(__file__).resolve().parents[2])
).resolve()


def read(relative_path: str) -> str:
    return (ROOT / relative_path).read_text(encoding="utf-8")


# --- clang-tidy ----------------------------------------------------------------------------------

def test_clang_tidy_config_is_focused_and_every_disabled_check_has_a_reason() -> None:
    config = read(".clang-tidy")
    checks = config[config.index("Checks:"):config.index("WarningsAsErrors")]
    for wanted in (
        "bugprone-*", "clang-analyzer-*",
        "cppcoreguidelines-misleading-capture-default-by-value",
        "cppcoreguidelines-avoid-capturing-lambda-coroutines",
        "performance-unnecessary-value-param", "performance-move-const-arg",
    ):
        assert wanted in checks, wanted
    assert "WarningsAsErrors: '*'" in config
    assert "HeaderFilterRegex: '.*/src/[^/]*\\.hpp$'" in config
    for disabled in re.findall(r"^\s*-([a-z][\w-]*[\w]),?$", checks, flags=re.M):
        if disabled == "*":
            continue
        assert re.search(rf"^# Off: {re.escape(disabled.split('-', 1)[1])}:", config, flags=re.M), disabled


def test_clang_tidy_runs_from_one_script_that_uses_the_cmake_compile_database() -> None:
    script = read("tests/tools/clang-tidy.sh")
    assert os.access(ROOT / "tests/tools/clang-tidy.sh", os.X_OK)
    assert "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON" in script
    assert "run-clang-tidy" in script and "-p /build" in script
    assert "--target toolchain -f \"$repo/tests/Dockerfile.sanitize\"" in script
    assert '/repo/src/.*\\.cpp$' in script
    workflow = read(".github/workflows/clang-tidy.yml")
    assert "run: tests/tools/clang-tidy.sh ${{ steps.files.outputs.files }}" in workflow
    assert "python3 tools/check_handler_captures.py src/server.cpp" in workflow
    assert "pull_request:" in workflow and "schedule:" in workflow and "workflow_dispatch:" in workflow


# --- sanitizers ----------------------------------------------------------------------------------

def test_sanitizer_dockerfile_builds_the_server_and_the_native_tests_with_asan_and_ubsan() -> None:
    docker = read("tests/Dockerfile.sanitize")
    assert "ARG CHDASH_SANITIZE=address,undefined" in docker
    assert docker.count('-DCHDASH_SANITIZE="${CHDASH_SANITIZE}"') == 2
    assert "-DCHDASH_WERROR=ON" in docker
    assert "-DCHDASH_BUILD_QUERY_LIBRARY_TESTS=ON -DCHDASH_BUILD_SYSTEM_TESTS=ON" in docker
    for target in ("AS toolchain", "AS builder", "AS native", "AS sanitized"):
        assert target in docker, target
    # A finding stops the process: ASan exits with 23, UBSan with 24 and halts.
    assert "ASAN_OPTIONS=detect_leaks=1:strict_string_checks=1:detect_stack_use_after_return=1" in docker
    assert "exitcode=23" in docker and "exitcode=24" in docker
    assert "UBSAN_OPTIONS=print_stacktrace=1:halt_on_error=1" in docker
    assert "suppressions=/app/lsan.supp" in docker
    assert (ROOT / "tests/sanitize/lsan.supp").is_file()
    runner = read("tests/sanitize/run-native-tests.sh")
    assert "chdash_query_library_test" in runner and "chdash_system_monitor_test" in runner


def test_sanitize_script_judges_the_server_log_and_exit_code() -> None:
    script = read("tests/tools/sanitize.sh")
    assert os.access(ROOT / "tests/tools/sanitize.sh", os.X_OK)
    assert "native|server|backend|frontend|all" in script
    assert "api/format/check_format.py api/query_types/check_query_types.py" in script
    assert "backend-functional /repo/tests/harness" in script
    assert "docker stop -t 60" in script  # SIGTERM: the server ends cleanly and LeakSanitizer reports
    assert "ERROR: (AddressSanitizer|LeakSanitizer)|runtime error:" in script
    assert "specs/page-per-view.spec.js specs/query-library.spec.js" in script
    workflow = read(".github/workflows/sanitize.yml")
    assert "docker compose -f tests/docker-compose.yml --profile otel up -d --build --wait" in workflow
    for text in ("pull_request:", "schedule:", "workflow_dispatch:",
                 "tests/tools/sanitize.sh native", "tests/tools/sanitize.sh backend", "tests/tools/sanitize.sh frontend"):
        assert text in workflow, text


def test_the_sanitized_server_ends_cleanly_on_sigterm_and_the_hook_is_sanitizer_only() -> None:
    flags = read("src/BuildFlags.cmake")
    assert "add_compile_definitions(CHDASH_SHUTDOWN_ON_SIGNAL=1)" in flags
    main = read("src/main.cpp")
    assert main.count("#ifdef CHDASH_SHUTDOWN_ON_SIGNAL") == 3
    assert "pthread_sigmask(SIG_BLOCK, &shutdown_signals, nullptr);" in main
    assert "server.stop();" in main
    assert "void Server::stop() { http_.stop(); }" in read("src/server.cpp")


# --- release smoke test --------------------------------------------------------------------------

def test_release_smoke_builds_the_binary_like_the_release_workflow() -> None:
    release = read(".github/workflows/release.yaml")
    docker = read("tests/smoke/Dockerfile.release")
    version = re.search(r"version: (\d+\.\d+\.\d+)\n\s+cache-key: chdash-zig", release).group(1)
    assert f"ARG ZIG_VERSION={version}" in docker
    for line in (
        'exec zig cc -target "${ZIG_TARGET}" -static "$@"',
        'exec zig c++ -target "${ZIG_TARGET}" -static "$@"',
        'set(CMAKE_EXE_LINKER_FLAGS_INIT "-static -s")',
        'set(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)',
        "-DCMAKE_BUILD_TYPE=Release",
        "-DCHDASH_EMBED_STATIC=ON",
        "-DFETCHCONTENT_BASE_DIR",
        "= delete;",
    ):
        assert line in release, ("release.yaml", line)
        assert line in docker, ("Dockerfile.release", line)
    # The release job smoke-tests its own binaries before it publishes anything.
    step = release[release.index("- name: Smoke test the Linux binary"):release.index("- name: Package")]
    assert 'python3 tests/smoke/release_smoke.py --binary "${BUILD_DIR}/chdash"' in step
    assert release.index("- name: Smoke test the Linux binary") > release.index("- name: Verify static Linux binary")
    assert release.index("- name: Smoke test the Linux binary") < release.index("- name: Upload release asset")
    workflow = read(".github/workflows/release-smoke.yml")
    assert "docker build -f tests/smoke/Dockerfile.release --target binary" in workflow
    assert "release_smoke.py --binary smoke-out/chdash --scratch" in workflow
    assert "pull_request:" in workflow


def test_release_smoke_config_enables_every_page_and_cannot_reach_clickhouse() -> None:
    config = read("tests/smoke/release-smoke.hcl")
    for block in ("explorer {", "system {", "traces {", "logs {", "metrics {", "query_library {"):
        assert block in config, block
    for key in ("browse = true", "enabled           = true", "enabled     = true", "enabled      = true", "enabled  = true"):
        assert key in config, key
    assert ".invalid:9000" in config


FAKE_SERVER = textwrap.dedent('''\
    #!{python}
    """A stand-in for the release binary: the routes of the smoke test, with or without the 2.16.3 bug."""
    import gzip, json, re, sys
    from http.server import BaseHTTPRequestHandler, HTTPServer

    BROKEN = {broken}
    port = int(re.search(r"listen_port = (\\d+)", open(sys.argv[2]).read()).group(1))
    JS = b"console.log('chdash');" * 100
    PAGE = b'<html><head><script>window.__chdashAssetVersions={{"static/app.js":"0123456789ab"}}</script><title>ChDash</title></head></html>'

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def send(self, code, body=b"", ctype="text/html; charset=utf-8", headers=()):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            for key, value in headers:
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            path, _, query = self.path.partition("?")
            suffix = "?" + query if query else ""
            if path == "/observability":
                if BROKEN:
                    return self.send(404, b"no observability view is enabled", "text/plain")
                return self.send(302, headers=[("Location", "observability/traces" + suffix)])
            if re.fullmatch(r"/observability/(zzz)", path):
                return self.send(302, headers=[("Location", "traces")])
            if path == "/explorer":
                return self.send(302, headers=[("Location", "explorer/catalog")])
            if path == "/system/zzz":
                return self.send(302, headers=[("Location", "../system")])
            if path == "/static/app.js":
                accepts = "gzip" in self.headers.get("Accept-Encoding", "")
                headers = [("Cache-Control", "public, max-age=31536000, immutable")]
                if accepts:
                    return self.send(200, gzip.compress(JS), "text/javascript", headers + [("Content-Encoding", "gzip")])
                return self.send(200, JS, "text/javascript", headers)
            if path in ("/", "/query", "/observability/traces", "/observability/logs", "/observability/metrics",
                        "/explorer/catalog", "/explorer/functions", "/system", "/system/queries", "/system/disks") \\
                    or path.startswith("/observability/traces/"):
                return self.send(200, PAGE)
            if path == "/api/version":
                features = {{name: {{"enabled": True}} for name in ("explorer", "system", "traces", "logs", "metrics", "query_library")}}
                return self.send(200, json.dumps({{"name": "clickhouse-dash", "version": "x", "features": features}}).encode(), "application/json")
            if path == "/api/health":
                return self.send(503, b'{{"ok":false,"total_hosts":1}}', "application/json")
            if path in ("/api/hosts", "/api/logs/meta", "/api/metrics/meta"):
                return self.send(200, b"{{}}", "application/json")
            if path == "/api/query-library":
                return self.send(200, b'{{"folders":[]}}', "application/json")
            self.send(404, b"not found", "text/plain")

    HTTPServer(("127.0.0.1", port), Handler).serve_forever()
''')


def run_smoke(tmp_path: Path, broken: bool) -> subprocess.CompletedProcess:
    fake = tmp_path / ("broken" if broken else "good")
    fake.write_text(FAKE_SERVER.format(python=sys.executable, broken=broken), encoding="utf-8")
    fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
    return subprocess.run(
        [sys.executable, str(ROOT / "tests/smoke/release_smoke.py"), "--binary", str(fake)],
        capture_output=True, text=True, timeout=120,
    )


def test_release_smoke_passes_on_a_healthy_server(tmp_path: Path) -> None:
    result = run_smoke(tmp_path, broken=False)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "ok    /observability 302" in result.stdout
    assert "ok    static assets" in result.stdout
    assert "release smoke test passed" in result.stdout


def test_release_smoke_fails_on_the_v2_16_3_answer(tmp_path: Path) -> None:
    # v2.16.3 answered /observability with 404 "no observability view is enabled" in the release binary.
    result = run_smoke(tmp_path, broken=True)
    assert result.returncode == 1, result.stdout + result.stderr
    assert "FAIL  /observability: status 404, expected 302" in result.stdout


def test_release_smoke_probes_every_route_of_the_brief() -> None:
    script = read("tests/smoke/release_smoke.py")
    for route in ("/", "/query", "/observability", "/observability/logs", "/explorer", "/explorer/catalog",
                  "/explorer/functions", "/system", "/system/queries", "/system/zzz", "/api/version", "/api/health"):
        assert f'("{route}", ' in script, route
    assert "Accept-Encoding" in script and "immutable" in script and "?v=" in script and "__chdashAssetVersions" in script
    assert "--scratch" in script and "FROM scratch" in script


def test_contributing_and_tests_readme_document_the_commands() -> None:
    contributing = read("CONTRIBUTING.md")
    for text in (
        "-DCHDASH_WERROR=ON", "-DCHDASH_SANITIZE=address,undefined", "tests/tools/clang-tidy.sh",
        "tests/tools/sanitize.sh native", "tests/tools/sanitize.sh backend", "tests/tools/sanitize.sh frontend",
        "python3 tools/check_handler_captures.py src/server.cpp", "tests/smoke/release_smoke.py --binary out/chdash --scratch",
        "tests/smoke/Dockerfile.release", "tests/sanitize/lsan.supp",
    ):
        assert text in contributing, text
    readme = read("tests/README.md")
    for text in (
        "## Sanitizers, static analysis and the release smoke test", "tests/Dockerfile.sanitize", "tests/tools/sanitize.sh",
        "CHDASH_SHUTDOWN_ON_SIGNAL", "tests/smoke/release_smoke.py", "tests/smoke/Dockerfile.release", ".clang-tidy",
        "sanitize.yml", "release-smoke.yml", "clang-tidy.yml",
    ):
        assert text in readme, text


def compiler(*names: str):
    import shutil
    for name in names:
        if shutil.which(name):
            return shutil.which(name)
    return None


def test_the_v2_16_3_pattern_is_caught_by_the_sanitizer_and_not_by_the_warnings(tmp_path: Path) -> None:
    source = ROOT / "tests/sanitize/repro/dangling_lambda.cpp"
    assert "[&]" in source.read_text(encoding="utf-8")
    cxx = compiler("clang++", "g++")
    if cxx is None:
        pytest.skip("a C++ compiler is required")
    # No warning: -Wall -Wextra -Wdangling-reference (and clang's -Wdangling) stay silent on the pattern.
    flags = ["-std=c++17", "-O1", "-g", "-Wall", "-Wextra"]
    warn = subprocess.run([cxx, *flags, "-c", str(source), "-o", str(tmp_path / "w.o")], capture_output=True, text=True)
    assert warn.returncode == 0 and "warning" not in warn.stderr, warn.stderr
    # AddressSanitizer: stack-use-after-return (clang) or stack-use-after-scope (GCC).
    binary = tmp_path / "repro"
    build = subprocess.run([cxx, *flags, "-fsanitize=address", "-fno-omit-frame-pointer", str(source), "-o", str(binary)],
                           capture_output=True, text=True)
    if build.returncode != 0:
        pytest.skip("the compiler has no AddressSanitizer runtime")
    run = subprocess.run([str(binary)], capture_output=True, text=True,
                         env={**os.environ, "ASAN_OPTIONS": "detect_stack_use_after_return=1:detect_leaks=0"})
    assert run.returncode != 0 and "AddressSanitizer: stack-use-after-" in run.stderr, run.stderr[-500:]


def test_the_dangling_reference_flag_reports_a_reference_to_a_temporary(tmp_path: Path) -> None:
    source = ROOT / "tests/sanitize/repro/dangling_reference.cpp"
    gxx = compiler("g++")
    if gxx is None:
        pytest.skip("GCC is required")
    probe = subprocess.run([gxx, "-Wdangling-reference", "-x", "c++", "-c", "-", "-o", "/dev/null"], input="", capture_output=True, text=True)
    if "unrecognized" in probe.stderr or probe.returncode != 0:
        pytest.skip("GCC 13 or later is required for -Wdangling-reference")
    run = subprocess.run([gxx, "-std=c++17", "-Wall", "-Wextra", "-Wdangling-reference", "-c", str(source), "-o", str(tmp_path / "d.o")],
                         capture_output=True, text=True)
    assert "-Wdangling-reference" in run.stderr, run.stderr
