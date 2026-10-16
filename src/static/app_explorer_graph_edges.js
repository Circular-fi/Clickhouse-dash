// The edges of the Explorer graph on the canvas.
// They cover the style by kind, the curves and the Storage routes, the flow markers, the selected halo and the labels.
// The labels are placed once per routed layout, in a fixed priority order.

import { bezierPoint, bezierRoutePoints, isInsertFlowEdge, isRefreshFlowEdge, storageRouteGeometry } from "./app_explorer_graph_geometry.js";
import { isLogicalDependencyEdge } from "./app_explorer_graph_model.js";
import { nodeExpandControls } from "./app_explorer_graph_nodes.js";
import { ensureLineageRouteCache, isStorageRouteEdge, visibleEdges } from "./app_explorer_graph_scene.js";
import { FONT, canvasEllipsis, dimAlpha, graphColor, model, reducedMotionPreferred, roundedRectPath } from "./app_explorer_graph_store.js";
import { edgeShortLabel, ttlEdgeLabelLines } from "./app_explorer_graph_text.js";
import { graphKit } from "./app_graph_kit.js";

const kit = graphKit;

// Dash pattern (kit.DASH) and width by edge kind.
// Solid is data flow. Dashed is query-time dependencies. Dotted is routing or containment.
function edgeDashPattern(edge) {
  const { DASH } = kit;
  if (edge.kind === "view" || edge.kind === "dependency") return { dash: DASH.dashed, width: 1 };
  if (edge.kind === "dictionary_source") return { dash: DASH.dashdot, width: 1.1 };
  if (edge.kind === "distributed_route") return { dash: DASH.route, width: 1.1 };
  if (edge.kind === "contains") return { dash: DASH.route, width: 0.8 };
  if (edge.kind === "ttl_delete" || edge.kind === "ttl_move" || (Array.isArray(edge.ttl_events) && edge.ttl_events.length)) {
    return { dash: DASH.lifecycle, width: 1.5 };
  }
  if (edge.kind === "refreshable_mv" || edge.kind === "refreshable_mv_output") return { dash: DASH.refresh, width: 1.25 };
  if (edge.kind === "materialized_view" || edge.kind === "materialized_view_output" || edge.kind === "buffer") return { dash: DASH.solid, width: 1.8 };
  return { dash: DASH.solid, width: 1.25 };
}

function edgeStyle(edge, ctx) {
  const style = edgeDashPattern(edge);
  ctx.setLineDash(style.dash);
  ctx.lineWidth = style.width;
}

function isFocusedDepthOneEdge(edge) {
  if (!model.focusedId || model.detailMode !== "logical") return false;
  return edge.from === model.focusedId || edge.to === model.focusedId;
}

function lineageEdgeShouldAnimate(edge) {
  if (reducedMotionPreferred() || !model.focusedId) return false;
  if (!isFocusedDepthOneEdge(edge)) return false;
  return isInsertFlowEdge(edge) || isRefreshFlowEdge(edge);
}

function storagePolylineMetric(points) {
  return kit.polylineMetric(points);
}

function storageRoutePoint(points, t) {
  return kit.routePoint(points, t);
}

function drawStorageRoute(ctx, points) {
  kit.tracePolyline(ctx, points);
}

// Storage and Lineage share this code.
// The marker lives in graph (world) space, not in screen space.
// Canvas zoom therefore scales both its radius and its apparent speed naturally.
// At zoom 0.5, a 72 world-unit/s marker moves at 36 px/s and is half as large on screen.
// This keeps the motion visually attached to the edges.
const FLOW_SPEED_WORLD_PER_SECOND = 72;

const FLOW_EMISSION_INTERVAL_MS = 900;

const FLOW_MAX_MARKERS_PER_EDGE = 24;

const FLOW_DOT_RADIUS_WORLD = 2.35;

