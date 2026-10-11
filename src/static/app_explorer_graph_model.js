// The pure part of the Explorer graph (ARCH-F-155): the request that a scope makes, the projections of a payload (Lineage with its non-storing
// objects contracted, Storage with its tiers and TTL events), the database groups of the overview, the neighbourhood of a focus and what the
// focus needs. A function takes the payload and the view it is asked for and returns data: no DOM, no state, the caches are the scene's
// (app_explorer_graph_scene.js). tests/frontend/model/explorer-graph-model.test.cjs.

import { isSystemDatabaseName } from "./app_explorer_summary.js";

// The size of a card in world units, and the gaps of the layout.
const NODE_HEIGHT = 80;
const NODE_WIDTH = 264;
const PHYSICAL_WIDTH = 180;
const PHYSICAL_HEIGHT = 60;
const X_GAP = 92;
const Y_GAP = 34;

function parseLogicalTableId(id) {
  const raw = String(id || "");
  if (!raw.startsWith("table:")) return null;
  const qualified = raw.slice(6);
  const dot = qualified.indexOf(".");
  if (dot <= 0 || dot >= qualified.length - 1) return null;
  return { database: qualified.slice(0, dot), table: qualified.slice(dot + 1) };
}

// The table that a node id names, or the table the focus stands on in `graph`; null when none.
function focusScopeOf(graph, id) {
  if (!id) return null;
  const node = (graph?.nodes || []).find((candidate) => candidate.id === id && candidate.layer === "logical");
  if (node) return { database: String(node.database || ""), table: String(node.name || "") };
  return parseLogicalTableId(id);
}

// The request that shows the scope `view` names: { detailMode, includeSystem, includeNonStoring, focus: {database, table} | null, focusDepth, expansions, database }.
function graphRequestOptions(view, refresh = false) {
  const focus = view.focus;
  const options = {
    mode: view.detailMode,
    includeSystem: view.includeSystem,
    includeNonStoring: view.includeNonStoring,
    refresh: !!refresh,
  };
  if (focus?.database && focus?.table) {
    options.focusDatabase = focus.database;
    options.focusTable = focus.table;
    // Request exactly what is displayed. The backend exposes scope_has_more,
    // so the + depth control never needs a hidden look-ahead ring.
    options.depth = view.detailMode === "logical" ? Math.min(8, view.focusDepth) : 0;
    if (view.detailMode === "logical" && view.expansions.size) {
      options.expand = [...view.expansions].sort().map((key) => {
        const [direction, id] = key.split("\u0000");
        return `${direction}:${id}`;
      });
    }
  } else if (view.database) {
    options.database = view.database;
  }
  return options;
}

function graphRequestKey(options) {
  return [
    options.mode || "logical",
    options.database || "",
    options.focusDatabase || "",
    options.focusTable || "",
    Number(options.depth) || 0,
    options.includeSystem === true ? 1 : 0,
    options.includeNonStoring === false ? 0 : 1,
    (options.expand || []).join("\u0001"),
  ].join("\u0000");
}

