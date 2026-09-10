(() => {
  "use strict";

  const ns = window.ChDash;
  if (!ns) return;

  const { dom, state, api, util } = ns;

  const model = {
    active: false,
    loading: false,
    refreshSerial: 0,
    refreshQueued: false,
    refreshQueuedForce: false,
    refreshQueuedReflow: false,
    graph: null,
    activity: null,
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
    dragging: false,
    dragMoved: false,
    dragX: 0,
    dragY: 0,
    hoveredId: null,
    focusedId: null,
    focusDepth: 1,
    pendingFocusId: null,
    pendingEnsureVisible: false,
    openTable: null,
    resizeObserver: null,
    pollTimer: null,
    pollGeneration: 0,
    animationFrame: 0,
    lastPointerX: 0,
    lastPointerY: 0,
    nodeActivity: new Map(),
    edgeActivity: new Map(),
    flowMarkerState: new Map(),
    storageProjectionCache: null,
    lineageRouteCache: null,
    includeSystem: false,
    includeNonStoring: true,
    onStateChange: null,
  };

  const NODE_HEIGHT = 70;
  const NODE_WIDTH = 210;
  const PHYSICAL_WIDTH = 166;
  const PHYSICAL_HEIGHT = 58;
  const X_GAP = 92;
  const Y_GAP = 34;

  function css(name, fallback) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  }

  function reducedMotionPreferred() {
    return !!window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  }

  function graphTypeMenuOpen() {
    return !!dom.explorerGraphTypeSelect?.classList.contains("themeSelect--open");
  }

  function closeGraphTypeMenu({ immediate = false } = {}) {
    const root = dom.explorerGraphTypeSelect;
    const button = dom.explorerGraphTypeSelectButton;
    const menu = dom.explorerGraphTypeSelectMenu;
    if (!root || !button || !menu) return;
    button.setAttribute("aria-expanded", "false");
    root.classList.remove("themeSelect--open");
    if (immediate) {
      root.classList.remove("themeSelect--closing");
      menu.hidden = true;
      return;
    }
    root.classList.add("themeSelect--closing");
    setTimeout(() => {
      if (!graphTypeMenuOpen()) menu.hidden = true;
      root.classList.remove("themeSelect--closing");
    }, 160);
  }

  function toggleGraphTypeMenu() {
    const root = dom.explorerGraphTypeSelect;
    const button = dom.explorerGraphTypeSelectButton;
    const menu = dom.explorerGraphTypeSelectMenu;
    if (!root || !button || !menu || root.hidden || button.dataset.singleOption === "1") return;
    if (graphTypeMenuOpen()) return closeGraphTypeMenu();
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    root.classList.remove("themeSelect--closing");
    requestAnimationFrame(() => root.classList.add("themeSelect--open"));
    menu.focus({ preventScroll: true });
  }

  function canvasSize() {
    const canvas = dom.explorerGraphCanvas;
    if (!canvas) return { width: 0, height: 0, dpr: 1 };
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    return { width: rect.width, height: rect.height, dpr };
  }

  function logicalNeighborhoodIds(depthLimit = model.focusDepth) {
    if (!model.focusedId || !model.graph) return null;
    const projection = logicalProjection();
    const logical = new Set(projection.nodes.map((node) => node.id));
    if (!logical.has(model.focusedId)) return null;
    const adjacency = new Map();
    for (const id of logical) adjacency.set(id, new Set());
    for (const edge of projection.edges) {
      if (!logical.has(edge.from) || !logical.has(edge.to)) continue;
      adjacency.get(edge.from)?.add(edge.to);
      adjacency.get(edge.to)?.add(edge.from);
    }
    const seen = new Set([model.focusedId]);
    let frontier = [model.focusedId];
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

  function logicalNodeAllowed(node) {
    if (!node || node.layer !== "logical") return true;
    if (!model.includeSystem && ["system", "information_schema", "INFORMATION_SCHEMA"].includes(String(node.database || ""))) return false;
    if (!model.includeNonStoring && isNonStoringNode(node)) return false;
    return true;
  }

  function collapsedEdgeKind(path) {
    if (path.some((part) => ["refreshable_mv", "refreshable_mv_output"].includes(part.kind))) return "refreshable_mv";
    if (path.some((part) => ["materialized_view", "materialized_view_output"].includes(part.kind))) return "materialized_view";
    if (path.some((part) => part.kind === "buffer")) return "buffer";
    return "view";
  }

  function logicalProjection() {
    const nodes = Array.isArray(model.graph?.nodes) ? model.graph.nodes.filter((node) => node.layer === "logical") : [];
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const systemHidden = (node) => !model.includeSystem && ["system", "information_schema", "INFORMATION_SCHEMA"].includes(String(node?.database || ""));
    const collapseHidden = (node) => !model.includeNonStoring && isNonStoringNode(node);
    const visible = new Set(nodes.filter((node) => !systemHidden(node) && !collapseHidden(node)).map((node) => node.id));
    const rawEdges = (model.graph?.edges || [])
      .filter((edge) => nodeById.has(edge.from) && nodeById.has(edge.to))
      .slice()
      .sort((a, b) => `${a.from}\u0000${a.to}\u0000${a.kind}\u0000${a.id}`.localeCompare(`${b.from}\u0000${b.to}\u0000${b.kind}\u0000${b.id}`));

    if (model.includeNonStoring) {
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

  function canUseStorageForId(id) {
    if (!id || !model.graph) return false;
    const nodes = model.graph.nodes || [];
    const edges = model.graph.edges || [];
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const outgoing = new Map();
    for (const edge of edges) {
      if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
      outgoing.get(edge.from).push(edge);
    }
    const root = byId.get(id);
    if (!root || root.layer !== "logical") return false;

    // Persistent tables own physical placement directly. Buffer tables are a
    // special storage-mode routing object: they do not own parts themselves,
    // but their flush destination does. Treat a Buffer as storage-capable when
    // following Buffer forwarding edges reaches a persistently stored table.
    const seen = new Set();
    const visit = (currentId) => {
      if (!currentId || seen.has(currentId)) return false;
      seen.add(currentId);
      const current = byId.get(currentId);
      if (!current || current.layer !== "logical") return false;
      if ((outgoing.get(currentId) || []).some((edge) => byId.get(edge.to)?.layer === "physical")) return true;
      if (current.kind !== "buffer") return false;
      return (outgoing.get(currentId) || []).some((edge) => edge.kind === "buffer" && visit(edge.to));
    };
    return visit(id);
  }

  function canUseStorageForTable(database, table) {
    if (!model.graph) return null;
    const id = `table:${String(database || "")}.${String(table || "")}`;
    // A table from another database can legitimately be absent from the
    // currently scoped graph. Absence is not evidence that it has no storage:
    // return unknown so Explorer may switch scope/database and refresh the
    // graph before evaluating the table in its new payload.
    const exists = (model.graph.nodes || []).some((node) => node.id === id && node.layer === "logical");
    if (!exists) return null;
    return canUseStorageForId(id);
  }

  function rawStorageProjection() {
    const nodes = Array.isArray(model.graph?.nodes) ? model.graph.nodes : [];
    const edgesAll = Array.isArray(model.graph?.edges) ? model.graph.edges : [];
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const outgoing = new Map();
    const incoming = new Map();
    for (const edge of edgesAll) {
      if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
      if (!incoming.has(edge.to)) incoming.set(edge.to, []);
      outgoing.get(edge.from).push(edge);
      incoming.get(edge.to).push(edge);
    }
    const rootId = logicalFocusId(model.focusedId);

    const storageLogicalAllowed = (node) => {
      if (!node || node.layer !== "logical") return true;
      if (!model.includeSystem && ["system", "information_schema", "INFORMATION_SCHEMA"].includes(String(node.database || ""))) return false;
      // Storage is intentionally stricter than Lineage: ordinary non-storing
      // objects stay out, while Buffer is shown because it is a real write path
      // into a persistent destination.
      return !isNonStoringNode(node) || node.kind === "buffer";
    };

    const keep = new Set();
    const addBufferRoute = (bufferId, trail = new Set()) => {
      if (!bufferId || trail.has(bufferId)) return;
      const buffer = byId.get(bufferId);
      if (!buffer || buffer.kind !== "buffer" || !storageLogicalAllowed(buffer)) return;
      const nextTrail = new Set(trail);
      nextTrail.add(bufferId);
      keep.add(bufferId);
      for (const edge of outgoing.get(bufferId) || []) {
        if (edge.kind !== "buffer") continue;
        const target = byId.get(edge.to);
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
        const source = byId.get(edge.from);
        if (!source || source.kind !== "buffer" || !storageLogicalAllowed(source)) continue;
        addBufferRoute(source.id);
        addBuffersFeeding(source.id, nextTrail);
      }
    };

    if (rootId) {
      const root = byId.get(rootId);
      if (root?.kind === "buffer") addBufferRoute(rootId);
      else if (root && storageLogicalAllowed(root) && canUseStorageForId(rootId)) {
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
          if (canUseStorageForId(node.id)) addBufferRoute(node.id);
        } else if (canUseStorageForId(node.id)) {
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
        const target = byId.get(edge.to);
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
      const source = byId.get(edge.from);
      const target = byId.get(edge.to);
      if (edge.kind === "buffer" && source?.kind === "buffer" && target?.layer === "logical") return true;
      return target?.layer === "physical" && ["contains", "storage_policy", "policy_volume", "volume_tier", "volume_disk"].includes(edge.kind);
    });
    return { nodes: visible, edges };
  }

  function storageProjection() {
    const cache = model.storageProjectionCache;
    if (cache
        && cache.graph === model.graph
        && cache.focusedId === model.focusedId
        && cache.includeSystem === model.includeSystem
        && cache.includeNonStoring === model.includeNonStoring) {
      return cache.projection;
    }

    const raw = rawStorageProjection();
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
          storage_disabled: !canUseStorageForId(node.id),
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
    const projection = { nodes: projectedNodes, edges: projectedEdges };
    model.storageProjectionCache = {
      graph: model.graph,
      focusedId: model.focusedId,
      includeSystem: model.includeSystem,
      includeNonStoring: model.includeNonStoring,
      projection,
    };
    return projection;
  }

  function visibleNodes() {
    if (model.detailMode === "physical") return storageProjection().nodes;
    const projection = logicalProjection();
    const logicalIds = logicalNeighborhoodIds();
    if (logicalIds) return projection.nodes.filter((node) => logicalIds.has(node.id));
    return projection.nodes;
  }

  function visibleNodeIds() {
    return new Set(visibleNodes().map((node) => node.id));
  }

  function visibleEdges() {
    if (model.detailMode === "physical") return storageProjection().edges;
    const ids = visibleNodeIds();
    return logicalProjection().edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
  }

  function ttlRules(node) {
    return Array.isArray(node?.ttl_rules) ? node.ttl_rules.filter((rule) => rule && rule.expression) : [];
  }

  function nodeSize(node) {
    if (node.kind === "storage_tier") {
      const disks = Array.isArray(node.tier_disks) ? node.tier_disks : [];
      const events = Array.isArray(node.ttl_events) ? node.ttl_events : [];
      const diskHeight = Math.max(1, disks.length) * 31;
      const eventHeight = events.length ? 25 + Math.min(5, events.length) * 31 + (events.length > 5 ? 17 : 0) : 0;
      return { width: 274, height: 55 + diskHeight + eventHeight };
    }
    if (node.kind === "ttl_expired") return { width: 154, height: 70 };
    if (node.layer === "physical") return { width: PHYSICAL_WIDTH, height: PHYSICAL_HEIGHT };
    const rules = model.detailMode === "physical" ? ttlRules(node) : [];
    const storageDisabled = model.detailMode === "physical" && node.layer === "logical" && node.storage_disabled === true;
    const hasStoragePolicy = model.detailMode === "physical" && node.layer === "logical" && !!String(node.storage_policy || "");
    // In Storage mode the table owns the policy label and only identifies the
    // TTL clock. Lifecycle actions themselves live on tiers/transitions.
    if (storageDisabled) return { width: 238, height: 92 };
    if (rules.length && hasStoragePolicy) return { width: 250, height: 110 };
    if (rules.length || hasStoragePolicy) return { width: 238, height: 92 };
    if (node.kind === "buffer") return { width: NODE_WIDTH, height: 88 };
    return { width: NODE_WIDTH, height: NODE_HEIGHT };
  }

  function rectsOverlap(a, b, padding = 14) {
    return !(
      a.x + a.width + padding <= b.x ||
      b.x + b.width + padding <= a.x ||
      a.y + a.height + padding <= b.y ||
      b.y + b.height + padding <= a.y
    );
  }

  function stabilizeLayoutPositions(positions, idealPositions, previousLayout, edges, preserveIds = null) {
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

    const anchorId = retained.has(model.focusedId) ? model.focusedId : retained.values().next().value;
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

  function alignPhysicalStorageRows(positions, nodes, edges, level) {
    if (model.detailMode !== "physical" || positions.size < 2) return;

    const byId = new Map(nodes.map((node) => [node.id, node]));
    const adjacency = new Map(nodes.map((node) => [node.id, []]));
    for (const edge of edges) {
      if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
      adjacency.get(edge.from)?.push(edge.to);
      adjacency.get(edge.to)?.push(edge.from);
    }

    const components = [];
    const seen = new Set();
    const stableId = (id) => {
      const node = byId.get(id);
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
      const logicalIds = component.filter((id) => byId.get(id)?.layer === "logical").sort((a, b) => stableId(a).localeCompare(stableId(b)));
      const tierIds = component.filter((id) => byId.get(id)?.kind === "storage_tier").sort((a, b) => {
        const an = byId.get(a);
        const bn = byId.get(b);
        return Number(an?.volume_priority || 0) - Number(bn?.volume_priority || 0)
          || stableId(a).localeCompare(stableId(b));
      });
      const expiredIds = component.filter((id) => byId.get(id)?.kind === "ttl_expired").sort((a, b) => stableId(a).localeCompare(stableId(b)));
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
          && byId.get(edge.from)?.kind === "buffer");
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
      const bufferIds = logicalIds.filter((id) => byId.get(id)?.kind === "buffer");
      const storedLogicalIds = logicalIds.filter((id) => byId.get(id)?.kind !== "buffer");
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
          && byId.get(edge.from)?.kind === "buffer");
        const indegree = new Map(logicalIds.map((id) => [id, 0]));
        const outgoing = new Map(logicalIds.map((id) => [id, []]));
        for (const edge of bufferRoutingEdges) {
          outgoing.get(edge.from)?.push(edge.to);
          indegree.set(edge.to, (indegree.get(edge.to) || 0) + 1);
        }
        const priority = (a, b) => {
          const aBuffer = byId.get(a)?.kind === "buffer" ? 0 : 1;
          const bBuffer = byId.get(b)?.kind === "buffer" ? 0 : 1;
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

      const middleIds = component.filter((id) => {
        const node = byId.get(id);
        return node && node.layer === "physical" && node.kind !== "storage_tier" && node.kind !== "ttl_expired";
      });
      let middleRight = logicalRight;
      if (middleIds.length) {
        const middleX = logicalRight + columnGap;
        let middleY = cursorY;
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
      let tierY = cursorY;
      let maxTierWidth = 0;
      const lastTierByRoot = new Map();
      for (const id of tierIds) {
        const item = positions.get(id);
        const node = byId.get(id);
        if (!item || !node) continue;
        item.x = tierX;
        item.y = tierY;
        maxTierWidth = Math.max(maxTierWidth, item.width);
        for (const rootId of node.root_logical_ids || []) lastTierByRoot.set(rootId, id);
        tierY += item.height + storageTierGap;
      }

      const terminalX = tierX + maxTierWidth + columnGap;
      let terminalFallbackY = cursorY;
      for (const id of expiredIds) {
        const item = positions.get(id);
        const node = byId.get(id);
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

  function computeLayout({ preserveExisting = false, preserveIds = null } = {}) {
    const previousLayout = preserveExisting ? new Map(model.layout) : null;
    const nodes = visibleNodes();
    const edges = visibleEdges();
    const xGap = model.detailMode === "physical" ? 138 : X_GAP;
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const indegree = new Map(nodes.map((node) => [node.id, 0]));
    const next = new Map(nodes.map((node) => [node.id, []]));

    for (const edge of edges) {
      if (!byId.has(edge.from) || !byId.has(edge.to) || edge.from === edge.to) continue;
      indegree.set(edge.to, (indegree.get(edge.to) || 0) + 1);
      next.get(edge.from)?.push(edge.to);
    }

    const sortIds = (arr) => arr.sort((a, b) => {
      const an = byId.get(a);
      const bn = byId.get(b);
      const adb = String(an?.database || "");
      const bdb = String(bn?.database || "");
      if (adb !== bdb) return adb.localeCompare(bdb);
      return String(an?.name || "").localeCompare(String(bn?.name || ""));
    });

    const queue = sortIds(nodes.filter((node) => (indegree.get(node.id) || 0) === 0).map((node) => node.id));
    const level = new Map(nodes.map((node) => [node.id, 0]));
    const processed = new Set();
    for (let qi = 0; qi < queue.length; qi += 1) {
      const id = queue[qi];
      processed.add(id);
      const base = level.get(id) || 0;
      for (const target of next.get(id) || []) {
        level.set(target, Math.max(level.get(target) || 0, base + 1));
        indegree.set(target, (indegree.get(target) || 0) - 1);
        if ((indegree.get(target) || 0) === 0) queue.push(target);
      }
    }

    // Cycles are valid for some view/topology combinations. Keep them visible
    // by placing remaining nodes after their strongest known predecessor.
    for (const node of nodes) {
      if (processed.has(node.id)) continue;
      let best = 0;
      for (const edge of edges) {
        if (edge.to === node.id) best = Math.max(best, (level.get(edge.from) || 0) + 1);
      }
      level.set(node.id, best);
    }

    const columns = new Map();
    for (const node of nodes) {
      const l = level.get(node.id) || 0;
      if (!columns.has(l)) columns.set(l, []);
      columns.get(l).push(node);
    }
    const stableNodeCompare = (a, b) => {
      if (a.database !== b.database) return String(a.database).localeCompare(String(b.database));
      if (a.layer !== b.layer) return a.layer === "logical" ? -1 : 1;
      return String(a.name).localeCompare(String(b.name));
    };
    for (const group of columns.values()) group.sort(stableNodeCompare);

    // Crossing minimization: perform a few Sugiyama-style barycentric sweeps
    // after topological layering. This keeps the deterministic layout while
    // placing nodes close to their connected neighbours instead of purely
    // alphabetically, which dramatically reduces crossing Bezier edges.
    const levels = [...columns.keys()].sort((a, b) => a - b);
    const predecessors = new Map(nodes.map((node) => [node.id, []]));
    const successors = new Map(nodes.map((node) => [node.id, []]));
    for (const edge of edges) {
      if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
      predecessors.get(edge.to)?.push(edge.from);
      successors.get(edge.from)?.push(edge.to);
    }
    const orderForLevel = (levelNumber) => {
      const map = new Map();
      (columns.get(levelNumber) || []).forEach((node, index) => map.set(node.id, index));
      return map;
    };
    const barySort = (group, neighborIds, neighborOrder) => {
      const decorated = group.map((node, index) => {
        const values = (neighborIds.get(node.id) || []).map((id) => neighborOrder.get(id)).filter((value) => Number.isFinite(value));
        const bary = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
        return { node, index, bary };
      });
      decorated.sort((a, b) => {
        if (a.bary != null && b.bary != null && a.bary !== b.bary) return a.bary - b.bary;
        if (a.bary != null && b.bary == null) return -1;
        if (a.bary == null && b.bary != null) return 1;
        const stable = stableNodeCompare(a.node, b.node);
        return stable || a.index - b.index;
      });
      group.splice(0, group.length, ...decorated.map((item) => item.node));
    };
    for (let sweep = 0; sweep < 4; sweep += 1) {
      for (let i = 1; i < levels.length; i += 1) {
        barySort(columns.get(levels[i]) || [], predecessors, orderForLevel(levels[i - 1]));
      }
      for (let i = levels.length - 2; i >= 0; i -= 1) {
        barySort(columns.get(levels[i]) || [], successors, orderForLevel(levels[i + 1]));
      }
    }

    // Adjacent transposition after barycentric sweeps. Barycentres give a good
    // global ordering; local swaps remove avoidable residual crossings between
    // neighbouring layers without sacrificing deterministic placement.
    const crossingScore = () => {
      let score = 0;
      const orderByLevel = new Map(levels.map((l) => [l, orderForLevel(l)]));
      const levelById = new Map();
      for (const [l, group] of columns.entries()) for (const node of group) levelById.set(node.id, l);
      const pairs = new Map();
      for (const edge of edges) {
        const fromLevel = levelById.get(edge.from);
        const toLevel = levelById.get(edge.to);
        if (!Number.isFinite(fromLevel) || !Number.isFinite(toLevel) || fromLevel === toLevel) continue;
        const lo = Math.min(fromLevel, toLevel);
        const hi = Math.max(fromLevel, toLevel);
        if (hi - lo !== 1) continue;
        const key = `${lo}:${hi}`;
        if (!pairs.has(key)) pairs.set(key, []);
        const forward = fromLevel === lo;
        pairs.get(key).push({
          a: forward ? edge.from : edge.to,
          b: forward ? edge.to : edge.from,
          lo, hi,
        });
      }
      for (const groupEdges of pairs.values()) {
        for (let i = 0; i < groupEdges.length; i += 1) {
          const a = groupEdges[i];
          const a0 = orderByLevel.get(a.lo)?.get(a.a);
          const a1 = orderByLevel.get(a.hi)?.get(a.b);
          if (!Number.isFinite(a0) || !Number.isFinite(a1)) continue;
          for (let j = i + 1; j < groupEdges.length; j += 1) {
            const b = groupEdges[j];
            const b0 = orderByLevel.get(b.lo)?.get(b.a);
            const b1 = orderByLevel.get(b.hi)?.get(b.b);
            if (!Number.isFinite(b0) || !Number.isFinite(b1)) continue;
            if ((a0 - b0) * (a1 - b1) < 0) score += 1;
          }
        }
      }
      return score;
    };
    for (let pass = 0; pass < 4; pass += 1) {
      let improved = false;
      for (const l of levels) {
        const group = columns.get(l) || [];
        for (let i = 0; i + 1 < group.length; i += 1) {
          const before = crossingScore();
          [group[i], group[i + 1]] = [group[i + 1], group[i]];
          const after = crossingScore();
          if (after < before) improved = true;
          else [group[i], group[i + 1]] = [group[i + 1], group[i]];
        }
      }
      if (!improved) break;
    }

    const positions = new Map();
    // Lineage is assigned to a *global* row grid, not a per-column row index.
    // Empty row slots are allowed. This is important: a node in column N can
    // stay on the exact row of its parent/child even when another column has a
    // different number of nodes. The assignment is optimized in repeated
    // left/right sweeps and keeps each column's crossing-minimized order.
    const lineageRowPitch = model.detailMode === "logical"
      ? Math.max(NODE_HEIGHT, ...nodes.filter((node) => node.layer === "logical").map((node) => nodeSize(node).height)) + Y_GAP
      : null;
    const lineageRows = new Map();
    if (model.detailMode === "logical" && levels.length) {
      const maxColumnSize = Math.max(1, ...levels.map((l) => (columns.get(l) || []).length));
      // One spare lane gives fan-in/fan-out branches room to remain separated
      // without making small graphs excessively tall.
      const rowCount = Math.max(1, maxColumnSize + (maxColumnSize >= 3 ? 1 : 0));
      for (const l of levels) {
        const group = columns.get(l) || [];
        if (!group.length) continue;
        group.forEach((node, index) => {
          const row = group.length === 1 ? Math.floor((rowCount - 1) / 2)
            : Math.round(index * (rowCount - 1) / Math.max(1, group.length - 1));
          lineageRows.set(node.id, row);
        });
      }

      const edgeWeight = (edge) => isLogicalDependencyEdge(edge) ? 0.62 : 1.0;
      const weightedIdeal = (nodeId) => {
        let weighted = 0;
        let total = 0;
        for (const edge of edges) {
          let other = null;
          if (edge.from === nodeId) other = edge.to;
          else if (edge.to === nodeId) other = edge.from;
          if (!other || !lineageRows.has(other)) continue;
          const weight = edgeWeight(edge);
          weighted += lineageRows.get(other) * weight;
          total += weight;
        }
        return total > 0 ? weighted / total : lineageRows.get(nodeId) ?? 0;
      };

      // Minimum-cost monotone assignment of a column to unique row slots. The
      // group order is preserved, so row optimization cannot re-introduce the
      // crossings already removed by the Sugiyama ordering pass.
      const assignRows = (group) => {
        const n = group.length;
        if (!n) return;
        const slots = Math.max(rowCount, n);
        const ideals = group.map((node) => weightedIdeal(node.id));
        const inf = 1e18;
        const dp = Array.from({ length: n }, () => Array(slots).fill(inf));
        const prev = Array.from({ length: n }, () => Array(slots).fill(-1));
        for (let row = 0; row < slots; row += 1) {
          if (slots - row < n) break;
          dp[0][row] = (row - ideals[0]) ** 2;
        }
        for (let i = 1; i < n; i += 1) {
          for (let row = i; row < slots; row += 1) {
            if (slots - row < n - i) continue;
            let bestCost = inf;
            let bestPrev = -1;
            for (let pr = i - 1; pr < row; pr += 1) {
              if (dp[i - 1][pr] < bestCost) { bestCost = dp[i - 1][pr]; bestPrev = pr; }
            }
            if (bestPrev < 0) continue;
            dp[i][row] = bestCost + (row - ideals[i]) ** 2;
            prev[i][row] = bestPrev;
          }
        }
        let endRow = 0;
        let endCost = inf;
        for (let row = n - 1; row < slots; row += 1) {
          if (dp[n - 1][row] < endCost) { endCost = dp[n - 1][row]; endRow = row; }
        }
        const assigned = Array(n).fill(0);
        for (let i = n - 1, row = endRow; i >= 0; i -= 1) {
          assigned[i] = row;
          row = i > 0 ? prev[i][row] : -1;
        }
        group.forEach((node, index) => lineageRows.set(node.id, assigned[index]));
      };

      for (let sweep = 0; sweep < 6; sweep += 1) {
        for (const l of levels) assignRows(columns.get(l) || []);
        for (let i = levels.length - 1; i >= 0; i -= 1) assignRows(columns.get(levels[i]) || []);
      }
    }

    let x = 70;
    for (const l of levels) {
      const group = columns.get(l) || [];
      let maxWidth = NODE_WIDTH;
      for (let row = 0; row < group.length; row += 1) {
        const node = group[row];
        const size = nodeSize(node);
        maxWidth = Math.max(maxWidth, size.width);
        const gridRow = model.detailMode === "logical" ? (lineageRows.get(node.id) ?? row) : row;
        const y = model.detailMode === "logical" ? 70 + gridRow * lineageRowPitch : (() => {
          let packed = 70;
          for (let i = 0; i < row; i += 1) packed += nodeSize(group[i]).height + Y_GAP;
          return packed;
        })();
        positions.set(node.id, { x, y, width: size.width, height: size.height, node, lineageRow: gridRow });
      }
      x += maxWidth + xGap;
    }

    // If the graph is mostly disconnected, the topological algorithm puts all
    // nodes in one very tall column. Wrap those nodes into deterministic lanes.
    if (levels.length <= 1 && nodes.length > 18) {
      positions.clear();
      const rowsPerColumn = Math.max(8, Math.ceil(Math.sqrt(nodes.length * 1.7)));
      nodes.slice().sort((a, b) => `${a.database}.${a.name}`.localeCompare(`${b.database}.${b.name}`)).forEach((node, index) => {
        const col = Math.floor(index / rowsPerColumn);
        const row = index % rowsPerColumn;
        const size = nodeSize(node);
        positions.set(node.id, {
          x: 70 + col * (NODE_WIDTH + xGap),
          y: 70 + row * ((model.detailMode === "logical" ? Math.max(NODE_HEIGHT, ...nodes.map((candidate) => nodeSize(candidate).height)) : NODE_HEIGHT) + Y_GAP),
          width: size.width,
          height: size.height,
          node,
          lineageRow: row,
        });
      });
    }

    alignPhysicalStorageRows(positions, nodes, edges, level);

    const idealPositions = new Map(
      [...positions.entries()].map(([id, item]) => [id, { ...item }])
    );
    if (preserveExisting) stabilizeLayoutPositions(positions, idealPositions, previousLayout, edges, preserveIds);

    model.layout = positions;
    model.lineageRouteCache = null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const item of positions.values()) {
      minX = Math.min(minX, item.x);
      minY = Math.min(minY, item.y);
      maxX = Math.max(maxX, item.x + item.width);
      maxY = Math.max(maxY, item.y + item.height);
    }
    model.worldBounds = Number.isFinite(minX)
      ? { x: minX - 50, y: minY - 50, width: Math.max(1, maxX - minX + 100), height: Math.max(1, maxY - minY + 100) }
      : { x: 0, y: 0, width: 1, height: 1 };
  }

  function fitToScreen() {
    const { width, height } = canvasSize();
    const bounds = model.worldBounds;
    if (!bounds || !width || !height) return;
    const scale = Math.min(width / bounds.width, height / bounds.height) * 0.92;
    model.scale = Math.max(0.08, Math.min(1.5, scale));
    model.fitScale = model.scale;
    model.offsetX = width / 2 - (bounds.x + bounds.width / 2) * model.scale;
    model.offsetY = height / 2 - (bounds.y + bounds.height / 2) * model.scale;
    model.fitOffsetX = model.offsetX;
    model.fitOffsetY = model.offsetY;
    model.isFitted = true;
    syncFocusControls();
    scheduleDraw();
  }

  function worldToScreen(x, y) {
    return { x: x * model.scale + model.offsetX, y: y * model.scale + model.offsetY };
  }

  function screenToWorld(x, y) {
    return { x: (x - model.offsetX) / model.scale, y: (y - model.offsetY) / model.scale };
  }

  function captureViewportAnchor({ includeSystem = model.includeSystem, includeNonStoring = model.includeNonStoring } = {}) {
    if (!model.layout.size || !dom.explorerGraphCanvas) return null;
    const { width, height } = canvasSize();
    if (!width || !height) return null;
    const remainsVisible = (item) => {
      const node = item?.node;
      if (!node) return false;
      if (node.layer !== "logical") return model.detailMode === "physical";
      if (!includeSystem && ["system", "information_schema", "INFORMATION_SCHEMA"].includes(String(node.database || ""))) return false;
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

  function ensureNodeVisible(id) {
    if (!id || nodeIsOnScreen(id)) return false;
    const item = model.layout.get(id);
    if (!item) return false;
    const { width, height } = canvasSize();
    if (!width || !height) return false;
    const centerX = item.x + item.width / 2;
    const centerY = item.y + item.height / 2;
    model.offsetX = width / 2 - centerX * model.scale;
    model.offsetY = height / 2 - centerY * model.scale;
    model.isFitted = false;
    syncFocusControls();
    scheduleDraw();
    return true;
  }

  function focusedSet() {
    if (!model.focusedId) return null;
    return new Set(visibleNodes().map((node) => node.id));
  }

  function databaseBounds() {
    const groups = new Map();
    for (const item of model.layout.values()) {
      if (item.node.layer !== "logical") continue;
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

  function edgeDashPattern(edge) {
    if (edge.kind === "view" || edge.kind === "dependency") return { dash: [7, 7], width: 1 };
    if (edge.kind === "distributed_route") return { dash: [3, 5], width: 1.1 };
    if (edge.kind === "contains") return { dash: [3, 5], width: 0.8 };
    if (edge.kind === "ttl_delete" || edge.kind === "ttl_move" || (Array.isArray(edge.ttl_events) && edge.ttl_events.length)) {
      return { dash: [6, 4], width: 1.5 };
    }
    if (edge.kind === "refreshable_mv" || edge.kind === "refreshable_mv_output") return { dash: [12, 5, 2, 5], width: 1.25 };
    if (edge.kind === "materialized_view" || edge.kind === "materialized_view_output" || edge.kind === "buffer") return { dash: [], width: 1.8 };
    return { dash: [], width: 1.25 };
  }

  function edgeStyle(edge, ctx) {
    const style = edgeDashPattern(edge);
    ctx.setLineDash(style.dash);
    ctx.lineWidth = style.width;
  }

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

  function isFocusedDepthOneEdge(edge) {
    if (!model.focusedId || model.detailMode !== "logical") return false;
    return edge.from === model.focusedId || edge.to === model.focusedId;
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

  function lineageEdgeShouldAnimate(edge, activity) {
    if (reducedMotionPreferred()) return false;
    if (isInsertFlowEdge(edge)) return isFocusedDepthOneEdge(edge) || activity?.active === true;
    // Refreshable MVs are not insert-time flows. Animate only while ClickHouse
    // reports an actual refresh, never merely because the edge has focus.
    if (isRefreshFlowEdge(edge)) return activity?.active === true;
    return false;
  }

  function bezierRoutePoints(a, p1, p2, b, samples = 40) {
    const points = [];
    for (let i = 0; i <= samples; i += 1) points.push(bezierPoint(a, p1, p2, b, i / samples));
    return points;
  }

  function isStorageRouteEdge(edge) {
    return model.detailMode === "physical" && [
      "storage_policy", "policy_volume", "volume_tier", "ttl_move", "ttl_delete", "contains", "buffer",
    ].includes(String(edge?.kind || ""));
  }

  function storageRouteGeometry(from, to, edge) {
    const fromNode = from?.node || {};
    const toNode = to?.node || {};

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

  function storagePolylineMetric(points) {
    const segments = [];
    let total = 0;
    for (let i = 0; i + 1 < points.length; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      segments.push({ a, b, length, start: total });
      total += length;
    }
    return { segments, total: Math.max(total, 0.0001) };
  }

  function storageRoutePoint(points, t) {
    const metric = storagePolylineMetric(points);
    const distance = Math.max(0, Math.min(1, t)) * metric.total;
    let segment = metric.segments[metric.segments.length - 1];
    for (const candidate of metric.segments) {
      if (distance <= candidate.start + candidate.length) { segment = candidate; break; }
    }
    if (!segment) return { x: 0, y: 0, angle: 0 };
    const local = segment.length > 0 ? Math.max(0, Math.min(1, (distance - segment.start) / segment.length)) : 0;
    return {
      x: segment.a.x + (segment.b.x - segment.a.x) * local,
      y: segment.a.y + (segment.b.y - segment.a.y) * local,
      angle: Math.atan2(segment.b.y - segment.a.y, segment.b.x - segment.a.x),
    };
  }

  function drawStorageRoute(ctx, points) {
    if (!points.length) return;
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i].x, points[i].y);
  }

  // Shared by Storage and Lineage. The marker lives in graph/world space, not
  // screen space. Canvas zoom therefore scales both its radius and its apparent
  // speed naturally: at zoom 0.5 a 72 world-unit/s marker moves at 36 px/s and
  // is half as large on screen. This keeps motion visually attached to edges.
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

    // Emission is clock-based rather than edge-length-based. A long route can
    // therefore contain several in-flight markers while a short route can be
    // empty between emissions, but every edge emits at the same cadence.
    const travelMs = metric.total / FLOW_SPEED_WORLD_PER_SECOND * 1000;
    if (!(travelMs > 0)) return;
    const newestAgeMs = (now + state.phaseOffsetMs) % FLOW_EMISSION_INTERVAL_MS;
    const markerCount = Math.min(
      FLOW_MAX_MARKERS_PER_EDGE,
      Math.max(0, Math.floor((travelMs - newestAgeMs) / FLOW_EMISSION_INTERVAL_MS) + 1),
    );

    ctx.save();
    ctx.globalAlpha = 0.96;
    ctx.fillStyle = css("--accent", "#7c9cff");
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

  function isLogicalDependencyEdge(edge) {
    return ["view", "dependency"].includes(String(edge?.kind || ""));
  }

  function pointInsideItem(point, item, padding = 8) {
    return point.x > item.x - padding && point.x < item.x + item.width + padding
      && point.y > item.y - padding && point.y < item.y + item.height + padding;
  }

  function segmentHitsItem(a, b, item, padding = 12) {
    const left = item.x - padding;
    const right = item.x + item.width + padding;
    const top = item.y - padding;
    const bottom = item.y + item.height + padding;
    if (Math.abs(a.x - b.x) < 0.001) {
      if (a.x <= left || a.x >= right) return false;
      const lo = Math.min(a.y, b.y);
      const hi = Math.max(a.y, b.y);
      return hi > top && lo < bottom;
    }
    if (Math.abs(a.y - b.y) < 0.001) {
      if (a.y <= top || a.y >= bottom) return false;
      const lo = Math.min(a.x, b.x);
      const hi = Math.max(a.x, b.x);
      return hi > left && lo < right;
    }
    return false;
  }

  function compressOrthogonalRoute(points) {
    if (!Array.isArray(points) || points.length <= 2) return points || [];
    const out = [points[0]];
    for (let i = 1; i + 1 < points.length; i += 1) {
      const a = out[out.length - 1];
      const b = points[i];
      const c = points[i + 1];
      const vertical = Math.abs(a.x - b.x) < 0.001 && Math.abs(b.x - c.x) < 0.001;
      const horizontal = Math.abs(a.y - b.y) < 0.001 && Math.abs(b.y - c.y) < 0.001;
      if (!vertical && !horizontal) out.push(b);
    }
    out.push(points[points.length - 1]);
    return out;
  }

  function orthogonalSegmentConflict(a, b, c, d) {
    const aVertical = Math.abs(a.x - b.x) < 0.001;
    const cVertical = Math.abs(c.x - d.x) < 0.001;
    const between = (value, x, y, strict = false) => strict
      ? value > Math.min(x, y) + 0.001 && value < Math.max(x, y) - 0.001
      : value >= Math.min(x, y) - 0.001 && value <= Math.max(x, y) + 0.001;

    if (aVertical !== cVertical) {
      const verticalA = aVertical ? a : c;
      const verticalB = aVertical ? b : d;
      const horizontalA = aVertical ? c : a;
      const horizontalB = aVertical ? d : b;
      const x = verticalA.x;
      const y = horizontalA.y;
      // Crossings at a route endpoint are normal fan-in/fan-out, not a visual
      // crossing in the middle of the graph.
      if (between(x, horizontalA.x, horizontalB.x, true) && between(y, verticalA.y, verticalB.y, true)) {
        return { crossings: 1, overlap: 0 };
      }
      return { crossings: 0, overlap: 0 };
    }

    if (aVertical) {
      if (Math.abs(a.x - c.x) > 0.001) return { crossings: 0, overlap: 0 };
      const overlap = Math.max(0, Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) - Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)));
      return { crossings: 0, overlap };
    }
    if (Math.abs(a.y - c.y) > 0.001) return { crossings: 0, overlap: 0 };
    const overlap = Math.max(0, Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) - Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)));
    return { crossings: 0, overlap };
  }

  const LINEAGE_NODE_PORT_TOP_OFFSET = 36;

  function lineageNodePort(item, side = "right") {
    const y = item.y + Math.min(Math.max(18, LINEAGE_NODE_PORT_TOP_OFFSET), Math.max(18, item.height - 18));
    return { x: side === "left" ? item.x : item.x + item.width, y };
  }

  // Every logical node exposes one semantic output point (right edge, at a
  // stable offset from the top of the card) and one semantic input point
  // (left edge, same top offset). Using the same top-based anchor as the
  // Storage projection keeps sibling rows literally horizontal when the cards
  // share a row, instead of forcing links through the visual centre. A very
  // small fan zone is allowed immediately outside those ports because several
  // orthogonal edges cannot leave one point without sharing a few pixels.
  // After that fan zone, every route owns its lane: overlaps are forbidden and
  // crossings are expensive.
  function routePortMaps(edges) {
    const outgoing = new Map();
    const incoming = new Map();
    for (const edge of edges) {
      if (!model.layout.has(edge.from) || !model.layout.has(edge.to)) continue;
      if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
      if (!incoming.has(edge.to)) incoming.set(edge.to, []);
      outgoing.get(edge.from).push(edge);
      incoming.get(edge.to).push(edge);
    }

    const ports = new Map();
    const FAN_BASE = 18;
    const FAN_STEP = 8;
    const FAN_MAX = 58;
    const edgePortY = (id, side) => {
      const item = model.layout.get(id);
      return item ? lineageNodePort(item, side).y : 0;
    };

    // Farthest destinations on the same vertical side turn first (closest to
    // the source). Their vertical lane therefore sits inside shorter routes
    // instead of cutting across them. Above/below branches may reuse the same
    // rank because they immediately travel in opposite directions.
    const fanRanks = (group, anchorY, otherId, otherSide) => {
      const buckets = { up: [], flat: [], down: [] };
      for (const edge of group) {
        const delta = edgePortY(otherId(edge), otherSide) - anchorY;
        const side = delta < -1 ? "up" : (delta > 1 ? "down" : "flat");
        buckets[side].push({ edge, distance: Math.abs(delta) });
      }
      buckets.up.sort((a, b) => b.distance - a.distance || String(a.edge.id).localeCompare(String(b.edge.id)));
      buckets.down.sort((a, b) => b.distance - a.distance || String(a.edge.id).localeCompare(String(b.edge.id)));
      buckets.flat.sort((a, b) => String(a.edge.id).localeCompare(String(b.edge.id)));
      const rank = new Map();
      for (const bucket of [buckets.up, buckets.down]) bucket.forEach((entry, index) => rank.set(entry.edge.id, index));
      const nonFlatMax = Math.max(buckets.up.length, buckets.down.length);
      buckets.flat.forEach((entry, index) => rank.set(entry.edge.id, nonFlatMax + index));
      return rank;
    };

    for (const [id, group] of outgoing) {
      const item = model.layout.get(id);
      if (!item) continue;
      const port = lineageNodePort(item, "right");
      const ranks = fanRanks(group, port.y, (edge) => edge.to, "left");
      for (const edge of group) {
        const current = ports.get(edge.id) || {};
        const rank = ranks.get(edge.id) || 0;
        const offset = Math.min(FAN_MAX, FAN_BASE + rank * FAN_STEP);
        current.a = port;
        current.aFan = { x: port.x + offset, y: port.y };
        current.aFanLimit = port.x + FAN_MAX + 2;
        ports.set(edge.id, current);
      }
    }

    for (const [id, group] of incoming) {
      const item = model.layout.get(id);
      if (!item) continue;
      const port = lineageNodePort(item, "left");
      const ranks = fanRanks(group, port.y, (edge) => edge.from, "right");
      for (const edge of group) {
        const current = ports.get(edge.id) || {};
        const rank = ranks.get(edge.id) || 0;
        const offset = Math.min(FAN_MAX, FAN_BASE + rank * FAN_STEP);
        current.b = port;
        current.bFan = { x: port.x - offset, y: port.y };
        current.bFanLimit = port.x - FAN_MAX - 2;
        ports.set(edge.id, current);
      }
    }
    return ports;
  }

  function routeSegmentMeta(points, edge) {
    const segments = [];
    const count = Math.max(0, points.length - 1);
    for (let i = 0; i < count; i += 1) {
      segments.push({
        a: points[i],
        b: points[i + 1],
        edgeId: edge.id,
        from: edge.from,
        to: edge.to,
        index: i,
        count,
        // Only the first/last segment belongs to the unavoidable shared port
        // fan. The old i<=1/i>=count-2 exemption was too broad and allowed
        // long pieces of unrelated routes to lie on top of each other.
        sourceFan: i === 0,
        targetFan: i === count - 1,
      });
    }
    return segments;
  }

  function sharedPortOverlapAllowed(a, b, currentEdge, segment) {
    if (!currentEdge || !segment) return false;
    const horizontal = Math.abs(a.y - b.y) < 0.001 && Math.abs(segment.a.y - segment.b.y) < 0.001;
    if (!horizontal) return false;

    if (segment.from === currentEdge.from) {
      const item = model.layout.get(currentEdge.from);
      if (item) {
        const portX = item.x + item.width;
        const portY = lineageNodePort(item, "right").y;
        const limit = portX + 62;
        const sameY = Math.abs(a.y - portY) < 0.001 && Math.abs(segment.a.y - portY) < 0.001;
        const inside = Math.max(a.x, b.x, segment.a.x, segment.b.x) <= limit + 0.001
          && Math.min(a.x, b.x, segment.a.x, segment.b.x) >= portX - 0.001;
        if (sameY && inside) return true;
      }
    }

    if (segment.to === currentEdge.to) {
      const item = model.layout.get(currentEdge.to);
      if (item) {
        const portX = item.x;
        const portY = lineageNodePort(item, "left").y;
        const limit = portX - 62;
        const sameY = Math.abs(a.y - portY) < 0.001 && Math.abs(segment.a.y - portY) < 0.001;
        const inside = Math.min(a.x, b.x, segment.a.x, segment.b.x) >= limit - 0.001
          && Math.max(a.x, b.x, segment.a.x, segment.b.x) <= portX + 0.001;
        if (sameY && inside) return true;
      }
    }
    return false;
  }

  function routeConflictPenalty(a, b, usedSegments, currentEdge = null) {
    let penalty = 0;
    for (const segment of usedSegments) {
      const conflict = orthogonalSegmentConflict(a, b, segment.a, segment.b);
      if (conflict.overlap > 0.5 && !sharedPortOverlapAllowed(a, b, currentEdge, segment)) {
        // Outside the tiny source/target fan, two routes must never share a
        // visible segment. Make overlap several orders of magnitude more
        // expensive than either a crossing or one extra bend.
        penalty += 1_000_000_000 + conflict.overlap * 100_000;
      }
      if (conflict.crossings) penalty += conflict.crossings * 28_000;
    }
    return penalty;
  }

  function routeBendCount(points) {
    let bends = 0;
    for (let i = 1; i + 1 < points.length; i += 1) {
      const a = points[i - 1];
      const b = points[i];
      const c = points[i + 1];
      const firstVertical = Math.abs(a.x - b.x) < 0.001;
      const secondVertical = Math.abs(b.x - c.x) < 0.001;
      if (firstVertical !== secondVertical) bends += 1;
    }
    return bends;
  }

  function orthogonalRouteForEdge(edge, start, end, usedSegments, port = {}) {
    const sourcePort = port.a || start;
    const targetPort = port.b || end;
    const sourceFan = port.aFan || { x: sourcePort.x + 18, y: sourcePort.y };
    const targetFan = port.bFan || { x: targetPort.x - 18, y: targetPort.y };
    const direction = targetFan.x >= sourceFan.x ? 1 : -1;

    // Keep routing local to the two endpoints. The previous visibility grid
    // incorporated every card in the graph and could therefore choose giant
    // U-shaped detours around unrelated rows. Only obstacles intersecting this
    // edge's corridor participate in its sparse grid.
    const horizontalPad = 48;
    const verticalPad = Math.max(78, Math.min(138, 72 + Math.abs(targetFan.y - sourceFan.y) * 0.12));
    const localLeft = Math.min(sourceFan.x, targetFan.x) - horizontalPad;
    const localRight = Math.max(sourceFan.x, targetFan.x) + horizontalPad;
    const localTop = Math.min(sourceFan.y, targetFan.y) - verticalPad;
    const localBottom = Math.max(sourceFan.y, targetFan.y) + verticalPad;
    const obstacles = [...model.layout.values()].filter((item) => {
      if (item.node.id === edge.from || item.node.id === edge.to) return false;
      const right = item.x + item.width;
      const bottom = item.y + item.height;
      return right >= localLeft && item.x <= localRight && bottom >= localTop && item.y <= localBottom;
    });

    const padding = 14;
    const xs = [sourceFan.x, targetFan.x, sourceFan.x + direction * 18, targetFan.x - direction * 18, localLeft, localRight];
    const ys = [sourceFan.y, targetFan.y, localTop, localBottom];

    // Route on the same global row grid used by the node layout. Horizontal
    // segments may occupy a node-row lane or a dedicated lane exactly between
    // rows. Logical dependencies prefer inter-row lanes so their dashed paths
    // do not weave through the blue data-flow corridors.
    const rowYByIndex = new Map();
    for (const item of model.layout.values()) {
      if (!Number.isFinite(item.lineageRow)) continue;
      if (!rowYByIndex.has(item.lineageRow)) rowYByIndex.set(item.lineageRow, lineageNodePort(item, "right").y);
    }
    const rowYs = [...rowYByIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, y]) => y);
    const betweenRowYs = [];
    for (let i = 0; i + 1 < rowYs.length; i += 1) betweenRowYs.push((rowYs[i] + rowYs[i + 1]) / 2);
    for (const y of [...rowYs, ...betweenRowYs]) {
      if (y >= localTop - 0.001 && y <= localBottom + 0.001) ys.push(y);
    }
    const preferredHorizontalYs = isLogicalDependencyEdge(edge) && betweenRowYs.length ? betweenRowYs : rowYs;
    const horizontalLanePenalty = (y) => {
      if (!preferredHorizontalYs.length) return 0;
      const nearest = Math.min(...preferredHorizontalYs.map((laneY) => Math.abs(laneY - y)));
      return nearest * (isLogicalDependencyEdge(edge) ? 1.35 : 0.55);
    };

    for (const item of obstacles) {
      xs.push(item.x - padding, item.x + item.width + padding);
      ys.push(item.y - padding, item.y + item.height + padding);
    }
    // Existing routes expose neighbouring lanes only when they intersect this
    // local corridor. This prevents far-away edges from distorting the path.
    for (const segment of usedSegments) {
      const minSegX = Math.min(segment.a.x, segment.b.x);
      const maxSegX = Math.max(segment.a.x, segment.b.x);
      const minSegY = Math.min(segment.a.y, segment.b.y);
      const maxSegY = Math.max(segment.a.y, segment.b.y);
      if (maxSegX < localLeft || minSegX > localRight || maxSegY < localTop || minSegY > localBottom) continue;
      if (Math.abs(segment.a.x - segment.b.x) < 0.001) xs.push(segment.a.x - 10, segment.a.x + 10);
      if (Math.abs(segment.a.y - segment.b.y) < 0.001) ys.push(segment.a.y - 10, segment.a.y + 10);
    }

    const uniqueSorted = (values) => values.map(Number).filter(Number.isFinite).sort((a, b) => a - b)
      .filter((value, index, arr) => index === 0 || Math.abs(value - arr[index - 1]) > 0.01);
    const gridX = uniqueSorted(xs);
    const gridY = uniqueSorted(ys);
    const pointKey = (x, y) => `${x}\u0000${y}`;
    const points = new Map();
    for (const x of gridX) {
      for (const y of gridY) {
        const point = { x, y };
        if (obstacles.some((item) => pointInsideItem(point, item, padding - 0.5))) continue;
        points.set(pointKey(x, y), point);
      }
    }
    points.set(pointKey(sourceFan.x, sourceFan.y), sourceFan);
    points.set(pointKey(targetFan.x, targetFan.y), targetFan);

    const clearSegment = (a, b) => !obstacles.some((item) => segmentHitsItem(a, b, item, padding));
    const verticalDelta = targetFan.y - sourceFan.y;
    const verticalDirection = verticalDelta < -0.001 ? -1 : (verticalDelta > 0.001 ? 1 : 0);
    // Same-row links are the only case allowed to move away from the target row
    // and then come back: that detour is necessary when a card blocks the
    // straight horizontal channel. For up/down links the vertical coordinate
    // is strictly monotone from source row to destination row.
    const sameRowNeedsDetour = verticalDirection === 0 && !clearSegment(sourceFan, targetFan);
    const adjacency = new Map([...points.keys()].map((key) => [key, []]));
    const connectLine = (keys, horizontal) => {
      keys.sort((ka, kb) => {
        const a = points.get(ka);
        const b = points.get(kb);
        return horizontal ? a.x - b.x : a.y - b.y;
      });
      for (let i = 0; i + 1 < keys.length; i += 1) {
        const aKey = keys[i];
        const bKey = keys[i + 1];
        const a = points.get(aKey);
        const b = points.get(bKey);
        if (!clearSegment(a, b)) continue;
        const length = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
        const dir = horizontal ? "H" : "V";
        adjacency.get(aKey).push({ key: bKey, length, dir });
        adjacency.get(bKey).push({ key: aKey, length, dir });
      }
    };
    for (const y of gridY) connectLine([...points.entries()].filter(([, point]) => point.y === y).map(([key]) => key), true);
    for (const x of gridX) connectLine([...points.entries()].filter(([, point]) => point.x === x).map(([key]) => key), false);

    const startKey = pointKey(sourceFan.x, sourceFan.y);
    const endKey = pointKey(targetFan.x, targetFan.y);
    const queue = [{ key: startKey, dir: "N", cost: 0 }];
    const best = new Map([[`${startKey}\u0000N`, 0]]);
    const previous = new Map();
    let finalState = null;
    const heuristic = (point) => Math.abs(point.x - targetFan.x) + Math.abs(point.y - targetFan.y);

    while (queue.length) {
      queue.sort((a, b) => (a.cost + heuristic(points.get(a.key))) - (b.cost + heuristic(points.get(b.key))));
      const current = queue.shift();
      const stateKey = `${current.key}\u0000${current.dir}`;
      if (current.cost !== best.get(stateKey)) continue;
      if (current.key === endKey) { finalState = current; break; }
      const currentPoint = points.get(current.key);
      for (const next of adjacency.get(current.key) || []) {
        const nextPoint = points.get(next.key);
        const dx = nextPoint.x - currentPoint.x;
        const dy = nextPoint.y - currentPoint.y;
        // Left-to-right DAG links never backtrack horizontally. Backward graph
        // edges use the mirrored rule. This removes rectangular loops that can
        // only make a route longer and harder to read.
        if (direction > 0 && dx < -0.001) continue;
        if (direction < 0 && dx > 0.001) continue;
        if (next.dir === "V") {
          if (verticalDirection < 0) {
            if (dy > 0.001 || nextPoint.y < targetFan.y - 0.001) continue;
          } else if (verticalDirection > 0) {
            if (dy < -0.001 || nextPoint.y > targetFan.y + 0.001) continue;
          } else if (!sameRowNeedsDetour && Math.abs(dy) > 0.001) {
            continue;
          }
        }
        // Angles are deliberately expensive: for a clean DAG a short route
        // with 2 bends is preferable to a maze of small detours.
        const bend = current.dir !== "N" && current.dir !== next.dir ? 220 : 0;
        const conflict = routeConflictPenalty(currentPoint, nextPoint, usedSegments, edge);
        const reverse = next.dir === "H" && direction * (nextPoint.x - currentPoint.x) < -0.001 ? 1400 : 0;
        const boundary = nextPoint.x < localLeft - 0.01 || nextPoint.x > localRight + 0.01
          || nextPoint.y < localTop - 0.01 || nextPoint.y > localBottom + 0.01 ? 20_000 : 0;
        const lane = next.dir === "H" ? horizontalLanePenalty(nextPoint.y) : 0;
        const cost = current.cost + next.length + bend + conflict + reverse + boundary + lane;
        const nextStateKey = `${next.key}\u0000${next.dir}`;
        if (cost + 0.001 >= (best.get(nextStateKey) ?? Infinity)) continue;
        best.set(nextStateKey, cost);
        previous.set(nextStateKey, stateKey);
        queue.push({ key: next.key, dir: next.dir, cost });
      }
    }

    let body;
    if (!finalState) {
      if (verticalDirection !== 0) {
        // Preserve the source->destination vertical direction even in the
        // fallback. Try simple H-V-H lanes on the existing sparse grid; a link
        // going upward can therefore never dip down and vice versa.
        const minX = Math.min(sourceFan.x, targetFan.x) - 0.001;
        const maxX = Math.max(sourceFan.x, targetFan.x) + 0.001;
        const candidateXs = gridX.filter((x) => x >= minX && x <= maxX)
          .sort((a, b) => Math.abs(a - (sourceFan.x + targetFan.x) / 2) - Math.abs(b - (sourceFan.x + targetFan.x) / 2));
        const candidates = candidateXs.map((laneX) => compressOrthogonalRoute([
          sourceFan,
          { x: laneX, y: sourceFan.y },
          { x: laneX, y: targetFan.y },
          targetFan,
        ])).filter((route) => route.slice(0, -1).every((point, index) => clearSegment(point, route[index + 1])));
        candidates.sort((a, b) => {
          const score = (route) => storagePolylineMetric(route).total
            + routeBendCount(route) * 220
            + route.slice(0, -1).reduce((sum, point, index) => sum + routeConflictPenalty(point, route[index + 1], usedSegments, edge), 0);
          return score(a) - score(b);
        });
        body = candidates[0] || compressOrthogonalRoute([
          sourceFan,
          { x: sourceFan.x + direction * 18, y: sourceFan.y },
          { x: sourceFan.x + direction * 18, y: targetFan.y },
          targetFan,
        ]);
      } else {
        // Same-row obstacle exception: a short top/bottom detour is allowed,
        // because remaining on the row would pass through another node.
        const fallbackTop = Math.min(localTop, ...obstacles.map((item) => item.y - padding - 24));
        const fallbackBottom = Math.max(localBottom, ...obstacles.map((item) => item.y + item.height + padding + 24));
        const candidates = [fallbackTop, fallbackBottom].map((channelY) => compressOrthogonalRoute([
          sourceFan,
          { x: sourceFan.x + direction * 18, y: sourceFan.y },
          { x: sourceFan.x + direction * 18, y: channelY },
          { x: targetFan.x - direction * 18, y: channelY },
          { x: targetFan.x - direction * 18, y: targetFan.y },
          targetFan,
        ])).filter((route) => route.slice(0, -1).every((point, index) => clearSegment(point, route[index + 1])));
        candidates.sort((a, b) => {
          const score = (route) => storagePolylineMetric(route).total
            + routeBendCount(route) * 220
            + route.slice(0, -1).reduce((sum, point, index) => sum + routeConflictPenalty(point, route[index + 1], usedSegments, edge), 0);
          return score(a) - score(b);
        });
        body = candidates[0] || compressOrthogonalRoute([
          sourceFan,
          { x: sourceFan.x + direction * 18, y: sourceFan.y },
          { x: sourceFan.x + direction * 18, y: fallbackTop },
          { x: targetFan.x - direction * 18, y: fallbackTop },
          { x: targetFan.x - direction * 18, y: targetFan.y },
          targetFan,
        ]);
      }
    } else {
      body = [];
      let stateKey = `${finalState.key}\u0000${finalState.dir}`;
      while (stateKey) {
        const split = stateKey.lastIndexOf("\u0000");
        const key = stateKey.slice(0, split);
        body.push(points.get(key));
        stateKey = previous.get(stateKey) || null;
      }
      body.reverse();
      body = compressOrthogonalRoute(body);
    }

    // Preserve sourceFan/targetFan as explicit anchors even when collinear.
    // Conflict detection can then exempt only the tiny shared port fan instead
    // of accidentally exempting a long merged segment.
    const route = [sourcePort, sourceFan];
    for (const point of body.slice(1, -1)) {
      const previousPoint = route[route.length - 1];
      if (!previousPoint || Math.abs(previousPoint.x - point.x) > 0.001 || Math.abs(previousPoint.y - point.y) > 0.001) route.push(point);
    }
    const previousPoint = route[route.length - 1];
    if (!previousPoint || Math.abs(previousPoint.x - targetFan.x) > 0.001 || Math.abs(previousPoint.y - targetFan.y) > 0.001) route.push(targetFan);
    route.push(targetPort);
    return route;
  }

  function routePairConflictScore(routeA, edgeA, routeB, edgeB) {
    let score = 0;
    const segmentsA = routeSegmentMeta(routeA, edgeA);
    const segmentsB = routeSegmentMeta(routeB, edgeB);
    for (const a of segmentsA) {
      for (const b of segmentsB) {
        const conflict = orthogonalSegmentConflict(a.a, a.b, b.a, b.b);
        const sharedFan = sharedPortOverlapAllowed(a.a, a.b, edgeA, b)
          || sharedPortOverlapAllowed(b.a, b.b, edgeB, a);
        if (conflict.crossings) score += conflict.crossings * 28_000;
        if (conflict.overlap > 0.5 && !sharedFan) score += 1_000_000_000 + conflict.overlap * 100_000;
      }
    }
    return score;
  }

  function lineageRouteSetScore(routes, edgesById) {
    const entries = [...routes.entries()];
    let score = 0;
    for (let i = 0; i < entries.length; i += 1) {
      const [idA, routeA] = entries[i];
      const edgeA = edgesById.get(idA);
      if (!edgeA) continue;
      // Prefer the simplest readable geometry once overlap/crossing safety is
      // satisfied. A bend is intentionally much more expensive than a modest
      // length difference, so the router does not create rectangular detours.
      score += storagePolylineMetric(routeA.points).total * 0.02;
      score += routeBendCount(routeA.points) * 180;
      for (let j = i + 1; j < entries.length; j += 1) {
        const [idB, routeB] = entries[j];
        const edgeB = edgesById.get(idB);
        if (!edgeB) continue;
        score += routePairConflictScore(routeA.points, edgeA, routeB.points, edgeB);
      }
    }
    return score;
  }

  function buildLineageRouteCandidate(ordered, ports) {
    const usedSegments = [];
    const routes = new Map();
    for (const edge of ordered) {
      const from = model.layout.get(edge.from);
      const to = model.layout.get(edge.to);
      if (!from || !to) continue;
      const port = ports.get(edge.id) || {};
      const a = port.a || lineageNodePort(from, "right");
      const b = port.b || lineageNodePort(to, "left");
      const points = orthogonalRouteForEdge(edge, a, b, usedSegments, port);
      routes.set(edge.id, { points, a, b });
      usedSegments.push(...routeSegmentMeta(points, edge));
    }
    return routes;
  }

  function improveLineageRouteCandidate(initialRoutes, edges, ports, edgesById) {
    let routes = initialRoutes;
    let score = lineageRouteSetScore(routes, edgesById);
    // Rip-up/reroute the most conflicted edge against the rest of the already
    // accepted graph. Four bounded passes are enough to resolve most local
    // order artefacts while keeping Explorer graphs deterministic and cheap.
    for (let pass = 0; pass < 4; pass += 1) {
      const conflictByEdge = new Map(edges.map((edge) => [edge.id, 0]));
      const entries = [...routes.entries()];
      for (let i = 0; i < entries.length; i += 1) {
        const [idA, routeA] = entries[i];
        const edgeA = edgesById.get(idA);
        if (!edgeA) continue;
        for (let j = i + 1; j < entries.length; j += 1) {
          const [idB, routeB] = entries[j];
          const edgeB = edgesById.get(idB);
          if (!edgeB) continue;
          const conflict = routePairConflictScore(routeA.points, edgeA, routeB.points, edgeB);
          if (!conflict) continue;
          conflictByEdge.set(idA, (conflictByEdge.get(idA) || 0) + conflict);
          conflictByEdge.set(idB, (conflictByEdge.get(idB) || 0) + conflict);
        }
      }
      const conflicted = edges.slice().sort((a, b) => (conflictByEdge.get(b.id) || 0) - (conflictByEdge.get(a.id) || 0) || String(a.id).localeCompare(String(b.id)));
      let improved = false;
      for (const edge of conflicted.slice(0, 8)) {
        if (!(conflictByEdge.get(edge.id) > 0)) break;
        const from = model.layout.get(edge.from);
        const to = model.layout.get(edge.to);
        if (!from || !to) continue;
        const usedSegments = [];
        for (const [otherId, otherRoute] of routes) {
          if (otherId === edge.id) continue;
          const otherEdge = edgesById.get(otherId);
          if (!otherEdge) continue;
          usedSegments.push(...routeSegmentMeta(otherRoute.points, otherEdge));
        }
        const port = ports.get(edge.id) || {};
        const a = port.a || lineageNodePort(from, "right");
        const b = port.b || lineageNodePort(to, "left");
        const points = orthogonalRouteForEdge(edge, a, b, usedSegments, port);
        const candidate = new Map(routes);
        candidate.set(edge.id, { points, a, b });
        const candidateScore = lineageRouteSetScore(candidate, edgesById);
        if (candidateScore + 0.001 < score) {
          routes = candidate;
          score = candidateScore;
          improved = true;
          break;
        }
      }
      if (!improved) break;
    }
    return routes;
  }

  function ensureLineageRouteCache() {
    if (model.detailMode !== "logical") return new Map();
    if (model.lineageRouteCache instanceof Map) return model.lineageRouteCache;
    const edges = visibleEdges().filter((edge) => !isStorageRouteEdge(edge));
    const ports = routePortMaps(edges);
    const edgesById = new Map(edges.map((edge) => [edge.id, edge]));
    const baseCompare = (a, b) => {
      const aDependency = isLogicalDependencyEdge(a) ? 1 : 0;
      const bDependency = isLogicalDependencyEdge(b) ? 1 : 0;
      if (aDependency !== bDependency) return aDependency - bDependency;
      const af = model.layout.get(a.from);
      const bf = model.layout.get(b.from);
      const at = model.layout.get(a.to);
      const bt = model.layout.get(b.to);
      return (af?.x ?? 0) - (bf?.x ?? 0)
        || (af?.y ?? 0) - (bf?.y ?? 0)
        // Fan-out follows target vertical order: low destinations are routed
        // after high destinations and leave through the lower fan lane.
        || ((at?.y ?? 0) + (at?.height ?? 0) / 2) - ((bt?.y ?? 0) + (bt?.height ?? 0) / 2)
        || String(a.id).localeCompare(String(b.id));
    };
    const base = edges.slice().sort(baseCompare);
    const verticalFirst = edges.slice().sort((a, b) => {
      const af = model.layout.get(a.from);
      const at = model.layout.get(a.to);
      const bf = model.layout.get(b.from);
      const bt = model.layout.get(b.to);
      const aSpan = Math.abs(((at?.y ?? 0) + (at?.height ?? 0) / 2) - ((af?.y ?? 0) + (af?.height ?? 0) / 2));
      const bSpan = Math.abs(((bt?.y ?? 0) + (bt?.height ?? 0) / 2) - ((bf?.y ?? 0) + (bf?.height ?? 0) / 2));
      return bSpan - aSpan || baseCompare(a, b);
    });

    // Routing is path-dependent because every accepted edge reserves channels.
    // Evaluate two deterministic orders (normal fan order and long-span first)
    // and keep the globally cleaner result. This inexpensive rip-up/reroute
    // pass removes crossings that a single greedy order cannot see in advance.
    const candidates = [buildLineageRouteCandidate(base, ports)];
    if (edges.length > 1 && edges.length <= 90) candidates.push(buildLineageRouteCandidate(verticalFirst, ports));
    candidates.sort((a, b) => lineageRouteSetScore(a, edgesById) - lineageRouteSetScore(b, edgesById));
    const best = candidates[0] || new Map();
    model.lineageRouteCache = improveLineageRouteCandidate(best, edges, ports, edgesById);
    return model.lineageRouteCache;
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
    ctx.strokeStyle = css("--accent", "#7c9cff");
    ctx.setLineDash(style.dash);
    ctx.lineWidth = style.width + 3.4;
    ctx.shadowColor = css("--accent", "#7c9cff");
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
    const activity = model.edgeActivity.get(edge.id);

    ctx.save();
    drawSelectedLogicalDependencyHalo(ctx, edge, routePoints, a, p1, p2, b);
    ctx.globalAlpha = selected ? 0.78 : 0.14;
    ctx.strokeStyle = isLogicalDependencyEdge(edge) ? css("--muted", "#788395") : css("--accentBorder", "#6b8cff");
    edgeStyle(edge, ctx);
    // Dash patterns encode edge semantics but never move. Motion is reserved
    // for the one normalized round marker on actual insert-time data flow.
    if (activity?.active && !isLogicalDependencyEdge(edge)) {
      const rate = Math.max(0, Number(activity.rows_per_second || 0));
      ctx.lineWidth += Math.min(4, Math.log10(rate + 1) * 0.55);
    }
    strokeEdgePath(ctx, routePoints, a, p1, p2, b);

    // Arrow head follows the final segment for routed polylines and the Bezier
    // tangent otherwise.
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
    if (!straightStorage && selected && lineageEdgeShouldAnimate(edge, activity)) {
      drawNormalizedFlowMarker(ctx, edge, now, routePoints || bezierRoutePoints(a, p1, p2, b));
    }
    ctx.restore();
  }

  function kindCode(kind) {
    return ({
      materialized_view: "Materialized View",
      refreshable_materialized_view: "Refreshable Materialized View",
      view: "View",
      distributed: "Distributed",
      buffer: "Buffer",
      mergetree: "Merge Tree",
      tinylog: "Tiny Log",
      stripelog: "Stripe Log",
      log: "Log",
      memory: "Memory",
      stream_engine: "Stream engine",
      dictionary: "Dictionary",
      external: "External",
      shard: "Shard",
      replica: "Replica",
      disk: "Disk",
      storage_policy: "Storage policy",
      volume: "Volume",
      storage_tier: "Storage tier",
      ttl_expired: "TTL terminal",
      table: "Table",
    })[kind] || String(kind || "Table").replaceAll("_", " ");
  }

  function humanEngine(engine) {
    const value = String(engine || "");
    const compact = value.toLowerCase().replace(/[^a-z0-9]/g, "");
    const labels = {
      mergetree: "Merge Tree",
      replacingmergetree: "Replacing Merge Tree",
      summingmergetree: "Summing Merge Tree",
      aggregatingmergetree: "Aggregating Merge Tree",
      collapsingmergetree: "Collapsing Merge Tree",
      versionedcollapsingmergetree: "Versioned Collapsing Merge Tree",
      replicatedmergetree: "Replicated Merge Tree",
      replicatedreplacingmergetree: "Replicated Replacing Merge Tree",
      replicatedsummingmergetree: "Replicated Summing Merge Tree",
      replicatedaggregatingmergetree: "Replicated Aggregating Merge Tree",
      materializedview: "Materialized View",
      parameterizedview: "Parameterized View",
      view: "View",
      distributed: "Distributed",
      dictionary: "Dictionary",
      buffer: "Buffer",
      memory: "Memory",
      tinylog: "Tiny Log",
      stripelog: "Stripe Log",
      log: "Log",
    };
    return labels[compact] || value.replace(/([a-z0-9])([A-Z])/g, "$1 $2") || "Table";
  }

  function canvasEllipsis(ctx, value, maxWidth) {
    const text = String(value || "");
    if (!text || ctx.measureText(text).width <= maxWidth) return text;
    let low = 0;
    let high = text.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxWidth) low = mid;
      else high = mid - 1;
    }
    return `${text.slice(0, low)}…`;
  }

  function ttlTimingSummary(rule) {
    const base = String(rule?.base_expression || "").trim();
    const offset = String(rule?.offset_label || "").trim();
    if (base && offset) return `${base} ${offset}`;
    if (base) return base;
    return offset || "expiry expression";
  }

  function ttlActionSummary(rule) {
    const action = String(rule?.action || "ttl");
    const target = String(rule?.target || "");
    const targetKind = String(rule?.target_kind || "");
    if (action === "recompress") return target ? `RECOMPRESS · ${target}` : "RECOMPRESS";
    if (action === "move") {
      const kind = targetKind ? `${targetKind.toUpperCase()} ` : "";
      return target ? `MOVE → ${kind}${target}` : "MOVE";
    }
    if (action === "delete") return target ? `DELETE · ${target}` : "DELETE";
    if (action === "group_by") return target ? `GROUP BY · ${target}` : "GROUP BY";
    return target || "TTL";
  }

  function ttlBaseSummary(node) {
    const rules = ttlRules(node);
    const bases = [...new Set(rules.map((rule) => String(rule.base_expression || "").trim()).filter(Boolean))];
    if (bases.length === 1) return bases[0];
    if (bases.length > 1) return "multiple expressions";
    return "expiration expression";
  }

  function drawTtlSummary(ctx, item, node) {
    if (model.detailMode !== "physical" || node.layer !== "logical") return;
    const rules = ttlRules(node);
    const storageDisabled = node.storage_disabled === true;
    const hasPolicy = !!String(node.storage_policy || "");
    if (!storageDisabled && !rules.length) return;

    const dividerY = item.y + (hasPolicy && !storageDisabled ? 82 : 66);
    ctx.strokeStyle = css("--borderStrong", "#384152");
    ctx.globalAlpha = storageDisabled ? 0.42 : 0.72;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(item.x + 10, dividerY);
    ctx.lineTo(item.x + item.width - 10, dividerY);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = css("--muted", "#8993a4");
    ctx.font = "9px Arial, Helvetica, sans-serif";
    if (storageDisabled) {
      ctx.fillText("No persistent storage", item.x + 10, item.y + 83);
      return;
    }
    const count = `${rules.length} lifecycle rule${rules.length === 1 ? "" : "s"}`;
    ctx.fillText(canvasEllipsis(ctx, `TTL · ${ttlBaseSummary(node)} · ${count}`, item.width - 20), item.x + 10, item.y + (hasPolicy ? 100 : 83));
  }

  function diskCapacitySummary(disk) {
    if (disk?.disk_free_space == null || disk?.disk_total_space == null) return "";
    const free = Number(disk.disk_free_space);
    const total = Number(disk.disk_total_space);
    const used = Math.max(0, total - free);
    const pct = total > 0 ? `${(used / total * 100).toFixed(1)}% used` : "capacity —";
    return `${pct} · ${util.formatBytes(free)} free`;
  }

  function drawStorageTierNode(ctx, item, focused) {
    const node = item.node;
    const selected = !focused || focused.has(node.id);
    const isHover = model.hoveredId === node.id;
    const disks = Array.isArray(node.tier_disks) ? node.tier_disks : [];
    const events = Array.isArray(node.ttl_events) ? node.ttl_events : [];
    const visibleEvents = events.slice(0, 5);
    const volumeName = String(node.volume_name || node.name || "volume");

    ctx.save();
    ctx.globalAlpha = selected ? 1 : 0.18;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(item.x, item.y, item.width, item.height, 10);
    else ctx.rect(item.x, item.y, item.width, item.height);
    ctx.fillStyle = css("--tableBg", "#10141d");
    ctx.fill();
    ctx.strokeStyle = isHover ? css("--accent", "#7c9cff") : css("--borderStrong", "#384152");
    ctx.lineWidth = isHover ? 1.5 : 1;
    ctx.stroke();

    ctx.fillStyle = css("--muted", "#8993a4");
    ctx.font = "9px Arial, Helvetica, sans-serif";
    ctx.fillText("Storage tier", item.x + 12, item.y + 16);
    if (Number(node.volume_priority || 0) > 0) {
      ctx.textAlign = "right";
      ctx.fillText(`priority ${node.volume_priority}`, item.x + item.width - 12, item.y + 16);
      ctx.textAlign = "left";
    }

    ctx.fillStyle = css("--text", "#edf2f7");
    ctx.font = "600 12px Arial, Helvetica, sans-serif";
    ctx.fillText(canvasEllipsis(ctx, `Volume · ${volumeName}`, item.width - 24), item.x + 12, item.y + 36);

    let y = item.y + 49;
    const diskRows = disks.length ? disks : [{ name: "No disk metadata" }];
    for (const disk of diskRows) {
      ctx.strokeStyle = css("--borderStrong", "#384152");
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.moveTo(item.x + 12, y);
      ctx.lineTo(item.x + item.width - 12, y);
      ctx.stroke();
      ctx.globalAlpha = 1;

      const diskName = String(disk.disk_name || disk.name || "disk");
      ctx.fillStyle = css("--text", "#edf2f7");
      ctx.font = "600 10px Arial, Helvetica, sans-serif";
      ctx.fillText(canvasEllipsis(ctx, `Disk · ${diskName}`, item.width - 24), item.x + 12, y + 14);
      const capacity = diskCapacitySummary(disk);
      if (capacity) {
        ctx.fillStyle = css("--muted", "#8993a4");
        ctx.font = "9px Arial, Helvetica, sans-serif";
        ctx.fillText(canvasEllipsis(ctx, capacity, item.width - 24), item.x + 12, y + 27);
      }
      y += 31;
    }

    if (visibleEvents.length) {
      ctx.strokeStyle = css("--borderStrong", "#384152");
      ctx.globalAlpha = 0.72;
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(item.x + 12, y + 1);
      ctx.lineTo(item.x + item.width - 12, y + 1);
      ctx.stroke();
      ctx.globalAlpha = 1;

      ctx.fillStyle = css("--muted", "#8993a4");
      ctx.font = "9px Arial, Helvetica, sans-serif";
      ctx.fillText(`TTL while in ${volumeName}`, item.x + 12, y + 17);
      y += 29;

      for (const event of visibleEvents) {
        ctx.fillStyle = css("--accent", "#7c9cff");
        ctx.beginPath();
        ctx.arc(item.x + 15, y - 3, 2.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.font = "600 9px Arial, Helvetica, sans-serif";
        ctx.fillText(canvasEllipsis(ctx, ttlTimingSummary(event), item.width - 38), item.x + 23, y);
        ctx.fillStyle = css("--text", "#edf2f7");
        ctx.font = "9px Arial, Helvetica, sans-serif";
        const summary = event.unresolved_target ? `${ttlActionSummary(event)} · target unresolved` : ttlActionSummary(event);
        ctx.fillText(canvasEllipsis(ctx, summary, item.width - 38), item.x + 23, y + 13);
        y += 31;
      }
      if (events.length > visibleEvents.length) {
        ctx.fillStyle = css("--muted", "#8993a4");
        ctx.font = "9px Arial, Helvetica, sans-serif";
        ctx.fillText(`+${events.length - visibleEvents.length} more`, item.x + 23, y - 2);
      }
    }
    ctx.restore();
  }

  function drawTtlExpiredNode(ctx, item, focused) {
    const node = item.node;
    const selected = !focused || focused.has(node.id);
    const isHover = model.hoveredId === node.id;
    ctx.save();
    ctx.globalAlpha = selected ? 1 : 0.18;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(item.x, item.y, item.width, item.height, 9);
    else ctx.rect(item.x, item.y, item.width, item.height);
    ctx.fillStyle = css("--tableBg", "#10141d");
    ctx.fill();
    ctx.strokeStyle = isHover ? css("--accent", "#7c9cff") : css("--borderStrong", "#384152");
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = css("--muted", "#8993a4");
    ctx.font = "9px Arial, Helvetica, sans-serif";
    ctx.fillText("TTL terminal", item.x + 11, item.y + 16);
    ctx.fillStyle = css("--text", "#edf2f7");
    ctx.font = "600 12px Arial, Helvetica, sans-serif";
    ctx.fillText("Expired", item.x + 11, item.y + 37);
    ctx.fillStyle = css("--muted", "#8993a4");
    ctx.font = "9px Arial, Helvetica, sans-serif";
    ctx.fillText("data deleted", item.x + 11, item.y + 55);
    ctx.restore();
  }

  function ttlEdgeLabelLines(edge) {
    const events = Array.isArray(edge?.ttl_events) ? edge.ttl_events : [];
    if (!events.length) return [];
    const lines = [];
    for (const event of events.slice(0, 2)) {
      lines.push(ttlTimingSummary(event));
      if (event.action === "move") {
        const kind = String(event.target_kind || "").toUpperCase();
        const target = String(event.target || "");
        lines.push(target ? `MOVE → ${kind ? `${kind} ` : ""}${target}` : "MOVE");
      } else if (event.action === "delete") {
        lines.push("DELETE");
      }
    }
    if (events.length > 2) lines.push(`+${events.length - 2} TTL transitions`);
    return lines;
  }

  function drawLifecycleEdgeLabel(ctx, edge, a, p1, p2, b, selected, explicitPoint = null) {
    const lines = ttlEdgeLabelLines(edge);
    if (!lines.length) return;
    const point = explicitPoint || bezierPoint(a, p1, p2, b, 0.5);
    ctx.save();
    ctx.setLineDash([]);
    ctx.font = "600 9px Arial, Helvetica, sans-serif";
    const width = Math.min(198, Math.max(...lines.map((line) => ctx.measureText(line).width)) + 18);
    const lineHeight = 13;
    const height = lines.length * lineHeight + 8;
    const x = point.x - width / 2;
    const y = point.y - height / 2;
    // Lifecycle labels are semantic data, not decorative overlays. Keep them
    // fully opaque even when another node is focused so MOVE/DELETE rules stay
    // readable against the animated storage route.
    ctx.globalAlpha = 1;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, width, height, 6);
    else ctx.rect(x, y, width, height);
    // --tableBg is intentionally translucent in the general UI theme. TTL
    // labels sit on top of moving routes, so they must use the fully opaque
    // panel background or the arrow remains visible through the label.
    ctx.fillStyle = css("--panelBg", "#0f1623");
    ctx.fill();
    ctx.strokeStyle = css("--borderStrong", "#384152");
    ctx.lineWidth = 0.8;
    ctx.stroke();
    for (let index = 0; index < lines.length; index += 1) {
      ctx.fillStyle = index === 0 ? css("--accent", "#7c9cff") : css("--text", "#edf2f7");
      ctx.font = `${index === 0 ? "600" : "400"} 9px Arial, Helvetica, sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText(canvasEllipsis(ctx, lines[index], width - 12), point.x, y + 13 + index * lineHeight);
    }
    ctx.textAlign = "left";
    ctx.restore();
  }

  function drawNode(ctx, item, focused, compact) {
    const node = item.node;
    if (node.kind === "storage_tier") return drawStorageTierNode(ctx, item, focused);
    if (node.kind === "ttl_expired") return drawTtlExpiredNode(ctx, item, focused);
    const selected = !focused || focused.has(node.id);
    const storageDisabled = model.detailMode === "physical" && node.layer === "logical" && node.storage_disabled === true;
    const isFocus = !storageDisabled && model.focusedId === node.id;
    const isHover = !storageDisabled && model.hoveredId === node.id;
    ctx.save();
    ctx.globalAlpha = storageDisabled ? 0.46 : selected ? 1 : 0.18;
    const radius = node.layer === "physical" ? 8 : 10;
    if (isFocus && node.layer === "logical") {
      ctx.save();
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(item.x - 4, item.y - 4, item.width + 8, item.height + 8, radius + 4);
      else ctx.rect(item.x - 4, item.y - 4, item.width + 8, item.height + 8);
      ctx.strokeStyle = css("--accent", "#7c9cff");
      ctx.lineWidth = 1.4;
      ctx.shadowColor = css("--accent", "#7c9cff");
      ctx.shadowBlur = 18;
      ctx.globalAlpha = 0.95;
      if (["view", "materialized_view", "refreshable_materialized_view"].includes(node.kind)) ctx.setLineDash([5, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(item.x, item.y, item.width, item.height, radius);
    else ctx.rect(item.x, item.y, item.width, item.height);
    ctx.fillStyle = storageDisabled
      ? css("--panelBg", "#0b0f16")
      : node.layer === "physical" ? css("--tableBg", "#10141d") : css("--metricBg", "#151a24");
    ctx.fill();
    ctx.strokeStyle = storageDisabled
      ? css("--border", "#2b3340")
      : isFocus || isHover ? css("--accent", "#7c9cff") : css("--borderStrong", "#384152");
    ctx.lineWidth = isFocus ? 2.4 : node.kind === "materialized_view" ? 1.8 : 1;
    if (["view", "materialized_view", "refreshable_materialized_view"].includes(node.kind)) ctx.setLineDash([5, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = css("--muted", "#8993a4");
    ctx.font = `${node.layer === "physical" ? 9 : 10}px Arial, Helvetica, sans-serif`;
    ctx.fillText(kindCode(node.kind), item.x + 10, item.y + 15);

    ctx.fillStyle = storageDisabled ? css("--muted", "#8993a4") : css("--text", "#edf2f7");
    ctx.font = `600 ${node.layer === "physical" ? 11 : 12}px Arial, Helvetica, sans-serif`;
    const maxChars = node.layer === "physical" ? 22 : 27;
    const name = String(node.label || node.name || "");
    ctx.fillText(name.length > maxChars ? `${name.slice(0, maxChars - 1)}…` : name, item.x + 10, item.y + (node.layer === "physical" ? 32 : 34));
    if (node.layer === "physical" && node.kind === "disk" && node.disk_free_space != null && node.disk_total_space != null) {
      const free = Number(node.disk_free_space);
      const total = Number(node.disk_total_space);
      const used = Math.max(0, total - free);
      const pct = total > 0 ? `${(used / total * 100).toFixed(1)}% used` : "capacity —";
      ctx.fillStyle = css("--muted", "#8993a4");
      ctx.font = "9px Arial, Helvetica, sans-serif";
      ctx.fillText(`${pct} · ${util.formatBytes(free)} free`, item.x + 10, item.y + 47);
    }

    const viewLike = node.kind === "view" || node.kind === "materialized_view" || node.kind === "refreshable_materialized_view";
    if (!compact && node.layer === "logical" && !viewLike) {
      ctx.fillStyle = css("--muted", "#8993a4");
      ctx.font = "10px Arial, Helvetica, sans-serif";
      const rows = node.rows == null
        ? (node.kind === "buffer" ? "— buffered rows" : "— rows")
        : `${util.formatInt(node.rows)}${node.kind === "buffer" ? " buffered rows" : " rows"}`;
      const memoryResident = node.kind === "buffer" || node.kind === "memory" || node.kind === "dictionary";
      const rawBytes = memoryResident ? node.resident_bytes : node.logical_bytes;
      const bytes = rawBytes == null
        ? "—"
        : `${util.formatBytes(rawBytes)}${memoryResident ? " RAM" : " logical"}`;
      ctx.fillText(`${rows} · ${bytes}`, item.x + 10, item.y + 52);
      if (model.detailMode === "physical" && node.storage_policy) {
        ctx.font = "9px Arial, Helvetica, sans-serif";
        ctx.fillText(canvasEllipsis(ctx, `Storage policy · ${node.storage_policy}`, item.width - 20), item.x + 10, item.y + 70);
      }
      if (node.kind === "buffer") {
        const minTime = node.buffer_min_time == null ? "—" : `${util.formatInt(node.buffer_min_time)}s`;
        const maxTime = node.buffer_max_time == null ? "—" : `${util.formatInt(node.buffer_max_time)}s`;
        const minRows = node.buffer_min_rows == null ? "—" : util.formatInt(node.buffer_min_rows);
        const maxRows = node.buffer_max_rows == null ? "—" : util.formatInt(node.buffer_max_rows);
        ctx.font = "9px Arial, Helvetica, sans-serif";
        ctx.fillText(`${node.buffer_layers || "—"} layers · ${minTime}–${maxTime} · ${minRows}–${maxRows} rows`, item.x + 10, item.y + 69);
      }
      const badge = String(node.topology_badge || "");
      if (badge) {
        ctx.textAlign = "right";
        ctx.fillText(badge, item.x + item.width - 10, item.y + 15);
        ctx.textAlign = "left";
      }
    }
    drawTtlSummary(ctx, item, node);
    ctx.restore();
  }

  function drawDatabaseLod(ctx) {
    const groups = databaseBounds();
    ctx.save();
    for (const [database, box] of groups) {
      const pad = 24;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(box.minX - pad, box.minY - pad, box.maxX - box.minX + pad * 2, box.maxY - box.minY + pad * 2, 12);
      else ctx.rect(box.minX - pad, box.minY - pad, box.maxX - box.minX + pad * 2, box.maxY - box.minY + pad * 2);
      ctx.fillStyle = css("--tableBg", "#10141d");
      ctx.fill();
      ctx.strokeStyle = css("--borderStrong", "#384152");
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.fillStyle = css("--text", "#edf2f7");
      ctx.font = "700 15px Arial, Helvetica, sans-serif";
      ctx.fillText(database, box.minX, box.minY + 6);
      ctx.fillStyle = css("--muted", "#8993a4");
      ctx.font = "11px Arial, Helvetica, sans-serif";
      ctx.fillText(`${box.count} objects`, box.minX, box.minY + 25);
    }
    ctx.restore();
  }

  function graphHasClippedElements() {
    const main = dom.explorerGraphCanvas?.getBoundingClientRect();
    if (!main || !model.layout.size || model.scale <= 0) return false;
    // Trigger the preview on the first partially clipped graph element. This is
    // intentionally stricter than the old zoom threshold: one pixel outside
    // the viewport is enough to make the minimap useful.
    const epsilon = 0.5;
    for (const item of model.layout.values()) {
      const topLeft = worldToScreen(item.x, item.y);
      const bottomRight = worldToScreen(item.x + item.width, item.y + item.height);
      if (topLeft.x < -epsilon || topLeft.y < -epsilon
          || bottomRight.x > main.width + epsilon || bottomRight.y > main.height + epsilon) return true;
    }
    return false;
  }

  function drawMinimap() {
    const canvas = dom.explorerGraphMinimap;
    const bounds = model.worldBounds;
    if (!canvas) return;
    const hasClippedElements = graphHasClippedElements();
    canvas.hidden = !hasClippedElements;
    if (!hasClippedElements || !bounds || !model.layout.size) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = css("--panelBg", "#0b0f16");
    ctx.fillRect(0, 0, width, height);
    const scale = Math.min((width - 12) / bounds.width, (height - 12) / bounds.height);
    const ox = 6 - bounds.x * scale;
    const oy = 6 - bounds.y * scale;
    ctx.fillStyle = css("--muted", "#8993a4");
    for (const item of model.layout.values()) {
      // The preview mirrors the active projection. Storage tiers/TTL terminals
      // must therefore be represented too; otherwise the minimap can appear
      // because a physical card is clipped without showing where that card is.
      ctx.globalAlpha = model.focusedId === item.node.id ? 1 : item.node.layer === "logical" ? 0.62 : 0.42;
      ctx.fillRect(ox + item.x * scale, oy + item.y * scale, Math.max(2, item.width * scale), Math.max(2, item.height * scale));
    }
    ctx.globalAlpha = 1;
    const main = dom.explorerGraphCanvas?.getBoundingClientRect();
    if (main && model.scale > 0) {
      const worldLeft = -model.offsetX / model.scale;
      const worldTop = -model.offsetY / model.scale;
      const worldWidth = main.width / model.scale;
      const worldHeight = main.height / model.scale;
      ctx.strokeStyle = css("--accent", "#7c9cff");
      ctx.lineWidth = 1;
      ctx.strokeRect(ox + worldLeft * scale, oy + worldTop * scale, worldWidth * scale, worldHeight * scale);
    }
  }

  function draw(now = performance.now()) {
    model.animationFrame = 0;
    if (!model.active || !dom.explorerGraphCanvas) return;
    const { width, height, dpr } = canvasSize();
    if (!width || !height) return;
    const ctx = dom.explorerGraphCanvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = css("--panelBg", "#0b0f16");
    ctx.fillRect(0, 0, width, height);

    if (!model.graph || !model.layout.size) {
      ctx.fillStyle = css("--muted", "#8993a4");
      ctx.font = "13px Arial, Helvetica, sans-serif";
      ctx.fillText(model.loading ? "Loading graph…" : "No accessible objects in this scope", 24, 34);
      return;
    }

    ctx.save();
    ctx.translate(model.offsetX, model.offsetY);
    ctx.scale(model.scale, model.scale);
    if (model.scale < 0.23 && model.detailMode === "logical") {
      drawDatabaseLod(ctx);
    } else {
      const focused = focusedSet();
      for (const edge of visibleEdges()) drawEdge(ctx, edge, now, focused);
      const compact = model.scale < 0.62;
      for (const item of model.layout.values()) drawNode(ctx, item, focused, compact);
    }
    ctx.restore();
    drawMinimap();

    const hasActive = [...model.edgeActivity.values()].some((activity) => activity?.active);
    const hasFocusAnimation = !!model.focusedId && model.detailMode === "logical"
      && visibleEdges().some((edge) => isFocusedDepthOneEdge(edge) && isInsertFlowEdge(edge));
    const hasStorageAnimation = model.detailMode === "physical" && !reducedMotionPreferred()
      && visibleEdges().some((edge) => isStorageRouteEdge(edge));
    if ((hasActive || hasFocusAnimation || hasStorageAnimation) && model.active) model.animationFrame = requestAnimationFrame(draw);
  }

  function scheduleDraw() {
    if (!model.active || model.animationFrame) return;
    model.animationFrame = requestAnimationFrame(draw);
  }

  function redrawThemeNow() {
    if (!model.active || !dom.explorerGraphCanvas) return;
    // Theme changes update CSS variables synchronously, while the canvas keeps
    // its previous pixels until it is painted again. Redraw immediately in the
    // same event turn so the graph/minimap cannot visibly lag behind the DOM.
    if (model.animationFrame) {
      cancelAnimationFrame(model.animationFrame);
      model.animationFrame = 0;
    }
    draw(performance.now());
  }

  function hitNode(clientX, clientY) {
    const canvas = dom.explorerGraphCanvas;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const world = screenToWorld(clientX - rect.left, clientY - rect.top);
    const items = [...model.layout.values()].reverse();
    for (const item of items) {
      if (world.x >= item.x && world.x <= item.x + item.width && world.y >= item.y && world.y <= item.y + item.height) return item.node;
    }
    return null;
  }

  function nodeIsStorageDisabled(node) {
    return !!node && model.detailMode === "physical" && node.layer === "logical" && node.storage_disabled === true;
  }

  function nodeIsClickable(node) {
    return !!node && !nodeIsStorageDisabled(node);
  }

  function updateCanvasPointerState(node = null) {
    const canvas = dom.explorerGraphCanvas;
    if (!canvas) return;
    canvas.classList.toggle("is-node-clickable", !model.dragging && nodeIsClickable(node));
    canvas.classList.toggle("is-node-disabled", !model.dragging && nodeIsStorageDisabled(node));
  }

  function viewportMeaningfullyDiffersFromFit() {
    const base = Math.max(0.001, Number(model.fitScale) || 1);
    const zoomDelta = Math.abs(model.scale / base - 1);
    const panDelta = Math.hypot(model.offsetX - model.fitOffsetX, model.offsetY - model.fitOffsetY);
    return zoomDelta > 0.10 || panDelta > 36;
  }

  function syncFocusControls() {
    if (dom.explorerGraphDepthControls) dom.explorerGraphDepthControls.hidden = model.detailMode !== "logical";
    if (dom.explorerGraphDepthValue) dom.explorerGraphDepthValue.textContent = String(model.focusDepth);
    if (dom.explorerGraphContractButton) {
      dom.explorerGraphContractButton.hidden = model.detailMode !== "logical";
      dom.explorerGraphContractButton.disabled = !model.focusedId || model.detailMode !== "logical" || model.focusDepth <= 0;
    }
    if (dom.explorerGraphExpandButton) {
      const current = model.focusedId ? logicalNeighborhoodIds(model.focusDepth) : null;
      const next = model.focusedId ? logicalNeighborhoodIds(model.focusDepth + 1) : null;
      const canGrow = !!current && !!next && next.size > current.size;
      dom.explorerGraphExpandButton.hidden = model.detailMode !== "logical";
      dom.explorerGraphExpandButton.disabled = !model.focusedId || model.detailMode !== "logical" || !canGrow;
    }
    const storageAllowed = !model.focusedId || canUseStorageForId(model.focusedId);
    if (dom.explorerGraphPhysicalButton) {
      dom.explorerGraphPhysicalButton.disabled = !storageAllowed;
      dom.explorerGraphPhysicalButton.setAttribute("aria-disabled", String(!storageAllowed));
    }
    if (dom.explorerGraphTypeSelectButton) {
      dom.explorerGraphTypeSelectButton.dataset.singleOption = storageAllowed ? "0" : "1";
      dom.explorerGraphTypeSelectButton.setAttribute("aria-disabled", String(!storageAllowed));
      dom.explorerGraphTypeSelectButton.classList.toggle("themeSelect__button--singleOption", !storageAllowed);
      if (!storageAllowed) closeGraphTypeMenu({ immediate: true });
    }
    if (dom.explorerGraphFitButton) dom.explorerGraphFitButton.hidden = false;
  }

  function recomputePreservingFocus() {
    // Keep the viewport and every retained node fixed. Only newly visible nodes
    // receive coordinates; nodes outside the new neighbourhood simply vanish.
    computeLayout({ preserveExisting: true });
    model.isFitted = false;
    syncFocusControls();
    scheduleDraw();
  }

  function recomputePreservingFocusAnchorOnly(anchor = captureViewportAnchor()) {
    // Visibility changes alter the projected DAG itself. Reusing old node
    // coordinates after Sugiyama crossing minimisation creates a hybrid layout
    // and is the source of the OFF -> ON arrow disorder. Recompute the canonical
    // layout from scratch, then preserve only the camera anchor.
    computeLayout();
    restoreViewportAnchor(anchor);
    model.isFitted = false;
    syncFocusControls();
    scheduleDraw();
  }

  function logicalFocusId(id) {
    if (!id || !model.graph) return id || null;
    const byId = new Map((model.graph.nodes || []).map((node) => [node.id, node]));
    const initial = byId.get(id) || null;
    if (!initial) return null;
    if (initial.layer === "logical") return initial.id;
    // Clicking a physical child should not jump away from an already selected
    // logical table, especially for a shared disk with multiple parents.
    if (model.focusedId && byId.get(model.focusedId)?.layer === "logical") return model.focusedId;

    const incoming = new Map();
    for (const edge of model.graph.edges || []) {
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
        const parent = byId.get(parentId);
        if (!parent) continue;
        if (parent.layer === "logical") return parent.id;
        queue.push(parent.id);
      }
    }
    return null;
  }

  function setFocus(id, center = false, { preserveDepth = true } = {}) {
    // Storage-topology nodes are implementation details of a logical object.
    // Keep the logical table/view as the neighbourhood anchor so selecting a
    // disk/replica/shard cannot accidentally expand back to the whole graph.
    const nextId = logicalFocusId(id);
    const changed = model.focusedId !== nextId;
    model.focusedId = nextId;
    if (changed && !preserveDepth) model.focusDepth = 1;
    syncFocusControls();
    if (changed) model.onStateChange?.();
    if (!model.graph) { scheduleDraw(); return; }

    if (center) {
      computeLayout();
      fitToScreen();
      return;
    }

    // A focus change is not a camera operation. Preserve the canvas transform
    // byte-for-byte and freeze every node that survives the neighbourhood
    // change. The layout engine may only position newly introduced nodes.
    computeLayout({ preserveExisting: true });
    model.isFitted = false;
    syncFocusControls();
    scheduleDraw();
  }

  function focusTable(database, table, { ensureVisible = false } = {}) {
    const db = String(database || "");
    const id = `table:${db}.${String(table || "")}`;
    model.pendingFocusId = id;
    model.pendingEnsureVisible = !!ensureVisible;
    if (model.database && model.database !== db) {
      model.database = db;
      model.focusedId = null;
      if (model.active) refresh(false);
      return;
    }
    if (!model.graph) return;
    const exists = (model.graph.nodes || []).some((node) => node.id === id && node.layer === "logical");
    if (exists && model.detailMode === "physical" && !canUseStorageForId(id)) {
      model.pendingFocusId = null;
      model.pendingEnsureVisible = false;
      return false;
    }
    if (!exists) {
      // The catalog may be fresher than the graph cache (for example directly
      // after a CREATE). Never leave the previously focused node selected when
      // the sidebar asks for a real table that is missing from this payload.
      // Force one graph refresh; pendingFocusId will be resolved by refresh().
      if (model.active) refresh(true);
      return true;
    }
    model.pendingFocusId = null;
    const shouldEnsure = model.pendingEnsureVisible;
    model.pendingEnsureVisible = false;
    // Canvas-originated clicks never move the camera. A table selected from
    // outside the canvas that is currently off-screen is different: make it
    // the neighbourhood anchor, recompute that scope and perform a real Fit so
    // the newly selected table is centered in a useful complete view.
    const needsFit = shouldEnsure && !nodeIsOnScreen(id);
    setFocus(id, needsFit, { preserveDepth: true });
    return true;
  }


  function focusDatabase(database) {
    const next = String(database || "");
    if (model.database === next && model.graph) {
      // Selecting the database is an explicit scope action and intentionally
      // restores the complete database topology.
      model.focusedId = null;
      model.pendingFocusId = null;
      model.pendingEnsureVisible = false;
      model.focusDepth = 1;
      computeLayout();
      fitToScreen();
      syncFocusControls();
      return;
    }
    model.database = next;
    // Database selection is a new graph scope. Old world coordinates are not
    // meaningful here; clearing them lets the fresh scope fit exactly once.
    model.layout.clear();
    model.worldBounds = null;
    model.focusedId = null;
    model.pendingFocusId = null;
    model.pendingEnsureVisible = false;
    model.focusDepth = 1;
    if (model.active) refresh(false);
  }

  function contractNeighborhood() {
    if (!model.focusedId || model.focusDepth <= 0) return;
    model.focusDepth -= 1;
    recomputePreservingFocus();
    model.onStateChange?.();
  }

  function expandNeighborhood() {
    if (!model.focusedId) return;
    const current = logicalNeighborhoodIds(model.focusDepth);
    const next = logicalNeighborhoodIds(model.focusDepth + 1);
    if (!current || !next || next.size <= current.size) { syncFocusControls(); return; }
    model.focusDepth += 1;
    recomputePreservingFocus();
    model.onStateChange?.();
  }

  function defaultFocusId() {
    const logical = (model.graph?.nodes || []).filter((node) => node.layer === "logical");
    if (!logical.length) return null;

    const logicalIds = new Set(logical.map((node) => node.id));
    const degree = new Map(logical.map((node) => [node.id, 0]));
    for (const edge of model.graph?.edges || []) {
      if (!logicalIds.has(edge.from) || !logicalIds.has(edge.to)) continue;
      degree.set(edge.from, (degree.get(edge.from) || 0) + 1);
      degree.set(edge.to, (degree.get(edge.to) || 0) + 1);
    }

    const systemDatabases = new Set(["system", "information_schema", "INFORMATION_SCHEMA"]);
    const ordered = logical.slice().sort((a, b) => {
      const aSystem = systemDatabases.has(String(a.database || "")) ? 1 : 0;
      const bSystem = systemDatabases.has(String(b.database || "")) ? 1 : 0;
      if (aSystem !== bSystem) return aSystem - bSystem;
      const degreeDelta = (degree.get(b.id) || 0) - (degree.get(a.id) || 0);
      if (degreeDelta) return degreeDelta;
      return `${a.database || ""}.${a.name || ""}`.localeCompare(`${b.database || ""}.${b.name || ""}`);
    });
    return ordered[0]?.id || null;
  }

  function searchFocus() {
    if (!model.active || !model.graph) return;
    const query = String(dom.explorerSearchInput?.value || "").trim().toLowerCase();
    if (!query) return;
    const match = visibleNodes().find((node) => node.layer === "logical" && `${node.database}.${node.name} ${node.engine || ""}`.toLowerCase().includes(query));
    if (match) setFocus(match.id, true);
  }

  function updateStatus() {
    if (!dom.explorerGraphStatus) return;
    if (model.loading) {
      dom.explorerGraphStatus.textContent = "Loading graph…";
      return;
    }
    const nodes = visibleNodes().length;
    const edges = visibleEdges().length;
    const scope = model.database || "all databases";
    const activityAt = model.activity?.generated_at_ms ? new Date(model.activity.generated_at_ms).toLocaleTimeString() : "—";
    const focus = model.focusedId && model.detailMode === "logical" ? ` · neighborhood depth ${model.focusDepth}` : "";
    dom.explorerGraphStatus.textContent = `${nodes} nodes · ${edges} edges · ${scope}${focus} · activity ${activityAt}`;
  }

  function setActivity(payload) {
    model.activity = payload || null;
    model.nodeActivity = new Map((payload?.nodes || []).map((item) => [item.node_id, item]));
    model.edgeActivity = new Map((payload?.edges || []).map((item) => [item.edge_id, item]));
    updateStatus();
    scheduleDraw();
  }

  async function refreshActivity(generation) {
    if (!model.active || !model.graph) return;
    const hostId = String(state.selectedHostId || "");
    if (!hostId) return;
    try {
      const payload = await api.getExplorerActivity(hostId, model.database);
      if (!model.active || generation !== model.pollGeneration || String(state.selectedHostId || "") !== hostId) return;
      setActivity(payload);
    } catch (e) {
      // Live overlay is best-effort; topology remains useful when system logs
      // are unavailable or disabled.
      if (dom.explorerGraphStatus) dom.explorerGraphStatus.textContent = `Topology available · live activity unavailable: ${e.message || e}`;
    }
  }

  function startPolling() {
    stopPolling();
    const generation = ++model.pollGeneration;
    refreshActivity(generation);
    const interval = Math.max(1000, Math.min(30000, Number(model.graph?.live_refresh_ms) || 2000));
    model.pollTimer = window.setInterval(() => refreshActivity(generation), interval);
  }

  function stopPolling() {
    model.pollGeneration += 1;
    if (model.pollTimer) window.clearInterval(model.pollTimer);
    model.pollTimer = null;
  }

  async function refresh(force = false, { reflow = false } = {}) {
    if (!model.active) return;

    // Every requested refresh receives a generation, including requests made
    // while another graph fetch is in flight. That immediately makes the
    // older response stale. The latest request is then replayed after the
    // current transport finishes instead of being silently discarded.
    const serial = ++model.refreshSerial;
    if (model.loading) {
      model.refreshQueued = true;
      model.refreshQueuedForce = model.refreshQueuedForce || !!force;
      model.refreshQueuedReflow = model.refreshQueuedReflow || !!reflow;
      return;
    }

    const hostId = String(state.selectedHostId || "");
    if (!hostId) return;
    const requestDatabase = String(model.database || "");
    const hadLayout = model.layout.size > 0;
    model.loading = true;
    updateStatus();
    scheduleDraw();
    try {
      const payload = await api.getExplorerGraph(hostId, requestDatabase, !!force);
      const stale = !model.active
        || serial !== model.refreshSerial
        || String(state.selectedHostId || "") !== hostId
        || String(model.database || "") !== requestDatabase;
      if (stale) return;

      model.graph = payload;
      model.activity = null;
      model.nodeActivity.clear();
      model.edgeActivity.clear();
      let ensurePendingFocus = false;
      if (model.pendingFocusId && (payload.nodes || []).some((node) => node.id === model.pendingFocusId)) {
        if (model.detailMode === "physical" && !canUseStorageForId(model.pendingFocusId)) {
          model.detailMode = "logical";
          dom.explorerGraphLogicalButton?.setAttribute("aria-selected", "true");
          dom.explorerGraphPhysicalButton?.setAttribute("aria-selected", "false");
          if (dom.explorerGraphTypeSelectButton) dom.explorerGraphTypeSelectButton.textContent = "Lineage";
          model.onStateChange?.();
        }
        model.focusedId = model.pendingFocusId;
        model.pendingFocusId = null;
        ensurePendingFocus = model.pendingEnsureVisible;
        model.pendingEnsureVisible = false;
      } else if (model.focusedId && !(payload.nodes || []).some((node) => node.id === model.focusedId)) {
        model.focusedId = null;
      }
      computeLayout({ preserveExisting: hadLayout && !reflow });
      if (ensurePendingFocus && model.focusedId) {
        // The selected table was not present in the previous graph payload. Once
        // the refresh exposes it, treat that as an off-screen selection and fit
        // the new focused neighbourhood instead of doing a blind pan.
        fitToScreen();
      } else if (reflow) {
        // Manual graph refresh means "re-layout what I am looking at now".
        // visibleNodes()/visibleEdges() already encode the current database,
        // focus depth and visibility toggles, so recompute from that projection
        // instead of preserving stale coordinates from a previous arrangement.
        fitToScreen();
      } else if (hadLayout && model.layout.size) {
        model.isFitted = false;
        syncFocusControls();
        scheduleDraw();
      } else {
        fitToScreen();
      }
      startPolling();
    } catch (e) {
      // A stale transport error belongs to the old scope and must not erase a
      // newer graph selection that is waiting in the queue.
      const stale = serial !== model.refreshSerial
        || String(state.selectedHostId || "") !== hostId
        || String(model.database || "") !== requestDatabase;
      if (!stale) {
        model.graph = null;
        model.layout.clear();
        if (dom.explorerGraphStatus) dom.explorerGraphStatus.textContent = e instanceof Error ? e.message : String(e);
        scheduleDraw();
      }
    } finally {
      model.loading = false;
      updateStatus();
      if (model.refreshQueued && model.active) {
        const queuedForce = model.refreshQueuedForce;
        const queuedReflow = model.refreshQueuedReflow;
        model.refreshQueued = false;
        model.refreshQueuedForce = false;
        model.refreshQueuedReflow = false;
        queueMicrotask(() => refresh(queuedForce, { reflow: queuedReflow }));
      }
    }
  }

  function setDetailMode(mode, { notify = true } = {}) {
    let next = mode === "physical" ? "physical" : "logical";
    if (next === "physical" && model.focusedId && !canUseStorageForId(model.focusedId)) next = "logical";
    const changed = model.detailMode !== next;
    model.detailMode = next;
    dom.explorerGraphLogicalButton?.setAttribute("aria-selected", String(next === "logical"));
    dom.explorerGraphPhysicalButton?.setAttribute("aria-selected", String(next === "physical"));
    if (dom.explorerGraphTypeSelectButton) dom.explorerGraphTypeSelectButton.textContent = next === "physical" ? "Storage" : "Lineage";
    // TTL lifecycle only exists in the Storage projection. Keep the legend
    // contextual so Lineage does not advertise an edge type it never renders.
    const ttlLegend = document.getElementById("explorerGraphLegendTtl");
    if (ttlLegend) ttlLegend.hidden = next !== "physical";
    closeGraphTypeMenu({ immediate: true });
    if (!changed) return;
    syncFocusControls();
    if (model.focusedId) recomputePreservingFocus();
    else { computeLayout(); fitToScreen(); }
    if (notify) model.onStateChange?.();
  }

  function minimumZoomScale() {
    const fitScale = Number(model.fitScale);
    return Number.isFinite(fitScale) && fitScale > 0 ? fitScale : 0.06;
  }

  function zoomBy(factor) {
    const canvas = dom.explorerGraphCanvas;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const px = rect.width / 2;
    const py = rect.height / 2;
    const before = screenToWorld(px, py);
    model.scale = Math.max(minimumZoomScale(), Math.min(3.2, model.scale * factor));
    model.offsetX = px - before.x * model.scale;
    model.offsetY = py - before.y * model.scale;
    model.isFitted = Math.abs(model.scale - model.fitScale) < 1e-9;
    syncFocusControls();
    scheduleDraw();
  }

  function getRouteState() { return { mode: model.detailMode, depth: model.focusDepth }; }

  function applyRouteState(route = {}) {
    const depth = Number(route.depth);
    if (Number.isFinite(depth)) model.focusDepth = Math.max(0, Math.min(8, Math.trunc(depth)));
    setDetailMode(route.mode === "physical" ? "physical" : "logical", { notify: false });
    syncFocusControls();
  }

  function isStorageMode() { return model.detailMode === "physical"; }

  function visibilityRequirements() {
    const node = (model.graph?.nodes || []).find((candidate) => candidate.id === model.focusedId) || null;
    const database = String(node?.database || "");
    return {
      includeSystem: !!node && ["system", "information_schema", "INFORMATION_SCHEMA"].includes(database),
      includeNonStoring: !!node && isNonStoringNode(node),
    };
  }

  function setVisibilityOptions(options = {}) {
    const previousIncludeNonStoring = model.includeNonStoring;
    const required = visibilityRequirements();
    const nextIncludeSystem = required.includeSystem || options.includeSystem === true;
    const nextIncludeNonStoring = required.includeNonStoring || options.includeNonStoring !== false;
    const projectionChanged = previousIncludeNonStoring !== nextIncludeNonStoring || model.includeSystem !== nextIncludeSystem;
    const anchor = projectionChanged ? captureViewportAnchor({ includeSystem: nextIncludeSystem, includeNonStoring: nextIncludeNonStoring }) : null;
    model.includeSystem = nextIncludeSystem;
    model.includeNonStoring = nextIncludeNonStoring;
    if (model.focusedId) {
      const node = (model.graph?.nodes || []).find((candidate) => candidate.id === model.focusedId);
      if (node && !logicalNodeAllowed(node)) model.focusedId = null;
    }
    if (projectionChanged) recomputePreservingFocusAnchorOnly(anchor);
    else {
      computeLayout({ preserveExisting: true });
      syncFocusControls();
      scheduleDraw();
    }
    return { includeSystem: model.includeSystem, includeNonStoring: model.includeNonStoring, required };
  }

  function activate(force = false) {
    model.active = true;
    if (dom.explorerGraphPane) dom.explorerGraphPane.hidden = false;
    refresh(force);
    scheduleDraw();
  }

  function deactivate() {
    model.active = false;
    stopPolling();
    if (model.animationFrame) cancelAnimationFrame(model.animationFrame);
    model.animationFrame = 0;
  }

  function onScopeChanged() {
    if (!model.active) return;
    searchFocus();
  }

  function onHostChanged() {
    model.refreshSerial += 1;
    model.refreshQueued = false;
    model.refreshQueuedForce = false;
    model.refreshQueuedReflow = false;
    model.graph = null;
    model.activity = null;
    model.layout.clear();
    model.focusedId = null;
    model.pendingEnsureVisible = false;
    if (model.active) refresh(false);
  }

  function init(options = {}) {
    model.openTable = typeof options.openTable === "function" ? options.openTable : null;
    model.onStateChange = typeof options.onStateChange === "function" ? options.onStateChange : null;
    const canvas = dom.explorerGraphCanvas;
    if (!canvas) return;

    model.resizeObserver = new ResizeObserver(() => {
      canvasSize();
      scheduleDraw();
    });
    model.resizeObserver.observe(canvas);

    canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      const before = screenToWorld(px, py);
      const factor = Math.exp(-event.deltaY * 0.0012);
      model.scale = Math.max(minimumZoomScale(), Math.min(3.2, model.scale * factor));
      model.offsetX = px - before.x * model.scale;
      model.offsetY = py - before.y * model.scale;
      model.isFitted = Math.abs(model.scale - model.fitScale) < 1e-9;
      syncFocusControls();
      scheduleDraw();
    }, { passive: false });

    canvas.addEventListener("pointerdown", (event) => {
      canvas.setPointerCapture?.(event.pointerId);
      model.dragging = true;
      model.dragMoved = false;
      model.dragX = event.clientX;
      model.dragY = event.clientY;
      canvas.classList.remove("is-node-clickable", "is-node-disabled");
      canvas.classList.add("is-dragging");
    });
    canvas.addEventListener("pointermove", (event) => {
      model.lastPointerX = event.clientX;
      model.lastPointerY = event.clientY;
      if (model.dragging) {
        const dx = event.clientX - model.dragX;
        const dy = event.clientY - model.dragY;
        if (Math.abs(dx) + Math.abs(dy) > 2) model.dragMoved = true;
        model.offsetX += dx;
        model.offsetY += dy;
        model.isFitted = false;
        syncFocusControls();
        model.dragX = event.clientX;
        model.dragY = event.clientY;
        scheduleDraw();
        return;
      }
      const node = hitNode(event.clientX, event.clientY);
      const clickable = nodeIsClickable(node);
      const next = clickable ? node.id : null;
      updateCanvasPointerState(clickable ? node : null);
      if (next !== model.hoveredId) {
        model.hoveredId = next;
        scheduleDraw();
      }
    });
    const endDrag = (event) => {
      if (!model.dragging) return;
      model.dragging = false;
      canvas.releasePointerCapture?.(event.pointerId);
      canvas.classList.remove("is-dragging");
      const node = hitNode(event.clientX, event.clientY);
      updateCanvasPointerState(node);
      if (!model.dragMoved && nodeIsClickable(node)) {
        setFocus(node.id);
        if (node.layer === "logical" && model.openTable && node.database && node.name) {
          model.openTable(node.database, node.name);
        }
      }
    };
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);
    canvas.addEventListener("pointerleave", () => {
      if (!model.dragging) {
        model.hoveredId = null;
        updateCanvasPointerState(null);
        scheduleDraw();
      }
    });
    dom.explorerGraphLogicalButton?.addEventListener("click", () => setDetailMode("logical"));
    dom.explorerGraphPhysicalButton?.addEventListener("click", () => setDetailMode("physical"));
    dom.explorerGraphTypeSelectButton?.addEventListener("click", toggleGraphTypeMenu);
    dom.explorerGraphContractButton?.addEventListener("click", contractNeighborhood);
    dom.explorerGraphExpandButton?.addEventListener("click", expandNeighborhood);
    dom.explorerGraphFitButton?.addEventListener("click", fitToScreen);
    dom.explorerGraphZoomInButton?.addEventListener("click", () => zoomBy(1.22));
    dom.explorerGraphZoomOutButton?.addEventListener("click", () => zoomBy(1 / 1.22));
    dom.explorerGraphRefreshButton?.addEventListener("click", () => refresh(true, { reflow: true }));
    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Node) || !graphTypeMenuOpen()) return;
      if (!dom.explorerGraphTypeSelect?.contains(target)) closeGraphTypeMenu();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeGraphTypeMenu({ immediate: true });
    });
    setDetailMode(model.detailMode);
  }

  ns.explorerGraph = {
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
})();
