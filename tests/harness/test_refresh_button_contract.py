from pathlib import Path

import css_sources

ROOT = Path(__file__).resolve().parents[2]


def read(rel):
    return (ROOT / rel).read_text(encoding="utf-8")


def test_the_refresh_button_is_one_chromeless_component_everywhere():
    css = css_sources.text()
    refresh = css_sources.decls(".refreshButton")
    # An icon, not a button: no border, no background, at rest and on hover.
    assert refresh["border"] == "0" and refresh["background"] == "transparent" and refresh["box-shadow"] == "none"
    assert ".refreshButton:hover:not(:disabled),\n.refreshButton:focus-visible {" in css or ".refreshButton:hover:not(:disabled)" in css
    assert refresh["color"] == "var(--muted)" and ".refreshButton .refreshGlyph" not in css  # one colour, no second dimming
    # The Explorer's two panels and the filter bars' refresh action are the same component.
    explorer, functions = read("src/static/explorer.html"), read("src/static/functions.html")
    assert explorer.count('class="refreshButton"') == 1 and functions.count('class="refreshButton"') == 1 and "button--small explorerRefreshButton" not in explorer + functions
    assert 'class: "refreshButton obsFilterBar__submit obsFilterBar__submit--icon",' in read("src/static/app_ui_filterbar.js")
    for rule in (".explorerRefreshButton", ".obsFilterBar__submit--icon.is-loading", ".obsFilterBar__submit--icon > .uiSpin"):
        assert rule not in css, rule
