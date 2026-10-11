// One frame of the Explorer graph: the cards, the edges and the labels under the camera, and the minimap of a graph that does not fit.

import { dom } from "./app_dom.js";
import { drawEdge, drawEdgeLabels, edgeDashPattern, lineageEdgeShouldAnimate } from "./app_explorer_graph_edges.js";
import { bezierRoutePoints, storageRouteGeometry } from "./app_explorer_graph_geometry.js";
import { compactCards, drawDatabaseGroups, drawDatabaseLod, drawNode, drawNodeExpandControls } from "./app_explorer_graph_nodes.js";
import { ensureLineageRouteCache, focusedSet, isStorageRouteEdge, visibleEdges } from "./app_explorer_graph_scene.js";
import { FONT, graphColor, model, reducedMotionPreferred } from "./app_explorer_graph_store.js";
import { graphKit } from "./app_graph_kit.js";

const kit = graphKit;

function graphHasClippedElements() {
  const main = dom.explorerGraphCanvas?.getBoundingClientRect();
  if (!main || !model.layout.size || model.scale <= 0) return false;
  return kit.anyClipped(model.layout.values(), model, main.width, main.height);
}

// The whole graph in the corner as soon as any card is clipped (never at
// Fit, which shows them all). It mirrors the active projection with the
// same routed geometry as the main canvas.
function drawMinimap(frame) {
  const canvas = dom.explorerGraphMinimap;
  const bounds = model.worldBounds;
  if (!canvas) return;
  const shown = graphHasClippedElements();
  canvas.hidden = !shown;
  if (!shown || !bounds || !model.layout.size) return;
  const lineageRoutes = model.detailMode === "logical" ? ensureLineageRouteCache() : null;
  const edges = [];
  for (const edge of visibleEdges()) {
    const from = model.layout.get(edge.from);
    const to = model.layout.get(edge.to);
    if (!from || !to) continue;
    let points = null;
    if (isStorageRouteEdge(edge)) {
      points = storageRouteGeometry(from, to, edge).points;
    } else {
      const route = lineageRoutes?.get(edge.id);
      if (Array.isArray(route?.points) && route.points.length >= 2) {
        points = route.points;
      } else {
        const a = route?.a || { x: from.x + from.width, y: from.y + from.height / 2 };
        const b = route?.b || { x: to.x, y: to.y + to.height / 2 };
        const dx = Math.max(42, Math.abs(b.x - a.x) * 0.45);
        points = bezierRoutePoints(a, { x: a.x + dx, y: a.y }, { x: b.x - dx, y: b.y }, b);
      }
    }
    const style = edgeDashPattern(edge);
    edges.push({ points, dash: style.dash, width: style.width, color: graphColor("edge") });
  }
  const nodes = [...model.layout.values()].map((item) => ({
    x: item.x, y: item.y, width: item.width, height: item.height,
    // Storage tiers / TTL terminals are represented too: the minimap can
    // appear because a physical card is clipped.
    alpha: model.focusedId === item.node.id ? 1 : item.node.layer === "logical" ? 0.62 : 0.42,
  }));
  kit.drawMinimap(canvas, { bounds, nodes, edges, view: model, width: frame.width, height: frame.height });
}

// One frame (kit.mount calls it after painting the dot-grid background);
// returns true while an activity / flow animation needs further frames.
function draw(ctx, frame) {
  const now = frame.now;
  if (!model.graph || !model.layout.size) {
    ctx.fillStyle = graphColor("muted");
    ctx.font = `13px ${FONT}`;
    ctx.fillText(model.loading ? "Loading graph\u2026" : "No accessible objects in this scope", 24, 34);
    if (dom.explorerGraphMinimap) dom.explorerGraphMinimap.hidden = true;
    return false;
  }

  ctx.save();
  ctx.translate(model.offsetX, model.offsetY);
  ctx.scale(model.scale, model.scale);
  model.edgeLabelHits = [];
  if (model.scale < 0.23 && model.detailMode === "logical" && !model.focusedId) {
    drawDatabaseLod(ctx);
  } else {
    const focused = focusedSet();
    drawDatabaseGroups(ctx);
    const edges = visibleEdges();
    model.edgeGeometry = new Map();
    for (const edge of edges) drawEdge(ctx, edge, now, focused);
    const compact = compactCards();
    for (const item of model.layout.values()) drawNode(ctx, item, focused, compact);
    if (!compact) drawEdgeLabels(ctx, edges, focused, frame);
    drawNodeExpandControls(ctx, compact);
  }
  ctx.restore();
  drawMinimap(frame);

  const animationEdges = visibleEdges();
  const hasActive = model.detailMode === "logical"
    && animationEdges.some((edge) => lineageEdgeShouldAnimate(edge));
  const hasStorageAnimation = model.detailMode === "physical" && !reducedMotionPreferred()
    && visibleEdges().some((edge) => isStorageRouteEdge(edge));
  return (hasActive || hasStorageAnimation) && model.active;
}

function redrawThemeNow() {
  // Called synchronously by the theme switch, before MutationObserver
  // callbacks run: drop resolved colours so this redraw uses the new theme.
  kit.theme.invalidate();
  if (!model.active || !dom.explorerGraphCanvas) return;
  // Theme changes update CSS variables synchronously, while the canvas keeps
  // its previous pixels until it is painted again. Redraw immediately in the
  // same event turn so the graph/minimap cannot visibly lag behind the DOM.
  model.view?.drawNow();
}

export { draw, redrawThemeNow };