// The ids within `depthLimit` hops of the focused object in a logical projection, or null when nothing is focused or the focus is not in it.
function neighborhoodIds(projection, focusedId, depthLimit) {
  if (!focusedId) return null;
  const logical = new Set(projection.nodes.map((node) => node.id));
  if (!logical.has(focusedId)) return null;
  const adjacency = new Map();
  for (const id of logical) adjacency.set(id, new Set());
  for (const edge of projection.edges) {
    if (!logical.has(edge.from) || !logical.has(edge.to)) continue;
    adjacency.get(edge.from)?.add(edge.to);
    adjacency.get(edge.to)?.add(edge.from);
  }
  const seen = new Set([focusedId]);
  let frontier = [focusedId];
  for (let depth = 0; depth < depthLimit; depth += 1) {
    const next = [];
    for (const id of frontier) {
      for (const neighbor of adjacency.get(id) || []) {
        if (seen.has(neighbor)) continue;
        seen.add(neighbor);
        next.push(neighbor);
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  return seen;
}

function isNonStoringNode(node) {
  return ["view", "materialized_view", "refreshable_materialized_view", "buffer"].includes(String(node?.kind || ""));
}

// Is the node shown with these visibility switches? (The focused object always is.)
function logicalNodeAllowed(node, view) {
  if (!node || node.layer !== "logical") return true;
  if (!view.includeSystem && isSystemDatabaseName(node.database)) return false;
  if (!view.includeNonStoring && isNonStoringNode(node) && node.id !== view.focusedId) return false;
  return true;
}

function collapsedEdgeKind(path) {
  if (path.some((part) => ["refreshable_mv", "refreshable_mv_output"].includes(part.kind))) return "refreshable_mv";
  if (path.some((part) => ["materialized_view", "materialized_view_output"].includes(part.kind))) return "materialized_view";
  if (path.some((part) => part.kind === "buffer")) return "buffer";
  return "view";
}

function buildLogicalProjection(graph, view) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes.filter((node) => node.layer === "logical") : [];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const systemHidden = (node) => !view.includeSystem && isSystemDatabaseName(node?.database);
  const collapseHidden = (node) => !view.includeNonStoring && isNonStoringNode(node) && node.id !== view.focusedId;
  const visible = new Set(nodes.filter((node) => !systemHidden(node) && !collapseHidden(node)).map((node) => node.id));
  const rawEdges = (graph?.edges || [])
    .filter((edge) => nodeById.has(edge.from) && nodeById.has(edge.to))
    .slice()
    .sort((a, b) => `${a.from}\u0000${a.to}\u0000${a.kind}\u0000${a.id}`.localeCompare(`${b.from}\u0000${b.to}\u0000${b.kind}\u0000${b.id}`));

  if (view.includeNonStoring) {
    return { nodes: nodes.filter((node) => visible.has(node.id)), edges: rawEdges.filter((edge) => visible.has(edge.from) && visible.has(edge.to)) };
  }

  const outgoing = new Map();
  for (const edge of rawEdges) {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from).push(edge);
  }

  const projected = [];
  const seen = new Set();
  const add = (edge) => {
    // Keep semantically distinct projected relations stable. De-duplicating on
    // endpoints alone made the result depend on traversal order when two
    // hidden paths represented different engines.
    const key = `${edge.from}\u0000${edge.to}\u0000${edge.kind}`;
    if (edge.from === edge.to || seen.has(key)) return;
    seen.add(key);
    projected.push(edge);
  };
  const addCollapsed = (source, target, path, hiddenIds) => {
    if (!visible.has(source) || !visible.has(target) || source === target) return;
    const kind = collapsedEdgeKind(path);
    const hidden = [...new Set(hiddenIds)];
    add({
      id: `collapsed:${source}:${target}:${kind}:${hidden.join(">")}`,
      from: source,
      to: target,
      kind,
      label: hidden.length === 1 ? "via hidden object" : `via ${hidden.length} hidden objects`,
      can_animate: kind === "materialized_view" || kind === "refreshable_mv" || kind === "buffer",
      collapsed: true,
      collapsed_path: hidden,
    });
  };

  for (const edge of rawEdges) {
    if (visible.has(edge.from) && visible.has(edge.to)) add(edge);
  }

  // A Buffer is a non-storing ingress object with one explicit forwarding
  // destination. When Buffer nodes are hidden, that destination is the stable
  // representative of the Buffer. This is what turns:
  //
  //   Buffer -> table1
  //   Buffer -> MV -> table2
  //
  // into table1 -> table2 rather than dropping the second branch entirely.
  // Nested Buffers stop at their own representative so a chain remains a
  // readable chain instead of becoming a transitive fan-out.
  const bufferRepresentativeMemo = new Map();
  const resolveBufferRepresentative = (bufferId, stack = new Set()) => {
    if (bufferRepresentativeMemo.has(bufferId)) return bufferRepresentativeMemo.get(bufferId);
    if (stack.has(bufferId)) return null;
    const node = nodeById.get(bufferId);
    if (!node || node.kind !== "buffer" || !collapseHidden(node)) return null;
    const nextStack = new Set(stack);
    nextStack.add(bufferId);
    for (const edge of outgoing.get(bufferId) || []) {
      if (edge.kind !== "buffer") continue;
      const target = nodeById.get(edge.to);
      if (!target || systemHidden(target)) continue;
      if (visible.has(edge.to)) {
        bufferRepresentativeMemo.set(bufferId, edge.to);
        return edge.to;
      }
      if (collapseHidden(target) && target.kind === "buffer") {
        const nested = resolveBufferRepresentative(edge.to, nextStack);
        if (nested) {
          bufferRepresentativeMemo.set(bufferId, nested);
          return nested;
        }
      }
    }
    bufferRepresentativeMemo.set(bufferId, null);
    return null;
  };

  const walkProjectedPath = (source, firstEdge, prefixHidden = []) => {
    const queue = [{ edge: firstEdge, path: [firstEdge], hidden: prefixHidden.slice(), trail: new Set(prefixHidden) }];
    const visited = new Set();
    while (queue.length) {
      const current = queue.shift();
      const targetNode = nodeById.get(current.edge.to);
      if (!targetNode || systemHidden(targetNode)) continue;
      if (visible.has(current.edge.to)) {
        addCollapsed(source, current.edge.to, current.path, current.hidden);
        continue;
      }
      if (!collapseHidden(targetNode)) continue;

      const hidden = current.hidden.concat(current.edge.to);
      if (targetNode.kind === "buffer") {
        const representative = resolveBufferRepresentative(current.edge.to);
        if (representative) addCollapsed(source, representative, current.path, hidden);
        continue;
      }

      const semantic = collapsedEdgeKind(current.path);
      const visitKey = `${current.edge.to}\u0000${semantic}`;
      if (visited.has(visitKey)) continue;
      visited.add(visitKey);
      const trail = new Set(current.trail);
      if (trail.has(current.edge.to)) continue;
      trail.add(current.edge.to);
      for (const edge of outgoing.get(current.edge.to) || []) {
        if (trail.has(edge.to)) continue;
        queue.push({ edge, path: current.path.concat(edge), hidden, trail });
      }
    }
  };

  // Standard contraction for visible -> hidden -> visible paths.
  for (const source of visible) {
    for (const edge of outgoing.get(source) || []) {
      const targetNode = nodeById.get(edge.to);
      if (!targetNode || systemHidden(targetNode) || !collapseHidden(targetNode)) continue;
      walkProjectedPath(source, edge);
    }
  }

  // Hidden Buffer fan-out has no incoming visible edge, so contract its other
  // outputs from the Buffer's forwarding destination (its representative).
  for (const node of nodes) {
    if (node.kind !== "buffer" || !collapseHidden(node) || systemHidden(node)) continue;
    const representative = resolveBufferRepresentative(node.id);
    if (!representative) continue;
    for (const edge of outgoing.get(node.id) || []) {
      walkProjectedPath(representative, edge, [node.id]);
    }
  }

  projected.sort((a, b) => `${a.from}\u0000${a.to}\u0000${a.kind}\u0000${a.id}`.localeCompare(`${b.from}\u0000${b.to}\u0000${b.kind}\u0000${b.id}`));
  return { nodes: nodes.filter((node) => visible.has(node.id)), edges: projected };
}

function canUseStorage(graph, id) {
  if (!id || !graph) return false;
  const nodes = graph.nodes || [];
  const edges = graph.edges || [];
  const itemById = new Map(nodes.map((node) => [node.id, node]));
  const outgoing = new Map();
  for (const edge of edges) {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from).push(edge);
  }
  const root = itemById.get(id);
  if (!root || root.layer !== "logical") return false;
  // Logical-only graph responses deliberately omit the physical layer. The
  // backend derives this flag from the complete cached topology so the UI can
  // still offer Storage without downloading every disk/volume/shard node.
  if (typeof root.storage_available === "boolean") return root.storage_available;

  // Persistent tables own physical placement directly. Buffer tables are a
  // special storage-mode routing object: they do not own parts themselves,
  // but their flush destination does. Treat a Buffer as storage-capable when
  // following Buffer forwarding edges reaches a persistently stored table.
  const seen = new Set();
  const visit = (currentId) => {
    if (!currentId || seen.has(currentId)) return false;
    seen.add(currentId);
    const current = itemById.get(currentId);
    if (!current || current.layer !== "logical") return false;
    if ((outgoing.get(currentId) || []).some((edge) => itemById.get(edge.to)?.layer === "physical")) return true;
    if (current.kind !== "buffer") return false;
    return (outgoing.get(currentId) || []).some((edge) => edge.kind === "buffer" && visit(edge.to));
  };
  return visit(id);
}

