// The layout of the Explorer graph: where each card goes. The layered kit gives the columns and rows; the rules here keep a focus change from
// moving what stays (stabilizeLayoutPositions), wrap a mostly disconnected graph into lanes, give Lineage one band per database and line up the
// Storage tiers. A function takes the cards and the mode and returns positions: no DOM, no state (tests/frontend/model/explorer-graph-model.test.cjs).

import { NODE_HEIGHT, NODE_WIDTH, PHYSICAL_HEIGHT, X_GAP, Y_GAP, isLogicalDependencyEdge, nodeSize } from "./app_explorer_graph_model.js";
import { graphKit } from "./app_graph_kit.js";

const kit = graphKit;

function rectsOverlap(a, b, padding = 14) {
  return !(
    a.x + a.width + padding <= b.x ||
    b.x + b.width + padding <= a.x ||
    a.y + a.height + padding <= b.y ||
    b.y + b.height + padding <= a.y
  );
}

function stabilizeLayoutPositions(positions, idealPositions, previousLayout, edges, { preserveIds = null, focusedId = null } = {}) {
  if (!(previousLayout instanceof Map) || previousLayout.size === 0 || positions.size === 0) return;

  const preserveOnly = preserveIds instanceof Set && preserveIds.size ? preserveIds : null;
  const retained = new Set();
  for (const [id, item] of positions) {
    if (preserveOnly && !preserveOnly.has(id)) continue;
    const previous = previousLayout.get(id);
    if (!previous) continue;
    item.x = previous.x;
    item.y = previous.y;
    retained.add(id);
  }
  if (!retained.size) return;

  // Existing nodes are immutable during a focus/depth transition. New nodes
  // are placed relative to already-visible neighbours, then nudged only when
  // necessary to avoid covering an immutable node. This deliberately trades
  // global crossing minimisation for a stable spatial mental model.
  const connectedRetained = new Map();
  for (const edge of edges || []) {
    if (retained.has(edge.from) && positions.has(edge.to) && !retained.has(edge.to)) {
      if (!connectedRetained.has(edge.to)) connectedRetained.set(edge.to, []);
      connectedRetained.get(edge.to).push(edge.from);
    }
    if (retained.has(edge.to) && positions.has(edge.from) && !retained.has(edge.from)) {
      if (!connectedRetained.has(edge.from)) connectedRetained.set(edge.from, []);
      connectedRetained.get(edge.from).push(edge.to);
    }
  }

  const anchorId = retained.has(focusedId) ? focusedId : retained.values().next().value;
  const anchorPrevious = previousLayout.get(anchorId);
  const anchorIdeal = idealPositions.get(anchorId);
  const fallbackDx = anchorPrevious && anchorIdeal ? anchorPrevious.x - anchorIdeal.x : 0;
  const fallbackDy = anchorPrevious && anchorIdeal ? anchorPrevious.y - anchorIdeal.y : 0;

  const occupied = [...retained].map((id) => positions.get(id)).filter(Boolean);
  const newItems = [...positions.entries()]
    .filter(([id]) => !retained.has(id))
    .sort((a, b) => {
      const ai = idealPositions.get(a[0]) || a[1];
      const bi = idealPositions.get(b[0]) || b[1];
      return ai.x - bi.x || ai.y - bi.y || a[0].localeCompare(b[0]);
    });

  for (const [id, item] of newItems) {
    const ideal = idealPositions.get(id) || item;
    const neighbours = connectedRetained.get(id) || [];
    if (neighbours.length) {
      let sx = 0;
      let sy = 0;
      let count = 0;
      for (const neighbourId of neighbours) {
        const previous = previousLayout.get(neighbourId);
        const neighbourIdeal = idealPositions.get(neighbourId);
        if (!previous || !neighbourIdeal) continue;
        sx += previous.x + (ideal.x - neighbourIdeal.x);
        sy += previous.y + (ideal.y - neighbourIdeal.y);
        count += 1;
      }
      if (count) {
        item.x = sx / count;
        item.y = sy / count;
      } else {
        item.x = ideal.x + fallbackDx;
        item.y = ideal.y + fallbackDy;
      }
    } else {
      item.x = ideal.x + fallbackDx;
      item.y = ideal.y + fallbackDy;
    }

    const baseX = item.x;
    const baseY = item.y;
    const yStep = Math.max(NODE_HEIGHT, item.height) + Y_GAP;
    const xStep = Math.max(NODE_WIDTH, item.width) + X_GAP;
    const clear = () => occupied.every((other) => !rectsOverlap(item, other));
    if (!clear()) {
      let placed = false;
      for (let ring = 1; ring <= 18 && !placed; ring += 1) {
        for (const sign of [1, -1]) {
          item.x = baseX;
          item.y = baseY + sign * ring * yStep;
          if (clear()) { placed = true; break; }
        }
      }
      if (!placed) {
        for (let ring = 1; ring <= 10 && !placed; ring += 1) {
          for (const sign of [1, -1]) {
            item.x = baseX + sign * ring * xStep;
            item.y = baseY;
            if (clear()) { placed = true; break; }
          }
        }
      }
    }
    occupied.push(item);
  }
}

