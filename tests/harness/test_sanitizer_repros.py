"""The sanitizer repros of tests/sanitize/repro: the v2.16.3 bug (a `[&]` handler that outlives its constructor) is invisible to the
warnings and caught by AddressSanitizer, and GCC's -Wdangling-reference reports a reference to a temporary. They are the reason the
sanitized build and tools/check_handler_captures.py exist; each skips when the compiler or its runtime is missing."""
import os
import subprocess
from pathlib import Path

import pytest

ROOT = Path(os.environ.get("TEST_REPOSITORY_ROOT", Path(__file__).resolve().parents[2])).resolve()


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