function rawStorageProjection(graph, view) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edgesAll = Array.isArray(graph?.edges) ? graph.edges : [];
  const itemById = new Map(nodes.map((node) => [node.id, node]));
  const outgoing = new Map();
  const incoming = new Map();
  for (const edge of edgesAll) {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    if (!incoming.has(edge.to)) incoming.set(edge.to, []);
    outgoing.get(edge.from).push(edge);
    incoming.get(edge.to).push(edge);
  }
  const rootId = logicalFocusId(graph, view.focusedId, view.focusedId);

  const storageLogicalAllowed = (node) => {
    if (!node || node.layer !== "logical") return true;
    if (!view.includeSystem && isSystemDatabaseName(node.database)) return false;
    // Storage is intentionally stricter than Lineage: ordinary non-storing
    // objects stay out, while Buffer is shown because it is a real write path
    // into a persistent destination.
    return !isNonStoringNode(node) || node.kind === "buffer";
  };

  const keep = new Set();
  const addBufferRoute = (bufferId, trail = new Set()) => {
    if (!bufferId || trail.has(bufferId)) return;
    const buffer = itemById.get(bufferId);
    if (!buffer || buffer.kind !== "buffer" || !storageLogicalAllowed(buffer)) return;
    const nextTrail = new Set(trail);
    nextTrail.add(bufferId);
    keep.add(bufferId);
    for (const edge of outgoing.get(bufferId) || []) {
      if (edge.kind !== "buffer") continue;
      const target = itemById.get(edge.to);
      if (!target || target.layer !== "logical" || !storageLogicalAllowed(target)) continue;
      keep.add(target.id);
      if (target.kind === "buffer") addBufferRoute(target.id, nextTrail);
    }
  };

  const addBuffersFeeding = (targetId, trail = new Set()) => {
    if (!targetId || trail.has(targetId)) return;
    const nextTrail = new Set(trail);
    nextTrail.add(targetId);
    for (const edge of incoming.get(targetId) || []) {
      if (edge.kind !== "buffer") continue;
      const source = itemById.get(edge.from);
      if (!source || source.kind !== "buffer" || !storageLogicalAllowed(source)) continue;
      addBufferRoute(source.id);
      addBuffersFeeding(source.id, nextTrail);
    }
  };

  if (rootId) {
    const root = itemById.get(rootId);
    if (root?.kind === "buffer") addBufferRoute(rootId);
    else if (root && storageLogicalAllowed(root) && canUseStorage(graph, rootId)) {
      keep.add(rootId);
      // Focusing a persistent table in Storage must include every Buffer that
      // flushes into it (including chained Buffers), not only the table's
      // physical descendants. This makes the selected table's write ingress
      // visible without requiring the database-wide graph.
      addBuffersFeeding(rootId);
    }
  } else {
    for (const node of nodes) {
      if (node.layer !== "logical" || !storageLogicalAllowed(node)) continue;
      if (node.kind === "buffer") {
        if (canUseStorage(graph, node.id)) addBufferRoute(node.id);
      } else if (canUseStorage(graph, node.id)) {
        keep.add(node.id);
      }
    }
  }

  // If a Buffer is in scope, its destination table is part of the same
  // storage story and must bring its physical topology with it automatically.
  // Then expand only physical descendants of all retained logical roots.
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edgesAll) {
      if (!keep.has(edge.from) || keep.has(edge.to)) continue;
      const target = itemById.get(edge.to);
      if (!target) continue;
      if (edge.kind === "buffer" && target.layer === "logical" && storageLogicalAllowed(target)) {
        keep.add(edge.to);
        changed = true;
        continue;
      }
      if (target.layer !== "physical") continue;
      keep.add(edge.to);
      changed = true;
    }
  }

  const visible = nodes.filter((node) => keep.has(node.id) && storageLogicalAllowed(node));
  const ids = new Set(visible.map((node) => node.id));
  const edges = edgesAll.filter((edge) => {
    if (!ids.has(edge.from) || !ids.has(edge.to)) return false;
    const source = itemById.get(edge.from);
    const target = itemById.get(edge.to);
    if (edge.kind === "buffer" && source?.kind === "buffer" && target?.layer === "logical") return true;
    return target?.layer === "physical" && ["contains", "storage_policy", "policy_volume", "volume_tier", "volume_disk"].includes(edge.kind);
  });
  return { nodes: visible, edges };
}