function alignPhysicalStorageRows(positions, nodes, edges, level, detailMode) {
  if (detailMode !== "physical" || positions.size < 2) return;

  const itemById = new Map(nodes.map((node) => [node.id, node]));
  const adjacency = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    if (!itemById.has(edge.from) || !itemById.has(edge.to)) continue;
    adjacency.get(edge.from)?.push(edge.to);
    adjacency.get(edge.to)?.push(edge.from);
  }

  const components = [];
  const seen = new Set();
  const stableId = (id) => {
    const node = itemById.get(id);
    return `${node?.database || ""}.${node?.name || ""}.${id}`;
  };
  for (const node of nodes.slice().sort((a, b) => stableId(a.id).localeCompare(stableId(b.id)))) {
    if (seen.has(node.id)) continue;
    const component = [];
    const queue = [node.id];
    seen.add(node.id);
    while (queue.length) {
      const id = queue.shift();
      component.push(id);
      for (const nextId of adjacency.get(id) || []) {
        if (seen.has(nextId)) continue;
        seen.add(nextId);
        queue.push(nextId);
      }
    }
    components.push(component);
  }

  const rowGap = 28;
  // Storage tiers need enough vertical runway for both the moving marker and
  // the TTL transition label. Keep this separate from generic row spacing so
  // tables in the same database remain compact while hot -> warm arrows stay
  // visually obvious.
  const storageTierGap = 82;
  const componentGap = 78;
  const columnGap = 150;
  let cursorY = 70;

  for (const component of components) {
    const logicalIds = component.filter((id) => itemById.get(id)?.layer === "logical").sort((a, b) => stableId(a).localeCompare(stableId(b)));
    const tierIds = component.filter((id) => itemById.get(id)?.kind === "storage_tier").sort((a, b) => {
      const an = itemById.get(a);
      const bn = itemById.get(b);
      return Number(an?.volume_priority || 0) - Number(bn?.volume_priority || 0)
        || stableId(a).localeCompare(stableId(b));
    });
    const expiredIds = component.filter((id) => itemById.get(id)?.kind === "ttl_expired").sort((a, b) => stableId(a).localeCompare(stableId(b)));
    const customStorage = tierIds.length > 0;

    if (!customStorage) {
      const groups = new Map();
      for (const id of component) {
        const l = Number(level.get(id) || 0);
        if (!groups.has(l)) groups.set(l, []);
        groups.get(l).push(id);
      }
      let componentHeight = 0;
      const stackHeights = new Map();
      for (const [l, ids] of groups) {
        ids.sort((a, b) => (positions.get(a)?.y ?? 0) - (positions.get(b)?.y ?? 0) || stableId(a).localeCompare(stableId(b)));
        const height = ids.reduce((total, id) => total + (positions.get(id)?.height || PHYSICAL_HEIGHT), 0)
          + Math.max(0, ids.length - 1) * rowGap;
        stackHeights.set(l, height);
        componentHeight = Math.max(componentHeight, height);
      }
      const centerY = cursorY + Math.max(componentHeight, PHYSICAL_HEIGHT) / 2;
      for (const [l, ids] of groups) {
        let y = centerY - (stackHeights.get(l) || componentHeight) / 2;
        for (const id of ids) {
          const item = positions.get(id);
          if (!item) continue;
          item.y = y;
          y += item.height + rowGap;
        }
      }

      // Buffer is always a stage above the table(s) it flushes into in the
      // Storage view. Repeat the constraint because Buffer -> Buffer -> table
      // chains are legal and a single pass would only align the last hop.
      const componentSet = new Set(component);
      const bufferEdges = edges.filter((edge) => edge.kind === "buffer"
        && componentSet.has(edge.from) && componentSet.has(edge.to)
        && itemById.get(edge.from)?.kind === "buffer");
      for (let pass = 0; pass < component.length; pass += 1) {
        let changed = false;
        for (const edge of bufferEdges) {
          const source = positions.get(edge.from);
          const target = positions.get(edge.to);
          if (!source || !target) continue;
          const maxSourceY = target.y - source.height - rowGap;
          if (source.y > maxSourceY) {
            source.y = maxSourceY;
            changed = true;
          }
        }
        if (!changed) break;
      }
      const minY = Math.min(...component.map((id) => positions.get(id)?.y ?? cursorY));
      if (minY < cursorY) {
        const shift = cursorY - minY;
        for (const id of component) {
          const item = positions.get(id);
          if (item) item.y += shift;
        }
      }
      const componentBottom = Math.max(...component.map((id) => {
        const item = positions.get(id);
        return item ? item.y + item.height : cursorY;
      }));
      cursorY = componentBottom + componentGap;
      continue;
    }

    // Storage has a deliberately stricter visual grammar than lineage:
    // the logical table starts the row, all volumes of its policy are stacked
    // in one column, and the terminal sits to the right of the last tier.
    // This prevents a ClickHouse policy from looking like an extra storage
    // hop and keeps connected card tops aligned by row.
    const bufferIds = logicalIds.filter((id) => itemById.get(id)?.kind === "buffer");
    const storedLogicalIds = logicalIds.filter((id) => itemById.get(id)?.kind !== "buffer");

    // Logical cards stacked vertically belong to one storage lane. Keep the
    // cards the same width so their centres line up and vertical Buffer ->
    // target edges can be drawn as one straight segment.
    const logicalStackWidth = Math.max(0, ...logicalIds.map((id) => positions.get(id)?.width || 0));
    if (logicalStackWidth > 0) {
      for (const id of logicalIds) {
        const item = positions.get(id);
        if (item) item.width = logicalStackWidth;
      }
    }

    let logicalY = cursorY;
    let logicalRight = 70;

    if (bufferIds.length && storedLogicalIds.length) {
      // Storage reads top-to-bottom for Buffer routing: every Buffer card must
      // appear above every direct downstream target. Topologically order only
      // Buffer edges, then stack the logical cards in one column before their
      // storage policy/volume lifecycle starts to the right.
      const logicalSet = new Set(logicalIds);
      const bufferRoutingEdges = edges.filter((edge) => edge.kind === "buffer"
        && logicalSet.has(edge.from) && logicalSet.has(edge.to)
        && itemById.get(edge.from)?.kind === "buffer");
      const indegree = new Map(logicalIds.map((id) => [id, 0]));
      const outgoing = new Map(logicalIds.map((id) => [id, []]));
      for (const edge of bufferRoutingEdges) {
        outgoing.get(edge.from)?.push(edge.to);
        indegree.set(edge.to, (indegree.get(edge.to) || 0) + 1);
      }
      const priority = (a, b) => {
        const aBuffer = itemById.get(a)?.kind === "buffer" ? 0 : 1;
        const bBuffer = itemById.get(b)?.kind === "buffer" ? 0 : 1;
        return aBuffer - bBuffer || stableId(a).localeCompare(stableId(b));
      };
      const queue = logicalIds.filter((id) => (indegree.get(id) || 0) === 0).sort(priority);
      const ordered = [];
      while (queue.length) {
        const id = queue.shift();
        ordered.push(id);
        for (const target of outgoing.get(id) || []) {
          indegree.set(target, (indegree.get(target) || 0) - 1);
          if ((indegree.get(target) || 0) === 0) {
            queue.push(target);
            queue.sort(priority);
          }
        }
      }
      for (const id of logicalIds) if (!ordered.includes(id)) ordered.push(id);

      for (const id of ordered) {
        const item = positions.get(id);
        if (!item) continue;
        item.x = 70;
        item.y = logicalY;
        logicalRight = Math.max(logicalRight, item.x + item.width);
        logicalY += item.height + rowGap;
      }
    } else {
      for (const id of logicalIds) {
        const item = positions.get(id);
        if (!item) continue;
        item.x = 70;
        item.y = logicalY;
        logicalRight = Math.max(logicalRight, item.x + item.width);
        logicalY += item.height + rowGap;
      }
    }

    const storedAnchorY = storedLogicalIds
      .map((id) => positions.get(id)?.y)
      .filter((value) => Number.isFinite(value))
      .reduce((best, value) => Math.min(best, value), Number.POSITIVE_INFINITY);
    const storageRowY = Number.isFinite(storedAnchorY) ? storedAnchorY : cursorY;
    const middleIds = component.filter((id) => {
      const node = itemById.get(id);
      return node && node.layer === "physical" && node.kind !== "storage_tier" && node.kind !== "ttl_expired";
    });
    let middleRight = logicalRight;
    if (middleIds.length) {
      const middleX = logicalRight + columnGap;
      let middleY = storageRowY;
      for (const id of middleIds.sort((a, b) => Number(level.get(a) || 0) - Number(level.get(b) || 0) || stableId(a).localeCompare(stableId(b)))) {
        const item = positions.get(id);
        if (!item) continue;
        item.x = middleX;
        item.y = middleY;
        middleRight = Math.max(middleRight, item.x + item.width);
        middleY += item.height + rowGap;
      }
    }

    const tierX = Math.max(logicalRight, middleRight) + columnGap;
    let tierY = storageRowY;
    const maxTierWidth = Math.max(0, ...tierIds.map((id) => positions.get(id)?.width || 0));
    const lastTierByRoot = new Map();
    for (const id of tierIds) {
      const item = positions.get(id);
      const node = itemById.get(id);
      if (!item || !node) continue;
      item.x = tierX;
      item.y = tierY;
      if (maxTierWidth > 0) item.width = maxTierWidth;
      for (const rootId of node.root_logical_ids || []) lastTierByRoot.set(rootId, id);
      tierY += item.height + storageTierGap;
    }

    const terminalX = tierX + maxTierWidth + columnGap;
    let terminalFallbackY = cursorY;
    for (const id of expiredIds) {
      const item = positions.get(id);
      const node = itemById.get(id);
      if (!item || !node) continue;
      const lastTier = positions.get(lastTierByRoot.get(node.root_logical_id));
      item.x = terminalX;
      item.y = lastTier ? lastTier.y : terminalFallbackY;
      terminalFallbackY += item.height + rowGap;
    }

    const componentBottom = Math.max(
      logicalY - rowGap,
      tierY - rowGap,
      terminalFallbackY - rowGap,
      ...component.map((id) => {
        const item = positions.get(id);
        return item ? item.y + item.height : cursorY;
      }),
    );
    cursorY = componentBottom + componentGap;
  }
}

