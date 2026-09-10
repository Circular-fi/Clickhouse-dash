from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_trace_service_marker_uses_same_attempt_color_as_timeline_bar() -> None:
    js = read("src/static/app_trace_viewer.js")
    css = read("src/static/style.css")
    assert 'row.style.setProperty("--trace-attempt-color"' in js
    assert 'service.style.setProperty("--trace-service-color"' not in js
    assert '.traceViewer__serviceMarker {' in css
    release = css[css.rindex("/* Release 24: trace geometry"):]
    assert 'background: var(--trace-attempt-color);' in release


def test_trace_header_and_rows_share_the_same_single_scroll_viewport() -> None:
    js = read("src/static/app_trace_viewer.js")
    css = read("src/static/style.css")
    head = js.index('head.className = "traceViewer__head";')
    scroll = js.index('scroll.className = "traceViewer__scroll";', head)
    append_head = js.index('scroll.appendChild(head);', scroll)
    append_body = js.index('scroll.appendChild(body);', append_head)
    assert append_head < append_body
    assert 'table.appendChild(head);' not in js[head:append_body]
    release = css[css.rindex("/* Release 24: trace geometry"):]
    assert '.analysisModal__content.traceViewerHost {' in release
    assert 'padding: 0;' in release
    assert 'overflow-y: auto;' in release
    assert 'scrollbar-gutter: stable;' in release
    assert '.traceViewer__head {' in release and 'width: 100%;' in release


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
    ui = read("src/static/app_explorer.js")
    css = read("src/static/style.css")
    info = ui[ui.index("function appendFinalizePreviewInfo"):ui.index("function renderData(container", ui.index("function appendFinalizePreviewInfo"))]
    assert 'th.classList.add("has-finalize-info")' in info
    assert 'event.stopPropagation()' in info
    release = css[css.rindex("/* Release 24: trace geometry"):]
    assert 'th.resultTable__thSortable.has-finalize-info::after' in release
    assert 'right: 0.8rem;' in release
    assert '.explorerFinalizeInfo {' in release
    assert 'top: 2px;' in release and 'right: 2px;' in release
    assert 'width: 9px;' in release and 'height: 9px;' in release


def test_overview_has_no_redundant_lineage_title() -> None:
    ui = read("src/static/app_explorer.js")
    overview = ui[ui.index("function renderOverview"):ui.index("function isImplementationSubcolumn")]
    assert 'sectionTitle("Lineage")' not in overview
    assert 'if (deps.length) renderDependencies(container, detail);' in overview


def test_storage_composition_legend_omits_zero_or_nonexistent_categories() -> None:
    ui = read("src/static/app_explorer.js")
    block = ui[ui.index("function renderStorageComposition"):ui.index("function renderOverview")]
    assert 'composition.items.filter((item) => Number(item.bytes) > 0)' in block
    assert 'if (legendItems.length) wrap.appendChild(legend);' in block
    assert '{ label: "Wide", variant: "wide", percent: null, bytes: null }' not in block