function buildStorageProjection(graph, view) {
  const raw = rawStorageProjection(graph, view);
  const rawById = new Map(raw.nodes.map((node) => [node.id, node]));
  const rawOutgoing = new Map();
  const rawIncoming = new Map();
  for (const edge of raw.edges) {
    if (!rawOutgoing.has(edge.from)) rawOutgoing.set(edge.from, []);
    if (!rawIncoming.has(edge.to)) rawIncoming.set(edge.to, []);
    rawOutgoing.get(edge.from).push(edge);
    rawIncoming.get(edge.to).push(edge);
  }

  // A storage tier is the unit users reason about: one ClickHouse volume plus
  // the disk(s) that belong to it. Keeping volume and disk as separate DAG
  // columns made the lifecycle read like unrelated objects. Collapse those
  // implementation nodes into a single visual card while preserving the
  // volume id, so existing topology/activity identity remains stable.
  const diskIdsOwnedByVolume = new Set();
  const tierById = new Map();
  const projectedNodes = [];

  for (const node of raw.nodes) {
    if (node.kind !== "volume") continue;
    const disks = [];
    for (const edge of rawOutgoing.get(node.id) || []) {
      if (edge.kind !== "volume_disk") continue;
      const disk = rawById.get(edge.to);
      if (!disk || disk.kind !== "disk") continue;
      disks.push({ ...disk });
      diskIdsOwnedByVolume.add(disk.id);
    }
    disks.sort((a, b) => String(a.name || a.disk_name || "").localeCompare(String(b.name || b.disk_name || "")));
    const tier = {
      ...node,
      kind: "storage_tier",
      tier_disks: disks,
      ttl_events: [],
      root_logical_ids: [],
    };
    tierById.set(node.id, tier);
  }

  const diskHasDirectPlacement = new Set();
  for (const edge of raw.edges) {
    const target = rawById.get(edge.to);
    if (target?.kind === "disk" && edge.kind !== "volume_disk") diskHasDirectPlacement.add(edge.to);
  }

  const policyById = new Map(raw.nodes.filter((node) => node.kind === "storage_policy").map((node) => [node.id, node]));
  const policyIncoming = new Map();
  const policyFirstVolumes = new Map();
  for (const edge of raw.edges) {
    if (edge.kind === "storage_policy" && policyById.has(edge.to)) {
      if (!policyIncoming.has(edge.to)) policyIncoming.set(edge.to, []);
      policyIncoming.get(edge.to).push(edge.from);
    }
    if (edge.kind === "policy_volume" && policyById.has(edge.from)) {
      if (!policyFirstVolumes.has(edge.from)) policyFirstVolumes.set(edge.from, []);
      policyFirstVolumes.get(edge.from).push(edge.to);
    }
  }

  const reachablePolicyForRoot = (rootId) => {
    const seen = new Set([rootId]);
    const queue = [rootId];
    while (queue.length) {
      const current = queue.shift();
      for (const edge of rawOutgoing.get(current) || []) {
        if (seen.has(edge.to)) continue;
        seen.add(edge.to);
        if (policyById.has(edge.to)) return policyById.get(edge.to);
        const target = rawById.get(edge.to);
        if (target?.layer === "physical") queue.push(edge.to);
      }
    }
    return null;
  };

  for (const node of raw.nodes) {
    if (node.kind === "storage_policy") continue;
    if (node.kind === "volume") {
      projectedNodes.push(tierById.get(node.id));
      continue;
    }
    // Do not draw the same disk again beside its containing storage tier.
    // If another root addresses that disk directly (for example a Log-family
    // data_path fallback), retain the standalone disk node as well.
    if (node.kind === "disk" && diskIdsOwnedByVolume.has(node.id) && !diskHasDirectPlacement.has(node.id)) continue;
    if (node.layer === "logical") {
      const policy = reachablePolicyForRoot(node.id);
      projectedNodes.push({
        ...node,
        storage_policy: policy ? (policy.storage_policy || policy.name || "") : "",
        storage_disabled: !canUseStorage(graph, node.id),
      });
      continue;
    }
    projectedNodes.push(node);
  }

  // A storage policy is configuration of the table, not a physical tier. Put
  // its name in the table card and bypass the standalone policy node. This
  // keeps the spatial model compact: table -> stacked volumes -> TTL terminal.
  let projectedEdges = raw.edges
    .filter((edge) => edge.kind !== "volume_disk" && edge.kind !== "storage_policy" && !policyById.has(edge.from) && !policyById.has(edge.to))
    .map((edge) => ({ ...edge }));
  for (const [policyId, parents] of policyIncoming) {
    const firstVolumes = policyFirstVolumes.get(policyId) || [];
    for (const parent of parents) {
      for (const volumeId of firstVolumes) {
        projectedEdges.push({
          id: `storage-policy-inline:${parent}:${volumeId}`,
          from: parent,
          to: volumeId,
          kind: "policy_volume",
          label: "storage policy",
          can_animate: false,
        });
      }
    }
  }
  let projectedNodeIds = new Set(projectedNodes.map((node) => node.id));
  projectedEdges = projectedEdges.filter((edge) => projectedNodeIds.has(edge.from) && projectedNodeIds.has(edge.to));

  const edgeByPair = new Map();
  for (const edge of projectedEdges) {
    const key = `${edge.from}\u0000${edge.to}`;
    if (!edgeByPair.has(key)) edgeByPair.set(key, edge);
  }

  const reachableVolumeIds = (rootId) => {
    const seen = new Set([rootId]);
    const queue = [rootId];
    const volumes = new Set();
    while (queue.length) {
      const current = queue.shift();
      for (const edge of rawOutgoing.get(current) || []) {
        if (seen.has(edge.to)) continue;
        seen.add(edge.to);
        const target = rawById.get(edge.to);
        if (!target) continue;
        if (target.kind === "volume") volumes.add(target.id);
        if (target.layer === "physical") queue.push(target.id);
      }
    }
    return [...volumes].sort((a, b) => {
      const an = rawById.get(a);
      const bn = rawById.get(b);
      const ap = Number(an?.volume_priority || 0);
      const bp = Number(bn?.volume_priority || 0);
      return ap - bp || String(an?.name || "").localeCompare(String(bn?.name || ""));
    });
  };

  const addRootToTier = (tier, rootId) => {
    if (!tier || !rootId) return;
    if (!tier.root_logical_ids.includes(rootId)) tier.root_logical_ids.push(rootId);
  };

  const addTtlEdgeEvent = (fromTier, toTier, event) => {
    if (!fromTier || !toTier || fromTier.id === toTier.id) return;
    const key = `${fromTier.id}\u0000${toTier.id}`;
    let edge = edgeByPair.get(key);
    if (!edge) {
      edge = {
        id: `ttl:${event.source_id}:${fromTier.id}:${toTier.id}:${event.offset_label || event.expression}`,
        from: fromTier.id,
        to: toTier.id,
        kind: "ttl_move",
        label: "TTL move",
        can_animate: false,
      };
      projectedEdges.push(edge);
      edgeByPair.set(key, edge);
    }
    if (!Array.isArray(edge.ttl_events)) edge.ttl_events = [];
    edge.ttl_events.push(event);
  };

  for (const root of raw.nodes.filter((node) => node.layer === "logical" && ttlRules(node).length)) {
    const volumeIds = reachableVolumeIds(root.id);
    if (!volumeIds.length) continue;
    const rootTierIds = new Set(volumeIds);
    for (const id of volumeIds) addRootToTier(tierById.get(id), root.id);
    let current = tierById.get(volumeIds[0]) || null;
    if (!current) continue;

    for (const rule of ttlRules(root)) {
      const event = { ...rule, source_id: root.id, source_table: root.name };
      if (rule.action === "move") {
        let targetId = null;
        if (rule.target_kind === "volume") {
          targetId = volumeIds.find((id) => String(rawById.get(id)?.volume_name || rawById.get(id)?.name || "") === String(rule.target || "")) || null;
        } else if (rule.target_kind === "disk") {
          targetId = volumeIds.find((id) => (tierById.get(id)?.tier_disks || []).some((disk) => String(disk.disk_name || disk.name || "") === String(rule.target || ""))) || null;
        }
        if (targetId && rootTierIds.has(targetId) && tierById.has(targetId)) {
          const target = tierById.get(targetId);
          addRootToTier(target, root.id);
          addTtlEdgeEvent(current, target, event);
          current = target;
        } else {
          current.ttl_events.push({ ...event, unresolved_target: true });
        }
        continue;
      }

      if (rule.action === "delete") {
        const expiredId = `ttl-expired:${root.id}`;
        let expired = projectedNodes.find((node) => node.id === expiredId);
        if (!expired) {
          expired = {
            id: expiredId,
            layer: "physical",
            kind: "ttl_expired",
            database: root.database,
            name: "Expired",
            label: "Expired",
            root_logical_id: root.id,
            ttl_events: [],
          };
          projectedNodes.push(expired);
          projectedNodeIds.add(expiredId);
        }
        expired.ttl_events.push(event);
        const edge = {
          id: `ttl-delete:${root.id}:${current.id}:${event.offset_label || event.expression}`,
          from: current.id,
          to: expiredId,
          kind: "ttl_delete",
          label: "TTL delete",
          can_animate: false,
          ttl_events: [event],
        };
        projectedEdges.push(edge);
        continue;
      }

      // RECOMPRESS and other in-place TTL actions happen while the part is
      // still inside its current tier. Render them inside that tier card so
      // the user can see that no storage move occurred yet.
      current.ttl_events.push(event);
    }
  }

  for (const tier of tierById.values()) tier.root_logical_ids.sort();
  return { nodes: projectedNodes, edges: projectedEdges };
}