function alignPhysicalHorizontalPeers(positions, edges, detailMode) {
  if (detailMode !== "physical" || positions.size < 2) return;
  const items = [...positions.values()];
  const overlapsAt = (item, y) => items.some((other) => {
    if (other === item) return false;
    const separatedX = item.x + item.width <= other.x || other.x + other.width <= item.x;
    if (separatedX) return false;
    return y < other.y + other.height + 8 && y + item.height + 8 > other.y;
  });
  for (let pass = 0; pass < 3; pass += 1) {
    for (const edge of edges) {
      if (String(edge?.kind || "") === "buffer") continue;
      const from = positions.get(edge.from);
      const to = positions.get(edge.to);
      if (!from || !to || Math.abs(from.x - to.x) < 24) continue;
      const storageEntry = from.node?.layer === "logical" && to.node?.layer === "physical"
        && ["storage_policy", "policy_volume", "volume_tier"].includes(String(edge?.kind || ""));
      // Logical table -> first storage card is a single horizontal lifecycle
      // step and should share one top row. Other physical tiers keep their
      // ordered vertical layout.
      if (!storageEntry && (from.node?.layer !== "logical" || to.node?.layer !== "logical")) continue;
      // Horizontal relationships read best when card tops share a row. Only
      // apply the alignment when it cannot overlap another card in that lane.
      if (!overlapsAt(to, from.y)) to.y = from.y;
    }
  }
}

