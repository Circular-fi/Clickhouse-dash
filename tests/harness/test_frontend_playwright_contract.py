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
    assert "profiling auto-opens a compact Jaeger-style wall-clock trace" in functional
    assert "explorer opens fixture" in functional
    assert "captureState" in design
    assert "query-results" in design
    assert "explorer-table-overview" in design
    for popup_state in [
        "query-run-menu",
        "editor-options-menu",
        "autocomplete-suggestions",
        "theme-menu",
        "results-copy-menu",
        "query-library",
        "analysis-trace",
        "explorer-table-overview",
        "explorer-table-overview-schema",
        "explorer-table-data",
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