// Unfocused Lineage overview (all databases or one database): objects
// without any dependency are hidden unless "Show objects without
// dependencies" is on, and every database that is not expanded collapses
// into one card. Edges between collapsed databases are aggregated with a
// count, so the overview stays a handful of readable cards on any catalog.
function groupOverview(nodes, edges, { expandedGroups, showIsolated }) {
  const degree = new Map();
  for (const edge of edges) {
    degree.set(edge.from, (degree.get(edge.from) || 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) || 0) + 1);
  }
  const stats = new Map();
  for (const node of nodes) {
    const database = String(node.database || "default");
    if (!stats.has(database)) stats.set(database, { total: 0, connected: 0, shown: 0 });
    const stat = stats.get(database);
    stat.total += 1;
    if (degree.get(node.id)) stat.connected += 1;
  }
  // One database (database scope or a single-database server) is always
  // shown expanded: there is nothing to group it against.
  const autoExpand = stats.size <= 1;
  const expanded = (database) => autoExpand || expandedGroups.has(database);
  const representative = new Map();
  const outNodes = [];
  const groupNodes = new Map();
  for (const node of nodes) {
    const database = String(node.database || "default");
    const stat = stats.get(database);
    const isolated = !degree.get(node.id);
    if (isolated && !showIsolated) continue;
    if (expanded(database)) {
      stat.shown += 1;
      representative.set(node.id, node.id);
      outNodes.push(node);
      continue;
    }
    let group = groupNodes.get(database);
    if (!group) {
      group = {
        id: `group:${database}`, layer: "logical", kind: "database_group", database, name: database, label: database,
        synthetic: true,
      };
      groupNodes.set(database, group);
      outNodes.push(group);
    }
    representative.set(node.id, group.id);
  }
  const aggregated = new Map();
  const outEdges = [];
  for (const edge of edges) {
    const from = representative.get(edge.from);
    const to = representative.get(edge.to);
    if (!from || !to) continue;
    if (from === edge.from && to === edge.to) { outEdges.push(edge); continue; }
    if (from === to) continue;
    const key = `${from}\u0000${to}`;
    let entry = aggregated.get(key);
    if (!entry) {
      entry = { id: `grouped:${from}:${to}`, from, to, kind: edge.kind, label: "", can_animate: false, aggregated: true, members: [] };
      aggregated.set(key, entry);
      outEdges.push(entry);
    }
    if (entry.kind !== edge.kind && !isLogicalDependencyEdge(edge)) entry.kind = edge.kind;
    entry.members.push(edge);
  }
  return { nodes: outNodes, edges: outEdges, stats };
}

