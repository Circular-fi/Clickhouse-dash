// This module holds the state of the Explorer graph. The state is the model: the payload, the focus, the layout, the camera and the panel.
// The module also has the canvas helpers: the size, the colour tokens and the world <-> screen conversion.
// It also has `actions`. The modules above this module give `actions` to the modules below.
// This module has no view of its own. The graph is app_explorer_graph.js (the entry that the Catalog hands over). That entry uses these modules:
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

// The modules above this one give these functions to the modules below. The modules below cannot import the modules above.
// A module cannot import the module that imports it. Set each action one time, when its module loads. A call before that point is a bug. The bug shows at once as a TypeError.
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
  // The kit controller (pan, zoom, keyboard, redraws). The init() function sets it.
  view: null,
  // The label placement of the edges in the current routed layout (edgeLabelLayout()).
  edgeLabelCache: null,
  flowMarkerState: new Map(),
  storageProjectionCache: null,
  logicalProjectionCache: null,
  visibleSetCache: null,
  lineageRouteCache: null,
  // The routing of a large layout runs in a Worker (kit.routeEdgesJob). This is the job while it runs. The status shows this state.
  routeJob: null,
  includeSystem: false,
  includeNonStoring: true,
  onStateChange: null,
  openCard: null,
  // Without focus, Lineage groups the objects of each database. A collapsed database is one card.
  // Objects without any dependency stay hidden, unless the user asks for them.
  expandedGroups: new Set(),
  groupsVersion: 0,
  showIsolated: false,
  // One-hop expansions for each node, on top of the global depth. The key has the form "up|down\0id".
  expansions: new Set(),
  hoveredEdgeId: null,
  hoveredControl: null,
  // Side panel. The value is { type: "node", id } or { type: "edge", id }, or null.
  panel: null,
  panelSerial: 0,
  definitionCache: new Map(),
  columnsCache: new Map(),
  // The scene and the frames store values for the modules that read them. Each value is null until the first write.
  // The request key of the payload, the counts of the databases in the overview, the geometry, and the label and control boxes of the last frame.
  graphRequestKey: "",
  groupStats: null,
  edgeGeometry: null,
  edgeLabelHits: null,
  controlHits: null,
  lastError: "",
};

// The smallest canvas font is 12px in Lineage and 11px in Storage. The readable scale keeps it at 11px on screen.
// Fit opens at this scale or above, unless the graph is far larger than the view (kit.fitView).
// Zoom out further is still possible. The cards then become compact (kit.isCompact).
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

// Graph colour tokens (--graph-*, css/00-tokens.css). The shared --accent is a translucent tint in the light theme.
// So canvas text, halos and edges use dedicated tokens. These tokens have readable values in both themes.
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
