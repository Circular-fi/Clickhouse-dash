# Contributing

Thank you for your contribution to `clickhouse-dash`.

## Before you open a pull request

- Open an issue first for large changes, architectural changes or UX changes.
- Keep the diffs focused. Do not do unrelated refactors.
- Update the tests and the documentation when the behavior changes.
- Make incremental PRs that are easy to review.

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

### Running tests quickly

Refer to `tests/README.md`, "Running tests quickly", for the details.

- `tests/tools/pw-changed.sh` runs the Playwright specs of the files that you changed. It uses `desktop-1440` and `PW_SHARED_HOST=1` (one worker, no timing-budget tests).
- A plain `npx playwright test` runs the layout specs on three viewports. It runs the behavioral specs on `desktop-1440`. `PW_ALL_PROJECTS=1` runs everything on every viewport before a release.
- `run-all-tests.py --quick` runs every test at least once. It runs the design phase on one viewport and does not change the other phases. Without `--quick`, it is the full official suite.
- On a shared host, follow these rules: run one Playwright run at a time, run the changed specs first, and run the full run once at the end. Do not use `sleep` polling loops. Run pytest without `CLICKHOUSE_URL`.

### Validate release builds

The release workflow builds Linux amd64/arm64 and macOS amd64/arm64. It uses isolated CMake directories and bounded parallelism. If a matrix build fails, download its `build-diagnostics-*` artifact. Then examine `build.log` and `CMakeCache.txt`. Do not cache a `CMakeCache.txt` of one platform. Do not reuse it across runners.

The release chain follows these rules:

- The release runs the CI workflow (`ci.yml`) on the commit that it builds. The build starts only when the tests pass.
- Each action has a pin to a commit SHA, with the version in a comment. Dependabot updates the pins.
- No release job restores a cache. Each checkout uses `persist-credentials: false`.
- Only the publish job can write to the repository. It runs in the `release` environment. Set a required reviewer for this environment in the repository settings. The `gh` CLI publishes the release. No third-party action gets the write token.
- A manual run (`workflow_dispatch`) creates the tag after the build, on the tested commit. If the tag exists, it must point to that commit.
- The publish job makes a build provenance attestation for each archive (`SECURITY.md`, "Verify a release").
- Each binary runs the smoke test (`tests/smoke/release_smoke.py`), on Linux and on macOS.
- A Linux binary is a static position independent executable (static-pie) with the stack protector and full RELRO. `tests/smoke/check_release_binary.sh` checks this before the strip.

The dependencies of the build have pins too:

- `src/CMakeLists.txt` fetches clickhouse-cpp, cpp-httplib and rapidjson by commit SHA. Dependabot does not read CMake: update a SHA and its comment by hand. `src/PatchRapidJSON.cmake` patches rapidjson for each toolchain.
- `tests/smoke/Dockerfile.release` checks the SHA-256 of the Zig archive. The release workflow uses `mlugg/setup-zig`, which checks the minisign signature of Zig. A new Zig version needs new sums.
- `tests/requirements.txt` holds the hash of each Python test package (`pip install --require-hashes`). Generate it from `tests/requirements.in` with the command in its header.
- `tests/frontend/package-lock.json` pins the npm packages. The test image installs them with `npm ci`.

### Hardening

`-DCHDASH_HARDEN=ON` (the default, off with a sanitizer) adds these flags to all code, the dependencies too: `-fstack-protector-strong`, `-fstack-clash-protection`, `-ftrivial-auto-var-init=zero`, and `-D_FORTIFY_SOURCE=3` in an optimized build. It also turns on the cheap checks of the standard library: the hardened mode of libc++ 18 or later (the Linux release build) or `_GLIBCXX_ASSERTIONS` (libstdc++, the test images). The build tests each flag first and skips a flag that the compiler does not know.

Some protections are not available in the release build:

- musl has no fortified functions, so `_FORTIFY_SOURCE` has no effect in the Linux release binary. The test image (Alpine `fortify-headers`) and the macOS build use it.
- The release build does not use `-fcf-protection`: musl does not turn on the control-flow protection (CET) of the CPU.

The Linux release binary is static-pie (the kernel loads it at a random address), with full RELRO (`BIND_NOW`) and a stack that is not executable. `tests/smoke/check_release_binary.sh` checks these properties.

### Compiler warnings

The build enables `-Wall`, `-Wextra` and `-Wdangling-reference` (GCC 13 and later) for our sources. The dependencies (clickhouse-cpp, cpp-httplib, rapidjson) do not get these flags. The file `src/BuildFlags.cmake` holds them.

