// The Explorer Lineage and Storage graph.
// It runs on the shared canvas graph kit (app_graph_kit.js).
// It covers projections, layout, database groups, per-node expansion, the side panel and the TTL overlays.
// The side panel is a bottom sheet on phones.
// The canvas is the only view, also on phones. The kit's keyboard access (arrows, Enter, the live region) is the accessible path.
// The Catalog entry hands this module to the controller (explorer.use()).
// The parts are app_explorer_graph_*.js (see app_explorer_graph_store.js).

import { dom } from "./app_dom.js";
import { activate, applyRouteState, clickTarget, contractNeighborhood, deactivate, describeNode, expandNeighborhood, focusDatabase, focusTable, getRouteState, hoverTarget, isStorageMode, onHostChanged, onScopeChanged, refresh, searchFocus, setDetailMode, setVisibilityOptions, syncFocusControls, visibilityRequirements } from "./app_explorer_graph_focus.js";
import { draw, redrawThemeNow } from "./app_explorer_graph_frame.js";
import { hitTarget, nodeIsClickable, nodeTarget } from "./app_explorer_graph_hit.js";
import { compactCards, drawnBox } from "./app_explorer_graph_nodes.js";
import { buildGraphChrome, chrome, closePanel, renderGraphChrome } from "./app_explorer_graph_panel.js";
import { canUseStorageForTable, visibleEdges } from "./app_explorer_graph_scene.js";
import { model, readableScale, worldToScreen } from "./app_explorer_graph_store.js";
import { edgeShortLabel } from "./app_explorer_graph_text.js";
import { fitToScreen, minimumZoomScale, overviewScale } from "./app_explorer_graph_viewport.js";
import { graphKit } from "./app_graph_kit.js";
import { segmented } from "./app_ui_segmented.js";

const kit = graphKit;

function init(options = {}) {
  model.openTable = typeof options.openTable === "function" ? options.openTable : null;
  model.openCard = typeof options.openCard === "function" ? options.openCard : null;
  model.onStateChange = typeof options.onStateChange === "function" ? options.onStateChange : null;
  // Canvas pixels do not react to CSS.
  // The graph draws again in the same visual transaction as the theme switch (app_header.js).
  window.addEventListener("chdash:theme-applied", () => redrawThemeNow());
  const canvas = dom.explorerGraphCanvas;
  if (!canvas) return;
  buildGraphChrome();

  model.view = kit.mount({
    canvas,
    view: model,
    active: () => model.active,
    draw,
    bounds: () => (model.layout.size ? model.worldBounds : null),
    minScale: minimumZoomScale,
    fit: () => fitToScreen(),
    hit: hitTarget,
    onHover: hoverTarget,
    onClick: clickTarget,
    nodes: () => [...model.layout.values()].filter((item) => nodeIsClickable(item.node))
      .map((item) => ({ id: item.node.id, x: item.x, y: item.y, width: item.width, height: item.height })),
    selectedId: () => (model.panel?.type === "node" ? model.panel.id : model.focusedId),
    target: nodeTarget,
    describe: describeNode,
    onActivate: (id) => clickTarget(nodeTarget(id)),
    onEscape: () => {
      if (!model.panel) return false;
      closePanel();
      return true;
    },
    onViewChange: (kind) => {
      model.isFitted = kind === "zoom" ? Math.abs(model.scale - model.fitScale) < 1e-9 : false;
      syncFocusControls();
    },
    panel: () => chrome.panel,
    toolbar: { zoomIn: dom.explorerGraphZoomInButton, zoomOut: dom.explorerGraphZoomOutButton, fit: dom.explorerGraphFitButton },
  });
  // Lineage | Tiers uses the shared segmented control (app_ui_segmented.js).
  segmented?.bind(dom.explorerGraphTypeSelect, { onChange: (mode) => { setDetailMode(mode); return false; } });
  dom.explorerGraphContractButton?.addEventListener("click", contractNeighborhood);
  dom.explorerGraphExpandButton?.addEventListener("click", expandNeighborhood);
  dom.explorerGraphRefreshButton?.addEventListener("click", () => refresh(true, { reflow: true }));
  setDetailMode(model.detailMode);
  renderGraphChrome();
}

// Read-only geometry of the last drawn frame, in client (CSS pixel) coordinates.
// Browser tests can click real nodes, edge labels and expand controls on the canvas.
// The tests do not guess pixels.
function inspect() {
  const rect = dom.explorerGraphCanvas?.getBoundingClientRect();
  const toClient = (box) => {
    const a = worldToScreen(box.x, box.y);
    return { x: (rect?.left || 0) + a.x, y: (rect?.top || 0) + a.y, width: box.width * model.scale, height: box.height * model.scale };
  };
  const labelCache = model.edgeLabelCache;
  const compact = compactCards();
  return {
    kit: true,
    compact,
    scale: model.scale,
    offsetX: model.offsetX,
    offsetY: model.offsetY,
    fitScale: model.fitScale,
    overviewScale: overviewScale(),
    readableScale: readableScale(),
    fitFloor: kit.FIT_FLOOR,
    gridSpacing: kit.GRID_SPACING,
    focusedId: model.focusedId,
    hoveredId: model.hoveredId,
    hoveredEdgeId: model.hoveredEdgeId,
    keyboardId: model.view?.keyboardId() || null,
    animating: !!model.view?.animating(),
    minimapVisible: !!dom.explorerGraphMinimap && !dom.explorerGraphMinimap.hidden,
    edgeLabelsPlaced: labelCache ? labelCache.placed.size : 0,
    edgeLabelsDropped: labelCache ? labelCache.dropped.slice() : [],
    panel: model.panel ? { ...model.panel } : null,
    expansions: [...model.expansions],
    showIsolated: model.showIsolated,
    nodes: [...model.layout.values()].map((item) => ({
      id: item.node.id, kind: item.node.kind, database: item.node.database, name: item.node.name,
      hiddenUpstream: Number(item.node.hidden_upstream) || 0, hiddenDownstream: Number(item.node.hidden_downstream) || 0,
      // The box drawn on screen. For a compact card, the box is its title row.
      ...toClient(drawnBox(item, compact)),
    })),
    edges: visibleEdges().map((edge) => ({
      id: edge.id, kind: edge.kind, from: edge.from, to: edge.to, aggregated: !!edge.aggregated, collapsed: !!edge.collapsed,
      points: (model.edgeGeometry?.get(edge.id) || []).map((point) => toClient({ x: point.x, y: point.y, width: 0, height: 0 })),
    })),
    edgeLabels: (model.edgeLabelHits || []).map((hit) => ({ id: hit.edge.id, kind: hit.edge.kind, from: hit.edge.from, to: hit.edge.to, text: edgeShortLabel(hit.edge), ...toClient(hit) })),
    controls: (model.controlHits || []).map((hit) => ({ key: hit.key, direction: hit.direction, nodeId: hit.node.id, label: hit.label, ...toClient(hit) })),
  };
}

// The calls that the Catalog controller makes (app_explorer.js, through explorer.use()).
const explorerGraph = {
  inspect,
  init,
  activate,
  deactivate,
  refresh,
  onScopeChanged,
  onHostChanged,
  searchFocus,
  focusTable,
  focusDatabase,
  setDetailMode,
  getRouteState,
  applyRouteState,
  isStorageMode,
  canUseStorageForTable,
  setVisibilityOptions,
  visibilityRequirements,
  redrawThemeNow,
};

export { explorerGraph };
