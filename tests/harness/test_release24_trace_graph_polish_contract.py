from pathlib import Path
import css_sources

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_trace_service_marker_uses_same_attempt_color_as_timeline_bar() -> None:
    js = read("src/static/app_trace_viewer.js")
    css = css_sources.text()
    assert 'row.style.setProperty("--trace-attempt-color"' in js
    assert 'service.style.setProperty("--trace-service-color"' not in js
    assert '.traceViewer__serviceMarker {' in css
    assert css_sources.decls('.traceViewer__serviceMarker')['background'] == 'var(--trace-attempt-color)'


def test_trace_header_and_rows_share_the_same_single_scroll_viewport() -> None:
    js = read("src/static/app_trace_viewer.js")
    css = css_sources.text()
    head = js.index('head.className = "traceViewer__head";')
    scroll = js.index('scroll.className = "traceViewer__scroll";', head)
    append_head = js.index('scroll.appendChild(head);', scroll)
    append_body = js.index('scroll.appendChild(body);', append_head)
    assert append_head < append_body
    assert 'table.appendChild(head);' not in js[head:append_body]
    # One scroller: the host has no padding, the scroll element scrolls and keeps the gutter.
    assert css_sources.decls('.analysisModal__content.traceViewerHost')['padding'] == '0'
    scroll = css_sources.decls('.traceViewer__scroll')
    assert scroll['overflow-y'] == 'auto' and scroll['scrollbar-gutter'] == 'stable'
    assert css_sources.decls('.traceViewer__head')['width'] == '100%'


def test_offscreen_graph_sidebar_selection_performs_a_real_focused_fit() -> None:
    graph = read("src/static/app_explorer_graph.js")
    block = graph[graph.index("function focusTable"):graph.index("function focusDatabase")]
    assert 'const needsFit = shouldEnsure && !nodeIsOnScreen(id);' in block
    assert 'setFocus(id, needsFit, { preserveDepth: true });' in block
    assert 'if (shouldEnsure) ensureNodeVisible(id);' not in block
    refresh = graph[graph.index("async function refresh("):graph.index("function setDetailMode", graph.index("async function refresh("))]
    assert 'if (ensurePendingFocus && model.focusedId) {' in refresh
    assert 'fitToScreen();' in refresh


def test_finalize_info_is_small_top_right_after_sort_arrow() -> None:
    ui = read("src/static/app_explorer_detail.js")
    css = css_sources.text()
    info = ui[ui.index("function appendFinalizePreviewInfo"):ui.index("function persistFlattenTuple", ui.index("function appendFinalizePreviewInfo"))]
    assert 'th.classList.add("has-finalize-info")' in info
    assert 'event.stopPropagation()' in info
    # The sort glyph sits inline in the header's sort button (.dataTable__sort),
    # so the info icon keeps its own corner: the header leaves room for it.
    assert '.explorerCard .explorerPreviewTable .resultTable thead th.has-finalize-info {' in css
    info = css_sources.decls('.explorerFinalizeInfo')
    assert info['position'] == 'absolute' and info['top'] == '8px' and info['right'] == '8px'
    assert info['width'] == '13px' and info['height'] == '13px'


def test_lineage_tab_has_one_title_per_direction() -> None:
    ui = read("src/static/app_explorer_detail.js")
    lineage = ui[ui.index("function renderLineageTab"):ui.index("function previewLimit")]
    assert 'sectionTitle("Lineage")' not in ui
    assert 'h("h4", { class: "explorerLineage__title" }, relation === "upstream" ? "Upstream" : "Downstream")' in lineage


def test_storage_composition_legend_omits_zero_or_nonexistent_categories() -> None:
    ui = read("src/static/app_explorer_detail.js")
    block = ui[ui.index("function buildStorageComposition"):ui.index("function renderStorageCompositionCard")]
    assert 'composition.items.filter((item) => Number(item.bytes) > 0)' in block
    assert 'if (legendItems.length) wrap.appendChild(legend);' in block
    assert '{ label: "Wide", variant: "wide", percent: null, bytes: null }' not in block