function groupLogicalPositionsByDatabase(positions, detailMode, focus) {
  if (detailMode !== "logical" || !positions.size) return;
  const groups = new Map();
  for (const item of positions.values()) {
    if (item.node?.layer !== "logical") continue;
    const database = String(item.node.database || "default");
    if (!groups.has(database)) groups.set(database, []);
    groups.get(database).push(item);
  }
  if (groups.size <= 1) return;

  const order = [...groups.entries()].sort(([adb, aitems], [bdb, bitems]) => {
    if (focus?.database === adb && focus?.database !== bdb) return -1;
    if (focus?.database === bdb && focus?.database !== adb) return 1;
    const ax = Math.min(...aitems.map((item) => item.x));
    const bx = Math.min(...bitems.map((item) => item.x));
    return ax - bx || adb.localeCompare(bdb);
  });

  // A high fan-out source can have many direct consumers
  // consumers in the same database. A single tall DB lane made Fit content
  // shrink the whole topology until only database LOD blocks were readable.
  // Keep each DB as one visual group, but wrap dense same-level columns into
  // short sub-columns. This bounds group height without losing DB locality.
  const maxRowsPerSubcolumn = 6;
  const subcolumnGap = 28;
  const databaseGap = 58;
  const headerSpace = 38;
  const innerPad = 14;
  let cursorY = 64;

  // Collapsed database cards form a compact grid above the expanded bands:
  // a 20-database server overview stays a few rows of cards, not one column.
  const cardOnly = order.filter(([, items]) => items.length === 1 && items[0].node?.kind === "database_group");
  if (cardOnly.length) {
    const columnsCount = Math.max(1, Math.min(6, Math.ceil(Math.sqrt(cardOnly.length * 1.6))));
    const cardGapX = 48;
    const cardGapY = 40;
    cardOnly.forEach(([, [item]], index) => {
      item.x = 70 + (index % columnsCount) * (NODE_WIDTH + cardGapX);
      item.y = cursorY + Math.floor(index / columnsCount) * (NODE_HEIGHT + cardGapY);
      item.lineageRow = Math.floor(index / columnsCount);
    });
    cursorY += Math.ceil(cardOnly.length / columnsCount) * (NODE_HEIGHT + cardGapY) + databaseGap - cardGapY + headerSpace;
  }

  for (const [, items] of order) {
    if (items.length === 1 && items[0].node?.kind === "database_group") continue;
    const columns = new Map();
    for (const item of items) {
      const key = Math.round(item.x * 1000) / 1000;
      if (!columns.has(key)) columns.set(key, []);
      columns.get(key).push(item);
    }

    const packedColumns = [];
    let cursorX = Math.min(...items.map((item) => item.x));
    for (const [originalX, column] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
      column.sort((a, b) => a.y - b.y || String(a.node?.name || "").localeCompare(String(b.node?.name || "")));
      cursorX = Math.max(cursorX, originalX);
      const chunks = [];
      for (let start = 0; start < column.length; start += maxRowsPerSubcolumn) {
        chunks.push(column.slice(start, start + maxRowsPerSubcolumn));
      }
      let blockRight = cursorX;
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
        const chunk = chunks[chunkIndex];
        const chunkWidth = Math.max(...chunk.map((item) => item.width));
        const x = cursorX + chunkIndex * (chunkWidth + subcolumnGap);
        const height = chunk.reduce((sum, item, index) => sum + item.height + (index ? Y_GAP : 0), 0);
        packedColumns.push({ items: chunk, x, height });
        blockRight = Math.max(blockRight, x + chunkWidth);
      }
      cursorX = blockRight + X_GAP;
    }

    const contentHeight = Math.max(NODE_HEIGHT, ...packedColumns.map((column) => column.height));
    const bandTop = cursorY;
    for (const column of packedColumns) {
      let y = bandTop + headerSpace + innerPad + Math.max(0, (contentHeight - column.height) / 2);
      for (let index = 0; index < column.items.length; index += 1) {
        const item = column.items[index];
        item.x = column.x;
        item.y = y;
        item.lineageRow = index;
        y += item.height + Y_GAP;
      }
    }
    cursorY += headerSpace + innerPad * 2 + contentHeight + databaseGap;
  }
}

