#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
import traceback
import zipfile
from pathlib import Path

ROOT = Path('/tests')
FRONTEND = Path('/work/frontend')
ARTIFACTS_ROOT = Path(os.environ.get('TEST_ARTIFACTS_ROOT', '/artifacts'))
RUN_ROOT = ARTIFACTS_ROOT / 'test-run'
ZIP_PATH = ARTIFACTS_ROOT / 'chdash-test-review.zip'


def utc_now() -> str:
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def run_phase(name: str, command: list[str], *, cwd: Path, env: dict[str, str], output_dir: Path) -> dict:
    output_dir.mkdir(parents=True, exist_ok=True)
    log_path = output_dir / 'run.log'
    started = time.perf_counter()
    print(f'\n=== {name} ===', flush=True)
    print('$ ' + ' '.join(command), flush=True)
    with log_path.open('w', encoding='utf-8') as log:
        log.write('$ ' + ' '.join(command) + '\n')
        log.flush()
        proc = subprocess.Popen(
            command,
            cwd=str(cwd),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding='utf-8',
            errors='replace',
        )
        assert proc.stdout is not None
        for line in proc.stdout:
            sys.stdout.write(line)
            log.write(line)
        rc = proc.wait()
    elapsed = round(time.perf_counter() - started, 3)
    status = {
        'name': name,
        'success': rc == 0,
        'exit_code': rc,
        'duration_seconds': elapsed,
        'log': f'{output_dir.name}/run.log',
    }
    (output_dir / 'status.json').write_text(json.dumps(status, indent=2, sort_keys=True), encoding='utf-8')
    return status



def split_sql_script(text: str) -> list[str]:
    statements: list[str] = []
    current: list[str] = []
    quote: str | None = None
    line_comment = False
    block_comment = False
    i = 0
    while i < len(text):
        ch = text[i]
        nxt = text[i + 1] if i + 1 < len(text) else ""
        if line_comment:
            current.append(ch)
            if ch == "\n":
                line_comment = False
            i += 1
            continue
        if block_comment:
            current.append(ch)
            if ch == "*" and nxt == "/":
                current.append(nxt)
                block_comment = False
                i += 2
                continue
            i += 1
            continue
        if quote:
            current.append(ch)
            if ch == "\\" and quote in ("'", '"') and i + 1 < len(text):
                current.append(text[i + 1])
                i += 2
                continue
            if ch == quote:
                if i + 1 < len(text) and text[i + 1] == quote:
                    current.append(text[i + 1])
                    i += 2
                    continue
                quote = None
            i += 1
            continue
        if ch == "-" and nxt == "-":
            current.extend((ch, nxt))
            line_comment = True
            i += 2
            continue
        if ch == "/" and nxt == "*":
            current.extend((ch, nxt))
            block_comment = True
            i += 2
            continue
        if ch in ("'", '"', "`"):
            quote = ch
            current.append(ch)
            i += 1
            continue
        if ch == ";":
            statement = "".join(current).strip()
            if statement:
                statements.append(statement)
            current = []
            i += 1
            continue
        current.append(ch)
        i += 1
    tail = "".join(current).strip()
    if tail:
        statements.append(tail)
    return statements


