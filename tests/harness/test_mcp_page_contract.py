import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
STATIC = ROOT / "src" / "static"
MCP_MODULES = ("app_mcp_page.js", "app_mcp_view.js", "app_mcp_form.js")


def read(rel):
    return (ROOT / rel).read_text(encoding="utf-8")


def code(rel):
    """A script without its comment lines."""
    return re.sub(r"^\s*//.*$", "", read(rel), flags=re.M)


def test_the_mcp_page_is_its_own_shell_filed_as_its_own_switcher_entry():
    html = read("src/static/mcp.html")
    assert '<body data-page="mcp">' in html
    assert "static/style.mcp.css" in html
    assert html.count("<h1") == 1 and 'class="mcpPage__title">MCP integration</h1>' in html
    assert '<main id="mcpWorkspace" class="mcpWorkspace" role="main">' in html
    assert 'id="mcpHead"' in html and 'id="mcpKeys"' in html
    assert html.count('<header class="appHeader" role="banner">') == 1
    # MCP is its own entry: selected and visible here, hidden in every other shell until /api/version enables it.
    assert 'id="navMcpButton" class="themeSelect__option" type="button" role="option" data-value="mcp" aria-selected="true">MCP</button>' in html
    assert 'id="navSystemButton" class="themeSelect__option" type="button" role="option" data-value="system" aria-selected="false"' in html
    for other in ("query", "explorer", "functions", "traces", "logs", "metrics", "trace", "system", "queries", "disks", "shape"):
        page = read(f"src/static/{other}.html")
        assert 'id="navMcpButton" class="themeSelect__option" type="button" role="option" data-value="mcp" aria-selected="false" hidden>MCP</button>' in page, other
    partial = read("src/shell/header.html")
    assert '{{mcp.hidden}}>MCP</button>' in partial and '{{selected.mcp}}' in partial
    # The page route is the shell's: no data and no address state of its own.
    assert "/mcp-integration" in html.split("<body")[0]


def test_the_page_registers_in_the_shell_and_stylesheet_builders():
    shells = read("tools/page_shells.py")
    assert '"mcp": "MCP"' in shells and '"{{mcp.hidden}}": "" if nav == "mcp" else " hidden",' in shells
    assert '"mcp"' not in re.search(r"NAV_PAGE = \{.*?\}", shells).group(0)
    assert '"shape", "mcp")' in read("tools/build_page_css.py")
    index = read("src/static/css/index.css")
    assert 'url("20-features/mcp.css") layer(features)' in index
    data = json.loads(read("src/static/modules.json"))
    page = data["pages"]["mcp"]
    assert page["bootstrap"] == "app_mcp_page.js"
    assert page["modules"] == ["app_api.js", "app_ui_dialog.js", "app_ui.js", "app_mcp_view.js", "app_mcp_form.js"]
    # None of the other pages' modules: the page is not tied to a host and draws no chart, table of data or editor.
    for name in ("app_explorer.js", "app_sql.js", "app_chart_core.js", "app_ui_filterbar.js", "app_system_view.js", "app_traces.js"):
        assert name not in page["modules"], name
    for name in MCP_MODULES:
        assert name not in json.dumps({key: value for key, value in data["pages"].items() if key != "mcp"}), name


def test_the_switcher_follows_features_mcp():
    ui = read("src/static/app_ui.js")
    state = read("src/static/app_state.js")
    assert 'const mcpEnabled = nav.mcp === true;' in ui
    assert "if (dom.navMcpButton) dom.navMcpButton.hidden = !mcpEnabled;" in ui
    assert 'const mcpEnabled = features.get("mcp.enabled");' in ui
    assert 'if (document.body?.dataset?.page !== "mcp") window.location.assign(api.resolveUrl("mcp-integration"));' in ui
    assert 'mcp: "MCP" };' in ui
    assert 'navMcpButton: byId("navMcpButton"),' in read("src/static/app_dom.js")
    assert "mcp: { enabled: false }," in state and "mcp: { enabled: bool(src.mcp?.enabled, d.mcp.enabled) }," in state
    assert "mcp: obj.mcp === true" in state and "mcp: nav?.mcp === true" in state
    # The page itself never leaves when MCP is off: it shows how to turn it on.
    assert 'dataset?.page === "mcp"' not in ui


