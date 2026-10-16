# Contributing

Thank you for your contribution to `clickhouse-dash`.

## Before you open a pull request

- Open an issue first for large changes, architectural changes or UX changes.
- Keep the diffs focused. Do not make unrelated refactors.
- Update the tests and the documentation when the behavior changes.
- Make incremental PRs. Make each PR easy to review.

## Development

### Prerequisites

- Docker and Docker Compose.
- Or: CMake >= 3.20, Ninja and a C++17 compiler.
- Python 3.12, if you want to run the API tests outside Docker.

### Local run

```bash
cd tests
docker compose up -d
```

### Local build

```bash
cmake -S src -B build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build build --target chdash
./build/chdash
```

### Run tests

```bash
cd tests
docker compose --profile test up -d --build
docker compose --profile test exec -T tests python /tests/runner/wait_for_job.py --job tests --timeout 900
```

### Quick test runs

Refer to `tests/README.md`, "Running tests quickly", for the details.

- `tests/tools/pw-changed.sh` runs the Playwright specs of the files that you changed. It uses `desktop-1440` and `PW_SHARED_HOST=1` (one worker, no timing-budget tests).
- A plain `npx playwright test` runs the layout specs on three viewports. It runs the behavioral specs on `desktop-1440`. `PW_ALL_PROJECTS=1` runs everything on every viewport before a release.
- `run-all-tests.py --quick` runs every test at least once. It runs the design phase on one viewport and does not change the other phases. Without `--quick`, it is the full official suite.
- On a shared host, follow these rules.
  - Run one Playwright run at a time.
  - Run the changed specs first.
  - Run the full run once at the end.
  - Do not use `sleep` polling loops.
  - Run pytest without `CLICKHOUSE_URL`.

### Validate release builds

The release workflow builds Linux amd64/arm64 and macOS amd64/arm64. It uses isolated CMake directories and bounded parallelism. If a matrix build fails, download its `build-diagnostics-*` artifact. Then examine `build.log` and `CMakeCache.txt`. Do not cache a `CMakeCache.txt` of one platform. Do not reuse it across runners.

The release chain follows these rules:

- The release runs no test suite. It builds the commit of the tag, smoke-tests each binary and publishes it (about 15 minutes). The full suite takes about 75 minutes on a runner. Before you make the tag, run the full suite with `docker compose --profile test up --build` in `tests/` (see `tests/README.md`).
- The tests do not run on a push or a pull request. They take a long time. `ci.yml` runs on request (Actions > CI > Run workflow). The sanitizers (`sanitize.yml`), clang-tidy and the release smoke test run on request only. CodeQL runs once a week.
- Each action pin uses a commit SHA. The version is in a comment. Dependabot updates the pins.
- No release job restores a cache. Each checkout uses `persist-credentials: false`.
- Only the publish job can write to the repository. It runs in the `release` environment. Set a required reviewer for this environment in the repository settings. The `gh` CLI publishes the release. No third-party action gets the write token.
- A manual run (`workflow_dispatch`) creates the tag after the build, on the tested commit. If the tag exists, it must refer to that commit.
- The publish job makes a build provenance attestation for each archive. Refer to `SECURITY.md`, "Verify a release".
- Each binary runs the smoke test (`tests/smoke/release_smoke.py`), on Linux and on macOS.
- A Linux binary is a static position independent executable (static-pie). It has the stack protector and full RELRO. The script `tests/smoke/check_release_binary.sh` checks these properties before the strip.

The dependencies of the build have pins too:

- `src/CMakeLists.txt` fetches clickhouse-cpp, cpp-httplib, rapidjson, Monocypher and micro-ecc by commit SHA. Monocypher (Ed25519) and micro-ecc (P-256) verify the signature of the identity token ([docs/access.md](docs/access.md)). Dependabot does not read CMake. Update a SHA and its comment by hand. `src/PatchRapidJSON.cmake` patches rapidjson for each toolchain.
- `tests/smoke/Dockerfile.release` checks the SHA-256 of the Zig archive. The release workflow uses `mlugg/setup-zig`, which checks the minisign signature of Zig. A new Zig version needs new sums.
- `tests/requirements.txt` holds the hash of each Python test package. Use `pip install --require-hashes` to install it. Generate it from `tests/requirements.in` with the command in its header.
- `tests/frontend/package-lock.json` pins the npm packages. The test image installs them with `npm ci`.

