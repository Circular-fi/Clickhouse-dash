// The state of the Explorer graph and what every module of it shares: the model (the payload, the focus, the layout, the camera, the panel), the
// canvas helpers (the size, the colour tokens, the world <-> screen mapping) and `actions`, what the modules above provide to the ones below.
// It holds no view of its own. The graph is app_explorer_graph.js (the entry that the Catalog hands over) over these modules:
//   model, text, geometry, layout   pure (the projections, the labels, the shapes, the positions)
//   store, scene, viewport          the state, the visible set and the layout, the camera
//   nodes, edges, frame, hit        the canvas: the cards, the edges, a frame, what is under the pointer
//   panel, focus                    the chrome and the side panel, the focus and the refresh

import { dom } from "./app_dom.js";
import { focusScopeOf } from "./app_explorer_graph_model.js";
import { graphKit } from "./app_graph_kit.js";

const kit = graphKit;

function currentFocusScope() {
  return focusScopeOf(model.graph, model.pendingFocusId || model.focusedId);
}

// What the modules above this one provide to the modules below, which cannot import them (a module cannot import the one that imports it).
// Each is set once, when its module loads; a call before that is a bug that shows at once (a TypeError).
const actions = {
  setFocus: null, setShowIsolated: null, syncFocusControls: null, toggleExpansion: null, updateStatus: null,
};

const model = {
  active: false,
  loading: false,
  refreshSerial: 0,
  refreshQueued: false,
  refreshQueuedForce: false,
  refreshQueuedReflow: false,
  graph: null,
  detailMode: "logical",
  database: "",
  layout: new Map(),
  worldBounds: null,
  scale: 1,
  fitScale: 1,
  fitOffsetX: 0,
  fitOffsetY: 0,
  isFitted: false,
  offsetX: 0,
  offsetY: 0,
  hoveredId: null,
  focusedId: null,
  focusDepth: 1,
  pendingFocusId: null,
  pendingEnsureVisible: false,
  openTable: null,
  // The kit controller (pan / zoom / keyboard / redraws), set by init().
  view: null,
  // Edge label placement of the current routed layout (edgeLabelLayout()).
  edgeLabelCache: null,
  flowMarkerState: new Map(),
  storageProjectionCache: null,
  logicalProjectionCache: null,
  visibleSetCache: null,
  lineageRouteCache: null,
  // The routing of a large layout runs in a Worker (kit.routeEdgesJob): its job, while it runs (the status says so).
  routeJob: null,
  includeSystem: false,
  includeNonStoring: true,
  onStateChange: null,
  openCard: null,
  // Unfocused Lineage groups objects per database: a collapsed database is
  // one card; objects without any dependency stay hidden unless asked for.
  expandedGroups: new Set(),
  groupsVersion: 0,
  showIsolated: false,
  // Per-node one-hop expansions on top of the global depth ("up|down\0id").
  expansions: new Set(),
  hoveredEdgeId: null,
  hoveredControl: null,
  // Side panel: { type: "node", id } | { type: "edge", id } | null.
  panel: null,
  panelSerial: 0,
  definitionCache: new Map(),
  columnsCache: new Map(),
  // What the scene and the frames leave for the modules that read them (null until the first one):
  // the request key of the payload, the databases' counts of the overview, the geometry and the label and control boxes of the last frame.
  graphRequestKey: "",
  groupStats: null,
  edgeGeometry: null,
  edgeLabelHits: null,
  controlHits: null,
  lastError: "",
};

// Smallest canvas font is 12px in Lineage and 11px in Storage: the readable
// scale keeps it at 11px on screen. Fit opens there or above unless the
// graph is far larger than the view (kit.fitView); further zoom-out stays
// possible and turns the cards compact (kit.isCompact).
const LINEAGE_FONT_MIN = 12;

const STORAGE_FONT_MIN = 11;

const READABLE_TEXT_PX = 11;

const FONT = kit.FONT;

function readableScale() {
  return READABLE_TEXT_PX / (model.detailMode === "physical" ? STORAGE_FONT_MIN : LINEAGE_FONT_MIN);
}

function reducedMotionPreferred() {
  return kit.reducedMotion();
}

function canvasSize() {
  return kit.canvasSize(dom.explorerGraphCanvas);
}

function worldToScreen(x, y) {
  return { x: x * model.scale + model.offsetX, y: y * model.scale + model.offsetY };
}

function screenToWorld(x, y) {
  return { x: (x - model.offsetX) / model.scale, y: (y - model.offsetY) / model.scale };
}

function canvasEllipsis(ctx, value, maxWidth) {
  return kit.ellipsis(ctx, value, maxWidth);
}

// Graph colour tokens (--graph-*, css/00-tokens.css). The shared
// --accent is a translucent tint in the light theme, so canvas text, halos
// and edges use dedicated tokens with readable values in both themes.
function graphColor(role) {
  return kit.color(role);
}

function dimAlpha() {
  return kit.dimAlpha();
}

function roundedRectPath(ctx, x, y, width, height, radius) {
  kit.roundRect(ctx, x, y, width, height, radius);
}

function scheduleDraw() {
  model.view?.scheduleDraw();
}

export { FONT, LINEAGE_FONT_MIN, STORAGE_FONT_MIN, actions, canvasEllipsis, canvasSize, currentFocusScope, dimAlpha, graphColor, model, readableScale, reducedMotionPreferred, roundedRectPath, scheduleDraw, screenToWorld, worldToScreen };