- `-DCHDASH_WERROR=ON` makes each warning an error. The test image (`tests/Dockerfile.source`) and the CI jobs turn it on. The release build leaves it off, so that a new compiler cannot stop a release.
- Fix a warning in the code.
- To silence a false positive, put `#pragma GCC diagnostic ignored "-W<name>"` between `push` and `pop` around the line. Write the reason in a comment. Do not turn a warning off for a whole target.
- A new C++ file needs no change. A new target needs `chdash_configure_target(<target>)` in `src/CMakeLists.txt`.

### Dangling captures in route handlers

A route handler lives longer than the `Server` constructor. A handler that captures `[&]` and uses a local variable or a local lambda of the constructor reads a destroyed object. Version 2.16.3 had this bug: `/observability` answered 404 in the release build only.

No compiler warning finds this bug. GCC `-Wdangling-reference`, clang `-Wdangling` and clang-tidy do not report it. These tools find it:

- `python3 tools/check_handler_captures.py src/server.cpp` finds every `[&]` lambda that uses a local of the constructor. Fix it with `[&, name]` (a copy) or call a member function. CI runs this script.
- The sanitizer build (below) reports it as `stack-use-after-return` when a test calls the route.
- The release smoke test (below) fails on it.

### clang-tidy

`.clang-tidy` lists the checks: `bugprone-*`, `clang-analyzer-*`, `concurrency-mt-unsafe` (a libc function that is not thread safe, such as `strerror`: use `std::generic_category().message(errno)`), a few `cppcoreguidelines-*` and `performance-*` checks. Each check that is off has a reason in the file. A finding is an error.

```bash
tests/tools/clang-tidy.sh                    # all of src/*.cpp, in Docker (about 10 minutes)
tests/tools/clang-tidy.sh src/api_logs.cpp   # some files
```

Fix a finding in the code. To silence one line, write `// NOLINT(<check>)` and the reason. The `clang-tidy.yml` workflow runs on each pull request. It checks only the changed `.cpp` files, unless a header, a build file or `.clang-tidy` changes.

### Sanitizers

`-DCHDASH_SANITIZE=address,undefined` builds with AddressSanitizer and UndefinedBehaviorSanitizer. AddressSanitizer covers the dependencies. UndefinedBehaviorSanitizer covers our code only. A finding of UndefinedBehaviorSanitizer stops the process. SIGTERM ends every build of the server cleanly, so with `address` LeakSanitizer reports leaks at exit.

```bash
tests/tools/sanitize.sh native     # the native unit tests
tests/tools/sanitize.sh backend    # tests/backend-functional and tests/harness on the sanitized server
tests/tools/sanitize.sh frontend   # five Playwright specs on the sanitized server
tests/tools/sanitize.sh load       # a concurrent load on the sanitized server (tests/sanitize/load.py)
tests/tools/sanitize.sh all        # the four above
```

`-DCHDASH_SANITIZE=thread` builds with ThreadSanitizer. It cannot go with AddressSanitizer, so it is a separate build. Set `CHDASH_SANITIZE=thread` for the script:

```bash
CHDASH_SANITIZE=thread tests/tools/sanitize.sh native   # the native unit tests under ThreadSanitizer
CHDASH_SANITIZE=thread tests/tools/sanitize.sh backend  # the backend tests on the ThreadSanitizer server
CHDASH_SANITIZE=thread tests/tools/sanitize.sh load     # many clients at the same time: the races show here
```

The `backend` and `frontend` commands need the test ClickHouse stack (`docker compose -f tests/docker-compose.yml --profile otel up -d clickhouse clickhouse_replica otel_fixture`). The server log stays in `/tmp/chdash-sanitize-logs/server.log`. The `sanitize.yml` workflow runs all three on each pull request, every night and on request. `tests/README.md`, "Sanitizers", has the details.

To accept a leak or a finding that is not ours, add it to `tests/sanitize/lsan.supp` (or `tests/sanitize/tsan.supp` for a race) with a comment that says why. Fix our own findings in the code.

### Fuzzing

`tests/fuzz` holds libFuzzer targets for the code that reads untrusted text: the JSON parse of a request body, the SQL formatter, the SQL policy of the Query page (`KILL QUERY`), the SQL checks of the MCP tools, the HCL parser and the WebAssembly kernels (built natively). `-DCHDASH_BUILD_FUZZERS=ON` builds them with clang, AddressSanitizer and UndefinedBehaviorSanitizer.