function ttlRules(node) {
  return Array.isArray(node?.ttl_rules) ? node.ttl_rules.filter((rule) => rule && rule.expression) : [];
}

function nodeSize(node, detailMode) {
  if (node.kind === "storage_tier") {
    const disks = Array.isArray(node.tier_disks) ? node.tier_disks : [];
    const events = Array.isArray(node.ttl_events) ? node.ttl_events : [];
    const diskHeight = Math.max(1, disks.length) * 33;
    const eventHeight = events.length ? 28 + Math.min(5, events.length) * 33 + (events.length > 5 ? 18 : 0) : 0;
    return { width: 290, height: 59 + diskHeight + eventHeight };
  }
  if (node.kind === "ttl_expired") return { width: 164, height: 72 };
  if (node.kind === "database_group") return { width: NODE_WIDTH, height: NODE_HEIGHT };
  if (node.layer === "physical") return { width: PHYSICAL_WIDTH, height: PHYSICAL_HEIGHT };
  const rules = detailMode === "physical" ? ttlRules(node) : [];
  const storageDisabled = detailMode === "physical" && node.layer === "logical" && node.storage_disabled === true;
  const hasStoragePolicy = detailMode === "physical" && node.layer === "logical" && !!String(node.storage_policy || "");
  // In Storage mode the table owns the policy label and only identifies the
  // TTL clock. Lifecycle actions themselves live on tiers/transitions.
  if (storageDisabled) return { width: NODE_WIDTH, height: 96 };
  if (rules.length && hasStoragePolicy) return { width: NODE_WIDTH, height: 114 };
  if (hasStoragePolicy) return { width: NODE_WIDTH, height: 88 };
  if (rules.length) return { width: NODE_WIDTH, height: 96 };
  if (node.kind === "buffer") return { width: NODE_WIDTH, height: 96 };
  return { width: NODE_WIDTH, height: NODE_HEIGHT };
}

