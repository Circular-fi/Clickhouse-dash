"""Build flags: warnings, -Werror, sanitizers, and the dangling-capture check (2.17.0)."""
import importlib.util
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(
    os.environ.get("TEST_REPOSITORY_ROOT", Path(__file__).resolve().parents[2])
).resolve()


def read(relative_path: str) -> str:
    return (ROOT / relative_path).read_text(encoding="utf-8")


def load_tool():
    spec = importlib.util.spec_from_file_location("check_handler_captures", ROOT / "tools/check_handler_captures.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_warning_flags_live_in_one_file_and_apply_to_our_targets_only() -> None:
    flags = read("src/BuildFlags.cmake")
    assert "list(APPEND CHDASH_WARNING_FLAGS -Wall -Wextra)" in flags
    assert "check_cxx_compiler_flag(-Wdangling-reference CHDASH_HAS_WDANGLING_REFERENCE)" in flags
    assert "list(APPEND CHDASH_WARNING_FLAGS -Werror)" in flags
    assert 'set(CHDASH_WERROR OFF CACHE BOOL' in flags
    assert "function(chdash_configure_target)" in flags
    assert "target_compile_options(${_target} PRIVATE ${CHDASH_WARNING_FLAGS} ${CHDASH_SANITIZER_COMPILE_FLAGS})" in flags
    # A flag set on the directory or on CMAKE_CXX_FLAGS would reach the dependencies.
    assert "CMAKE_CXX_FLAGS" not in flags
    assert "add_compile_options(${CHDASH_WARNING_FLAGS}" not in flags
    cmake = read("src/CMakeLists.txt")
    assert "include(${CMAKE_CURRENT_LIST_DIR}/BuildFlags.cmake)" in cmake
    for target in ("chdash", "chdash_query_library_test", "chdash_system_monitor_test", "chdash_processor_codec_test"):
        assert f"chdash_configure_target({target})" in cmake, target
    # The old blanket suppressions are gone.
    for old in ("-Wno-error", "-Wno-implicit-fallthrough"):
        assert old not in cmake, old


def test_werror_is_off_for_the_release_and_on_for_the_test_image() -> None:
    release = read(".github/workflows/release.yaml")
    assert "CHDASH_WERROR" not in release
    assert "src/BuildFlags.cmake" in release  # part of the FetchContent cache key
    docker = read("tests/Dockerfile.source")
    assert "ARG SOURCE_WERROR=ON" in docker
    assert "-DCHDASH_WERROR=${SOURCE_WERROR}" in docker
    assert docker.count("COPY src/BuildFlags.cmake /work/src/") == 2


def test_sanitizer_option_covers_the_dependencies_with_asan_and_our_targets_with_ubsan() -> None:
    flags = read("src/BuildFlags.cmake")
    assert 'set(CHDASH_SANITIZE "" CACHE STRING' in flags
    assert '"-fsanitize=${CHDASH_SANITIZE}" -fno-omit-frame-pointer' in flags
    # A finding of ours stops the process.
    assert "-fno-sanitize-recover=undefined" in flags
    # AddressSanitizer is global (the dependencies too); UBSan is on our targets only: lz4 of clickhouse-cpp
    # adds 0 to a null pointer for an empty block.
    assert "add_compile_options(-fsanitize=address -fno-omit-frame-pointer -g1)" in flags
    assert "add_link_options(-fsanitize=address)" in flags
    assert "add_compile_options(-fsanitize=undefined" not in flags
    assert "target_link_options(${_target} PRIVATE ${CHDASH_SANITIZER_LINK_FLAGS})" in flags
    assert "(address|undefined)" in flags


def test_dangling_capture_check_flags_the_v2_16_3_pattern(tmp_path: Path) -> None:
    tool = load_tool()
    broken = """
Server::Server(Config cfg) : cfg_(cfg) {
  const auto first_view = [&]() -> std::string {
    if (cfg_.traces) return "traces";
    return "";
  };
  http_.Get("/observability", [&](const auto& req, auto& res) {
    const std::string view = first_view();
    res.status = view.empty() ? 404 : 302;
  });
}
"""
    fixed_copy = broken.replace("http_.Get(\"/observability\", [&]", "http_.Get(\"/observability\", [&, first_view]")
    fixed_member = """
Server::Server(Config cfg) : cfg_(cfg) {
  http_.Get("/observability", [&](const auto& req, auto& res) {
    std::string view;
    if (cfg_.traces) view = "traces";
    handle(req, res, view);
  });
}
"""
    parameter = """
Server::Server(Config cfg) : cfg_(cfg) {
  http_.Get("/x", [&](const auto& req, auto& res) { res.set_content(cfg.name, "text/plain"); });
}
"""
    accepted = broken.replace("http_.Get(\"/observability\", [&](const auto& req, auto& res) {",
                              "http_.Get(\"/observability\", [&](const auto& req, auto& res) {  // handler-capture-ok: runs below")

    def problems(source: str):
        path = tmp_path / "fixture.cpp"
        path.write_text(source, encoding="utf-8")
        return [name for _line, name, _capture in tool.check(str(path), "Server::Server")]

    assert problems(broken) == ["first_view"]
    assert problems(fixed_copy) == []
    assert problems(fixed_member) == []
    assert problems(parameter) == ["cfg"]
    assert problems(accepted) == []


def test_dangling_capture_check_passes_on_the_server_and_flags_the_release_that_broke(tmp_path: Path) -> None:
    result = subprocess.run(
        [sys.executable, str(ROOT / "tools/check_handler_captures.py"), str(ROOT / "src/server.cpp")],
        capture_output=True, text=True, timeout=60,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    # The commit before the fix (946ba81^) must fail the check, when the history is available.
    old = subprocess.run(["git", "-C", str(ROOT), "show", "946ba81^:src/server.cpp"], capture_output=True, text=True)
    if old.returncode == 0:
        scratch = tmp_path / "server_v2_16_3.cpp"
        scratch.write_text(old.stdout, encoding="utf-8")
        broken = subprocess.run(
            [sys.executable, str(ROOT / "tools/check_handler_captures.py"), str(scratch)],
            capture_output=True, text=True, timeout=60,
        )
        assert broken.returncode == 1
        assert "first_observability_view" in broken.stdout and "redirect_in_explorer" in broken.stdout
