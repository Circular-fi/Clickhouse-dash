"""The WebAssembly kernels of the front end (docs/wasm.md): the binaries are checked in and match their lock, a kernel is freestanding (no glue
file, only host math imported), the files are staged, compressed and embedded byte for byte, and each kernel is a lazy group that no page loads at
start. What a kernel computes is tested against the JavaScript reference by tests/frontend/specs/wasm-*.spec.js and, natively, by the sanitizer
build (tests/native/wasm_kernel_*.c, tests/fuzz)."""
import gzip
import hashlib
import importlib.util
import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

import modules as graph

ROOT = Path(__file__).resolve().parents[2]
WASM_DIR = ROOT / "src" / "static" / "wasm"
SOURCES = ROOT / "src" / "wasm"
ALLOWED_IMPORTS = {("env", name) for name in ("sin", "cos", "atan2", "pow", "exp", "log", "cbrt", "hypot")}


def read(rel):
    return (ROOT / rel).read_text(encoding="utf-8")


def tool(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "tools" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def leb(data, at):
    value = shift = 0
    while True:
        byte = data[at]
        at += 1
        value |= (byte & 0x7F) << shift
        shift += 7
        if not byte & 0x80:
            return value, at


def sections(data):
    """{section id: payload} of a WebAssembly binary (custom sections included under id 0, last one wins)."""
    assert data[:8] == b"\0asm\x01\0\0\0"
    out, at = {}, 8
    while at < len(data):
        sid = data[at]
        size, at = leb(data, at + 1)
        out[sid] = data[at:at + size]
        at += size
    return out


def imports(data):
    payload = sections(data).get(2)
    if payload is None:
        return []
    count, at = leb(payload, 0)
    found = []
    for _ in range(count):
        n, at = leb(payload, at)
        module = payload[at:at + n].decode()
        at += n
        n, at = leb(payload, at)
        name = payload[at:at + n].decode()
        at += n
        kind = payload[at]
        at += 1
        found.append((module, name, kind))
        if kind == 0:
            _, at = leb(payload, at)
        else:
            raise AssertionError(f"{module}.{name}: a kernel imports functions only")
    return found


def exports(data):
    payload = sections(data)[7]
    count, at = leb(payload, 0)
    names = []
    for _ in range(count):
        n, at = leb(payload, at)
        names.append(payload[at:at + n].decode())
        at += n + 1
        _, at = leb(payload, at)
    return names


def kernels():
    return sorted(WASM_DIR.glob("*.wasm"))


def test_every_source_has_a_committed_binary_and_the_lock_matches():
    builder = tool("build_wasm")
    assert builder.verify_lock() == []
    assert sorted(path.stem for path in kernels()) == sorted(path.stem for path in SOURCES.glob("*.c"))
    lock = json.loads((SOURCES / "wasm.lock.json").read_text(encoding="utf-8"))
    assert "clang" in lock["toolchain"].lower()
    for path in kernels():
        assert lock["kernels"][path.stem]["bytes"] == path.stat().st_size


def test_a_kernel_is_freestanding_no_glue_file_and_only_host_math_is_imported():
    for path in kernels():
        data = path.read_bytes()
        assert imports(data) == [] or {(m, n) for m, n, _ in imports(data)} <= ALLOWED_IMPORTS, path.name
        names = exports(data)
        assert "memory" in names and "wasm_alloc_bytes" in names and "wasm_mark" in names and "wasm_release" in names, path.name
        # No timestamp, path or producer text: the same sources give the same bytes.
        assert b"/repo" not in data and b"clang version" not in data and b"/tmp" not in data, path.name
        assert not path.with_suffix(".js").exists()


def test_the_stage_versions_and_compresses_a_kernel(tmp_path):
    stage = tool("stage_static")
    payload = (kernels()[0].read_bytes() if kernels() else b"\0asm\x01\0\0\0" + bytes(range(256)) * 8)
    (tmp_path / "wasm").mkdir()
    (tmp_path / "wasm" / "k.wasm").write_bytes(payload)
    (tmp_path / "query.html").write_text("<!doctype html>\n<html><head>\n<title>x</title></head><body></body></html>\n", encoding="utf-8")
    versioned, packed = stage.stage(tmp_path)
    assert versioned == 1 and packed >= 1
    html = (tmp_path / "query.html").read_text(encoding="utf-8")
    mapping = json.loads(html.split("window.__chdashAssetVersions=", 1)[1].split(";</script>", 1)[0])
    assert mapping["static/wasm/k.wasm"] == hashlib.sha256(payload).hexdigest()[:12]
    assert gzip.decompress((tmp_path / "wasm" / "k.wasm.gz").read_bytes()) == payload


def test_the_embedded_copy_of_every_kernel_is_byte_exact(tmp_path):
    cmake = shutil.which("cmake")
    if cmake is None:
        pytest.skip("CMake is required for the embedding test")
    if not kernels():
        pytest.skip("no kernel")
    assets = tmp_path / "static" / "wasm"
    assets.mkdir(parents=True)
    for path in kernels():
        (assets / path.name).write_bytes(path.read_bytes())
    (tmp_path / "CMakeLists.txt").write_text(
        'cmake_minimum_required(VERSION 3.20)\nproject(embed NONE)\n'
        f'include("{ROOT / "src/EmbedStatic.cmake"}")\n'
        'chdash_embed_directory("${CMAKE_SOURCE_DIR}/static" "${CMAKE_BINARY_DIR}/a.cpp" "${CMAKE_BINARY_DIR}/a.hpp" fixture)\n',
        encoding="utf-8",
    )
    subprocess.run([cmake, "-S", str(tmp_path), "-B", str(tmp_path / "build")], check=True, capture_output=True, text=True, timeout=120)
    source = (tmp_path / "build/a.cpp").read_text()
    for path in kernels():
        symbol = f"data_wasm_{path.stem}_wasm"
        body = re.search(symbol + r"\[\] = \{(.*?)\};", source, re.S).group(1)
        assert bytes(int(x, 16) for x in re.findall(r"0x([0-9a-f]{2})", body)) == path.read_bytes(), path.name


def test_every_kernel_has_a_lazy_group_an_adapter_and_a_javascript_reference_path():
    manifest = json.loads(read("src/static/modules.json"))
    groups = {}
    for page, entry in manifest["pages"].items():
        for name, files in entry.get("lazy", {}).items():
            if name.startswith("wasm-"):
                groups.setdefault(name, []).append((page, files))
    assert groups, "no wasm-* lazy group"
    for name, pages in groups.items():
        for page, files in pages:
            assert files and "app_wasm.js" not in files and all((ROOT / "src/static" / f).exists() for f in files), (page, name)
            # The loader runs before any module: the kernel's modules load on demand only, never at start.
            assert not set(files) & set(graph.page_files(page)), (page, name)
    for adapter in (ROOT / "src/static").glob("app_wasm_*.js"):
        text = adapter.read_text(encoding="latin-1")
        if adapter.name != "app_wasm_worker.js":
            assert "wasm.ops." in text, adapter.name
    # Each kernel is one freestanding C file (the build is -ffreestanding -nostdlib: a libc include would not link).
    for source in SOURCES.glob("*.c"):
        text = source.read_text(encoding="utf-8")
        assert '#include "rt.h"' in text and "#include <" not in text, source.name


def test_the_worker_and_the_loader_use_no_eval_and_no_network_beyond_the_kernel_file():
    for name in ("app_wasm.js", "app_wasm_worker.js"):
        text = read(f"src/static/{name}")
        assert not re.search(r"\beval\s*\(|new Function\s*\(", text), name
        assert not re.search(r"https?://", text), name
