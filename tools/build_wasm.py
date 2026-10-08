#!/usr/bin/env python3
"""Build the WebAssembly kernels of the front end (docs/wasm.md).

Every src/wasm/<name>.c is one freestanding C file (src/wasm/rt.h is its runtime). clang compiles it for
wasm32 and lld links it into src/static/wasm/<name>.wasm: no libc, no JavaScript glue file, no timestamp, so
the same sources and the same compiler give the same bytes.

The built files are committed. src/wasm/wasm.lock.json records, for each kernel, the SHA-256 of its sources
(the C file, every header of src/wasm and the compiler flags below) and the SHA-256 of the committed binary. The contract test
tests/harness/test_wasm_contract.py fails when a source changed without a rebuild.

    python3 tools/build_wasm.py             # build with clang when it is installed, else in a Docker container
    python3 tools/build_wasm.py --docker    # always build in the container (alpine:3.20, clang 18, lld)
    python3 tools/build_wasm.py --local     # build with clang-18 / clang from PATH (the container runs this)
    python3 tools/build_wasm.py --check     # rebuild into a temporary directory and compare with the committed files
    python3 tools/build_wasm.py --docker --check
    python3 tools/build_wasm.py --verify    # only compare the lock with the committed files (no compiler)
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCES = ROOT / "src" / "wasm"
OUT = ROOT / "src" / "static" / "wasm"
LOCK = SOURCES / "wasm.lock.json"
IMAGE = "alpine:3.20"
PACKAGES = ("clang18", "lld", "python3")

# The one set of flags of every kernel. -Os is not used: the kernels are hot loops, -O3 keeps them fast and
# the sizes stay small anyway. bulk-memory (memory.copy) and nontrapping-fptoint are in every browser since 2021.
FLAGS = (
    "--target=wasm32",
    "-O3",
    "-std=c11",
    "-ffreestanding",
    "-nostdlib",
    "-fno-builtin-printf",
    "-fno-stack-protector",
    "-fno-ident",
    "-mbulk-memory",
    "-mnontrapping-fptoint",
    "-fuse-ld=lld",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-Wl,--no-entry",
    "-Wl,--strip-all",
    "-Wl,--gc-sections",
    "-Wl,--export-memory",
    "-Wl,-z,stack-size=1048576",
)


def kernels() -> list[Path]:
    return sorted(SOURCES.glob("*.c"))


def source_digest(source: Path) -> str:
    """SHA-256 of what decides the bytes of a kernel: its file, the headers and the flags."""
    digest = hashlib.sha256()
    headers = [path.read_bytes() for path in sorted(SOURCES.glob("*.h"))]
    for part in (source.read_bytes(), *headers, "\n".join(FLAGS).encode()):
        digest.update(hashlib.sha256(part).digest())
    return digest.hexdigest()


def file_digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def find_clang() -> str | None:
    for name in ("clang-18", "clang"):
        found = shutil.which(name)
        if found:
            return found
    return None


def clang_version(clang: str) -> str:
    out = subprocess.run([clang, "--version"], check=True, capture_output=True, text=True).stdout
    return out.splitlines()[0].strip()


def compile_all(clang: str, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    for source in kernels():
        target = out / (source.stem + ".wasm")
        command = [clang, *FLAGS, "-I", str(SOURCES), "-o", str(target), str(source)]
        result = subprocess.run(command, capture_output=True, text=True)
        if result.returncode != 0:
            sys.stderr.write(result.stdout + result.stderr)
            raise SystemExit(f"build_wasm: clang failed on {source.name}")


def lock_for(out: Path, toolchain: str) -> dict:
    return {
        "toolchain": toolchain,
        "flags": list(FLAGS),
        "kernels": {
            source.stem: {
                "source_sha256": source_digest(source),
                "wasm_sha256": file_digest(out / (source.stem + ".wasm")),
                "bytes": (out / (source.stem + ".wasm")).stat().st_size,
            }
            for source in kernels()
        },
    }


def build_local(out: Path) -> dict:
    clang = find_clang()
    if not clang:
        raise SystemExit("build_wasm: clang is not installed (use --docker)")
    compile_all(clang, out)
    return lock_for(out, clang_version(clang))


def docker_run(args: list[str], out_dir: Path) -> None:
    if not shutil.which("docker"):
        raise SystemExit("build_wasm: neither clang nor docker is installed")
    script = (
        f"apk add --no-cache {' '.join(PACKAGES)} >/dev/null && "
        f"python3 /repo/tools/build_wasm.py --local"
    )
    subprocess.run(
        ["docker", "run", "--rm", "-v", f"{ROOT}:/repo:ro", "-v", f"{out_dir}:/out", "-w", "/repo", IMAGE, "sh", "-c", script],
        check=True,
    )


def write_outputs(built: Path, lock: dict) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for stale in OUT.glob("*.wasm"):
        stale.unlink()
    for source in kernels():
        shutil.copyfile(built / (source.stem + ".wasm"), OUT / (source.stem + ".wasm"))
    LOCK.write_text(json.dumps(lock, indent=2) + "\n", encoding="utf-8")


def verify_lock() -> list[str]:
    """Problems between the lock and the committed files (no compiler needed)."""
    problems = []
    lock = json.loads(LOCK.read_text(encoding="utf-8")) if LOCK.exists() else {"kernels": {}}
    names = {source.stem for source in kernels()}
    for name in sorted(names ^ set(lock["kernels"])):
        problems.append(f"{name}: in the sources or in the lock only")
    for source in kernels():
        entry = lock["kernels"].get(source.stem)
        built = OUT / (source.stem + ".wasm")
        if not entry:
            continue
        if entry["source_sha256"] != source_digest(source):
            problems.append(f"{source.name}: changed since the last build (run tools/build_wasm.py)")
        if not built.exists():
            problems.append(f"{built.name}: missing")
        elif entry["wasm_sha256"] != file_digest(built):
            problems.append(f"{built.name}: differs from the lock")
    for stray in OUT.glob("*.wasm") if OUT.exists() else []:
        if stray.stem not in names:
            problems.append(f"{stray.name}: no source")
    return problems


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--docker", action="store_true", help="build in a container, whether clang is installed or not")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--local", action="store_true")
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--verify", action="store_true")
    options = parser.parse_args(argv)

    if options.verify:
        problems = verify_lock()
        print("\n".join(problems) if problems else "build_wasm: the lock matches the committed files")
        return 1 if problems else 0

    if options.local:
        # Inside the container (or on a host with clang): write into /out when it exists (container), else a stage.
        target = Path("/out") if Path("/out").is_dir() else Path(tempfile.mkdtemp(prefix="chdash-wasm-"))
        lock = build_local(target)
        (target / "wasm.lock.json").write_text(json.dumps(lock, indent=2) + "\n", encoding="utf-8")
        if target != Path("/out"):
            print(target)
        return 0

    if options.docker or not find_clang():
        with tempfile.TemporaryDirectory(prefix="chdash-wasm-") as tmp:
            built = Path(tmp)
            docker_run(["--local"], built)
            lock = json.loads((built / "wasm.lock.json").read_text(encoding="utf-8"))
            return finish(options, built, lock)
    with tempfile.TemporaryDirectory(prefix="chdash-wasm-") as tmp:
        built = Path(tmp)
        lock = build_local(built)
        return finish(options, built, lock)


def finish(options: argparse.Namespace, built: Path, lock: dict) -> int:
    if options.check:
        problems = []
        old = json.loads(LOCK.read_text(encoding="utf-8")) if LOCK.exists() else {"kernels": {}}
        # Another compiler release may write other bytes for the same sources: that is a warning (the committed files are
        # what ships), unless CHDASH_WASM_STRICT is set. The same compiler must give the same bytes.
        same_toolchain = old.get("toolchain") == lock["toolchain"] or os.environ.get("CHDASH_WASM_STRICT") == "1"
        for name, entry in lock["kernels"].items():
            committed = OUT / (name + ".wasm")
            if not committed.exists() or committed.read_bytes() != (built / (name + ".wasm")).read_bytes():
                problems.append(f"{name}.wasm: the rebuild differs from the committed file (toolchain {lock['toolchain']}, lock {old.get('toolchain')})")
            if old["kernels"].get(name, {}).get("source_sha256") != entry["source_sha256"]:
                problems.append(f"{name}: the lock does not match the sources")
        if problems and not same_toolchain:
            print("build_wasm: WARNING, another toolchain than the lock; rebuild with tools/build_wasm.py --docker\n" + "\n".join(problems))
            return 0
        print("\n".join(problems) if problems else f"build_wasm: the rebuild is byte-identical ({lock['toolchain']})")
        return 1 if problems else 0
    write_outputs(built, lock)
    for name, entry in lock["kernels"].items():
        print(f"build_wasm: {name}.wasm {entry['bytes']} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
