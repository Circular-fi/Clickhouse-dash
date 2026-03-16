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
cd test
docker compose up --build
```

### Local build

```bash
cmake -S src -B build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build build --target chdash
./build/chdash
```

### Run tests

```bash
cd test
docker compose up --build --abort-on-container-exit --exit-code-from api-tests
```

## Coding guidelines

- Backend code is C++17.
- Frontend code is vanilla JavaScript.
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