function isLogicalDependencyEdge(edge) {
  return ["view", "dependency", "dictionary_source"].includes(String(edge?.kind || ""));
}

// The logical object that a node stands for: itself, the object it belongs to (a click on a disk), or the one already focused.
function logicalFocusId(graph, focusedId, id) {
  if (!id || !graph) return id || null;
  const itemById = new Map((graph.nodes || []).map((node) => [node.id, node]));
  const initial = itemById.get(id) || null;
  if (!initial) return null;
  if (initial.layer === "logical") return initial.id;
  // Clicking a physical child should not jump away from an already selected
  // logical table, especially for a shared disk with multiple parents.
  if (focusedId && itemById.get(focusedId)?.layer === "logical") return focusedId;

  const incoming = new Map();
  for (const edge of graph.edges || []) {
    if (!incoming.has(edge.to)) incoming.set(edge.to, []);
    incoming.get(edge.to).push(edge.from);
  }
  const queue = [id];
  const seen = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    for (const parentId of incoming.get(current) || []) {
      const parent = itemById.get(parentId);
      if (!parent) continue;
      if (parent.layer === "logical") return parent.id;
      queue.push(parent.id);
    }
  }
  return null;
}

// What the focused object needs the visibility switches to be (a system object needs System, a view needs the non-storing objects).
function requiredVisibility(graph, focusedId) {
  const node = (graph?.nodes || []).find((candidate) => candidate.id === focusedId) || null;
  return {
    includeSystem: !!node && isSystemDatabaseName(node.database),
    // A focused View/MV/Buffer is itself part of the non-storing projection,
    // so the option must remain enabled until focus moves to a storing node.
    includeNonStoring: !!node && isNonStoringNode(node),
  };
}

export {
  NODE_HEIGHT, NODE_WIDTH, PHYSICAL_HEIGHT, PHYSICAL_WIDTH, X_GAP, Y_GAP, buildLogicalProjection, buildStorageProjection, canUseStorage, collapsedEdgeKind,
  focusScopeOf, graphRequestKey, graphRequestOptions, groupOverview, isLogicalDependencyEdge, isNonStoringNode, logicalFocusId,
  logicalNodeAllowed, neighborhoodIds, nodeSize, parseLogicalTableId, requiredVisibility, ttlRules,
};
