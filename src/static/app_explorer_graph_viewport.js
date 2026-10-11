// The camera of the Explorer graph: Fit, the anchor that a layout change keeps still, the box of a database, the zoom floor and the clamp.

import { dom } from "./app_dom.js";
import { isNonStoringNode } from "./app_explorer_graph_model.js";
import { visibleEdges } from "./app_explorer_graph_scene.js";
import { actions, canvasSize, model, readableScale, scheduleDraw, worldToScreen } from "./app_explorer_graph_store.js";
import { isSystemDatabaseName } from "./app_explorer_summary.js";
import { graphKit } from "./app_graph_kit.js";

const kit = graphKit;

// Scale at which the whole graph fits the part of the canvas its chrome
// leaves free (may be unreadable).
function overviewScale() {
  const { width, height } = kit.safeArea(dom.explorerGraphCanvas);
  const bounds = model.worldBounds;
  if (!bounds || !width || !height) return 1;
  const cap = model.detailMode === "physical" ? 1.5 : 1.15;
  return Math.max(0.02, Math.min(cap, Math.min(width / bounds.width, height / bounds.height) * 0.92));
}

// The world box around a card and the cards it shares a visible edge with
// (what a phone fits on open).
function neighbourhoodBox(id) {
  const item = id ? model.layout.get(id) : null;
  if (!item) return null;
  let minX = item.x; let minY = item.y; let maxX = item.x + item.width; let maxY = item.y + item.height;
  for (const edge of visibleEdges()) {
    const other = edge.from === id ? edge.to : edge.to === id ? edge.from : null;
    const near = other ? model.layout.get(other) : null;
    if (!near) continue;
    minX = Math.min(minX, near.x); minY = Math.min(minY, near.y);
    maxX = Math.max(maxX, near.x + near.width); maxY = Math.max(maxY, near.y + near.height);
  }
  return { x: minX - 24, y: minY - 24, width: maxX - minX + 48, height: maxY - minY + 48 };
}

// Fit (kit.fitView): the whole graph when it is readable as a whole; a
// graph slightly too large opens at the readable scale on the focused
// object (or the requested anchor, else the top-left of the graph), the
// minimap giving the rest; a much larger one shows whole with compact
// cards. A phone opens on the focus and its neighbours, then pans.
function fitToScreen({ anchorId = null, anchorBox = null } = {}) {
  const { width, height } = canvasSize();
  const bounds = model.worldBounds;
  if (!bounds || !width || !height) return;
  model.view?.unfollow();
  kit.foldLegendToFit(dom.explorerGraphCanvas, bounds, { readableScale: readableScale() });
  const anchorItem = (anchorId && model.layout.get(anchorId)) || (model.focusedId && model.layout.get(model.focusedId)) || null;
  const fitted = kit.fitView(dom.explorerGraphCanvas, {
    bounds,
    overview: overviewScale(),
    readable: readableScale(),
    anchor: anchorBox || anchorItem,
    corner: !!anchorBox,
    neighbourhood: anchorBox ? null : neighbourhoodBox(anchorItem?.node?.id),
    maxScale: model.detailMode === "physical" ? 1.5 : 1.15,
  });
  if (!fitted) return;
  model.scale = fitted.scale;
  model.fitScale = fitted.scale;
  model.offsetX = fitted.offsetX;
  model.offsetY = fitted.offsetY;
  clampViewportToGraph();
  model.fitOffsetX = model.offsetX;
  model.fitOffsetY = model.offsetY;
  model.isFitted = true;
  actions.syncFocusControls();
  scheduleDraw();
}

function captureViewportAnchor({ includeSystem = model.includeSystem, includeNonStoring = model.includeNonStoring } = {}) {
  if (!model.layout.size || !dom.explorerGraphCanvas) return null;
  const { width, height } = canvasSize();
  if (!width || !height) return null;
  const remainsVisible = (item) => {
    const node = item?.node;
    if (!node) return false;
    if (node.layer !== "logical") return model.detailMode === "physical";
    if (!includeSystem && isSystemDatabaseName(node.database)) return false;
    if (!includeNonStoring && isNonStoringNode(node)) return false;
    return true;
  };
  const focused = model.focusedId ? model.layout.get(model.focusedId) : null;
  let anchor = focused && remainsVisible(focused) ? focused : null;
  if (!anchor) {
    const centerX = width / 2;
    const centerY = height / 2;
    let bestDistance = Infinity;
    for (const item of model.layout.values()) {
      if (!remainsVisible(item)) continue;
      const point = worldToScreen(item.x + item.width / 2, item.y + item.height / 2);
      const distance = Math.hypot(point.x - centerX, point.y - centerY);
      if (distance < bestDistance) {
        bestDistance = distance;
        anchor = item;
      }
    }
  }
  if (!anchor) return null;
  const point = worldToScreen(anchor.x + anchor.width / 2, anchor.y + anchor.height / 2);
  return { id: anchor.node.id, screenX: point.x, screenY: point.y };
}

function restoreViewportAnchor(anchor) {
  if (!anchor) return false;
  const item = model.layout.get(anchor.id);
  if (!item) return false;
  model.offsetX = anchor.screenX - (item.x + item.width / 2) * model.scale;
  model.offsetY = anchor.screenY - (item.y + item.height / 2) * model.scale;
  clampViewportToGraph();
  return true;
}

function nodeIsOnScreen(id, padding = 18) {
  const item = model.layout.get(id);
  if (!item || !dom.explorerGraphCanvas || model.scale <= 0) return false;
  const rect = dom.explorerGraphCanvas.getBoundingClientRect();
  const topLeft = worldToScreen(item.x, item.y);
  const bottomRight = worldToScreen(item.x + item.width, item.y + item.height);
  return topLeft.x >= padding && topLeft.y >= padding
    && bottomRight.x <= rect.width - padding
    && bottomRight.y <= rect.height - padding;
}

function databaseBounds({ includeGroupCards = false } = {}) {
  const groups = new Map();
  for (const item of model.layout.values()) {
    if (item.node.layer !== "logical") continue;
    // A collapsed database card is its own frame; bands wrap expanded ones.
    if (!includeGroupCards && item.node.kind === "database_group") continue;
    const key = item.node.database || "default";
    const current = groups.get(key) || { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, count: 0 };
    current.minX = Math.min(current.minX, item.x);
    current.minY = Math.min(current.minY, item.y);
    current.maxX = Math.max(current.maxX, item.x + item.width);
    current.maxY = Math.max(current.maxY, item.y + item.height);
    current.count += 1;
    groups.set(key, current);
  }
  return groups;
}

// Centred in the visible canvas once the side panel has settled (its
// content arrives after it opens), and again when it closes (kit
// follow()).
function centerOnNode(id) {
  if (!model.layout.get(id) || !model.view) return;
  model.view.follow(id);
}

function minimumZoomScale() {
  // Zoom-out stops at the whole-graph overview: below the readable Fit the
  // cards switch to their compact level of detail.
  const fitScale = Number(model.fitScale);
  const floor = Number.isFinite(fitScale) && fitScale > 0 ? fitScale : 0.06;
  return Math.min(floor, overviewScale());
}

function clampViewportToGraph() {
  const canvas = dom.explorerGraphCanvas;
  if (!canvas || !model.layout.size) return;
  const rect = canvas.getBoundingClientRect();
  kit.clampView(model, model.worldBounds, rect.width, rect.height);
}

export { captureViewportAnchor, centerOnNode, databaseBounds, fitToScreen, minimumZoomScale, nodeIsOnScreen, overviewScale, restoreViewportAnchor };
