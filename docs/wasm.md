# WebAssembly kernels

The front end is vanilla JavaScript. Most of it builds the DOM, and WebAssembly cannot reach the DOM. A few computations are different. They read numbers or text and return numbers or text. These computations run as WebAssembly kernels.

## Rules

- A kernel has the same interface as the JavaScript code that it replaces. Typed arrays or strings go in. Typed arrays or strings come out.
- The JavaScript code stays. It is the fallback and it is the reference of the tests.
- The result of a kernel is identical to the result of the JavaScript code. For floating point numbers, "identical" means the same double.
- A kernel loads on demand, in a lazy group of `src/static/modules.json`. A page that does not use a kernel never fetches it.
- A kernel never breaks a page. If the file is blocked, missing or refused, the page keeps its JavaScript path.
- A short input stays on the JavaScript path. A call into a kernel has a fixed cost. Each kernel has a size threshold that was measured.
- A call that takes more than a few milliseconds runs in a Web Worker, so the page does not freeze.

## How a kernel is made

| Part | File |
| --- | --- |
| The C source of the kernel | `src/wasm/<name>.c` |
| The runtime that all kernels share | `src/wasm/rt.h`, `src/wasm/sort.h` |
| The built kernel (committed) | `src/static/wasm/<name>.wasm` |
| The hashes of the sources and of the binaries | `src/wasm/wasm.lock.json` |
| The adapter: the JavaScript side of the kernel | `src/static/app_wasm_<name>.js` |
| The loader and the Worker | `src/static/app_wasm.js`, `src/static/app_wasm_worker.js` |
| The build tool | `tools/build_wasm.py` |

### Toolchain

The kernels are freestanding C. clang 18 compiles them to `wasm32`. lld links them. The tool runs both in a container (`alpine:3.20`, packages `clang18` and `lld`).

| Choice | Reason |
| --- | --- |
| C and not Rust | No cargo, no crate download, no target install. One `apk add` gives the compiler. |
| C and not Emscripten | Emscripten adds a glue file and a large runtime. A kernel here is a few KB and needs no glue. |
| C and not AssemblyScript | It needs Node and npm packages at build time. |
| No libc | The kernels use no `malloc`, no `printf` and no `libm`. `rt.h` has an arena allocator. |
| Host Math | `sin`, `cos`, `pow` and the like are imports from JavaScript `Math`. A kernel then gives the same doubles as the JavaScript code. |

The flags are in `tools/build_wasm.py`. They strip all debug data, producer names and paths. The same sources and the same compiler give the same bytes.

### Commit the binary

The built `.wasm` files are committed. This choice has these effects:

- A normal checkout builds and runs with no wasm toolchain. The release workflow needs no compiler.
- A pull request shows the sizes of the binaries.
- The lock file `src/wasm/wasm.lock.json` stores the SHA-256 of each source set and of each binary. The test `tests/harness/test_wasm_contract.py` fails when a source changed and the binary did not.
- `python3 tools/build_wasm.py --check` rebuilds the kernels and compares them with the committed files. The CI workflow, the release workflow and `tests/Dockerfile.source` run it. The image build fails when the bytes differ.
- When the compiler release differs from the one in the lock, the check prints a warning and does not fail. Set `CHDASH_WASM_STRICT=1` to make it fail.

### Rebuild

1. Edit `src/wasm/<name>.c`.
2. Run `python3 tools/build_wasm.py --docker`. It builds all kernels in a container and writes the `.wasm` files and the lock.
3. Run `python3 tools/build_wasm.py --check` to see that a second build gives the same bytes.
4. Commit the C file, the `.wasm` file and the lock together.

Without Docker, install `clang-18` and `lld`, and run `python3 tools/build_wasm.py --local`.

## Loading

`ns.wasm` (`src/static/app_wasm.js`) loads a kernel.

- `ns.wasm.load(name)` fetches `static/wasm/<name>.wasm`. It uses `WebAssembly.instantiateStreaming`. If that fails, it reads the bytes and calls `WebAssembly.instantiate`. It never rejects. A failure gives `null`.
- `ns.wasm.get(name)` returns the kernel if it is ready now.
- The server sends `.wasm` as `application/wasm`. The staged build adds `?v=<hash>` to the address, and a `.gz` copy for clients that accept gzip.
- A kernel has its own memory. `kernel.scope(fn)` frees all allocations of `fn` when it returns.
- `ns.wasm.worker(name, adapterFile)` runs the same kernel in a Worker. It returns `{ call(op, args, transfer), close() }`, or `null` if Workers or the kernel are not available.

An adapter registers its operations in `ns.wasm.ops.<name>`. The same adapter file runs in the page and in the Worker.

## Tests

- `tests/harness/test_wasm_contract.py` checks the lock, the imports of each binary, the mime type, the staging, the byte-exact embedding and the lazy groups.
- Each kernel has a Playwright spec `tests/frontend/specs/wasm-<name>.spec.js`. It runs the JavaScript reference and the kernel on the same inputs. It uses the SQL files of `tests/api/format/input` and seeded random inputs. It compares the results. It blocks the `.wasm` request and checks that the page still works.
- `WASM_FUZZ_SCALE=20` multiplies the number of seeded inputs.
- Specs with "performance budget" in the title print the timings of both paths. They run in the timing project of the Playwright configuration.
