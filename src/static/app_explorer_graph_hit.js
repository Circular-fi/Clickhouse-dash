// What is under the pointer on the Explorer graph's canvas: a control, a card or an edge (the kit's controller asks for it).

import { dom } from "./app_dom.js";
import { compactCards, databaseBandHeader, drawnBox } from "./app_explorer_graph_nodes.js";
import { visibleEdges } from "./app_explorer_graph_scene.js";
import { model, screenToWorld } from "./app_explorer_graph_store.js";
import { databaseBounds } from "./app_explorer_graph_viewport.js";

function eventWorldPoint(clientX, clientY) {
  const rect = dom.explorerGraphCanvas.getBoundingClientRect();
  return screenToWorld(clientX - rect.left, clientY - rect.top);
}

function pointInRect(point, rect, padding = 0) {
  return point.x >= rect.x - padding && point.x <= rect.x + rect.width + padding
    && point.y >= rect.y - padding && point.y <= rect.y + rect.height + padding;
}

function hitControl(clientX, clientY) {
  if (!dom.explorerGraphCanvas) return null;
  const point = eventWorldPoint(clientX, clientY);
  const padding = 3 / Math.max(0.05, model.scale);
  const control = (model.controlHits || []).find((hit) => pointInRect(point, hit, padding));
  if (control) return { type: "expand", key: control.key, control };
  if (model.detailMode === "logical" && !model.focusedId && model.groupStats && model.groupStats.size > 1) {
    for (const [database, box] of databaseBounds()) {
      if (pointInRect(point, databaseBandHeader(box))) return { type: "band", database };
    }
  }
  return null;
}

function distanceToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const t = length > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function hitEdge(clientX, clientY) {
  if (!dom.explorerGraphCanvas || !model.edgeGeometry || model.scale < 0.2) return null;
  const point = eventWorldPoint(clientX, clientY);
  const itemById = new Map(visibleEdges().map((edge) => [edge.id, edge]));
  for (const hit of model.edgeLabelHits || []) {
    if (pointInRect(point, hit, 2 / model.scale) && itemById.has(hit.edge.id)) return itemById.get(hit.edge.id);
  }
  const tolerance = 6 / model.scale;
  let best = null;
  for (const [id, points] of model.edgeGeometry) {
    const edge = itemById.get(id);
    if (!edge || !Array.isArray(points)) continue;
    for (let i = 1; i < points.length; i += 1) {
      const distance = distanceToSegment(point, points[i - 1], points[i]);
      if (distance <= tolerance && (!best || distance < best.distance)) best = { edge, distance };
    }
  }
  return best ? best.edge : null;
}

function hitNode(clientX, clientY) {
  const canvas = dom.explorerGraphCanvas;
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const world = screenToWorld(clientX - rect.left, clientY - rect.top);
  const items = [...model.layout.values()].reverse();
  // A compact card is hit on the box it draws.
  const compact = compactCards();
  for (const item of items) {
    const box = drawnBox(item, compact);
    if (world.x >= box.x && world.x <= box.x + box.width && world.y >= box.y && world.y <= box.y + box.height) return item.node;
  }
  return null;
}

function nodeIsStorageDisabled(node) {
  return !!node && model.detailMode === "physical" && node.layer === "logical" && node.storage_disabled === true;
}

function nodeIsClickable(node) {
  return !!node && !nodeIsStorageDisabled(node);
}

// What is under the pointer, for the kit controller: an expand control or
// a database band header first, then a card, then an edge (or its label).
function hitTarget(clientX, clientY) {
  const control = hitControl(clientX, clientY);
  if (control) {
    return { type: control.type, key: `${control.type}\u0000${control.key || control.database}`, expandKey: control.key, database: control.database };
  }
  const node = hitNode(clientX, clientY);
  if (node) return { type: "node", key: `node\u0000${node.id}`, node, disabled: !nodeIsClickable(node) };
  const edge = hitEdge(clientX, clientY);
  if (edge) return { type: "edge", key: `edge\u0000${edge.id}`, edge };
  return null;
}

function nodeTarget(id) {
  const item = model.layout.get(id);
  return item ? { type: "node", key: `node\u0000${id}`, node: item.node, disabled: !nodeIsClickable(item.node) } : null;
}

export { hitTarget, nodeIsClickable, nodeTarget };
