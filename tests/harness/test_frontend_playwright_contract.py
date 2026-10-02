from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def test_playwright_lives_inside_the_single_test_container():
    compose = read("tests/docker-compose.yml")
    dockerfile = read("tests/Dockerfile.tests")
    package = read("tests/frontend/package.json")
    assert "  tests:" in compose
    assert "frontend_tests:" not in compose
    assert '"@playwright/test": "1.62.1"' in package
    assert '"@axe-core/playwright": "4.13.0"' in package
    assert "mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e" in dockerfile
    assert "npm install --no-audit --no-fund" in dockerfile


def test_frontend_functional_and_design_are_separate_playwright_suites():
    functional = read("tests/frontend/specs/functional.spec.js")
    design = read("tests/frontend/specs/design.spec.js")
    a11y = read("tests/frontend/specs/accessibility.spec.js")
    review = read("tests/frontend/helpers/review.js")
    assert "captureState" not in functional
    assert "query execution renders rows" in functional
    assert "profiling auto-opens Pipeline and lazily mounts Tracing" in functional
    assert "explorer opens fixture" in functional
    assert "captureState" in design
    assert "query-results" in design
    assert "explorer-table-columns" in design
    for popup_state in [
        "query-run-menu",
        "editor-options-menu",
        "autocomplete-suggestions",
        "theme-menu",
        "results-copy-menu",
        "query-library",
        "analysis-pipeline",
        "analysis-trace",
        "explorer-table-columns",
        "explorer-table-preview",
        "explorer-table-ddl",
        "explorer-table-lineage",
        "explorer-table-storage",
        "explorer-table-operations",
        "explorer-graph-lineage",
        "explorer-graph-storage-topology",
        "explorer-function-markdown",
        "explorer-database-detail",
        "explorer-dictionary-overview",
        "query-library-history",
        "query-normal-no-analysis",
        "query-results-light",
    ]:
        assert popup_state in design
    assert "normal runs do not expose Analyze" in design
    assert "editor.focus()" in design
    assert "AxeBuilder" in a11y
    assert "horizontalOverflow" in review
    assert "clippedText" in review
    assert "smallControls" in review
    assert "overlappingControls" in review


def test_design_covers_three_desktop_viewports_and_visual_baseline_remains_opt_in():
    config = read("tests/frontend/playwright.config.js")
    visual = read("tests/frontend/specs/visual-regression.spec.js")
    for size in ["1920, height: 1080", "1440, height: 900", "1280, height: 800"]:
        assert size in config
    assert "VISUAL_COMPARE" in visual
    assert "toHaveScreenshot" in visual


def test_ci_collects_single_combined_test_review_artifact():
    ci = read(".github/workflows/ci.yml")
    assert "--exit-code-from tests" in ci
    assert "tests/artifacts/chdash-test-review.zip" in ci
    assert "name: chdash-test-review" in ci


def test_fast_default_keeps_a_full_mode_and_a_shared_host_mode():
    config = read("tests/frontend/playwright.config.js")
    runner = read("tests/test-suite/run-all-tests.py")
    readme = read("tests/README.md")
    # Layout specs on every viewport, behavioural specs on desktop-1440, everything
    # everywhere with PW_ALL_PROJECTS=1; timing budgets last, one at a time, and
    # out of shared-host runs.
    assert "PW_ALL_PROJECTS === '1'" in config and "PW_SHARED_HOST === '1'" in config
    assert "const CANONICAL = 'desktop-1440';" in config
    for spec in ["accessibility", "design", "explorer-nav", "obs-filterbar", "page-chrome", "'ui-*'", "visual-regression"]:
        assert spec in config
    assert "grep: PERF_TITLES, workers: 1" in config
    assert "retryStrategy: 'isolated'" in config
    assert "'on-first-retry'" in config and "screenshot: 'only-on-failure'" in config
    # The runner stays the full official suite (every test on every viewport its
    # phases select) unless asked for --quick, which still runs every test once.
    assert "'--quick' in sys.argv[1:]" in runner
    assert "base_env['PW_ALL_PROJECTS'] = '1'" in runner
    assert "PW_SHARED_HOST" not in runner
    assert "'--project=desktop-1440'" in runner
    assert "backend_env['CHDASH_FIXTURES_FRESH'] = '1'" in runner
    assert (ROOT / "tests/tools/pw-changed.sh").is_file()
    assert "## Running tests quickly" in readme and "PW_ALL_PROJECTS=1" in readme
