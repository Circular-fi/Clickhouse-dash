import gzip
import hashlib
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SHELLS = ("query", "explorer", "traces", "logs", "metrics", "trace", "system", "shape")


def read(rel):
    return (ROOT / rel).read_text(encoding="utf-8")


def stage_tool():
    spec = importlib.util.spec_from_file_location("stage_static", ROOT / "tools/stage_static.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_staging_versions_scripts_and_stylesheets_and_writes_gzip_copies(tmp_path):
    tool = stage_tool()
    script = "window.answer = 42;\n" * 80
    (tmp_path / "app.js").write_text(script, encoding="utf-8")
    (tmp_path / "style.css").write_text("body { color: red; }\n" * 80, encoding="utf-8")
    (tmp_path / "tiny.js").write_text("1", encoding="utf-8")
    (tmp_path / "logo.png").write_bytes(b"\x89PNG" * 400)
    (tmp_path / "query.html").write_text("<!doctype html>\n<html><head>\n<title>x</title></head><body></body></html>\n" * 1, encoding="utf-8")
    versioned, packed = tool.stage(tmp_path)
    assert versioned == 3 and packed >= 2
    html = (tmp_path / "query.html").read_text(encoding="utf-8")
    mapping = json.loads(html.split("window.__chdashAssetVersions=", 1)[1].split(";</script>", 1)[0])
    assert mapping["static/app.js"] == hashlib.sha256(script.encode()).hexdigest()[:12]
    assert set(mapping) == {"static/app.js", "static/style.css", "static/tiny.js"}
    # The map comes first in <head>, before any script that reads it.
    assert html.index("<head>") < html.index("__chdashAssetVersions") < html.index("<title>")
    # A copy is the same bytes, deterministic, and only exists when it is worth a second file.
    assert gzip.decompress((tmp_path / "app.js.gz").read_bytes()).decode() == script
    assert not (tmp_path / "tiny.js.gz").exists() and not (tmp_path / "logo.png.gz").exists()
    first = (tmp_path / "app.js.gz").read_bytes()
    tool.compress(tmp_path)
    assert (tmp_path / "app.js.gz").read_bytes() == first
    # Staging is for a fresh copy: a shell that already has the map is refused, not versioned twice.
    try:
        tool.stage(tmp_path)
    except ValueError:
        pass
    else:
        raise AssertionError("a staged shell was versioned twice")


def test_every_shell_and_the_loader_use_the_version_map():
    for page in SHELLS:
        shell = read(f"src/static/{page}.html")
        assert 'var hash = window.__chdashAssetVersions && window.__chdashAssetVersions[rel];' in shell, page
        assert 'return appBase + rel + (hash ? "?v=" + hash : "");' in shell, page
    loader = read("src/static/app_loader.js")
    assert "const versions = window.__chdashAssetVersions || {};" in loader
    assert "out.searchParams.set(\"v\", hash);" in loader


def test_the_build_stages_the_static_files_and_the_server_answers_gzip():
    cmake = read("src/CMakeLists.txt")
    assert cmake.index("tools/build_page_css.py failed") < cmake.index("tools/stage_static.py failed") < cmake.index("chdash_embed_directory(")
    assert '"${_STAGE_TOOL}"' in cmake
    server = read("src/serve_embedded_static.hpp")
    assert 'chdash_embedded::find(rel + ".gz")' in server
    assert 'res.set_header("Content-Encoding", "gzip");' in server
    assert 'res.set_header("Vary", "Accept-Encoding");' in server
    # A compressed copy is an answer, never an address; a shell is never immutable.
    assert 'rel.compare(rel.size() - 3, 3, ".gz") == 0) return false;' in server
    assert 'req.has_param("v") && !html' in server


def test_embedding_writes_every_byte_of_a_file_in_one_pass(tmp_path):
    import re
    import shutil
    import subprocess

    import pytest

    cmake = shutil.which("cmake")
    if cmake is None:
        pytest.skip("CMake is required for the embedding test")
    assets = tmp_path / "assets"
    assets.mkdir()
    payload = bytes(range(256)) * 3 + b"\x00\x01\x0a"
    (assets / "blob.bin").write_bytes(payload)
    (assets / "empty.txt").write_bytes(b"")
    (tmp_path / "CMakeLists.txt").write_text(
        'cmake_minimum_required(VERSION 3.20)\nproject(embed NONE)\n'
        f'include("{ROOT / "src/EmbedStatic.cmake"}")\n'
        'chdash_embed_directory("${CMAKE_SOURCE_DIR}/assets" "${CMAKE_BINARY_DIR}/a.cpp" "${CMAKE_BINARY_DIR}/a.hpp" fixture)\n',
        encoding="utf-8",
    )
    subprocess.run([cmake, "-S", str(tmp_path), "-B", str(tmp_path / "build")], check=True, capture_output=True, text=True, timeout=60)
    source = (tmp_path / "build/a.cpp").read_text()
    body = re.search(r"data_blob_bin\[\] = \{(.*?)\};", source, re.S).group(1)
    assert bytes(int(x, 16) for x in re.findall(r"0x([0-9a-f]{2})", body)) == payload
    assert "data_empty_txt[] = {};" in source
    # No loop per byte: the generator must not append byte by byte again.
    assert "foreach(i RANGE" not in read("src/EmbedStatic.cmake")


def test_the_loader_drops_its_handlers_once_a_script_has_settled():
    loader = read("src/static/app_loader.js")
    assert loader.count("el.onload = el.onerror = null;") == 2
    assert loader.index("el.onload = () => {") < loader.index("el.onload = el.onerror = null;") < loader.index("resolve();")