def test_every_mcp_request_is_one_function_of_app_api():
    api = read("src/static/app_api.js")
    for name in ("getMcpMeta", "getMcpKeys", "createMcpKey", "updateMcpKey", "rotateMcpKey", "deleteMcpKey"):
        assert f"async function {name}(" in api and name in api[api.index("ns.api = {"):], name
    assert 'request(`api/mcp${path}`, options)' in api
    for path in STATIC.glob("*.js"):
        text = path.read_text(encoding="latin-1")
        if path.name != "app_api.js":
            assert not re.search(r"[\"'`]/?api/mcp", text), path.name
    # The page modules reach the server through ns.api only.
    for name in MCP_MODULES:
        text = code(f"src/static/{name}")
        assert "fetch(" not in text and "XMLHttpRequest" not in text, name


def test_the_secret_is_never_kept_by_the_browser():
    form = read("src/static/app_mcp_form.js")
    # Shown once in a dialog; the dialog is removed on close and its nodes are cleared.
    assert "body.replaceChildren();" in form
    assert 'ns.dialog.open({' in form[form.index("function showSecret"):]
    for name in MCP_MODULES:
        text = code(f"src/static/{name}")
        for forbidden in ("localStorage", "sessionStorage", "ns.storage", "history.", "router.", "location.hash", "document.cookie"):
            assert forbidden not in text, (name, forbidden)
        # Nodes come from ns.h: no API value reaches markup.
        assert ".innerHTML" not in text and "insertAdjacentHTML" not in text, name
    page = read("src/static/app_mcp_page.js")
    assert "announce(`Key ${result.key.name} created`)" in page
    # The announcement never carries the secret.
    assert "announce(" not in code("src/static/app_mcp_form.js")


def test_the_page_follows_the_ui_foundations():
    page = read("src/static/app_mcp_page.js")
    view = read("src/static/app_mcp_view.js")
    form = read("src/static/app_mcp_form.js")
    # States come from ns.uiState, the dialogs from ns.dialog, copy buttons from ns.copy, badges from ns.badge.
    for text in ("ns.uiState.loading(", "ns.uiState.error(", "ns.dialog.confirm("):
        assert text in page + view, text
    assert "ns.uiState.empty(" in view and "ns.uiState.banner(" in view
    assert "ns.copy.button(" in view and "ns.badge.el(" in view and "ns.dialog.open({" in form
    assert 'ns.dialog.confirm({' in page and "danger: true" in page
    # Rotate and delete confirm and the focus starts on Cancel (ns.dialog.confirm danger).
    assert page.count("danger: true") == 2
    # The SQL tools need All data: they are disabled with their reason until then.
    assert 'const NEEDS_ALL_DATA = "Needs All data: ChDash cannot limit free SQL to some tables.";' in form
    assert "box.input.disabled = locked;" in form and "tool.needsAllData" in form
    # A field's error sits next to it, from the server's field.
    assert "info.code === \"validation\" || info.code === \"name_taken\"" in form and 'role: "alert"' in form
    css = read("src/static/css/20-features/mcp.css")
    assert not re.search(r"#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(", css)
    assert "@media (max-width: 600px)" in css and 'body[data-page="mcp"] #hostPicker' in css


def test_the_spec_and_the_docs_are_registered():
    runner = read("tests/test-suite/run-all-tests.py")
    assert "specs/mcp-page.spec.js" in runner
    spec = read("tests/frontend/specs/mcp-page.spec.js")
    assert "/api/mcp/**" in spec and "route.continue" in spec
    foundations = read("docs/ui-foundations.md")
    assert "| `/mcp-integration` |" in foundations and "docs/mcp-integration-page.md" in foundations
    doc = read("docs/mcp-integration-page.md")
    for text in ("## One-time secret", "## Keys table", "## States of the page", "`chdash.pageNav.v1`", "features.mcp.enabled"):
        assert text in doc, text
