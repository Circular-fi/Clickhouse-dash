# Contributing

Thanks for contributing to `clickhouse-dash`.

## Before you open a pull request

- Open an issue first for large changes, architectural changes, or UX changes.
- Keep diffs focused and avoid unrelated refactors.
- Update tests and documentation when behavior changes.
- Prefer incremental PRs that are easy to review.

## Development

### Prerequisites

- Docker and Docker Compose
- Or: CMake >= 3.20, Ninja, and a C++17 compiler
- Python 3.12 if you want to run the API tests outside Docker

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

Details in `tests/README.md`, "Running tests quickly".

- `tests/tools/pw-changed.sh` runs the Playwright specs of the files you changed, on `desktop-1440`, with `PW_SHARED_HOST=1` (one worker, no timing-budget tests).
- A plain `npx playwright test` runs the layout specs on three viewports and the behavioural specs on `desktop-1440`; `PW_ALL_PROJECTS=1` runs everything on every viewport before a release.
- `run-all-tests.py --quick` runs every test at least once: the design phase on one viewport, the other phases unchanged; without `--quick` it is the full official suite.
- On a shared host: one Playwright run at a time, changed specs first, the full run once at the end, no `sleep` polling loops, and pytest without `CLICKHOUSE_URL`.

### Validate release builds

The release workflow builds Linux amd64/arm64 and macOS amd64/arm64 in isolated CMake directories with bounded parallelism. When a matrix build fails, download its `build-diagnostics-*` artifact and inspect `build.log` and `CMakeCache.txt`. Do not cache or reuse a platform-specific `CMakeCache.txt` across runners.

## Coding guidelines

- Backend code is C++17.
- Frontend code is vanilla JavaScript.
- Styles live in `src/static/css/` (docs/ui-foundations.md, "Stylesheets"): `00-tokens.css` (custom properties), `01-base.css`, `10-components/<component>.css`, `20-features/<feature>.css` and `30-overrides.css`, imported into the cascade layers `tokens, base, components, features, overrides` by `src/static/css/index.css`. Write a selector list once per layer: add declarations to its rule rather than a second rule. A colour literal goes in `00-tokens.css` as a token, and a font size, weight or family, a radius, a shadow, a duration or a z-index names the scales there (docs/ui-foundations.md, "Type, shape, motion and stacking"); `!important` only on the allow-list of `tests/harness/test_css_layers_contract.py`.
- Each page loads a generated `style.<page>.css`, the rules of the sources that can match on it. They are build outputs (CMake and the Docker images run `tools/build_page_css.py`), never committed: to serve `src/static` from the file system, run `python3 tools/build_page_css.py` once (its output is ignored). `python3 tools/build_page_css.py --report-dead` lists the selectors no page can match.
- A page's script modules are listed in `src/static/modules.json` (shared helpers and UI components in `common`); the page header lives in `src/shell/header.html`. After editing either, run `python3 tools/build_page_css.py`: it writes the generated `shell:header` and `shell:scripts` regions of the page shells, then the stylesheets.
- The embedded build stages `src/static` once more (`tools/stage_static.py`): scripts and stylesheets are addressed `?v=<content hash>` (the shells carry the map in `window.__chdashAssetVersions`, `ns.loader.url` and `window.__chdashUrl` read it) and served immutable, and text files get a `.gz` copy the server sends to clients that accept gzip. Load scripts through `ns.loader` or `window.__chdashUrl` so they take part; a hard-coded `static/x.js` still works but revalidates on every load.
- Keep `src/static/*.js` and the stylesheet sources Latin-1: write `"…"` in JavaScript and `"\2026"` in CSS rather than the character, so Chrome stores the sources one byte per character.
- Keep code and docs in English.
- Do not reformat unrelated files.
- Prefer minimal patches over broad rewrites.

## Commit and pull request guidelines

- Use clear commit messages.
- Describe the problem, the change, and the impact.
- Include screenshots for UI changes when relevant.
- Mention any follow-up work explicitly.

## Security

Please do not report security issues in public issues. Follow `SECURITY.md` instead.