def reset_clickhouse_fixtures(env: dict[str, str]) -> None:
    import requests

    base = env.get("CLICKHOUSE_URL", "http://clickhouse:8123").rstrip("/")
    user = env.get("CLICKHOUSE_USER", "test")
    password = env.get("CLICKHOUSE_PASSWORD", "test")
    fixture_root = Path("/repo/tests/clickhouse-init")
    scripts = [fixture_root / "01-chdash-users.sql", fixture_root / "02-frontend-fixtures.sql"]
    print("\n=== fixture-reset ===", flush=True)
    for script in scripts:
        if not script.is_file():
            raise RuntimeError(f"Missing ClickHouse fixture script: {script}")
        statements = split_sql_script(script.read_text(encoding="utf-8"))
        for index, sql in enumerate(statements, start=1):
            response = requests.post(
                base + "/",
                data=sql.encode("utf-8"),
                auth=(user, password),
                timeout=30,
                headers={"Content-Type": "text/plain; charset=utf-8"},
            )
            if response.status_code >= 400:
                detail = response.text.strip()
                raise RuntimeError(
                    f"Fixture {script.name} statement {index}/{len(statements)} failed "
                    f"with HTTP {response.status_code}: {detail}\nSQL:\n{sql}"
                )
        print(f"[fixtures] {script.name}: {len(statements)} statements applied", flush=True)

    system_user = env.get("CHDASH_SYSTEM_USER", "chdash_system")
    system_password = env.get("CHDASH_SYSTEM_PASSWORD", "system_test")

    def check_grant_as(user_name: str, user_password: str, grant: str, expected: str) -> None:
        response = requests.post(
            base + "/", data=("CHECK GRANT " + grant).encode("utf-8"),
            auth=(user_name, user_password), timeout=15,
        )
        actual = response.text.strip()
        if response.status_code >= 400 or actual != expected:
            raise RuntimeError(
                f"Fixture security boundary mismatch for {user_name}: CHECK GRANT {grant} "
                f"expected {expected}, got HTTP {response.status_code} {actual!r}"
            )

    runner_user = env.get("CHDASH_RUNNER_USER", "chdash_runner")
    runner_password = env.get("CHDASH_RUNNER_PASSWORD", "runner_test")
    check_grant_as(runner_user, runner_password, "KILL QUERY ON *.*", "0")
    check_grant_as(system_user, system_password, "KILL QUERY ON *.*", "1")
    check_grant_as(system_user, system_password, "SYSTEM FLUSH LOGS ON *.*", "1")
    check_grant_as(system_user, system_password, "SHOW TABLES ON *.*", "1")
    check_grant_as(system_user, system_password, "SHOW COLUMNS ON *.*", "1")
    check_grant_as(system_user, system_password, "SHOW DICTIONARIES ON *.*", "1")

    flush = requests.post(base + "/", data=b"SYSTEM FLUSH LOGS", auth=(system_user, system_password), timeout=15)
    if flush.status_code >= 400:
        raise RuntimeError(f"SYSTEM FLUSH LOGS failed after fixture reset: {flush.text.strip()}")