```bash
tests/tools/fuzz.sh                  # every target, 60 s each
tests/tools/fuzz.sh 600 format hcl   # two targets, 600 s each
tests/tools/fuzz.sh list             # the names of the targets
```

A finding is a file `crash-*`, `leak-*`, `timeout-*` or `oom-*` in `/tmp/chdash-fuzz/<target>/`. Fix the code, then add the input to `tests/fuzz/corpus/<target>/` so that the next runs start from it. The `sanitize.yml` workflow runs every target for one minute. `tests/README.md`, "Fuzzing", has the details.

### Release smoke test

The test image is not the shipped binary. The release binary is static, stripped and optimized, and it serves the embedded files. `tests/smoke/release_smoke.py` starts a binary with every page enabled and a ClickHouse host that does not exist. It probes the routes that must answer.

```bash
docker build -f tests/smoke/Dockerfile.release --target binary --output type=local,dest=out .
python3 tests/smoke/release_smoke.py --binary out/chdash            # run it as a process
python3 tests/smoke/release_smoke.py --binary out/chdash --scratch  # run it in a FROM scratch container
```

The Dockerfile builds the binary like `.github/workflows/release.yaml` does (Zig, musl, static-pie, hardened). The release workflow runs the script on each binary before it publishes. The `release-smoke.yml` workflow runs it on each pull request.

The backend tests can also run against the release binary:

```bash
tests/tools/release-backend.sh   # tests/backend-functional on the release binary in a FROM scratch container
```

It needs the test ClickHouse stack, like `tests/tools/sanitize.sh backend`. The `release-smoke.yml` workflow runs it on each pull request.

## Coding guidelines

- Backend code is C++17.
- Frontend code is vanilla JavaScript.
- Styles are in `src/static/css/` (docs/ui-foundations.md, "Stylesheets"). The files are `00-tokens.css` (custom properties), `01-base.css`, `10-components/<component>.css`, `20-features/<feature>.css` and `30-overrides.css`. `src/static/css/index.css` imports them into the cascade layers `tokens, base, components, features, overrides`. Write a selector list once in each layer. Add declarations to its rule. Do not add a second rule. Put a color literal in `00-tokens.css` as a token. Use the scales in `00-tokens.css` for these values (docs/ui-foundations.md, "Type, shape, motion and stacking"): a font size, a weight, a family, a radius, a shadow, a duration and a z-index. Use `!important` only for the allow-list of `tests/harness/test_css_layers_contract.py`.
- Each page loads a generated `style.<page>.css`. It has the rules of the sources that can match on that page. They are build outputs. CMake and the Docker images run `tools/build_page_css.py` to create them. Do not commit them. To serve `src/static` from the file system, run `python3 tools/build_page_css.py` once (git ignores its output). `python3 tools/build_page_css.py --report-dead` lists the selectors that no page can match.
- `src/static/modules.json` lists the script modules of a page (shared helpers and UI components are in `common`). The page header is in `src/shell/header.html`. After you edit one of them, run `python3 tools/build_page_css.py`. It writes the generated `shell:header` and `shell:scripts` regions of the page shells. Then it writes the stylesheets.
- The embedded build stages `src/static` one more time (`tools/stage_static.py`). The scripts and stylesheets are addressed as `?v=<content hash>`. The shells carry the map in `window.__chdashAssetVersions`, and `ns.loader.url` and `window.__chdashUrl` read it. The server sends these files as immutable. The text files get a `.gz` copy. The server sends this copy to the clients that accept gzip. Load the scripts through `ns.loader` or `window.__chdashUrl`, so that they take part. A hard-coded `static/x.js` still works, but the browser revalidates it on every load.
- The WebAssembly kernels are C files in `src/wasm/`. The built files are in `src/static/wasm/`. They are committed. After you edit a C file or a header of `src/wasm/`, run `python3 tools/build_wasm.py --docker`. It needs Docker and builds with `clang` 18 in a container. Commit the C file, the `.wasm` file and `src/wasm/wasm.lock.json` together. `python3 tools/build_wasm.py --check` proves that the committed files match a fresh build. A kernel keeps its JavaScript reference. docs/wasm.md has the rules.
- Keep `src/static/*.js` and the stylesheet sources in Latin-1. Write `"…"` in JavaScript and `"\2026"` in CSS. Do not write the character. In this way, Chrome stores the sources with one byte for each character.
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