### Hardening

`-DCHDASH_HARDEN=ON` is the default. A sanitizer disables it. It adds these flags to all code, and to the dependencies: `-fstack-protector-strong`, `-fstack-clash-protection`, `-ftrivial-auto-var-init=zero`, and `-D_FORTIFY_SOURCE=3` in an optimized build. It also enables the cheap checks of the standard library. For libc++ 18 or later, these checks are its hardened mode (the Linux release build). For libstdc++, they are `_GLIBCXX_ASSERTIONS` (the test images).

The build tests each flag first. It skips a flag that the compiler does not know.

Some protections are not available in the release build.

- musl has no fortified functions, so `_FORTIFY_SOURCE` has no effect in the Linux release binary. The test image (Alpine `fortify-headers`) and the macOS build use it.
- The release build does not use `-fcf-protection`. musl does not enable the control-flow protection (CET) of the CPU.

The Linux release binary is static-pie. The kernel loads it at a random address. It has full RELRO (`BIND_NOW`) and a stack that is not executable. `tests/smoke/check_release_binary.sh` checks these properties.

### Compiler warnings

The build enables `-Wall`, `-Wextra` and `-Wdangling-reference` (GCC 13 and later) for our sources. The dependencies (clickhouse-cpp, cpp-httplib, rapidjson, Monocypher, micro-ecc) do not get these flags. The file `src/BuildFlags.cmake` holds them.

- `-DCHDASH_WERROR=ON` makes each warning an error. The test image (`tests/Dockerfile.source`) and the CI jobs enable it. The release build does not enable it. A new compiler then cannot stop a release.
- Fix a warning in the code.
- To silence a false positive, put `#pragma GCC diagnostic ignored "-W<name>"` between `push` and `pop` around the line. Write the reason in a comment. Do not disable a warning for a whole target.
- A new C++ file needs no change. For a new target, add `chdash_configure_target(<target>)` in `src/CMakeLists.txt`.

### Dangling captures in route handlers

A route handler lives longer than the `Server` constructor. If a handler captures `[&]` and uses a local variable or a local lambda of the constructor, it reads a destroyed object. Version 2.16.3 had this bug: `/observability` answered 404 in the release build only.

No compiler warning finds this bug. GCC `-Wdangling-reference`, clang `-Wdangling` and clang-tidy do not report it. Use these tools to find it:

- Run `python3 tools/check_handler_captures.py src/server.cpp`. It finds every `[&]` lambda that uses a local of the constructor. Fix it with `[&, name]` (a copy) or call a member function. CI runs this script.
- The sanitizer build (below) reports it as `stack-use-after-return` when a test calls the route.
- The release smoke test (below) fails on it.

### clang-tidy

`.clang-tidy` lists the checks. The checks are `bugprone-*`, `clang-analyzer-*`, `concurrency-mt-unsafe`, a few `cppcoreguidelines-*` and `performance-*` checks. The check `concurrency-mt-unsafe` finds a libc function that is not thread safe, such as `strerror`. Use `std::generic_category().message(errno)` instead. Each check that is off has a reason in the file. A finding is an error.

```bash
tests/tools/clang-tidy.sh                    # all of src/*.cpp, in Docker (about 10 minutes)
tests/tools/clang-tidy.sh src/api_logs.cpp   # some files
```

Fix a finding in the code. To silence one line, write `// NOLINT(<check>)` and the reason. The `clang-tidy.yml` workflow runs on request (Actions > run workflow). It checks only the changed `.cpp` files, unless a header, a build file or `.clang-tidy` changes.

### Sanitizers