// The positions of the visible cards, from the layered kit and the Lineage / Storage rules: a card per node with its box, and the box that
// holds them. `previousLayout` (a Map) keeps the cards that stay where they were (a focus or depth change only places the new ones).
function layoutNodes({ nodes, edges, detailMode, focus = null, focusedId = null, previousLayout = null, preserveIds = null }) {
  const xGap = detailMode === "physical" ? 138 : X_GAP;
  const stableNodeCompare = (a, b) => {
    if (a.database !== b.database) return String(a.database).localeCompare(String(b.database));
    if (a.layer !== b.layer) return a.layer === "logical" ? -1 : 1;
    return String(a.name).localeCompare(String(b.name));
  };
  // Lineage is assigned to a *global* row grid (kit.layered rowGrid): a node
  // in column N can stay on the exact row of its parent/child even when
  // another column has a different number of nodes. Storage packs columns.
  const lineageRowPitch = detailMode === "logical"
    ? Math.max(NODE_HEIGHT, ...nodes.filter((node) => node.layer === "logical").map((node) => nodeSize(node, detailMode).height)) + Y_GAP
    : null;
  const { positions, level } = kit.layered({
    nodes,
    edges,
    size: (node) => nodeSize(node, detailMode),
    compare: stableNodeCompare,
    queueCompare: (an, bn) => {
      const adb = String(an?.database || "");
      const bdb = String(bn?.database || "");
      if (adb !== bdb) return adb.localeCompare(bdb);
      return String(an?.name || "").localeCompare(String(bn?.name || ""));
    },
    weight: (edge) => (isLogicalDependencyEdge(edge) ? 0.62 : 1.0),
    rowGrid: detailMode === "logical",
    rowPitch: lineageRowPitch,
    xGap,
    yGap: Y_GAP,
    minColumnWidth: NODE_WIDTH,
    origin: 70,
  });
  const levels = [...new Set(level.values())];

  // If the graph is mostly disconnected, the topological algorithm puts all
  // nodes in one very tall column. Wrap those nodes into deterministic lanes.
  if (levels.length <= 1 && nodes.length > 18) {
    positions.clear();
    const rowsPerColumn = Math.max(8, Math.ceil(Math.sqrt(nodes.length * 1.7)));
    // The tallest card, once: the rows of a lane are as high as it (ARCH-F-114).
    const rowHeight = (detailMode === "logical" ? Math.max(NODE_HEIGHT, ...nodes.map((candidate) => nodeSize(candidate, detailMode).height)) : NODE_HEIGHT) + Y_GAP;
    nodes.slice().sort((a, b) => `${a.database}.${a.name}`.localeCompare(`${b.database}.${b.name}`)).forEach((node, index) => {
      const col = Math.floor(index / rowsPerColumn);
      const row = index % rowsPerColumn;
      const size = nodeSize(node, detailMode);
      positions.set(node.id, {
        x: 70 + col * (NODE_WIDTH + xGap),
        y: 70 + row * rowHeight,
        width: size.width,
        height: size.height,
        node,
        lineageRow: row,
      });
    });
  }

  groupLogicalPositionsByDatabase(positions, detailMode, focus);
  alignPhysicalStorageRows(positions, nodes, edges, level, detailMode);
  alignPhysicalHorizontalPeers(positions, edges, detailMode);

  const idealPositions = new Map(
    [...positions.entries()].map(([id, item]) => [id, { ...item }])
  );
  if (previousLayout) stabilizeLayoutPositions(positions, idealPositions, previousLayout, edges, { preserveIds, focusedId });
  return { positions, bounds: layoutBounds(positions) };
}

// The box around the cards, 50 units wider on each side.
function layoutBounds(positions) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const item of positions.values()) {
    minX = Math.min(minX, item.x);
    minY = Math.min(minY, item.y);
    maxX = Math.max(maxX, item.x + item.width);
    maxY = Math.max(maxY, item.y + item.height);
  }
  return Number.isFinite(minX)
    ? { x: minX - 50, y: minY - 50, width: Math.max(1, maxX - minX + 100), height: Math.max(1, maxY - minY + 100) }
    : { x: 0, y: 0, width: 1, height: 1 };
}

export { alignPhysicalHorizontalPeers, alignPhysicalStorageRows, groupLogicalPositionsByDatabase, layoutBounds, layoutNodes, rectsOverlap, stabilizeLayoutPositions };
