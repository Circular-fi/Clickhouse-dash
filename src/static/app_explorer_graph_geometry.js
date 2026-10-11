// The shapes of the Explorer graph's edges, without a canvas: the Bezier of a curved edge, the route of a Storage edge between two cards, and
// which edges are data flow. Pure: tests/frontend/model/explorer-graph-model.test.cjs.

function bezierPoint(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const tt = t * t;
  const uu = u * u;
  const uuu = uu * u;
  const ttt = tt * t;
  return {
    x: uuu * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3.x,
    y: uuu * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3.y,
  };
}

function bezierRoutePoints(a, p1, p2, b, samples = 40) {
  const points = [];
  for (let i = 0; i <= samples; i += 1) points.push(bezierPoint(a, p1, p2, b, i / samples));
  return points;
}

function storageRouteGeometry(from, to, edge) {
  const fromNode = from?.node || {};
  const toNode = to?.node || {};

  // A Buffer sits above the MergeTree/table it flushes into. Use bottom/top
  // ports for that vertical semantic relation instead of routing out of the
  // right edge and back into the left edge.
  if (String(edge?.kind || "") === "buffer" && from.y + from.height <= to.y + 2) {
    const overlapLeft = Math.max(from.x, to.x);
    const overlapRight = Math.min(from.x + from.width, to.x + to.width);
    if (overlapRight >= overlapLeft) {
      const x = (overlapLeft + overlapRight) / 2;
      return {
        points: [
          { x, y: from.y + from.height },
          { x, y: to.y },
        ],
        vertical: true,
      };
    }
    // The layout normally keeps a vertical storage stack overlapping. Keep a
    // conservative orthogonal fallback only for malformed/legacy layouts.
    const a = { x: from.x + from.width / 2, y: from.y + from.height };
    const b = { x: to.x + to.width / 2, y: to.y };
    const midY = a.y + Math.max(18, (b.y - a.y) / 2);
    return { points: [a, { x: a.x, y: midY }, { x: b.x, y: midY }, b], vertical: true };
  }

  // Consecutive policy volumes are intentionally stacked. Their lifecycle
  // transition therefore uses a straight vertical segment through the card
  // centres instead of a diagonal line across both cards.
  if (fromNode.kind === "storage_tier" && toNode.kind === "storage_tier" && Math.abs(from.x - to.x) < 2) {
    return {
      points: [
        { x: from.x + from.width / 2, y: from.y + from.height },
        { x: to.x + to.width / 2, y: to.y },
      ],
      vertical: true,
    };
  }

  // Cards that share a top row use the same semantic port so the arrow is
  // literally horizontal even when the cards have different heights.
  if (Math.abs(from.y - to.y) < 2) {
    const y = from.y + Math.min(36, from.height / 2, to.height / 2);
    return {
      points: [
        { x: from.x + from.width, y },
        { x: to.x, y },
      ],
      vertical: false,
    };
  }

  const a = { x: from.x + from.width, y: from.y + from.height / 2 };
  const b = { x: to.x, y: to.y + to.height / 2 };
  const midX = a.x + (b.x - a.x) / 2;
  return {
    points: [a, { x: midX, y: a.y }, { x: midX, y: b.y }, b],
    vertical: false,
  };
}

// A Storage edge draws as a route between its cards (not as a curve), in Storage only.
function isStorageRouteEdge(edge, detailMode) {
  return detailMode === "physical" && [
    "storage_policy", "policy_volume", "volume_tier", "ttl_move", "ttl_delete", "contains", "buffer",
  ].includes(String(edge?.kind || ""));
}

function isInsertFlowEdge(edge) {
  const kind = String(edge?.kind || "");
  // A normal View is query-time lineage only: inserts do not flow into it.
  // Buffer forwarding and ordinary Materialized Views are insert-time paths.
  return kind === "buffer" || kind === "materialized_view" || kind === "materialized_view_output";
}

function isRefreshFlowEdge(edge) {
  const kind = String(edge?.kind || "");
  return kind === "refreshable_mv" || kind === "refreshable_mv_output";
}

export { bezierPoint, bezierRoutePoints, isInsertFlowEdge, isRefreshFlowEdge, isStorageRouteEdge, storageRouteGeometry };
