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
