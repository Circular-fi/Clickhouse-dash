import gzip
import hashlib
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SHELLS = ("query", "explorer", "traces", "logs", "metrics", "trace", "system", "shape", "mcp")


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
    (tmp_path / "app_one.js").write_text(script, encoding="utf-8")
    (tmp_path / "style.css").write_text("body { color: red; }\n" * 80, encoding="utf-8")
    (tmp_path / "app_tiny.js").write_text("1", encoding="utf-8")
    (tmp_path / "logo.png").write_bytes(b"\x89PNG" * 400)
    (tmp_path / "query.html").write_text("<!doctype html>\n<html><head>\n<title>x</title></head><body></body></html>\n" * 1, encoding="utf-8")
    versioned, packed = tool.stage(tmp_path)
    assert versioned == 3 and packed >= 2
    html = (tmp_path / "query.html").read_text(encoding="utf-8")
    mapping = json.loads(html.split("window.__chdashAssetVersions=", 1)[1].split(";</script>", 1)[0])
    assert mapping["static/app_one.js"] == hashlib.sha256(script.encode()).hexdigest()[:12]
    assert set(mapping) == {"static/app_one.js", "static/style.css", "static/app_tiny.js"}
    # The map comes first in <head>, before any script that reads it.
    assert html.index("<head>") < html.index("__chdashAssetVersions") < html.index("<title>")
    # A copy is the same bytes, deterministic, and only exists when it is worth a second file.
    assert gzip.decompress((tmp_path / "app_one.js.gz").read_bytes()).decode() == script
    assert not (tmp_path / "app_tiny.js.gz").exists() and not (tmp_path / "logo.png.gz").exists()
    first = (tmp_path / "app_one.js.gz").read_bytes()
    tool.compress(tmp_path)
    assert (tmp_path / "app_one.js.gz").read_bytes() == first
    # Staging twice gives the same stage: the second map replaces the first, it is not added to it.
    tool.stage(tmp_path)
    assert (tmp_path / "query.html").read_text(encoding="utf-8").count("__chdashAssetVersions=") == 1


def test_staging_writes_the_hash_of_each_imported_module_into_the_import(tmp_path):
    tool = stage_tool()
    body = "export const value = 1;\n" * 80
    (tmp_path / "app_leaf.js").write_text(body, encoding="utf-8")
    (tmp_path / "app_mid.js").write_text('import { value } from "./app_leaf.js";\nexport const twice = value * 2;\n' + body.replace("value", "other"), encoding="utf-8")
    (tmp_path / "app_top.js").write_text('import { twice } from "./app_mid.js";\nimport "./app_leaf.js";\nexport { twice };\n', encoding="utf-8")
    (tmp_path / "query.html").write_text("<html><head></head></html>", encoding="utf-8")
    tool.stage(tmp_path)
    html = (tmp_path / "query.html").read_text(encoding="utf-8")
    mapping = json.loads(html.split("window.__chdashAssetVersions=", 1)[1].split(";</script>", 1)[0])
    leaf = mapping["static/app_leaf.js"]
    mid = mapping["static/app_mid.js"]
    assert leaf == hashlib.sha256(body.encode()).hexdigest()[:12]
    mid_text = (tmp_path / "app_mid.js").read_text(encoding="utf-8")
    assert f'from "./app_leaf.js?v={leaf}";' in mid_text
    # The hash of a module is the hash of the bytes the server will send, imports included: a change under it is a new address.
    assert mid == hashlib.sha256(mid_text.encode()).hexdigest()[:12]
    top_text = (tmp_path / "app_top.js").read_text(encoding="utf-8")
    assert f'from "./app_mid.js?v={mid}";' in top_text and f'import "./app_leaf.js?v={leaf}";' in top_text
    assert mapping["static/app_top.js"] == hashlib.sha256(top_text.encode()).hexdigest()[:12]
    # Staging again changes nothing (the imports already carry their hash).
    tool.stage(tmp_path)
    assert (tmp_path / "app_top.js").read_text(encoding="utf-8") == top_text


def test_staging_refuses_modules_that_import_each_other(tmp_path):
    tool = stage_tool()
    (tmp_path / "app_a.js").write_text('import "./app_b.js";\n', encoding="utf-8")
    (tmp_path / "app_b.js").write_text('import "./app_a.js";\n', encoding="utf-8")
    (tmp_path / "query.html").write_text("<html><head></head></html>", encoding="utf-8")
    try:
        tool.stage(tmp_path)
    except ValueError as error:
        assert "cycle" in str(error)
    else:
        raise AssertionError("a cycle was staged")


def test_every_shell_and_the_asset_module_use_the_version_map():
    for page in SHELLS:
        shell = read(f"src/static/{page}.html")
        assert 'var hash = window.__chdashAssetVersions && window.__chdashAssetVersions[rel];' in shell, page
        assert 'return appBase + rel + (hash ? "?v=" + hash : "");' in shell, page
        # The shell preloads and starts the page's modules by the same addresses, with their hashes.
        assert 'link.href = url(page.files[i]);' in shell and 'entry.src = url(page.entry);' in shell, page
    assets = read("src/static/app_assets.js")
    assert "const versions = globalThis.__chdashAssetVersions || {};" in assets
    assert 'out.searchParams.set("v", hash);' in assets
    assert "new URL(\"./\", import.meta.url)" in assets


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
