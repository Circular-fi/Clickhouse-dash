"""The WebAssembly kernels of the front end (docs/wasm.md): the build is reproducible and checked in, the files are served
and embedded byte for byte as application/wasm, and a kernel needs nothing from the network or from a glue file."""
import gzip
import hashlib
import importlib.util
import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

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


def test_the_build_is_reproducible_in_a_container_and_in_the_release_workflow():
    docker = read("tests/Dockerfile.source")
    assert "build_wasm.py --check" in docker and "COPY --from=wasm /work/src/static/wasm /app/static/wasm" in docker
    for workflow in ("ci.yml", "release.yaml"):
        text = read(f".github/workflows/{workflow}")
        assert "tools/build_wasm.py --verify" in text and "tools/build_wasm.py --docker --check" in text, workflow
    builder = read("tools/build_wasm.py")
    for flag in ("-ffreestanding", "-nostdlib", "-fno-ident", "-Wl,--strip-all", "-Wl,--no-entry"):
        assert f'"{flag}"' in builder, flag
    assert "IMAGE = \"alpine:3.20\"" in builder


def test_a_kernel_is_freestanding_no_glue_file_and_only_host_math_is_imported():
    for path in kernels():
        data = path.read_bytes()
        assert imports(data) == [] or {(m, n) for m, n, _ in imports(data)} <= ALLOWED_IMPORTS, path.name
        names = exports(data)
        assert "memory" in names and "wasm_alloc_bytes" in names and "wasm_mark" in names and "wasm_release" in names, path.name
        # No timestamp, path or producer text: the same sources give the same bytes.
        assert b"/repo" not in data and b"clang version" not in data and b"/tmp" not in data, path.name
        assert not path.with_suffix(".js").exists()


def test_the_server_answers_wasm_with_its_own_mime_type_and_the_stage_versions_and_compresses_it(tmp_path):
    server = read("src/serve_embedded_static.hpp")
    assert 'if (ext == "wasm") return "application/wasm";' in server
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
    modules = json.loads(read("src/static/modules.json"))
    groups = {}
    for page, entry in modules["pages"].items():
        for name, files in entry.get("lazy", {}).items():
            if name.startswith("wasm-"):
                groups.setdefault(name, []).append((page, files))
    assert groups, "no wasm-* lazy group"
    for name, pages in groups.items():
        for page, files in pages:
            assert files[0] == "app_wasm.js", (page, name)
            assert files[1:] and all((ROOT / "src/static" / f).exists() for f in files), (page, name)
            # The loader runs before any module: the kernel's modules load on demand only, never at start.
            assert not set(files) & set(modules["common"] + modules["pages"][page]["modules"]), (page, name)
    loader = read("src/static/app_wasm.js")
    assert "WebAssembly.instantiateStreaming" in loader and "WebAssembly.instantiate(await response.arrayBuffer()" in loader
    # A failure is a null kernel, never a rejection or an exception of the page.
    assert "return null;\n        }\n      );" in loader and "stats.failures += 1;" in loader
    for adapter in (ROOT / "src/static").glob("app_wasm_*.js"):
        text = adapter.read_text(encoding="latin-1")
        if adapter.name == "app_wasm_worker.js":
            assert "importScripts(...m.scripts)" in text
        else:
            assert "ns.wasm.ops." in text, adapter.name


def test_the_worker_and_the_loader_use_no_eval_and_no_network_beyond_the_kernel_file():
    for name in ("app_wasm.js", "app_wasm_worker.js"):
        text = read(f"src/static/{name}")
        assert not re.search(r"\beval\s*\(|new Function\s*\(", text), name
        assert not re.search(r"https?://", text), name
