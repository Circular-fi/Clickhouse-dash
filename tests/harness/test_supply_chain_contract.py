"""The supply chain of the build and the CI (SEC-010, SEC-019, SEC-021): pinned actions and dependencies, no
persisted token, no event text in a script."""
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
