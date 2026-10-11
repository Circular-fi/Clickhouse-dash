"""The dangling-capture check (tools/check_handler_captures.py): a `[&]` route handler that uses a local of the constructor that registers it
reads a destroyed object once the constructor returns (v2.16.3 answered /observability with 404 in the release build; no compiler warning sees it).
The check is run on small sources that have the pattern, on its fixes, and on src/server.cpp and on the commit that had the bug."""
import importlib.util
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(os.environ.get("TEST_REPOSITORY_ROOT", Path(__file__).resolve().parents[2])).resolve()


def load_tool():
    spec = importlib.util.spec_from_file_location("check_handler_captures", ROOT / "tools/check_handler_captures.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


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