`-DCHDASH_SANITIZE=address,undefined` builds with AddressSanitizer and UndefinedBehaviorSanitizer. AddressSanitizer covers the dependencies. UndefinedBehaviorSanitizer covers only our code. A finding of UndefinedBehaviorSanitizer stops the process. SIGTERM ends every build of the server cleanly. With `address`, LeakSanitizer reports leaks at exit.

```bash
tests/tools/sanitize.sh native     # the native unit tests
tests/tools/sanitize.sh backend    # tests/backend-functional and tests/harness on the sanitized server
tests/tools/sanitize.sh frontend   # five Playwright specs on the sanitized server
tests/tools/sanitize.sh load       # a concurrent load on the sanitized server (tests/sanitize/load.py)
tests/tools/sanitize.sh all        # the four above
```

`-DCHDASH_SANITIZE=thread` builds with ThreadSanitizer. It cannot combine with AddressSanitizer. Build it separately. Set `CHDASH_SANITIZE=thread` for the script:

```bash
CHDASH_SANITIZE=thread tests/tools/sanitize.sh native   # the native unit tests under ThreadSanitizer
CHDASH_SANITIZE=thread tests/tools/sanitize.sh backend  # the backend tests on the ThreadSanitizer server
CHDASH_SANITIZE=thread tests/tools/sanitize.sh load     # many clients at the same time: the races show here
```

The `backend` and `frontend` commands need the test ClickHouse stack (`docker compose -f tests/docker-compose.yml --profile otel up -d clickhouse clickhouse_replica otel_fixture`). The server log is in `/tmp/chdash-sanitize-logs/server.log`. The `sanitize.yml` workflow runs all three on each pull request, every night and on request. `tests/README.md`, "Sanitizers", has the details.

To accept a leak or a finding that is not ours, add it to `tests/sanitize/lsan.supp`. For a race, add it to `tests/sanitize/tsan.supp` instead. Add a comment that says why. Fix our own findings in the code.

### Fuzzing

`tests/fuzz` holds libFuzzer targets for the code that reads untrusted text. These targets cover:

- the JSON parse of a request body
- the SQL formatter
- the SQL policy of the Query page (`KILL QUERY`)
- the SQL checks of the MCP tools
- the HCL parser
- the WebAssembly kernels (built natively)

`-DCHDASH_BUILD_FUZZERS=ON` builds them with clang, AddressSanitizer and UndefinedBehaviorSanitizer.

```bash
tests/tools/fuzz.sh                  # every target, 60 s each
tests/tools/fuzz.sh 600 format hcl   # two targets, 600 s each
tests/tools/fuzz.sh list             # the names of the targets
```

A finding is a file `crash-*`, `leak-*`, `timeout-*` or `oom-*` in `/tmp/chdash-fuzz/<target>/`. Fix the code. Add the input to `tests/fuzz/corpus/<target>/`. The next runs then start from it. The `sanitize.yml` workflow runs every target for one minute. `tests/README.md`, "Fuzzing", has the details.

### Release smoke test

The test image is not the shipped binary. The release binary is static, stripped and optimized. It serves the embedded files. `tests/smoke/release_smoke.py` starts a binary with every page enabled and a ClickHouse host that does not exist. It probes the routes that must answer.

```bash
docker build -f tests/smoke/Dockerfile.release --target binary --output type=local,dest=out .
python3 tests/smoke/release_smoke.py --binary out/chdash            # run it as a process
python3 tests/smoke/release_smoke.py --binary out/chdash --scratch  # run it in a FROM scratch container
```

The Dockerfile builds the binary like `.github/workflows/release.yaml` does. It uses Zig, musl, static-pie and hardened settings. The release workflow runs the script on each binary before it publishes. The `release-smoke.yml` workflow runs it on request.

You can also run the backend tests against the release binary:

```bash
tests/tools/release-backend.sh   # tests/backend-functional on the release binary in a FROM scratch container
```

The backend tests need the test ClickHouse stack, like `tests/tools/sanitize.sh backend`. The `release-smoke.yml` workflow runs them on each pull request.

## Coding guidelines

