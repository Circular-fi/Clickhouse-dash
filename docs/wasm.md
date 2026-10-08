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

## Findings of the profile

The profile ran in Chrome with timers around the real functions. It used the median of several runs. The machine was shared, so the numbers can move by 30 percent.

| Part | What dominates | Decision |
| --- | --- | --- |
| Explorer graph, 2,000 objects | Compute: the edge router (A\* on a grid) takes 3.5 to 4.6 s of 3.7 s | Router, layered layout and label placement moved |
| Trace service map, dense | Compute, but the JavaScript is already JIT-fast | Router moved: 1.6 to 2.4 times faster on the kernel |
| Trace views (timeline, graph, flame graph, statistics) | DOM and idle time. Each function takes under 20 ms for 10,000 spans | Left in JavaScript |
| Duration heatmap | The server aggregates the buckets | Left in JavaScript |
| Query chart, 1,000,000 sorted rows | Reading the cells (80 ms), canvas drawing (40 to 55 ms) and paint | Left in JavaScript: the cells are JavaScript objects, and the kernel cannot read them |
| Query chart, 1,000,000 rows with x out of order | Compute: sort and merge take 0.8 to 1.4 s | Moved (`chartprep`) |
| Result table sort, numeric column | Compute: the comparator normalizes both values on each comparison | Moved (`rowsort`) |
| Result table sort, text column | Compute and string compares | Keys made once in JavaScript. The kernel was not faster, so it stays in JavaScript |
| Result stream parsing | `JSON.parse` (native) and DOM | Left in JavaScript |
| SQL colouring | Compute. Small for typical blocks | Moved (`highlight`) for long texts |
| Editor diagnostics | Compute, and quadratic in the JavaScript | Moved (`sqlscan`) |
| Treemap layout | A group has 100 nodes or fewer in the page: 0.4 ms | Moved for groups of 48 nodes or more. No page-level gain |
| Colour arithmetic | Micro: no page batch above a few hundred items | Moved as batches. No page-level gain |

## Kernels

| Kernel | JavaScript it replaces | Size (raw, gzip) | Used from |
| --- | --- | --- | --- |
| `highlight` | The lexer of `app_highlight.js` | 15.6 KB, 6.4 KB | 2,000 characters |
| `sqlscan` | The scans of the editor diagnostics, the statement at the cursor and the statement split | 37.8 KB, 10.3 KB | Diagnostics: always. Cursor statement: 16,000 characters. Split: 20,000 characters |
| `chartprep` | The general path of the Query chart model | 3.5 KB, 1.6 KB | 20,000 rows |
| `rowsort` | The numeric sort of the result table | 4.8 KB, 1.3 KB | 5,000 rows |
| `treemap` | The placement of one group in the Explorer treemap | 4.9 KB, 1.9 KB | 48 nodes |
| `color` | Batches of colour arithmetic | 28.5 KB, 7.6 KB | 64 to 5,000 items, by operation |
| `router` | The orthogonal edge router of the graph kit | 68.1 KB, 22.5 KB | 8 edges. A Worker runs it from 24 edges |
| `layered` | The layers, order and rows of the layered layout | 20.9 KB, 7.1 KB | 24 cards |
| `labels` | The placement of the edge labels | 7.4 KB, 2.9 KB | 30 labels |

The size of the adapters is 1.5 to 6 KB each. A page loads only the kernels of its own lazy groups, and only when it needs them.

### Measures

The times are medians. "Before" is the JavaScript reference.

| Case | Before | After |
| --- | --- | --- |
| Explorer, expand a database of 2,000 objects (page time) | 3.6 to 3.7 s | 0.28 to 0.30 s |
| Router, 852 cards and 550 edges | 3.5 to 4.6 s | 135 to 220 ms |
| Service map 12 nodes and 132 call paths, layout | 80 to 117 ms | 34 to 49 ms |
| Service map 40 nodes and 600 call paths, layout | 181 to 219 ms | 103 to 125 ms |
| Label placement, 550 labels | 31 ms | 9 ms |
| Layered layout, 213 seeded graphs | 583 ms | 47 ms |
| Diagnostics, 2,000 characters | 16 ms | 1.2 ms |
| Diagnostics, 30,000 characters | 5.1 s | 20 ms |
| Diagnostics, 100,000 characters | 21 to 54 s | 42 ms |
| Colouring, 25,000 characters | 2.7 ms | 1.0 ms |
| Colouring, 400,000 characters | 63 ms | 21 ms |
| Colouring, 1,500,000 characters | 167 ms | 58 ms |
| Chart model, 1,000,000 rows, x out of order | 0.7 to 1.4 s | 0.09 to 0.19 s |
| Sort of 200,000 rows, numeric column | 1.0 to 2.3 s | 50 ms (keys in JavaScript: 95 ms) |
| Sort of 200,000 rows, text column | 0.6 to 1.1 s | 0.27 to 0.4 s (JavaScript, keys made once) |
| Treemap layout, 5,000 nodes | 26.6 ms | 8.4 ms |
| Readable label colours, 20,000 items | 72 ms | 13 ms |

Some kernels did not win everywhere:

- The diagnostics of the JavaScript reference are quadratic. Three small JavaScript fixes (a prefix array of depths, a bounded scan of the previous word, memoized name sets) bring 100,000 characters from 23 s to 0.8 s. The kernel is still 6 to 20 times faster than the fixed JavaScript. The reference stays as it is, so the tests keep the old behavior.
- The service maps gain less than 2 times, because the JIT already compiles the A\* well.
- The colour operations `mix`, `hashSlot`, `sequential` and `categorical` were slower on the kernel than in the JavaScript loop at every size. The page does not send them to the kernel. The kernel has them for the tests.
- Text sort: the kernel copies the strings and then does about 3 million string compares with cache misses. It took as long as the JavaScript with keys made once.
- The time of the Query chart with sorted rows is the time to read the cells and to draw. The kernel cannot read JavaScript objects, so this part stays.

## Worker

The `router` kernel runs in a Worker for 24 edges or more. The graph kit prepares the Worker and the kernels when a graph mounts and the browser is idle. The Worker stops after 20 seconds without work.

- The Explorer shows "Routing edges" and draws curves until the routes arrive. A stale answer is dropped. A change of the layout cancels the job.
- On the 2,000-object database, the longest task of the main thread is 0 ms. The reference blocks the page for 3 to 9 s.
- The other kernels run on the main thread. Each call takes a few milliseconds at most for the sizes where the page uses it. The highlight kernel takes 58 ms for 1.5 million characters, and the reference takes 167 ms. A Worker would make the colouring asynchronous for no gain on normal blocks.
- If Workers or the kernel do not load, the JavaScript code answers.

## Equivalence

Each kernel has a spec that runs the reference and the kernel on the same inputs.

- Inputs: the 481 SQL files of `tests/api/format/input`, seeded random graphs, results, colours and scripts, and edge cases (empty, one item, ties, NaN, infinities, surrogate pairs, unterminated strings).
- A run with `WASM_FUZZ_SCALE=15` or `40` found no difference.
- A kernel hands a case back to the JavaScript code when it cannot judge it. Example: a quoted function name with a letter outside ASCII, where JavaScript lowercases with Unicode rules. The result is then the JavaScript result.
- The router and the layered layout also hand back duplicate ids and a table overflow.
