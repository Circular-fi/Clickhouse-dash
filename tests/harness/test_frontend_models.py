"""The Node unit tests of the pure frontend modules (tests/frontend/model/*.test.cjs), run in a bare vm
(tests/harness/esm_vm.js: the real modules, the page stubbed). One test per file, so a failure names its file. Every
file runs here and nowhere else in the harness; a missing node is a failure, not a skip (the tests image has it, and
CI runs the same files first with `node --test`, .github/workflows/ci.yml)."""
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
MODEL = ROOT / "tests" / "frontend" / "model"


@pytest.mark.parametrize("name", sorted(path.name for path in MODEL.glob("*.test.cjs")))
def test_model_unit_tests(name: str) -> None:
    node = shutil.which("node")
    assert node, "node is not installed: run the harness in the tests image (tests/Dockerfile.tests)"
    result = subprocess.run(
        [node, "--experimental-vm-modules", "--no-warnings", "--test", f"tests/frontend/model/{name}"],
        cwd=ROOT, capture_output=True, text=True, timeout=120, check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
