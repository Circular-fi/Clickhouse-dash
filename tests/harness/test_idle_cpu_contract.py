from pathlib import Path

import css_sources

ROOT = Path(__file__).resolve().parents[2]


def read(rel):
    return (ROOT / rel).read_text(encoding="utf-8")


def test_nothing_repaints_or_relayouts_a_page_at_rest():
    css = css_sources.text()
    shell = read("src/static/css/20-features/shell.css")
    # The healthy host dot: a ring moved by transform and opacity (the compositor), three times, not a
    # box-shadow animated forever on the main thread (7 to 20 % of a core on every page).
    assert "animation: hostDotHealthyPulse 1.8s ease-in-out 3;" in shell
    keyframes = shell[shell.index("@keyframes hostDotHealthyPulse"):].split("\n", 1)[0]
    assert "transform" in keyframes and "opacity" in keyframes and "box-shadow" not in keyframes
    assert ".hostDot--good::after" in css and "hostDotHealthyPulse 1.8s ease-in-out infinite" not in css
    # No infinite animation on a property the compositor cannot run (they repaint every frame).
    for name in ("hostDotHealthyPulse", "explorerTreeHealthPulse"):
        body = css[css.find(f"@keyframes {name}"):].split("\n", 1)[0] if f"@keyframes {name}" in css else ""
        assert "box-shadow" not in body, name
    # The hosts stream's tick (every second) writes only what changed.
    ui = read("src/static/app_ui.js")
    assert "function setText(el, text) {\n    if (el && el.textContent !== text) el.textContent = text;\n  }" in ui
    assert "setText(dom.hostPickerText," in ui and "setText(dom.hostPickerPing," in ui and "setText(dom.hostPickerVersion," in ui
    assert "if (dom.runButton.textContent !== runLabel) dom.runButton.textContent = runLabel;" in read("src/static/app_run.js")
