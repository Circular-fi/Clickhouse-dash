"""Runs the native unit binaries (tests/native) that the environment names, so that one pytest run covers them.

The sanitizer build runs every native binary itself (tests/sanitize/run-native-tests.sh); this file is for a plain build:
set the variable of a binary to its path and the test runs it, without the variable it is skipped (the binaries need the C++ toolchain, which the
tests image does not have).
"""
import os
import subprocess

import pytest

BINARIES = {
    "MCP_TEST_BINARY": "chdash_mcp_test",
    "QUERY_LIBRARY_TEST_BINARY": "chdash_query_library_test",
    "RESULT_PATH_TEST_BINARY": "chdash_result_path_test",
    "SYSTEM_MONITOR_TEST_BINARY": "chdash_system_monitor_test",
}


@pytest.mark.parametrize("variable", sorted(BINARIES))
def test_native_unit_binary_passes(variable: str) -> None:
    binary = os.environ.get(variable)
    if not binary:
        pytest.skip(f"{variable} is not set (build {BINARIES[variable]})")
    result = subprocess.run([binary], capture_output=True, text=True, timeout=300)
    assert result.returncode == 0, result.stdout + result.stderr
    assert " 0 failures" in result.stdout