- Backend code is C++17.
- Frontend code is vanilla JavaScript in ES modules (`src/static/app_*.js`). There is no bundler and no transpiler. A module imports what it needs, for example `import { format } from "./app_format.js";`, and exports its API by name. Write the import with the exact sibling name.
- Do not make an import cycle. Do not write to or read from `window`. `python3 tools/module_graph.py` checks these rules. The harness also runs it.
- Styles are in `src/static/css/` (docs/ui-foundations.md, "Stylesheets").
- The files are `00-tokens.css` (custom properties), `01-base.css`, `10-components/<component>.css`, `20-features/<feature>.css` and `30-overrides.css`.
- `src/static/css/index.css` imports them into the cascade layers `tokens, base, components, features, overrides`.
- Write a selector list once in each layer. Add the declarations to its rule. Do not add a second rule.
- Put a color literal in `00-tokens.css` as a token.
- Use the scales in `00-tokens.css` for these values. The values are a font size, a weight, a family, a radius, a shadow, a duration and a z-index. See docs/ui-foundations.md, "Type, shape, motion and stacking", for the scales.
- Use `!important` only for the allow-list of `tests/harness/test_css_rules.py`.
- Each page loads a generated `style.<page>.css`. It has the rules of the sources that can match on that page.
- These files are build outputs. CMake and the Docker images run `tools/build_page_css.py` to create them. Do not commit them.
- To serve `src/static` from the file system, run `python3 tools/build_page_css.py` once. Git ignores its output.
- Run `python3 tools/build_page_css.py --report-dead` to list the selectors that no page can match.
- A page is its entry module, `src/static/app_page_<page>.js`.
- The entry imports `app_common.js` (the foundations and the components that every page uses), the modules of the page, and `app_boot.js`.
- The modules that the entry imports, and the modules that those import, are the page. Nothing else lists them.
- `src/static/modules.json` holds only the entry of each page, what the page says about its shell (`label`, `main`, `nav`) and its lazy groups. It is the one list of pages.
- A lazy group is a list of modules that load on first use (`loader.loadGroup("<group>")` in `app_loader.js`). A page does not import a lazy module.
- Some pages have a collaborator, for example the Explorer graph. The entry gives it to the module that needs it, with a `use({ ... })` call. Do not import it there.
- The page header is in `src/shell/header.html`.
- After you edit it, `modules.json` or an import, run `python3 tools/build_page_css.py`.
- The script writes the generated `shell:header` and `shell:scripts` regions of the page shells. Then it writes the stylesheets.
- The shell adds the entry as a module script. The shell preloads the modules of the page with `modulepreload`.
- The page description for `app_loader.js` is in the `chdashModules` JSON block of the shell.
- The CSP of a shell allows its inline scripts by hash. The build writes these hashes.
- The browser tests and the console read the exports of the modules of a page from `window.ChDash` (for example `ChDash.format`).
- `app_loader.js` is the only module that writes this handle. The generated `handle:start` region of each entry calls it, before the `load` event.
- No module reads this handle.
- The harness runs a Node unit test of a module with `tests/harness/esm_vm.js`. This file loads the real modules in a `vm` context. It replaces the imports that the test does not need with stubs.
- Run the test with `node` and `--experimental-vm-modules`.
- The embedded build stages `src/static` one more time (`tools/stage_static.py`).
- The stage addresses the scripts, the stylesheets and the kernels as `?v=<content hash>`.
- It also writes the hash of each imported module into the `import` of a module (`./app_x.js?v=<hash>`), in dependency order.
- The hash of a module covers the modules under it. So a change in a low module changes the address of all modules that import it.
- The shells carry the map in `window.__chdashAssetVersions`. `loader.url` (`app_assets.js`) and `window.__chdashUrl` read it.
- The server sends these files as immutable. It checks that the hash is the hash of the bytes that it serves.
- The text files get a `.gz` copy. The server sends this copy to the clients that accept gzip.
- Load a file that is not imported through `loader.url`, `loader.loadGroup` or `window.__chdashUrl`. Then the stage includes it.
- A hard-coded `static/x.js` still works. But the browser revalidates it on every load.
- Read SQL text through the one lexer of the page, `src/static/app_sql_lex.js` (`spans`, `mask`, `statementAt`, `splitRanges`, `matchParen`, `splitTopLevel`).
- Do not write another scanner for quotes, comments and semicolons.
- The kernels `highlight.c` and `sqlscan.c` follow its rules. `tests/frontend/model/sql-lex-vectors.json` holds the cases that the module, the kernels and the backend lexer all read (docs/wasm.md, "The SQL lexer").
- The WebAssembly kernels are C files in `src/wasm/`. The built files are in `src/static/wasm/`. These built files are committed.
- After you edit a C file or a header of `src/wasm/`, run `python3 tools/build_wasm.py --docker`.
- This command needs Docker. It builds with `clang` 18 in a container.
- Commit the C file, the `.wasm` file and `src/wasm/wasm.lock.json` together.
- Run `python3 tools/build_wasm.py --check` to prove that the committed files match a fresh build.
- A kernel keeps its JavaScript reference. docs/wasm.md has the rules.
- Keep `src/static/*.js` and the stylesheet sources in Latin-1. Write `"…"` in JavaScript and `"\2026"` in CSS. Do not write the character.
- This practice lets Chrome store the sources with one byte for each character.
- A route of the Traces page is a short adapter in `src/api_traces.cpp`.
- The adapter finds the host and parses the request (`trace_request`). It calls `TraceService` with the context of the request. It writes the JSON of the answer (`trace_json`).
- The reads are in units that do not know HTTP. These units are:
  - `trace_sql`: every statement, as a pure function.
  - `trace_filters`, `trace_search`, `trace_analytics`, `trace_services`, `trace_facets`, `trace_detail` and `trace_spans`.
  - `trace_budget`: the bounds of a route.