def build_archive(manifest: dict) -> None:
    ZIP_PATH.unlink(missing_ok=True)
    with zipfile.ZipFile(ZIP_PATH, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for path in sorted(RUN_ROOT.rglob('*')):
            if path.is_file():
                archive.write(path, Path('chdash-test-review') / path.relative_to(RUN_ROOT))
    print(f'\nArchive: {ZIP_PATH}', flush=True)


def main() -> int:
    shutil.rmtree(RUN_ROOT, ignore_errors=True)
    RUN_ROOT.mkdir(parents=True, exist_ok=True)
    ZIP_PATH.unlink(missing_ok=True)

    base_env = os.environ.copy()
    reset_clickhouse_fixtures(base_env)
    statuses: dict[str, dict] = {}

    backend_dir = RUN_ROOT / 'backend-functional'
    backend_env = base_env.copy()
    backend_env['TEST_ARTIFACTS_DIR'] = str(backend_dir)
    backend_env['TEST_REPOSITORY_ROOT'] = '/repo'
    statuses['backend_functional'] = run_phase(
        'backend-functional',
        [
            sys.executable, '-m', 'pytest', '-q',
            str(ROOT / 'api' / 'format' / 'check_format.py'),
            str(ROOT / 'api' / 'query_types' / 'check_query_types.py'),
            str(ROOT / 'backend-functional' / 'test_routes.py'),
            '/repo/tests/harness',
            '--junitxml', str(backend_dir / 'junit.xml'),
        ],
        cwd=ROOT,
        env=backend_env,
        output_dir=backend_dir,
    )

    frontend_functional_dir = RUN_ROOT / 'frontend-functional'
    ff_env = base_env.copy()
    ff_env['FRONTEND_ARTIFACTS_DIR'] = str(frontend_functional_dir)
    statuses['frontend_functional'] = run_phase(
        'frontend-functional',
        ['npx', 'playwright', 'test', 'specs/functional.spec.js', '--project=desktop-1440'],
        cwd=FRONTEND,
        env=ff_env,
        output_dir=frontend_functional_dir,
    )

    performance_dir = RUN_ROOT / 'performance'
    perf_env = base_env.copy()
    perf_env['PERF_ARTIFACTS_DIR'] = str(performance_dir)
    statuses['performance'] = run_phase(
        'performance',
        [sys.executable, str(ROOT / 'performance' / 'run.py')],
        cwd=ROOT,
        env=perf_env,
        output_dir=performance_dir,
    )

    design_dir = RUN_ROOT / 'design'
    design_env = base_env.copy()
    design_env['FRONTEND_ARTIFACTS_DIR'] = str(design_dir)
    design_cmd = [
        'npx', 'playwright', 'test',
        'specs/design.spec.js',
        'specs/accessibility.spec.js',
        'specs/visual-regression.spec.js',
    ]
    statuses['design'] = run_phase(
        'design', design_cmd, cwd=FRONTEND, env=design_env, output_dir=design_dir
    )
    # The design report is generated even when a capture failed, so the archive
    # remains useful for diagnosing the failure.
    report_proc = subprocess.run(
        ['node', './scripts/build-report.mjs'], cwd=str(FRONTEND), env=design_env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding='utf-8', errors='replace'
    )
    (design_dir / 'report-build.log').write_text(report_proc.stdout, encoding='utf-8')
    if report_proc.returncode != 0:
        statuses['design']['success'] = False
        statuses['design']['report_exit_code'] = report_proc.returncode
        (design_dir / 'status.json').write_text(json.dumps(statuses['design'], indent=2, sort_keys=True), encoding='utf-8')

    perf_actual = {}
    try:
        perf_actual = json.loads((performance_dir / 'actual.json').read_text(encoding='utf-8'))
    except Exception:
        pass

    overall = all(bool(status.get('success')) for status in statuses.values())
    manifest = {
        'schema_version': 2,
        'generated_at': utc_now(),
        'success': overall,
        'test_model': 'single one-shot Docker container',
        'categories': {
            'backend-functional': statuses['backend_functional'],
            'frontend-functional': statuses['frontend_functional'],
            'performance': {
                **statuses['performance'],
                'expected_baseline_configured': bool(perf_actual.get('expected_baseline_configured')),
            },
            'design': statuses['design'],
        },
        'archive_layout': {
            'backend-functional': 'backend-functional/',
            'frontend-functional': 'frontend-functional/',
            'performance': 'performance/',
            'design': 'design/',
        },
        'analysis_hint': 'Upload this ZIP for separate backend functional, frontend functional, performance and design review.',
    }
    (RUN_ROOT / 'manifest.json').write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding='utf-8')
    readme = f'''# ChDash test review\n\nGenerated: {manifest['generated_at']}\n\nOverall success: **{overall}**\n\nThe archive contains exactly four test categories:\n\n- `backend-functional/`: query formatting and live API route/function flows.\n- `frontend-functional/`: Playwright interaction/functionality tests at the canonical desktop viewport.\n- `performance/`: hardcoded SELECT/DDL/INSERT scenarios and their timings. `expected.json` contains the approved first-run performance envelope.\n- `design/`: multi-viewport screenshots, layout heuristics and accessibility findings.\n\nThe Docker test runner has no web UI and exits after this archive is produced.\n'''
    (RUN_ROOT / 'README.md').write_text(readme, encoding='utf-8')
    build_archive(manifest)

    print(json.dumps(manifest, indent=2, sort_keys=True), flush=True)
    return 0 if overall else 1


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception:
        RUN_ROOT.mkdir(parents=True, exist_ok=True)
        (RUN_ROOT / 'orchestrator-error.log').write_text(traceback.format_exc(), encoding='utf-8')
        emergency = {
            'schema_version': 2,
            'generated_at': utc_now(),
            'success': False,
            'orchestrator_error': traceback.format_exc().splitlines()[-1] if traceback.format_exc() else 'unknown',
        }
        (RUN_ROOT / 'manifest.json').write_text(json.dumps(emergency, indent=2), encoding='utf-8')
        try:
            build_archive(emergency)
        finally:
            print(traceback.format_exc(), file=sys.stderr)
        raise SystemExit(1)
