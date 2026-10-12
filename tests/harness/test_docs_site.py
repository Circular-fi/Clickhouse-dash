"""The documentation page (docs/documentation.html) renders the Markdown files of docs/ in the browser: nothing is generated, so the
only thing that can drift is its list of pages. Every docs/*.md must be in that list, and every listed page must exist."""
import os
import re
from pathlib import Path

ROOT = Path(os.environ.get("TEST_REPOSITORY_ROOT", Path(__file__).resolve().parents[2])).resolve()


def listed_pages() -> set[str]:
    source = (ROOT / "docs/assets/docs.js").read_text(encoding="utf-8")
    block = source.split("const DOCS = [", 1)[1].split("const FLAT", 1)[0]
    return set(re.findall(r'\["([a-z0-9-]+)", "[^"]+"\]', block))


def test_every_markdown_page_of_docs_is_in_the_documentation_site_and_the_other_way_round():
    on_disk = {path.stem for path in (ROOT / "docs").glob("*.md")}
    listed = listed_pages()
    assert on_disk - listed == set(), f"docs/*.md missing from docs/assets/docs.js: {sorted(on_disk - listed)}"
    assert listed - on_disk == set(), f"listed in docs/assets/docs.js but not in docs/: {sorted(listed - on_disk)}"


def test_the_home_page_links_only_to_documentation_pages_that_exist():
    home = (ROOT / "docs/index.html").read_text(encoding="utf-8")
    pages = listed_pages()
    for name in re.findall(r'documentation\.html#/([a-z0-9-]+)', home):
        assert name in pages, name


def test_the_home_page_keeps_its_weight_budget():
    # Why: the page is meant to cost as little as possible (bytes, decoding, GPU). These are the limits that were measured when it was
    # optimised (video 2.4 MB, images 243 kB without the video, fonts 63 kB); a change that goes past them should be a decision.
    docs = ROOT / "docs"
    assert (docs / "media/chdash-presentation-web.mp4").stat().st_size <= 3_500_000
    for image in (docs / "assets/img").iterdir():
        assert image.stat().st_size <= 70_000, image.name
    fonts = sum(path.stat().st_size for path in (docs / "assets/fonts").glob("*.woff2"))
    assert fonts <= 80_000, fonts
    assert (docs / "assets/icons.svg").stat().st_size <= 6_000
    for script in ("site.js", "scene.js", "docs.js"):
        assert (docs / "assets" / script).stat().st_size <= 20_000, script


def test_the_home_page_does_not_keep_working_for_nothing():
    docs = ROOT / "docs"
    home = (docs / "index.html").read_text(encoding="utf-8")
    video = re.search(r"<video[^>]*>", home).group(0)
    assert 'preload="none"' in video and " loop" not in video  # it starts when idle and plays once
    css = (docs / "assets/site.css").read_text(encoding="utf-8")
    assert "backdrop-filter" not in css  # a blur over an animated canvas is repainted every frame
    scene = (docs / "assets/scene.js").read_text(encoding="utf-8")
    assert 'powerPreference: "low-power"' in scene and "antialias: false" in scene
    assert "setInterval" not in scene and "pointermove" not in scene
    for picture in re.findall(r"<picture>.*?</picture>", home, re.S):
        assert 'loading="lazy"' in picture and 'decoding="async"' in picture