- They send their statements through a `ChExecutor` (`src/ch_executor.hpp`).
- So `tests/native/trace_test.cpp` runs them on a fake executor.
- When you change a statement, change the text that the test expects in the same commit.
- `tests/native/trace_golden.hpp` holds the text that the code wrote before the split.
- The routes of Logs (`src/api_logs.cpp`), Metrics (`api_metrics.cpp`) and System (`api_system.cpp`, `api_system_activity.cpp`) are adapters of the same kind.
- `logs_request`, `metrics_request` and `system_request` parse a request.
- `logs_sql`, `logs_filters`, `metrics_sql` and the System section units (`system_overview`, `system_series`, `system_queries`, `system_disks`, `system_activity`) hold the statements.
- `LogsService`, `MetricsService` and `SystemService` read through a `ChExecutor`. `logs_json`, `metrics_json` and `system_json` write the answer.
- `tests/native/logs_test.cpp`, `metrics_test.cpp` and `system_monitor_test.cpp` run them on a fake executor. They compare the statements with the text that a build sent (`logs_golden.hpp`, `metrics_golden.hpp`).
- Pass each user value (a service, an attribute, a search term, an id) to ClickHouse as a query parameter. Do not put it in the SQL text.
- Use `SqlParams` (`src/sql_params.hpp`).
- `params.text(value)` gives `{pN:String}`.
- `params.texts(values)` gives the inside of an `IN (...)`.
- Pass `params.list()` with the statement to `ch_select` or `bounded_select`.
- A cache that is keyed by the SQL text must add `params.key()`.
- Do not use an `Array(String)` parameter for such a value. Its text has the quoting rules of ClickHouse, which differ between versions.
- A name of a column or a table is a quoted identifier (`sql::quote_ident`), not a parameter.
- Keep the code and the documentation in English.
- Do not reformat unrelated files.
- Prefer minimal patches to broad rewrites.

## Commit and pull request guidelines

- Use clear commit messages.
- Describe the problem, the change and the impact.
- Include screenshots for UI changes when they are relevant.
- Mention any follow-up work explicitly.

## Security

Do not report security issues in public issues. Follow `SECURITY.md` instead.
