"""The Node unit tests of the pure frontend modules (tests/frontend/model/*.test.cjs), run in a bare vm
(tests/harness/esm_vm.js: the real modules, the page stubbed). One test per file, so a failure names its file."""
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
MODEL = ROOT / "tests" / "frontend" / "model"
# The files that a contract test of their own already runs (test_release*).
COVERED_ELSEWHERE = {"pipeline.test.cjs", "processors-compact.test.cjs", "trace.test.cjs"}


@pytest.mark.parametrize("name", sorted(path.name for path in MODEL.glob("*.test.cjs") if path.name not in COVERED_ELSEWHERE))
def test_model_unit_tests(name: str) -> None:
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed (the tests image has it)")
    result = subprocess.run(
        [node, "--experimental-vm-modules", "--no-warnings", "--test", f"tests/frontend/model/{name}"],
        cwd=ROOT, capture_output=True, text=True, timeout=120, check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