function drawNormalizedFlowMarker(ctx, edge, now, points) {
  const metric = storagePolylineMetric(points);
  const key = String(edge.id || `${edge.from}:${edge.to}:${edge.kind || "flow"}`);
  let state = model.flowMarkerState.get(key);
  if (!state) {
    const seed = [...key].reduce((acc, ch) => (acc + ch.charCodeAt(0)) % 997, 0) / 997;
    state = { phaseOffsetMs: seed * FLOW_EMISSION_INTERVAL_MS };
    model.flowMarkerState.set(key, state);
  }

  // Emission is based on a clock, not on the edge length.
  // A long route can therefore contain several in-flight markers. A short route can be empty between emissions.
  // Every edge emits at the same cadence.
  const travelMs = metric.total / FLOW_SPEED_WORLD_PER_SECOND * 1000;
  if (!(travelMs > 0)) return;
  const newestAgeMs = (now + state.phaseOffsetMs) % FLOW_EMISSION_INTERVAL_MS;
  const markerCount = Math.min(
    FLOW_MAX_MARKERS_PER_EDGE,
    Math.max(0, Math.floor((travelMs - newestAgeMs) / FLOW_EMISSION_INTERVAL_MS) + 1),
  );

  ctx.save();
  ctx.globalAlpha = 0.96;
  ctx.fillStyle = graphColor("halo");
  for (let index = 0; index < markerCount; index += 1) {
    const ageMs = newestAgeMs + index * FLOW_EMISSION_INTERVAL_MS;
    if (ageMs < 0 || ageMs > travelMs) continue;
    const worldDistance = ageMs / 1000 * FLOW_SPEED_WORLD_PER_SECOND;
    const point = storageRoutePoint(points, worldDistance / metric.total);
    ctx.beginPath();
    ctx.arc(point.x, point.y, FLOW_DOT_RADIUS_WORLD, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawStorageFlowMarker(ctx, edge, now, points, selected) {
  if (!selected || !isStorageRouteEdge(edge) || reducedMotionPreferred()) return;
  drawNormalizedFlowMarker(ctx, edge, now, points);
}

function strokeEdgePath(ctx, routePoints, a, p1, p2, b) {
  ctx.beginPath();
  if (routePoints) drawStorageRoute(ctx, routePoints);
  else {
    ctx.moveTo(a.x, a.y);
    ctx.bezierCurveTo(p1.x, p1.y, p2.x, p2.y, b.x, b.y);
  }
  ctx.stroke();
}

function drawSelectedLogicalDependencyHalo(ctx, edge, routePoints, a, p1, p2, b) {
  if (!model.focusedId || !isLogicalDependencyEdge(edge)) return;
  if (edge.from !== model.focusedId && edge.to !== model.focusedId) return;
  const style = edgeDashPattern(edge);
  ctx.save();
  ctx.globalAlpha = 0.30;
  ctx.strokeStyle = graphColor("halo");
  ctx.setLineDash(style.dash);
  ctx.lineWidth = style.width + 3.4;
  ctx.shadowColor = graphColor("halo");
  ctx.shadowBlur = 7 / Math.max(0.2, Number(model.scale || 1));
  strokeEdgePath(ctx, routePoints, a, p1, p2, b);
  ctx.restore();
}

function drawEdge(ctx, edge, now, focused) {
  const from = model.layout.get(edge.from);
  const to = model.layout.get(edge.to);
  if (!from || !to) return;
  const straightStorage = isStorageRouteEdge(edge);
  const storageRoute = straightStorage ? storageRouteGeometry(from, to, edge) : null;
  const lineageRoute = straightStorage ? null : ensureLineageRouteCache().get(edge.id);
  const a = straightStorage
    ? storageRoute.points[0]
    : (lineageRoute?.a || { x: from.x + from.width, y: from.y + from.height / 2 });
  const b = straightStorage
    ? storageRoute.points[storageRoute.points.length - 1]
    : (lineageRoute?.b || { x: to.x, y: to.y + to.height / 2 });
  const dx = Math.max(42, Math.abs(b.x - a.x) * 0.45);
  const p1 = straightStorage ? a : { x: a.x + dx, y: a.y };
  const p2 = straightStorage ? b : { x: b.x - dx, y: b.y };
  const routePoints = straightStorage ? storageRoute.points : (lineageRoute?.points || null);
  const selected = !focused || (focused.has(edge.from) && focused.has(edge.to));
  // Hit testing and labels use the exact drawn geometry of this frame.
  if (model.edgeGeometry) model.edgeGeometry.set(edge.id, routePoints || bezierRoutePoints(a, p1, p2, b, 24));
  const highlighted = edgeIsHighlighted(edge);
  ctx.save();
  drawSelectedLogicalDependencyHalo(ctx, edge, routePoints, a, p1, p2, b);
  ctx.globalAlpha = highlighted ? 1 : selected ? 0.8 : Math.min(0.2, dimAlpha());
  ctx.strokeStyle = highlighted ? graphColor("halo") : isLogicalDependencyEdge(edge) ? graphColor("edgeMuted") : graphColor("edge");
  edgeStyle(edge, ctx);
  if (highlighted) ctx.lineWidth += 1.2;
  // Dash patterns encode edge meaning. They never move.
  // Motion is reserved for the one normalized round marker on actual insert-time data flow.
  strokeEdgePath(ctx, routePoints, a, p1, p2, b);

  // The arrow head follows the final segment of a routed polyline.
  // Otherwise, it follows the Bezier tangent.
  const routed = Array.isArray(routePoints) && routePoints.length >= 2;
  const near = routed ? storageRoutePoint(routePoints, 0.985) : bezierPoint(a, p1, p2, b, 0.97);
  const tip = b;
  const angle = routed ? near.angle : Math.atan2(tip.y - near.y, tip.x - near.x);
  ctx.setLineDash([]);
  ctx.fillStyle = ctx.strokeStyle;
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(tip.x - 8 * Math.cos(angle - 0.5), tip.y - 8 * Math.sin(angle - 0.5));
  ctx.lineTo(tip.x - 8 * Math.cos(angle + 0.5), tip.y - 8 * Math.sin(angle + 0.5));
  ctx.closePath();
  ctx.fill();

  if (straightStorage) drawStorageFlowMarker(ctx, edge, now, routePoints, selected);
  const lifecyclePoint = straightStorage ? storageRoutePoint(routePoints, 0.5) : null;
  drawLifecycleEdgeLabel(ctx, edge, a, p1, p2, b, selected, lifecyclePoint);
  if (!straightStorage && selected && lineageEdgeShouldAnimate(edge)) {
    drawNormalizedFlowMarker(ctx, edge, now, routePoints || bezierRoutePoints(a, p1, p2, b));
  }
  ctx.restore();
}

function drawLifecycleEdgeLabel(ctx, edge, a, p1, p2, b, selected, explicitPoint = null) {
  const lines = ttlEdgeLabelLines(edge);
  if (!lines.length) return;
  const point = explicitPoint || bezierPoint(a, p1, p2, b, 0.5);
  ctx.save();
  ctx.setLineDash([]);
  ctx.font = `600 11px ${FONT}`;
  const width = Math.min(224, Math.max(...lines.map((line) => ctx.measureText(line).width)) + 20);
  const lineHeight = 15;
  const height = lines.length * lineHeight + 8;
  const x = point.x - width / 2;
  const y = point.y - height / 2;
  // Lifecycle labels are semantic data, not decorative overlays.
  // Keep them fully opaque, even when another node is focused.
  // The MOVE and DELETE rules then stay readable against the animated storage route.
  ctx.globalAlpha = 1;
  roundedRectPath(ctx, x, y, width, height, 6);
  // --table-bg is intentionally translucent in the general UI theme.
  // TTL labels sit on top of moving routes. They must use the fully opaque panel background.
  // Otherwise the arrow stays visible through the label.
  ctx.fillStyle = graphColor("labelBg");
  ctx.fill();
  ctx.strokeStyle = graphColor("border");
  ctx.lineWidth = 0.8;
  ctx.stroke();
  for (let index = 0; index < lines.length; index += 1) {
    ctx.fillStyle = index === 0 ? graphColor("accentText") : graphColor("text");
    ctx.font = `${index === 0 ? "600" : "400"} 11px ${FONT}`;
    ctx.textAlign = "center";
    ctx.fillText(canvasEllipsis(ctx, lines[index], width - 12), point.x, y + 15 + index * lineHeight);
  }
  ctx.textAlign = "left";
  ctx.restore();
}

function edgeIsHighlighted(edge) {
  if (!edge) return false;
  if (model.hoveredEdgeId === edge.id) return true;
  if (model.panel?.type === "edge" && model.panel.id === edge.id) return true;
  const hover = model.hoveredId;
  return !!hover && (edge.from === hover || edge.to === hover);
}

// Every Lineage edge has its label (kind, "x N" between databases).
// The code places each label once per routed layout, in a fixed priority order.
// The order is: edges of the focused object, then data flow, then dependencies.
// The label goes at the first anchor along the route. That anchor covers no card, no per-node expand control and no other label (kit.placeLabels).
// Hover and selection only restyle a label where it was placed. They never move it on top of another one.
function edgeLabelLayout(ctx) {
  const routes = ensureLineageRouteCache();
  const edges = visibleEdges();
  const controlsKey = `${model.focusedId || ""}\u0000${[...model.expansions].sort().join("\u0001")}`;
  const cache = model.edgeLabelCache;
  if (cache && cache.routes === routes && cache.edges === edges && cache.layout === model.layout && cache.controlsKey === controlsKey) return cache;
  ctx.save();
  ctx.font = `600 12px ${FONT}`;
  const obstacles = [...model.layout.values()].map((item) => ({ x: item.x, y: item.y, width: item.width, height: item.height }));
  ctx.font = `600 12px ${FONT}`;
  for (const item of model.layout.values()) {
    for (const control of nodeExpandControls(item)) {
      const width = Math.max(24, ctx.measureText(control.label).width + 14);
      obstacles.push({ x: control.cx - width / 2, y: control.cy - 10, width, height: 20 });
    }
  }
  ctx.font = `600 12px ${FONT}`;
  const touchesFocus = (edge) => !!model.focusedId && (edge.from === model.focusedId || edge.to === model.focusedId);
  const ordered = edges.filter((edge) => !isStorageRouteEdge(edge) && routes.get(edge.id)).sort((a, b) => (
    Number(touchesFocus(b)) - Number(touchesFocus(a))
    || Number(isLogicalDependencyEdge(a)) - Number(isLogicalDependencyEdge(b))
    || String(a.id).localeCompare(String(b.id))
  ));
  const requests = ordered.map((edge) => {
    const text = edgeShortLabel(edge);
    return { key: edge.id, edge, text, width: ctx.measureText(text).width + 12, height: 18, points: routes.get(edge.id).points };
  });
  ctx.restore();
  const { placed, dropped } = kit.placeLabels(requests, obstacles);
  model.edgeLabelCache = { routes, edges, layout: model.layout, controlsKey, requests, placed, dropped };
  return model.edgeLabelCache;
}

function drawEdgeLabels(ctx, edges, focused, frame) {
  if (model.detailMode !== "logical") return;
  const layout = edgeLabelLayout(ctx);
  // The code skips labels outside the viewport (world-space culling).
  const left = -model.offsetX / model.scale;
  const top = -model.offsetY / model.scale;
  const right = left + frame.width / model.scale;
  const bottom = top + frame.height / model.scale;
  ctx.save();
  ctx.font = `600 12px ${FONT}`;
  for (const request of layout.requests) {
    const rect = layout.placed.get(request.key);
    if (!rect) continue;
    if (rect.x > right || rect.x + rect.width < left || rect.y > bottom || rect.y + rect.height < top) continue;
    const edge = request.edge;
    const highlighted = edgeIsHighlighted(edge);
    const selected = !focused || (focused.has(edge.from) && focused.has(edge.to));
    kit.drawLabel(ctx, rect, request.text, { highlighted, alpha: highlighted || selected ? 1 : dimAlpha() });
    model.edgeLabelHits.push({ edge, ...rect });
  }
  ctx.restore();
}

export { drawEdge, drawEdgeLabels, edgeDashPattern, lineageEdgeShouldAnimate };
