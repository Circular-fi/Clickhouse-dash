(() => {
  "use strict";

  // Explorer Lineage / Storage graph on the shared canvas graph kit
  // (app_graph_kit.js): projections, layout, database groups, per-node
  // expansion, side panel (a bottom sheet on phones) and the activity / TTL
  // overlays. The canvas is the only view, on phones too: the kit's keyboard
  // access (arrows, Enter, the live region) is the accessible path.
  const ns = window.ChDash;
  if (!ns || !ns.graphKit) return;
  const { byId, $ } = ns.dom;

  const { dom, state, api, h } = ns;
  // Counts, sizes and shares from ns.format (docs/ui-foundations.md).
  const format = ns.format;
  const kit = ns.graphKit;

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
  };

  const NODE_HEIGHT = 80;
  const NODE_WIDTH = 264;
  const PHYSICAL_WIDTH = 180;
  const PHYSICAL_HEIGHT = 60;
  const X_GAP = 92;
  const Y_GAP = 34;
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

  // Theme tokens, canvas sizing, cards, routing, labels, minimap and the
  // pan / zoom / keyboard controller come from the shared graph kit.
  function css(name) {
    return kit.theme.cssVar(name);
  }

  function lightThemeActive() {
    return kit.theme.isLight();
  }

  function reducedMotionPreferred() {
    return kit.reducedMotion();
  }

  function canvasSize() {
    return kit.canvasSize(dom.explorerGraphCanvas);
  }

  function parseLogicalTableId(id) {
    const raw = String(id || "");
    if (!raw.startsWith("table:")) return null;
    const qualified = raw.slice(6);
    const dot = qualified.indexOf(".");
    if (dot <= 0 || dot >= qualified.length - 1) return null;
    return { database: qualified.slice(0, dot), table: qualified.slice(dot + 1) };
  }

  function currentFocusScope() {
    const id = model.pendingFocusId || model.focusedId;
    if (!id) return null;
    const node = (model.graph?.nodes || []).find((candidate) => candidate.id === id && candidate.layer === "logical");
    if (node) return { database: String(node.database || ""), table: String(node.name || "") };
    return parseLogicalTableId(id);
  }

  function graphRequestOptions(refresh = false) {
    const focus = currentFocusScope();
    const options = {
      mode: model.detailMode,
      includeSystem: model.includeSystem,
      includeNonStoring: model.includeNonStoring,
      refresh: !!refresh,
    };
    if (focus?.database && focus?.table) {
      options.focusDatabase = focus.database;
      options.focusTable = focus.table;
      // Request exactly what is displayed. The backend exposes scope_has_more,
      // so the + depth control never needs a hidden look-ahead ring.
      options.depth = model.detailMode === "logical" ? Math.min(8, model.focusDepth) : 0;
      if (model.detailMode === "logical" && model.expansions.size) {
        options.expand = [...model.expansions].sort().map((key) => {
          const [direction, id] = key.split("\u0000");
          return `${direction}:${id}`;
        });
      }
    } else if (model.database) {
      options.database = model.database;
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
    if (!model.includeNonStoring && isNonStoringNode(node) && node.id !== model.focusedId) return false;
    return true;
  }

  function collapsedEdgeKind(path) {
    if (path.some((part) => ["refreshable_mv", "refreshable_mv_output"].includes(part.kind))) return "refreshable_mv";
    if (path.some((part) => ["materialized_view", "materialized_view_output"].includes(part.kind))) return "materialized_view";
    if (path.some((part) => part.kind === "buffer")) return "buffer";
    return "view";
  }

  function logicalProjectionCacheValid(cache) {
    return !!cache
      && cache.graph === model.graph
      && cache.focusedId === model.focusedId
      && cache.includeSystem === model.includeSystem
      && cache.includeNonStoring === model.includeNonStoring;
  }

  function rememberLogicalProjection(projection) {
    model.logicalProjectionCache = {
      graph: model.graph,
      focusedId: model.focusedId,
      includeSystem: model.includeSystem,
      includeNonStoring: model.includeNonStoring,
      projection,
    };
    return projection;
  }

  function logicalProjection() {
    // The projection depends only on the payload object and the visibility
    // inputs below, yet draw/minimap/status asked for it ~11 times per frame
    // (each call sorting every edge with localeCompare). Payloads are replaced,
    // never mutated, so object identity is a sound cache key.
    if (logicalProjectionCacheValid(model.logicalProjectionCache)) return model.logicalProjectionCache.projection;
    const nodes = Array.isArray(model.graph?.nodes) ? model.graph.nodes.filter((node) => node.layer === "logical") : [];
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const systemHidden = (node) => !model.includeSystem && ["system", "information_schema", "INFORMATION_SCHEMA"].includes(String(node?.database || ""));
    const collapseHidden = (node) => !model.includeNonStoring && isNonStoringNode(node) && node.id !== model.focusedId;
    const visible = new Set(nodes.filter((node) => !systemHidden(node) && !collapseHidden(node)).map((node) => node.id));
    const rawEdges = (model.graph?.edges || [])
      .filter((edge) => nodeById.has(edge.from) && nodeById.has(edge.to))
      .slice()
      .sort((a, b) => `${a.from}\u0000${a.to}\u0000${a.kind}\u0000${a.id}`.localeCompare(`${b.from}\u0000${b.to}\u0000${b.kind}\u0000${b.id}`));

    if (model.includeNonStoring) {
      return rememberLogicalProjection({ nodes: nodes.filter((node) => visible.has(node.id)), edges: rawEdges.filter((edge) => visible.has(edge.from) && visible.has(edge.to)) });
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
    return rememberLogicalProjection({ nodes: nodes.filter((node) => visible.has(node.id)), edges: projected });
  }

  function canUseStorageForId(id) {
    if (!id || !model.graph) return false;
    const nodes = model.graph.nodes || [];
    const edges = model.graph.edges || [];
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
    const itemById = new Map(nodes.map((node) => [node.id, node]));
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

  // visibleNodes()/visibleEdges() run several times per animated frame (edges,
  // minimap, animation check, status). Memoise them on the projection object
  // plus the neighbourhood inputs; callers treat the returned arrays as
  // read-only.
  function visibleSet() {
    let projection;
    if (model.detailMode === "physical") projection = storageProjection();
    else projection = logicalProjection();
    const cache = model.visibleSetCache;
    if (cache
        && cache.projection === projection
        && cache.detailMode === model.detailMode
        && cache.focusedId === model.focusedId
        && cache.focusDepth === model.focusDepth
        && cache.groupsVersion === model.groupsVersion
        && cache.showIsolated === model.showIsolated) {
      model.groupStats = cache.groupStats;
      return cache;
    }
    let nodes = projection.nodes;
    let edges = projection.edges;
    model.groupStats = null;
    if (model.detailMode !== "physical") {
      // A payload scoped to exactly the current request (focus, depth and
      // per-node expansions) is already the neighbourhood. The client-side
      // ring only bridges the time until a new focus/depth arrives.
      const exactScope = !!model.focusedId && model.graphRequestKey === graphRequestKey(graphRequestOptions(false));
      const logicalIds = exactScope ? null : logicalNeighborhoodIds();
      if (logicalIds) nodes = projection.nodes.filter((node) => logicalIds.has(node.id));
      const ids = new Set(nodes.map((node) => node.id));
      edges = projection.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
      if (!model.focusedId) ({ nodes, edges } = groupedOverview(nodes, edges));
    }
    model.visibleSetCache = {
      projection,
      detailMode: model.detailMode,
      focusedId: model.focusedId,
      focusDepth: model.focusDepth,
      groupsVersion: model.groupsVersion,
      showIsolated: model.showIsolated,
      groupStats: model.groupStats,
      nodes,
      edges,
    };
    return model.visibleSetCache;
  }

  // Unfocused Lineage overview (all databases or one database): objects
  // without any dependency are hidden unless "Show objects without
  // dependencies" is on, and every database that is not expanded collapses
  // into one card. Edges between collapsed databases are aggregated with a
  // count, so the overview stays a handful of readable cards on any catalog.
  function groupedOverview(nodes, edges) {
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
    const expanded = (database) => autoExpand || model.expandedGroups.has(database);
    const representative = new Map();
    const outNodes = [];
    const groupNodes = new Map();
    for (const node of nodes) {
      const database = String(node.database || "default");
      const stat = stats.get(database);
      const isolated = !degree.get(node.id);
      if (isolated && !model.showIsolated) continue;
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
    model.groupStats = stats;
    return { nodes: outNodes, edges: outEdges };
  }

  function visibleNodes() {
    const projection = visibleSet();
    return projection.nodes;
  }

  function visibleNodeIds() {
    return new Set(visibleNodes().map((node) => node.id));
  }

  function visibleEdges() {
    return visibleSet().edges;
  }

  function ttlRules(node) {
    return Array.isArray(node?.ttl_rules) ? node.ttl_rules.filter((rule) => rule && rule.expression) : [];
  }

  function nodeSize(node) {
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
    const rules = model.detailMode === "physical" ? ttlRules(node) : [];
    const storageDisabled = model.detailMode === "physical" && node.layer === "logical" && node.storage_disabled === true;
    const hasStoragePolicy = model.detailMode === "physical" && node.layer === "logical" && !!String(node.storage_policy || "");
    // In Storage mode the table owns the policy label and only identifies the
    // TTL clock. Lifecycle actions themselves live on tiers/transitions.
    if (storageDisabled) return { width: NODE_WIDTH, height: 96 };
    if (rules.length && hasStoragePolicy) return { width: NODE_WIDTH, height: 114 };
    if (hasStoragePolicy) return { width: NODE_WIDTH, height: 88 };
    if (rules.length) return { width: NODE_WIDTH, height: 96 };
    if (node.kind === "buffer") return { width: NODE_WIDTH, height: 96 };
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

  function alignPhysicalHorizontalPeers(positions, edges) {
    if (model.detailMode !== "physical" || positions.size < 2) return;
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

  function groupLogicalPositionsByDatabase(positions) {
    if (model.detailMode !== "logical" || !positions.size) return;
    const groups = new Map();
    for (const item of positions.values()) {
      if (item.node?.layer !== "logical") continue;
      const database = String(item.node.database || "default");
      if (!groups.has(database)) groups.set(database, []);
      groups.get(database).push(item);
    }
    if (groups.size <= 1) return;

    const focus = currentFocusScope();
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

  function computeLayout({ preserveExisting = false, preserveIds = null } = {}) {
    const previousLayout = preserveExisting ? new Map(model.layout) : null;
    const nodes = visibleNodes();
    const edges = visibleEdges();
    const xGap = model.detailMode === "physical" ? 138 : X_GAP;
    const stableNodeCompare = (a, b) => {
      if (a.database !== b.database) return String(a.database).localeCompare(String(b.database));
      if (a.layer !== b.layer) return a.layer === "logical" ? -1 : 1;
      return String(a.name).localeCompare(String(b.name));
    };
    // Lineage is assigned to a *global* row grid (kit.layered rowGrid): a node
    // in column N can stay on the exact row of its parent/child even when
    // another column has a different number of nodes. Storage packs columns.
    const lineageRowPitch = model.detailMode === "logical"
      ? Math.max(NODE_HEIGHT, ...nodes.filter((node) => node.layer === "logical").map((node) => nodeSize(node).height)) + Y_GAP
      : null;
    const { positions, level } = kit.layered({
      nodes,
      edges,
      size: nodeSize,
      compare: stableNodeCompare,
      queueCompare: (an, bn) => {
        const adb = String(an?.database || "");
        const bdb = String(bn?.database || "");
        if (adb !== bdb) return adb.localeCompare(bdb);
        return String(an?.name || "").localeCompare(String(bn?.name || ""));
      },
      weight: (edge) => (isLogicalDependencyEdge(edge) ? 0.62 : 1.0),
      rowGrid: model.detailMode === "logical",
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

    groupLogicalPositionsByDatabase(positions);
    alignPhysicalStorageRows(positions, nodes, edges, level);
    alignPhysicalHorizontalPeers(positions, edges);

    const idealPositions = new Map(
      [...positions.entries()].map(([id, item]) => [id, { ...item }])
    );
    if (preserveExisting) stabilizeLayoutPositions(positions, idealPositions, previousLayout, edges, preserveIds);

    model.layout = positions;
    model.routeJob?.cancel();
    model.routeJob = null;
    model.lineageRouteCache = null;
    // A layout that routes in a Worker starts at once, so the status says "Routing edges" from the first frame.
    if (model.detailMode === "logical" && kit.routeEdgesJobWanted(visibleEdges().length)) ensureLineageRouteCache();
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
    clampViewportToGraph();
    model.isFitted = false;
    syncFocusControls();
    scheduleDraw();
    return true;
  }

  function focusedSet() {
    if (!model.focusedId) return null;
    return new Set(visibleNodes().map((node) => node.id));
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

  // Dash pattern (kit.DASH) and width by edge kind: solid data flow, dashed
  // query-time dependencies, dotted routing / containment.
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

  function lineageEdgeShouldAnimate(edge) {
    if (reducedMotionPreferred() || !model.focusedId) return false;
    if (!isFocusedDepthOneEdge(edge)) return false;
    return isInsertFlowEdge(edge) || isRefreshFlowEdge(edge);
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

  function storagePolylineMetric(points) {
    return kit.polylineMetric(points);
  }

  function storageRoutePoint(points, t) {
    return kit.routePoint(points, t);
  }

  function drawStorageRoute(ctx, points) {
    kit.tracePolyline(ctx, points);
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

  function isLogicalDependencyEdge(edge) {
    return ["view", "dependency", "dictionary_source"].includes(String(edge?.kind || ""));
  }

  // Every logical node exposes one output port (right edge) and one input
  // port (left edge) at LINEAGE_NODE_PORT_TOP_OFFSET from the top of the card,
  // on the global row grid of the layout: the kit's orthogonal router
  // (kit.routeEdges) keeps each route in its own lane past a small fan zone.
  const LINEAGE_NODE_PORT_TOP_OFFSET = kit.LINEAGE_NODE_PORT_TOP_OFFSET;

  function lineageNodePort(item, side = "right") {
    return kit.nodePort(item, side);
  }

  function ensureLineageRouteCache() {
    if (model.detailMode !== "logical") return new Map();
    if (model.lineageRouteCache instanceof Map) return model.lineageRouteCache;
    const edges = visibleEdges().filter((edge) => !isStorageRouteEdge(edge));
    const options = { isSecondary: isLogicalDependencyEdge };
    // A large layout routes in a Worker: until it answers the edges are drawn as curves and carry no labels (a placeholder
    // stands for the routes, so the label cache stays valid), then the routes replace it and the graph redraws. A small
    // one, or a browser without the Worker or the kernel, routes here at once.
    const layout = model.layout;
    const job = model.detailMode === "logical" ? kit.routeEdgesJob(layout, edges, options) : null;
    if (job) {
      const placeholder = new Map();
      model.lineageRouteCache = placeholder;
      model.routeJob = job;
      updateStatus();
      job.promise.then((routes) => {
        if (model.lineageRouteCache !== placeholder) return;
        model.routeJob = null;
        model.lineageRouteCache = routes || kit.routeEdges(layout, edges, options);
        updateStatus();
        scheduleDraw();
      });
      return placeholder;
    }
    model.lineageRouteCache = kit.routeEdges(model.layout, edges, { isSecondary: isLogicalDependencyEdge });
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
    // Hit testing and labels reuse the exact drawn geometry of this frame.
    if (model.edgeGeometry) model.edgeGeometry.set(edge.id, routePoints || bezierRoutePoints(a, p1, p2, b, 24));
    const highlighted = edgeIsHighlighted(edge);
    ctx.save();
    drawSelectedLogicalDependencyHalo(ctx, edge, routePoints, a, p1, p2, b);
    ctx.globalAlpha = highlighted ? 1 : selected ? 0.8 : Math.min(0.2, dimAlpha());
    ctx.strokeStyle = highlighted ? graphColor("halo") : isLogicalDependencyEdge(edge) ? graphColor("edgeMuted") : graphColor("edge");
    edgeStyle(edge, ctx);
    if (highlighted) ctx.lineWidth += 1.2;
    // Dash patterns encode edge semantics but never move. Motion is reserved
    // for the one normalized round marker on actual insert-time data flow.
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
    if (!straightStorage && selected && lineageEdgeShouldAnimate(edge)) {
      drawNormalizedFlowMarker(ctx, edge, now, routePoints || bezierRoutePoints(a, p1, p2, b));
    }
    ctx.restore();
  }

  function kindCode(kind) {
    return ({
      materialized_view: "MaterializedView",
      refreshable_materialized_view: "Refreshable materialized view",
      view: "View",
      distributed: "Distributed",
      buffer: "Buffer",
      mergetree: "MergeTree",
      tinylog: "TinyLog",
      stripelog: "StripeLog",
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
    // ClickHouse's own engine names, as system.tables spells them: an engine
    // given in another spelling (lower case, spaced) is written back that way,
    // any other name is shown as sent.
    const labels = {
      mergetree: "MergeTree",
      replacingmergetree: "ReplacingMergeTree",
      summingmergetree: "SummingMergeTree",
      aggregatingmergetree: "AggregatingMergeTree",
      collapsingmergetree: "CollapsingMergeTree",
      versionedcollapsingmergetree: "VersionedCollapsingMergeTree",
      replicatedmergetree: "ReplicatedMergeTree",
      replicatedreplacingmergetree: "ReplicatedReplacingMergeTree",
      replicatedsummingmergetree: "ReplicatedSummingMergeTree",
      replicatedaggregatingmergetree: "ReplicatedAggregatingMergeTree",
      materializedview: "MaterializedView",
      view: "View",
      distributed: "Distributed",
      dictionary: "Dictionary",
      memory: "Memory",
      buffer: "Buffer",
      tinylog: "TinyLog",
      stripelog: "StripeLog",
      log: "Log",
    };
    return labels[compact] || value || "Table";
  }

  function canvasEllipsis(ctx, value, maxWidth) {
    return kit.ellipsis(ctx, value, maxWidth);
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
      return target ? `MOVE \u2192 ${kind}${target}` : "MOVE";
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

  function drawTtlSummary(ctx, item, node) {
    if (model.detailMode !== "physical" || node.layer !== "logical") return;
    const rules = ttlRules(node);
    const storageDisabled = node.storage_disabled === true;
    const hasPolicy = !!String(node.storage_policy || "");
    if (!storageDisabled && !rules.length) return;

    const dividerY = item.y + (hasPolicy && !storageDisabled ? 85 : 67);
    ctx.strokeStyle = graphColor("border");
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(item.x + 12, dividerY);
    ctx.lineTo(item.x + item.width - 12, dividerY);
    ctx.stroke();
    ctx.fillStyle = graphColor("muted");
    ctx.font = `12px ${FONT}`;
    if (storageDisabled) {
      ctx.fillText("No persistent storage", item.x + 12, item.y + 85);
      return;
    }
    const count = `${rules.length} lifecycle rule${rules.length === 1 ? "" : "s"}`;
    ctx.fillStyle = graphColor("accentText");
    ctx.fillText(canvasEllipsis(ctx, `TTL · ${ttlBaseSummary(node)} · ${count}`, item.width - 24), item.x + 12, item.y + (hasPolicy ? 103 : 85));
  }

  function diskCapacitySummary(disk) {
    if (disk?.disk_free_space == null || disk?.disk_total_space == null) return "";
    const free = Number(disk.disk_free_space);
    const total = Number(disk.disk_total_space);
    const used = Math.max(0, total - free);
    const pct = total > 0 ? `${format.percent(used / total)} used` : `capacity ${format.EMPTY}`;
    return `${pct} · ${format.bytes(free)} free`;
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
    ctx.globalAlpha = selected ? 1 : dimAlpha();
    roundedRectPath(ctx, item.x, item.y, item.width, item.height, 10);
    ctx.fillStyle = graphColor("nodeBg");
    ctx.fill();
    ctx.strokeStyle = isHover ? graphColor("halo") : graphColor("border");
    ctx.lineWidth = isHover ? 1.6 : 1.1;
    ctx.stroke();

    ctx.fillStyle = graphColor("muted");
    ctx.font = `11px ${FONT}`;
    ctx.fillText("Storage tier", item.x + 12, item.y + 17);
    if (Number(node.volume_priority || 0) > 0) {
      ctx.textAlign = "right";
      ctx.fillText(`priority ${node.volume_priority}`, item.x + item.width - 12, item.y + 17);
      ctx.textAlign = "left";
    }

    ctx.fillStyle = graphColor("text");
    ctx.font = `600 13px ${FONT}`;
    ctx.fillText(canvasEllipsis(ctx, `Volume · ${volumeName}`, item.width - 24), item.x + 12, item.y + 38);

    let y = item.y + 51;
    const diskRows = disks.length ? disks : [{ name: "No disk metadata" }];
    for (const disk of diskRows) {
      ctx.strokeStyle = graphColor("border");
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.moveTo(item.x + 12, y);
      ctx.lineTo(item.x + item.width - 12, y);
      ctx.stroke();

      const diskName = String(disk.disk_name || disk.name || "disk");
      ctx.fillStyle = graphColor("text");
      ctx.font = `600 12px ${FONT}`;
      ctx.fillText(canvasEllipsis(ctx, `Disk · ${diskName}`, item.width - 24), item.x + 12, y + 16);
      const capacity = diskCapacitySummary(disk);
      if (capacity) {
        ctx.fillStyle = graphColor("muted");
        ctx.font = `11px ${FONT}`;
        ctx.fillText(canvasEllipsis(ctx, capacity, item.width - 24), item.x + 12, y + 29);
      }
      y += 33;
    }

    if (visibleEvents.length) {
      ctx.strokeStyle = graphColor("border");
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(item.x + 12, y + 1);
      ctx.lineTo(item.x + item.width - 12, y + 1);
      ctx.stroke();

      ctx.fillStyle = graphColor("muted");
      ctx.font = `11px ${FONT}`;
      ctx.fillText(`TTL while in ${volumeName}`, item.x + 12, y + 18);
      y += 31;

      for (const event of visibleEvents) {
        ctx.fillStyle = graphColor("accentText");
        ctx.beginPath();
        ctx.arc(item.x + 15, y - 4, 2.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.font = `600 11px ${FONT}`;
        ctx.fillText(canvasEllipsis(ctx, ttlTimingSummary(event), item.width - 38), item.x + 23, y);
        ctx.fillStyle = graphColor("text");
        ctx.font = `11px ${FONT}`;
        const summary = event.unresolved_target ? `${ttlActionSummary(event)} · target unresolved` : ttlActionSummary(event);
        ctx.fillText(canvasEllipsis(ctx, summary, item.width - 38), item.x + 23, y + 14);
        y += 33;
      }
      if (events.length > visibleEvents.length) {
        ctx.fillStyle = graphColor("muted");
        ctx.font = `11px ${FONT}`;
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
    ctx.globalAlpha = selected ? 1 : dimAlpha();
    roundedRectPath(ctx, item.x, item.y, item.width, item.height, 9);
    ctx.fillStyle = graphColor("nodeBg");
    ctx.fill();
    ctx.strokeStyle = isHover ? graphColor("halo") : graphColor("border");
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.1;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = graphColor("muted");
    ctx.font = `11px ${FONT}`;
    ctx.fillText("TTL terminal", item.x + 12, item.y + 17);
    ctx.fillStyle = graphColor("text");
    ctx.font = `600 13px ${FONT}`;
    ctx.fillText("Expired", item.x + 12, item.y + 38);
    ctx.fillStyle = graphColor("muted");
    ctx.font = `11px ${FONT}`;
    ctx.fillText("data deleted", item.x + 12, item.y + 57);
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
        lines.push(target ? `MOVE \u2192 ${kind ? `${kind} ` : ""}${target}` : "MOVE");
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
    ctx.font = `600 11px ${FONT}`;
    const width = Math.min(224, Math.max(...lines.map((line) => ctx.measureText(line).width)) + 20);
    const lineHeight = 15;
    const height = lines.length * lineHeight + 8;
    const x = point.x - width / 2;
    const y = point.y - height / 2;
    // Lifecycle labels are semantic data, not decorative overlays. Keep them
    // fully opaque even when another node is focused so MOVE/DELETE rules stay
    // readable against the animated storage route.
    ctx.globalAlpha = 1;
    roundedRectPath(ctx, x, y, width, height, 6);
    // --tableBg is intentionally translucent in the general UI theme. TTL
    // labels sit on top of moving routes, so they must use the fully opaque
    // panel background or the arrow remains visible through the label.
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

  function nodeKindLabel(node) {
    if (node.kind === "refreshable_materialized_view" || node.layer !== "logical") return kindCode(node.kind);
    return node.engine ? humanEngine(node.engine) : kindCode(node.kind);
  }

  function nodeSizeLabel(node) {
    const memoryResident = node.kind === "buffer" || node.kind === "memory" || node.kind === "dictionary";
    const rawBytes = memoryResident ? node.resident_bytes : node.logical_bytes;
    const rows = node.rows == null
      ? (node.kind === "buffer" ? "\u2014 buffered rows" : "\u2014 rows")
      : `${format.count(node.rows)}${node.kind === "buffer" ? " buffered rows" : " rows"}`;
    const bytes = rawBytes == null ? format.EMPTY : `${format.bytes(rawBytes)}${memoryResident ? " RAM" : " logical"}`;
    return `${rows} · ${bytes}`;
  }

  // Level of detail (kit.isCompact): the cards turn compact once an ordinary
  // card is under 40 px on screen or its smallest text under 7.5 px; a
  // compact card is its title row only, in kit.compactBox().
  function compactCards(scale = model.scale) {
    return model.detailMode === "physical"
      ? kit.isCompact(PHYSICAL_HEIGHT, scale, STORAGE_FONT_MIN)
      : kit.isCompact(NODE_HEIGHT, scale, LINEAGE_FONT_MIN);
  }

  // The box a card is drawn in: its own, or its compact box. Storage tiers
  // and TTL terminals always draw in full.
  function drawnBox(item, compact) {
    const kind = item.node.kind;
    return compact && kind !== "storage_tier" && kind !== "ttl_expired" ? kit.compactBox(item, model.scale) : item;
  }

  // Card texts per payload node: formatting every card on every frame
  // dominated pan / zoom frames on large catalogs.
  const nodeTextCache = new WeakMap();
  function nodeTexts(node) {
    let texts = nodeTextCache.get(node);
    if (texts) return texts;
    const fmt = (value, suffix = "") => (value == null ? format.EMPTY : `${format.count(value)}${suffix}`);
    texts = {
      subtitle: `${node.database || ""} \u00b7 ${nodeKindLabel(node)}`,
      size: nodeSizeLabel(node),
      policy: node.storage_policy ? `Storage policy \u00b7 ${node.storage_policy}` : "",
      flush: node.kind === "buffer"
        ? `flush ${fmt(node.buffer_min_time, "s")}\u2013${fmt(node.buffer_max_time, "s")} \u00b7 ${fmt(node.buffer_min_rows)}\u2013${fmt(node.buffer_max_rows)} rows`
        : "",
    };
    nodeTextCache.set(node, texts);
    return texts;
  }

  function drawNode(ctx, item, focused, compact) {
    const node = item.node;
    if (node.kind === "storage_tier") return drawStorageTierNode(ctx, item, focused);
    if (node.kind === "ttl_expired") return drawTtlExpiredNode(ctx, item, focused);
    if (node.kind === "database_group") return drawGroupNode(ctx, item, compact);
    const selected = !focused || focused.has(node.id);
    const storageDisabled = model.detailMode === "physical" && node.layer === "logical" && node.storage_disabled === true;
    const isFocus = !storageDisabled && model.focusedId === node.id;
    const isHover = !storageDisabled && model.hoveredId === node.id;
    const inPanel = model.panel?.type === "node" && model.panel.id === node.id;
    const viewLike = node.kind === "view" || node.kind === "materialized_view" || node.kind === "refreshable_materialized_view";
    const radius = kit.CARD_RADIUS;
    const baseName = String(node.label || node.name || "");
    const titleColor = storageDisabled ? graphColor("muted") : graphColor("text");
    const card = {
      radius,
      alpha: selected ? 1 : dimAlpha(),
      // The focused card: a 2 px accent border, dashed like any View / MV outline.
      focused: isFocus,
      fill: storageDisabled ? graphColor("disabledBg") : graphColor("nodeBg"),
      border: isHover || inPanel ? graphColor("halo") : graphColor("border"),
      borderWidth: isHover || inPanel ? 1.8 : node.kind === "materialized_view" ? 1.8 : 1.2,
      dashed: viewLike || storageDisabled,
      rows: [],
    };
    if (compact) {
      const box = kit.compactBox(item, model.scale);
      if (box.titleSize) card.rows.push({ text: baseName, size: box.titleSize, weight: 600, color: titleColor, y: box.baseline, fit: "full" });
      card.statusY = box.height / 2;
      kit.drawCard(ctx, box, card);
      return;
    } else if (node.layer === "physical") {
      card.rows.push(
        { text: kindCode(node.kind), size: 11, weight: 400, color: graphColor("muted"), y: 17, fit: "full" },
        { text: baseName, size: 12, weight: 600, color: graphColor("text"), y: 34 },
      );
      if (node.kind === "disk") card.rows.push({ text: diskCapacitySummary(node), size: 11, y: 51 });
    } else {
      // Title = the object's own name; the database is the subtitle so a long
      // database prefix never truncates the part that tells objects apart.
      const health = String(node.health || "healthy");
      if (health !== "healthy") card.status = health === "error" || health === "critical" ? "error" : "warn";
      card.badge = String(node.topology_badge || "");
      const texts = nodeTexts(node);
      card.rows.push(
        { text: baseName, size: 14, weight: 600, color: titleColor, y: 22 },
        { text: texts.subtitle, y: 41 },
      );
      if (!viewLike) {
        card.rows.push({ text: texts.size, y: 60 });
        if (model.detailMode === "physical" && node.storage_policy) {
          card.rows.push({ text: texts.policy, y: 78 });
        } else if (node.kind === "buffer") {
          card.rows.push({ text: texts.flush, y: 78 });
        }
      }
    }
    kit.drawCard(ctx, item, card);
    if (!compact && node.layer === "logical" && model.detailMode === "physical") {
      ctx.save();
      ctx.globalAlpha = card.alpha;
      drawTtlSummary(ctx, item, node);
      ctx.restore();
    }
  }

  function groupStat(database) {
    return model.groupStats?.get(database) || null;
  }

  function drawGroupNode(ctx, card, compact) {
    const node = card.node;
    const box = compact ? kit.compactBox(card, model.scale) : null;
    const item = box || card;
    const isHover = model.hoveredId === node.id;
    const stat = groupStat(node.database) || { total: 0, connected: 0 };
    ctx.save();
    // Two offset sheets behind the card read as "a stack of objects".
    for (const offset of [8, 4]) {
      roundedRectPath(ctx, item.x + offset, item.y - offset, item.width, item.height, 10);
      ctx.fillStyle = graphColor("nodeBg");
      ctx.fill();
      ctx.strokeStyle = graphColor("border");
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    roundedRectPath(ctx, item.x, item.y, item.width, item.height, 10);
    ctx.fillStyle = graphColor("groupBg");
    ctx.fill();
    ctx.strokeStyle = isHover ? graphColor("halo") : graphColor("border");
    ctx.lineWidth = isHover ? 1.8 : 1.2;
    ctx.stroke();
    const pad = 12;
    if (box) {
      if (box.titleSize) {
        ctx.fillStyle = graphColor("text");
        ctx.font = `600 ${box.titleSize}px ${FONT}`;
        ctx.fillText(canvasEllipsis(ctx, node.database, item.width - pad * 2), item.x + pad, item.y + box.baseline);
      }
      ctx.restore();
      return;
    }
    ctx.fillStyle = graphColor("text");
    ctx.font = `600 14px ${FONT}`;
    ctx.fillText(canvasEllipsis(ctx, `\u25b8 ${node.database}`, item.width - pad * 2), item.x + pad, item.y + 24);
    ctx.fillStyle = graphColor("muted");
    ctx.font = `12px ${FONT}`;
    const objects = format.countLabel(stat.total, "object");
    const linked = stat.connected ? `${format.count(stat.connected)} with dependencies` : "no dependencies";
    ctx.fillText(canvasEllipsis(ctx, `${objects} · ${linked}`, item.width - pad * 2), item.x + pad, item.y + 44);
    ctx.fillStyle = graphColor("accentText");
    ctx.fillText("Click to expand", item.x + pad, item.y + 64);
    ctx.restore();
  }

  // Header strip of an expanded database band (click target to collapse).
  function databaseBandHeader(box) {
    const padX = 20;
    const header = 34;
    return { x: box.minX - padX, y: box.minY - header, width: box.maxX - box.minX + padX * 2, height: header };
  }

  function drawDatabaseGroups(ctx) {
    if (model.detailMode !== "logical") return;
    const groups = databaseBounds();
    if (groups.size <= 1 && !(model.groupStats && model.groupStats.size > 1)) return;
    ctx.save();
    for (const [database, box] of groups) {
      const padX = 20;
      const padBottom = 20;
      const header = 34;
      roundedRectPath(ctx, box.minX - padX, box.minY - header, box.maxX - box.minX + padX * 2, box.maxY - box.minY + header + padBottom, 12);
      ctx.fillStyle = graphColor("bandBg");
      ctx.globalAlpha = 0.36;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = graphColor("border");
      ctx.lineWidth = 0.9;
      ctx.stroke();
      const stat = groupStat(database);
      const collapsible = !!stat && !model.focusedId;
      const hover = collapsible && model.hoveredControl?.type === "band" && model.hoveredControl.database === database;
      ctx.fillStyle = hover ? graphColor("accentText") : graphColor("muted");
      ctx.font = `600 13px ${FONT}`;
      // DataHub-style "N of M": the band says when objects without
      // dependencies are filtered out of it.
      const count = stat && stat.shown !== stat.total
        ? `${format.count(stat.shown)} of ${format.count(stat.total)} objects`
        : `${format.count(stat ? stat.total : box.count)} objects`;
      ctx.fillText(`${collapsible ? "\u25be " : ""}${database} · ${count}`, box.minX, box.minY - 12);
    }
    ctx.restore();
  }

  function drawDatabaseLod(ctx) {
    const groups = databaseBounds({ includeGroupCards: true });
    ctx.save();
    for (const [database, box] of groups) {
      const pad = 24;
      roundedRectPath(ctx, box.minX - pad, box.minY - pad, box.maxX - box.minX + pad * 2, box.maxY - box.minY + pad * 2, 12);
      ctx.fillStyle = graphColor("groupBg");
      ctx.fill();
      ctx.strokeStyle = graphColor("border");
      ctx.lineWidth = 1.2;
      ctx.stroke();
      const scale = Math.max(0.01, Number(model.scale) || 1);
      ctx.fillStyle = graphColor("text");
      ctx.font = `600 ${Math.max(14, 13 / scale)}px ${FONT}`;
      ctx.fillText(database, box.minX, box.minY + Math.max(6, 13 / scale));
      ctx.fillStyle = graphColor("muted");
      ctx.font = `${Math.max(11, 11 / scale)}px ${FONT}`;
      ctx.fillText(`${box.count} objects`, box.minX, box.minY + Math.max(25, 30 / scale));
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // Edge labels, per-node expand controls and canvas hit testing.

  function edgeIsHighlighted(edge) {
    if (!edge) return false;
    if (model.hoveredEdgeId === edge.id) return true;
    if (model.panel?.type === "edge" && model.panel.id === edge.id) return true;
    const hover = model.hoveredId;
    return !!hover && (edge.from === hover || edge.to === hover);
  }

  const EDGE_KIND_LABELS = {
    materialized_view: ["MV", "Materialized View trigger"],
    materialized_view_output: ["MV output", "Materialized View output"],
    refreshable_mv: ["refresh", "Refreshable MV input"],
    refreshable_mv_output: ["refresh output", "Refreshable MV output"],
    view: ["view", "View dependency (query time)"],
    buffer: ["flush", "Buffer flush"],
    distributed_route: ["route", "Distributed route"],
    dictionary_source: ["dictionary", "Dictionary source"],
    dependency: ["dependency", "Dependency"],
  };

  function edgeShortLabel(edge) {
    if (edge.aggregated) return `×${edge.members.length}`;
    const base = (EDGE_KIND_LABELS[edge.kind] || [String(edge.kind || "").replaceAll("_", " ")])[0];
    if (edge.collapsed) return `${base} · via ${edge.collapsed_path?.length || 1}`;
    return base;
  }

  function edgeLongLabel(edge) {
    if (edge.aggregated) return `${edge.members.length} dependenc${edge.members.length === 1 ? "y" : "ies"} between databases`;
    return (EDGE_KIND_LABELS[edge.kind] || [null, String(edge.kind || "").replaceAll("_", " ")])[1];
  }

  // Every Lineage edge carries its label (kind, "x N" between databases). The
  // placement is computed once per routed layout, in a fixed priority order
  // (edges of the focused object, then data flow, then dependencies), at the
  // first anchor along the route that covers neither a card, a per-node
  // expand control nor another label (kit.placeLabels). Hover and selection
  // only restyle a label where it was placed: they never move it on top of
  // another one.
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
    // Labels outside the viewport are skipped (world-space culling).
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

  function nodeExpandControls(item) {
    const node = item.node;
    if (model.detailMode !== "logical" || !model.focusedId || node.layer !== "logical" || node.synthetic) return [];
    const controls = [];
    for (const direction of ["up", "down"]) {
      const hidden = Number(direction === "up" ? node.hidden_upstream : node.hidden_downstream) || 0;
      const key = `${direction}\u0000${node.id}`;
      const expanded = model.expansions.has(key);
      if (!hidden && !expanded) continue;
      controls.push({
        key, direction, hidden, expanded, node,
        label: expanded ? "\u2212" : `+${hidden}`,
        cx: direction === "up" ? item.x : item.x + item.width,
        cy: item.y + item.height - 18,
      });
    }
    return controls;
  }

  function drawNodeExpandControls(ctx, compact) {
    model.controlHits = [];
    if (compact || model.detailMode !== "logical" || !model.focusedId) return;
    ctx.save();
    ctx.font = `600 12px ${FONT}`;
    for (const item of model.layout.values()) {
      for (const control of nodeExpandControls(item)) {
        const width = Math.max(24, ctx.measureText(control.label).width + 14);
        const rect = { x: control.cx - width / 2, y: control.cy - 10, width, height: 20 };
        const hover = model.hoveredControl?.type === "expand" && model.hoveredControl.key === control.key;
        roundedRectPath(ctx, rect.x, rect.y, rect.width, rect.height, 10);
        ctx.fillStyle = hover ? graphColor("halo") : graphColor("nodeBg");
        ctx.fill();
        ctx.strokeStyle = graphColor("halo");
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.fillStyle = hover ? graphColor("labelBg") : graphColor("accentText");
        ctx.textAlign = "center";
        ctx.fillText(control.label, control.cx, control.cy + 4.5);
        ctx.textAlign = "left";
        model.controlHits.push({ ...control, ...rect });
      }
    }
    ctx.restore();
  }

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

  function toggleExpansion(key) {
    if (model.expansions.has(key)) model.expansions.delete(key);
    else model.expansions.add(key);
    if (model.active) refresh(false);
  }

  function setGroupExpanded(database, expanded) {
    const db = String(database || "");
    if (!db) return;
    const before = expanded ? null : captureViewportAnchor();
    if (expanded) model.expandedGroups.add(db);
    else model.expandedGroups.delete(db);
    model.groupsVersion += 1;
    computeLayout();
    if (expanded) {
      const band = databaseBounds().get(db);
      fitToScreen({ anchorBox: band ? databaseBandHeader(band) : null });
    } else {
      if (!restoreViewportAnchor(before)) fitToScreen();
      model.isFitted = false;
      syncFocusControls();
      scheduleDraw();
    }
    renderGraphChrome();
  }

  function setShowIsolated(value) {
    const next = !!value;
    if (model.showIsolated === next) return;
    model.showIsolated = next;
    model.groupsVersion += 1;
    computeLayout();
    fitToScreen();
    renderGraphChrome();
  }

  // ---------------------------------------------------------------------------
  // Graph chrome: "objects without dependencies" toggle and side panel (node
  // or edge). All of it lives inside #explorerGraphPane and is created once
  // by init().

  const chrome = {
    root: null, isolatedLabel: null, isolatedInput: null, panel: null, panelBody: null, panelShell: null,
  };


  function buildGraphChrome() {
    const pane = dom.explorerGraphPane;
    if (!pane || chrome.root) return;
    chrome.root = pane;
    const controls = $(".explorerGraphViewportControls", pane);

    const isolated = h("label", { class: "graphKitGroup explorerGraphIsolatedToggle" });
    chrome.isolatedInput = h("input");
    chrome.isolatedInput.type = "checkbox";
    chrome.isolatedInput.id = "explorerGraphShowIsolated";
    chrome.isolatedInput.addEventListener("change", () => setShowIsolated(chrome.isolatedInput.checked));
    isolated.append(chrome.isolatedInput, h("span", null, "Show objects without dependencies"));
    chrome.isolatedLabel = isolated;
    if (controls) controls.append(isolated);
    else pane.append(isolated);

    const panel = h("aside", { class: "graphKitPanel explorerGraphPanel" });
    panel.id = "explorerGraphPanel";
    panel.hidden = true;
    panel.setAttribute("aria-label", "Graph object details");
    chrome.panelBody = h("div", { class: "graphKitPanel__body" });
    panel.append(chrome.panelBody);
    chrome.panel = panel;
    pane.append(panel);
    // The floating detail panel shell (kit.panelShell): Escape through
    // ns.layers, the focus back to the canvas.
    chrome.panelShell = kit.panelShell(panel, { opener: () => dom.explorerGraphCanvas, onClose: () => { if (model.panel) closePanel(); } });
  }

  function renderGraphChrome() {
    updateStatus();
    if (!chrome.root) return;
    const lineage = model.detailMode === "logical";
    chrome.root.classList.toggle("graphKitPane--panel", !!model.panel && !chrome.panel.hidden);
    if (chrome.isolatedLabel) chrome.isolatedLabel.hidden = !lineage || !!model.focusedId;
    if (chrome.isolatedInput) chrome.isolatedInput.checked = model.showIsolated;
  }

  // Same path as a canvas click on a logical node: focus, tree/URL sync, the
  // side panel, and the camera recentred on the node in the area the panel
  // leaves free (above the bottom sheet on phones).
  function selectGraphNode(id) {
    const node = (model.graph?.nodes || []).find((candidate) => candidate.id === id && candidate.layer === "logical");
    if (!node) return;
    setFocus(node.id);
    if (model.openTable && node.database && node.name) model.openTable(node.database, node.name);
    openPanel({ type: "node", id: node.id });
    centerOnNode(node.id);
  }

  function openPanel(target) {
    model.panel = target;
    model.panelSerial += 1;
    renderPanel();
    scheduleDraw();
  }

  function closePanel() {
    if (!model.panel) return;
    model.panel = null;
    model.panelSerial += 1;
    renderPanel();
    scheduleDraw();
  }

  function panelSection(title) {
    const section = h("section", { class: "graphKitPanel__section" });
    if (title) section.append(h("h3", { class: "graphKitPanel__sectionTitle" }, title));
    return section;
  }

  function panelFacts(pairs) {
    const list = h("dl", { class: "graphKitPanel__facts" });
    for (const [label, value] of pairs) {
      if (value == null || value === "") continue;
      list.append(h("dt", null, label), h("dd", null, value));
    }
    return list;
  }

  function objectButton(id, fallback) {
    const node = (model.graph?.nodes || []).find((candidate) => candidate.id === id);
    const label = node ? `${node.database}.${node.name}` : (parseLogicalTableId(id) ? `${parseLogicalTableId(id).database}.${parseLogicalTableId(id).table}` : fallback || id);
    const button = h("button", { class: "graphKitPanel__link" }, label);
    button.type = "button";
    button.title = label;
    button.addEventListener("click", () => selectGraphNode(id));
    return button;
  }

  // The shared read-only SQL block (ui.sqlBlock): copy, the first 16 lines
  // and "Show all".
  function sqlBlock(sql, truncated) {
    const wrap = h("div", { class: "explorerGraphPanel__sqlWrap" });
    wrap.append(ns.ui.sqlBlock({ sql, copy: true, maxLines: 16, wrap: true, label: "SELECT", className: "explorerGraphPanel__sql" }));
    if (truncated) wrap.append(h("p", { class: "graphKitPanel__note" }, "Truncated at 32 KB: the full text is in the object's DDL."));
    return wrap;
  }

  async function loadDefinition(node) {
    const hostId = String(state.selectedHostId || "");
    const key = `${hostId}\u0000${node.id}`;
    if (!model.definitionCache.has(key)) {
      model.definitionCache.set(key, api.getExplorerGraphDefinition(hostId, node.database, node.name).catch((error) => {
        model.definitionCache.delete(key);
        throw error;
      }));
    }
    return model.definitionCache.get(key);
  }

  async function loadColumns(node) {
    const hostId = String(state.selectedHostId || "");
    const key = `${hostId}\u0000${node.id}`;
    if (!model.columnsCache.has(key)) {
      model.columnsCache.set(key, api.getExplorerTable(hostId, node.database, node.name).then((detail) => (
        Array.isArray(detail?.columns) ? detail.columns : []
      )).catch((error) => {
        model.columnsCache.delete(key);
        throw error;
      }));
    }
    return model.columnsCache.get(key);
  }

  // Fills `container` with what the object definition says about it; used by
  // node panels and by edge panels for the object that defines the edge.
  function renderDefinitionInto(container, node, { compact = false } = {}) {
    const serial = model.panelSerial;
    const status = h("p", { class: "graphKitPanel__note" }, "Loading definition\u2026");
    container.append(status);
    loadDefinition(node).then((definition) => {
      if (serial !== model.panelSerial) return;
      status.remove();
      const facts = [];
      const target = definition.target ? `${definition.target.database}.${definition.target.table}` : null;
      if (node.kind === "materialized_view" || node.kind === "refreshable_materialized_view") {
        facts.push(["Writes to", target || (definition.target_visible ? null : "implicit inner table or not visible")]);
      } else if (node.kind === "buffer") {
        facts.push(["Flushes to", target || "not visible"]);
        facts.push(["Flush after", `${format.count(node.buffer_min_time)}\u2013${format.count(node.buffer_max_time)} s`]);
        facts.push(["Flush rows", `${format.count(node.buffer_min_rows)}\u2013${format.count(node.buffer_max_rows)}`]);
        facts.push(["Flush bytes", `${format.bytes(node.buffer_min_bytes)}\u2013${format.bytes(node.buffer_max_bytes)}`]);
        facts.push(["Layers", format.count(node.buffer_layers)]);
      } else if (node.kind === "dictionary" && definition.dictionary) {
        facts.push(["Source", [definition.dictionary.source_kind, target].filter(Boolean).join(" · ") || format.EMPTY]);
        facts.push(["Layout", definition.dictionary.layout || format.EMPTY]);
        facts.push(["Lifetime", definition.dictionary.lifetime || format.EMPTY]);
      } else if (node.kind === "distributed" && definition.distributed) {
        const d = definition.distributed;
        facts.push(["Cluster", d.cluster || format.EMPTY]);
        facts.push(["Local table", target || "not visible"]);
        facts.push(["Sharding key", d.sharding_key || "none (single shard writes)"]);
        if (d.shards) facts.push(["Topology", `${format.count(d.shards)} shard${d.shards === 1 ? "" : "s"} × ${format.count(d.replicas_per_shard)} replica${d.replicas_per_shard === 1 ? "" : "s"}`]);
      }
      if (facts.length) container.append(panelFacts(facts));
      if (definition.select_sql) {
        if (!compact) container.append(h("h4", { class: "graphKitPanel__subTitle" }, "SELECT"));
        container.append(sqlBlock(definition.select_sql, definition.select_sql_truncated));
      }
      if (!facts.length && !definition.select_sql) container.append(h("p", { class: "graphKitPanel__note" }, "No definition beyond the table structure."));
    }).catch((error) => {
      if (serial !== model.panelSerial) return;
      status.textContent = ns.util.errorText(error);
    });
  }

  function renderColumnsInto(container, node) {
    const serial = model.panelSerial;
    const status = h("p", { class: "graphKitPanel__note" }, "Loading columns\u2026");
    container.append(status);
    loadColumns(node).then((columns) => {
      if (serial !== model.panelSerial) return;
      status.remove();
      if (!columns.length) { container.append(h("p", { class: "graphKitPanel__note" }, "No columns.")); return; }
      // The shared key / value list (ui.kvList): name, type (mono), copy.
      const limit = 40;
      container.append(ns.ui.kvList(columns.slice(0, limit).map((column) => ({
        key: column.name, value: column.type, json: false, text: true, mono: true, actions: ["copy"],
      })), { className: "explorerGraphPanel__columns", label: "Columns" }));
      if (columns.length > limit) container.append(h("p", { class: "graphKitPanel__note" }, `${format.count(columns.length - limit)} more columns in the table card.`));
    }).catch((error) => {
      if (serial !== model.panelSerial) return;
      status.textContent = ns.util.errorText(error);
    });
  }

  function neighborIds(id, direction) {
    const edges = visibleEdges().filter((edge) => !edge.aggregated);
    return [...new Set(edges.filter((edge) => (direction === "up" ? edge.to === id : edge.from === id))
      .map((edge) => (direction === "up" ? edge.from : edge.to)))];
  }

  function renderNodePanel(body, node) {
    body.append(kit.panelHeader({ eyebrow: nodeKindLabel(node), title: node.name, subtitle: node.database, onClose: closePanel }));

    const actions = h("div", { class: "graphKitPanel__actions" });
    const open = h("button", { class: "button button--small explorerGraphPanel__openCard" }, "Open card");
    open.type = "button";
    open.id = "explorerGraphPanelOpenCard";
    open.addEventListener("click", () => {
      if (typeof model.openCard === "function") model.openCard(node.database, node.name);
    });
    actions.append(open);
    body.append(actions);

    const summary = panelSection("Summary");
    const viewLike = ["view", "materialized_view", "refreshable_materialized_view"].includes(node.kind);
    summary.append(panelFacts([
      ["Engine", humanEngine(node.engine)],
      ["Rows", viewLike ? null : format.count(node.rows)],
      ["Size", viewLike ? null : (node.kind === "buffer" || node.kind === "memory" || node.kind === "dictionary"
        ? `${format.bytes(node.resident_bytes)} RAM` : format.bytes(node.logical_bytes))],
      ["Parts", viewLike || !node.active_parts ? null : format.count(node.active_parts)],
      ["Replication", node.topology_badge || null],
      ["Health", node.health && node.health !== "healthy" ? node.health : null],
      ["TTL", ttlRules(node).length ? `${ttlRules(node).length} rule${ttlRules(node).length === 1 ? "" : "s"} · ${ttlBaseSummary(node)}` : null],
    ]));
    body.append(summary);

    const lineage = panelSection("Lineage");
    for (const [label, direction] of [["Reads from", "up"], ["Used by", "down"]]) {
      const ids = neighborIds(node.id, direction);
      const hidden = Number(direction === "up" ? node.hidden_upstream : node.hidden_downstream) || 0;
      const row = h("div", { class: "explorerGraphPanel__lineageRow" });
      row.append(h("span", { class: "explorerGraphPanel__lineageLabel" }, label));
      const values = h("div", { class: "explorerGraphPanel__lineageValues" });
      for (const id of ids.slice(0, 12)) values.append(objectButton(id));
      if (ids.length > 12) values.append(h("span", { class: "graphKitPanel__note" }, `+${ids.length - 12} more`));
      if (!ids.length && !hidden) values.append(h("span", { class: "graphKitPanel__note" }, format.EMPTY));
      if (hidden) {
        const more = h("button", { class: "graphKitPanel__link explorerGraphPanel__expand" }, `Show ${format.count(hidden)} more`);
        more.type = "button";
        more.addEventListener("click", () => toggleExpansion(`${direction}\u0000${node.id}`));
        values.append(more);
      }
      row.append(values);
      lineage.append(row);
    }
    body.append(lineage);

    if (["view", "materialized_view", "refreshable_materialized_view", "dictionary", "distributed", "buffer"].includes(node.kind)) {
      const definition = panelSection("Definition");
      renderDefinitionInto(definition, node);
      body.append(definition);
    }
    const columns = panelSection("Columns");
    renderColumnsInto(columns, node);
    body.append(columns);
  }

  // The object whose definition explains an edge: the MV for MV trigger and
  // output edges, the View it feeds, the Buffer / Distributed table that
  // forwards, the dictionary that loads.
  function edgeDefiningObjectIds(edge) {
    if (edge.collapsed) return (edge.collapsed_path || []).slice();
    if (["materialized_view", "refreshable_mv", "view", "dictionary_source"].includes(edge.kind)) return [edge.to];
    if (["materialized_view_output", "refreshable_mv_output", "buffer", "distributed_route"].includes(edge.kind)) return [edge.from];
    return [];
  }

  function renderEdgePanel(body, edge) {
    body.append(kit.panelHeader({ eyebrow: "Dependency", title: edgeLongLabel(edge), onClose: closePanel }));

    const route = panelSection(null);
    const fromTo = h("div", { class: "explorerGraphPanel__route" });
    const groupLabel = (id) => {
      const node = visibleNodes().find((candidate) => candidate.id === id);
      return node?.kind === "database_group" ? h("span", { class: "explorerGraphPanel__routeGroup" }, `${node.database} (database)`) : objectButton(id);
    };
    fromTo.append(groupLabel(edge.from), h("span", { class: "graphKitPanel__arrow" }, "\u2192"), groupLabel(edge.to));
    route.append(fromTo);
    if (edge.collapsed) route.append(h("p", { class: "graphKitPanel__note" }, `Through ${edge.collapsed_path.length} hidden object${edge.collapsed_path.length === 1 ? "" : "s"} (non-storing objects are hidden).`));
    body.append(route);

    if (edge.aggregated) {
      const members = panelSection("Dependencies");
      const list = h("ul", { class: "explorerGraphPanel__members" });
      for (const member of edge.members.slice(0, 40)) {
        const item = h("li");
        item.append(objectButton(member.from), h("span", { class: "graphKitPanel__arrow" }, "\u2192"), objectButton(member.to),
          h("span", { class: "explorerGraphPanel__memberKind" }, edgeShortLabel(member)));
        list.append(item);
      }
      members.append(list);
      body.append(members);
      return;
    }

    const nodesById = new Map((model.graph?.nodes || []).map((node) => [node.id, node]));
    for (const id of edgeDefiningObjectIds(edge)) {
      const node = nodesById.get(id);
      if (!node) continue;
      const section = panelSection(`${nodeKindLabel(node)} · ${node.name}`);
      renderDefinitionInto(section, node, { compact: false });
      body.append(section);
    }
    if (edge.kind === "view" && !edge.collapsed) {
      body.append(h("p", { class: "graphKitPanel__note graphKitPanel__note--block" }, "A View is evaluated at query time: no data is copied along this edge."));
    }
  }

  function renderPanel({ keepScroll = false } = {}) {
    const panel = chrome.panel;
    const body = chrome.panelBody;
    if (!panel || !body) return;
    const scrollTop = keepScroll ? body.scrollTop : 0;
    body.replaceChildren();
    let rendered = false;
    if (model.panel?.type === "node") {
      const node = (model.graph?.nodes || []).find((candidate) => candidate.id === model.panel.id && candidate.layer === "logical");
      if (node) { renderNodePanel(body, node); rendered = true; }
    } else if (model.panel?.type === "edge") {
      const edge = visibleEdges().find((candidate) => candidate.id === model.panel.id);
      if (edge) { renderEdgePanel(body, edge); rendered = true; }
    }
    if (rendered) chrome.panelShell.show(body);
    else {
      model.panel = null;
      chrome.panelShell.hide();
    }
    chrome.root?.classList.toggle("graphKitPane--panel", rendered);
    panel.dataset.panelType = rendered ? model.panel.type : "";
    if (keepScroll) body.scrollTop = scrollTop;
  }

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

  function scheduleDraw() {
    model.view?.scheduleDraw();
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

  // Hover outlines the card (or edge / control) under the pointer and
  // highlights the edges of a hovered card; it never dims or moves anything.
  function hoverTarget(target) {
    model.hoveredId = target?.type === "node" && !target.disabled ? target.node.id : null;
    model.hoveredEdgeId = target?.type === "edge" ? target.edge.id : null;
    model.hoveredControl = target && (target.type === "expand" || target.type === "band")
      ? { type: target.type, key: target.expandKey, database: target.database } : null;
  }

  // A click selects: a card recentres on itself, takes the focus (tree and
  // URL follow) and opens the side panel; an edge opens its definition; the
  // background closes the panel.
  function clickTarget(target) {
    if (target?.type === "expand") { toggleExpansion(target.expandKey); return; }
    if (target?.type === "band") { setGroupExpanded(target.database, false); return; }
    if (target?.type === "node") {
      const node = target.node;
      if (node.kind === "database_group") { setGroupExpanded(node.database, true); return; }
      if (target.disabled) return;
      if (node.layer === "logical") { selectGraphNode(node.id); return; }
      setFocus(node.id);
      centerOnNode(node.id);
      return;
    }
    if (target?.type === "edge" && model.detailMode === "logical") { model.view?.unfollow(); openPanel({ type: "edge", id: target.edge.id }); return; }
    closePanel();
  }

  // Centred in the visible canvas once the side panel has settled (its
  // content arrives after it opens), and again when it closes (kit
  // follow()).
  function centerOnNode(id) {
    if (!model.layout.get(id) || !model.view) return;
    model.view.follow(id);
  }

  function describeNode(id) {
    const node = model.layout.get(id)?.node;
    if (!node) return "";
    if (node.kind === "database_group") return `${node.database}, collapsed database. Enter expands it.`;
    return `${node.name || node.label || node.id}, ${nodeKindLabel(node)}${node.database ? ` in ${node.database}` : ""}. Enter selects it.`;
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
      const scopeMatches = model.graph?.scope_focus_id === model.focusedId
        && Number(model.graph?.scope_depth) === model.focusDepth;
      const canGrow = scopeMatches && model.focusDepth < 8 && model.graph?.scope_has_more === true;
      dom.explorerGraphExpandButton.hidden = model.detailMode !== "logical";
      dom.explorerGraphExpandButton.disabled = !model.focusedId || model.detailMode !== "logical" || !canGrow;
    }
    // Storage needs an object that stores data (a view has no storage).
    const storageAllowed = !model.focusedId || canUseStorageForId(model.focusedId);
    if (dom.explorerGraphPhysicalButton) {
      dom.explorerGraphPhysicalButton.disabled = !storageAllowed;
      dom.explorerGraphPhysicalButton.title = storageAllowed ? "Tiers: where the objects keep their data (storage policies, volumes, disks)" : "Tiers: the selected object keeps no data of its own";
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
    const itemById = new Map((model.graph.nodes || []).map((node) => [node.id, node]));
    const initial = itemById.get(id) || null;
    if (!initial) return null;
    if (initial.layer === "logical") return initial.id;
    // Clicking a physical child should not jump away from an already selected
    // logical table, especially for a shared disk with multiple parents.
    if (model.focusedId && itemById.get(model.focusedId)?.layer === "logical") return model.focusedId;

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
        const parent = itemById.get(parentId);
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
    // Per-node expansions belong to the neighbourhood they were made in.
    if (changed) model.expansions.clear();
    syncFocusControls();
    if (changed) renderGraphChrome();
    if (changed) model.onStateChange?.();
    if (!model.graph) { scheduleDraw(); return; }

    if (center) {
      computeLayout();
      fitToScreen();
      if (changed && model.active) refresh(false, { reflow: true });
      return;
    }

    // A focus change is not a camera operation. Preserve the canvas transform
    // byte-for-byte and freeze every node that survives the neighbourhood
    // change. The layout engine may only position newly introduced nodes.
    computeLayout({ preserveExisting: true });
    model.isFitted = false;
    syncFocusControls();
    scheduleDraw();
    if (changed && model.active) refresh(false);
  }

  function focusTable(database, table, { ensureVisible = false } = {}) {
    const db = String(database || "");
    const id = `table:${db}.${String(table || "")}`;
    // A table focus is a cross-database neighbourhood scope, not a database
    // filter. Clearing the database scope is what lets upstream/downstream
    // objects in other databases remain visible while keeping the payload local.
    model.database = "";
    model.pendingFocusId = id;
    model.pendingEnsureVisible = !!ensureVisible;
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
      if (model.active) refresh(false, { reflow: !!ensureVisible });
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
    if (model.active) refresh(false);
    model.onStateChange?.();
  }

  function expandNeighborhood() {
    if (!model.focusedId || model.focusDepth >= 8 || model.graph?.scope_has_more !== true) { syncFocusControls(); return; }
    model.focusDepth = Math.min(8, model.focusDepth + 1);
    // The next ring is intentionally not prefetched. Keep the current camera and
    // request the newly visible depth only when the user asks for it.
    if (model.active) refresh(false);
    else recomputePreservingFocus();
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
    // Search every shown object, including those inside collapsed databases.
    const candidates = model.detailMode === "logical" ? logicalProjection().nodes : visibleNodes();
    const match = candidates.find((node) => node.layer === "logical" && !node.synthetic && `${node.database}.${node.name} ${node.engine || ""}`.toLowerCase().includes(query));
    if (match) setFocus(match.id, true);
  }

  function updateStatus() {
    if (!dom.explorerGraphStatus) return;
    if (model.loading) {
      dom.explorerGraphStatus.textContent = "Loading graph\u2026";
      return;
    }
    if (model.routeJob) {
      dom.explorerGraphStatus.textContent = "Routing edges\u2026";
      return;
    }
    if (model.lastError && !model.graph) {
      dom.explorerGraphStatus.textContent = model.lastError;
      return;
    }
    const visible = visibleNodes();
    const nodes = visible.filter((node) => !node.synthetic).length;
    const groups = visible.length - nodes;
    const edges = visibleEdges().length;
    const focusedScope = currentFocusScope();
    const scope = focusedScope ? `${focusedScope.database}.${focusedScope.table}` : (model.database || "all databases");
    const focus = model.focusedId && model.detailMode === "logical"
      ? `, neighborhood depth ${model.focusDepth}${model.expansions.size ? ` + ${model.expansions.size} expanded` : ""}` : "";
    // Two separators at most: the counts, the scope, what is hidden.
    const counts = [];
    if (groups) counts.push(`${groups} collapsed database${groups === 1 ? "" : "s"}`);
    if (nodes || !groups) counts.push(`${nodes} nodes`);
    counts.push(`${edges} edges`);
    const parts = [counts.join(", "), `${scope}${focus}`];
    if (model.groupStats && !model.showIsolated && model.detailMode === "logical" && !model.focusedId) {
      let isolated = 0;
      for (const stat of model.groupStats.values()) isolated += stat.total - stat.connected;
      if (isolated) parts.push(`${isolated} without dependencies hidden`);
    }
    dom.explorerGraphStatus.textContent = parts.join(" · ");
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
    const requestOptions = graphRequestOptions(force);
    const requestKey = graphRequestKey(requestOptions);
    const hadLayout = model.layout.size > 0;
    model.loading = true;
    updateStatus();
    scheduleDraw();
    try {
      const payload = await api.getExplorerGraph(hostId, requestOptions);
      const stale = !model.active
        || serial !== model.refreshSerial
        || String(state.selectedHostId || "") !== hostId
        || graphRequestKey(graphRequestOptions(false)) !== requestKey;
      if (stale) {
        // The scope changed while this request was in flight (for example the
        // route's table was resolved after an unscoped request started).
        // Fetch the current scope instead of dropping both answers.
        if (model.active && String(state.selectedHostId || "") === hostId) model.refreshQueued = true;
        return;
      }

      model.graph = payload;
      model.lastError = "";
      model.graphRequestKey = requestKey;
      let ensurePendingFocus = false;
      if (model.pendingFocusId && (payload.nodes || []).some((node) => node.id === model.pendingFocusId)) {
        if (model.detailMode === "physical" && !canUseStorageForId(model.pendingFocusId)) {
          model.detailMode = "logical";
          ns.segmented?.set(dom.explorerGraphTypeSelect, "logical");
          model.onStateChange?.();
        }
        model.focusedId = model.pendingFocusId;
        model.pendingFocusId = null;
        ensurePendingFocus = model.pendingEnsureVisible;
        model.pendingEnsureVisible = false;
      } else if (model.pendingFocusId && !force) {
        // Scoped payloads intentionally omit unrelated tables. If the requested
        // table is still absent from a payload scoped directly to it, retry once
        // with cache invalidation to cover a just-created object.
        model.refreshQueued = true;
        model.refreshQueuedForce = true;
        model.refreshQueuedReflow = model.refreshQueuedReflow || reflow || model.pendingEnsureVisible;
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
    } catch (e) {
      // A stale transport error belongs to the old scope and must not erase a
      // newer graph selection that is waiting in the queue.
      const stale = serial !== model.refreshSerial
        || String(state.selectedHostId || "") !== hostId
        || graphRequestKey(graphRequestOptions(false)) !== requestKey;
      if (!stale) {
        model.graph = null;
        model.lastError = ns.util.errorText(e);
        model.layout.clear();
        if (dom.explorerGraphStatus) dom.explorerGraphStatus.textContent = ns.util.errorText(e);
        scheduleDraw();
      }
    } finally {
      model.loading = false;
      updateStatus();
      renderGraphChrome();
      if (model.panel) renderPanel({ keepScroll: true });
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
    ns.segmented?.set(dom.explorerGraphTypeSelect, next);
    // TTL lifecycle only exists in the Storage projection. Keep the legend
    // contextual so Lineage does not advertise an edge type it never renders.
    const ttlLegend = byId("explorerGraphLegendTtl");
    if (ttlLegend) ttlLegend.hidden = next !== "physical";
    if (!changed) return;
    if (model.panel?.type === "edge") closePanel();
    renderGraphChrome();
    syncFocusControls();
    // The backend now serves only the active layer. Switching Lineage/Storage
    // therefore changes the transport scope and must fetch that projection
    // instead of expecting the hidden layer to already be in browser memory.
    if (model.active) refresh(false, { reflow: true });
    else if (model.focusedId) recomputePreservingFocus();
    else { computeLayout(); fitToScreen(); }
    if (notify) model.onStateChange?.();
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

  function zoomBy(factor) {
    model.view?.zoomBy(factor);
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
      // A focused View/MV/Buffer is itself part of the non-storing projection,
      // so the option must remain enabled until focus moves to a storing node.
      includeNonStoring: !!node && isNonStoringNode(node),
    };
  }

  function setVisibilityOptions(options = {}) {
    const previousIncludeSystem = model.includeSystem;
    const previousIncludeNonStoring = model.includeNonStoring;
    const required = visibilityRequirements();
    const nextIncludeSystem = required.includeSystem || options.includeSystem === true;
    const nextIncludeNonStoring = required.includeNonStoring || options.includeNonStoring !== false;
    const systemScopeChanged = previousIncludeSystem !== nextIncludeSystem;
    const projectionChanged = previousIncludeNonStoring !== nextIncludeNonStoring || systemScopeChanged;
    const anchor = projectionChanged ? captureViewportAnchor({ includeSystem: nextIncludeSystem, includeNonStoring: nextIncludeNonStoring }) : null;
    model.includeSystem = nextIncludeSystem;
    model.includeNonStoring = nextIncludeNonStoring;
    if (model.focusedId) {
      const node = (model.graph?.nodes || []).find((candidate) => candidate.id === model.focusedId);
      if (node && !logicalNodeAllowed(node)) model.focusedId = null;
    }
    if ((systemScopeChanged || projectionChanged) && model.active) {
      // Both system visibility and non-storing visibility change the server-side
      // scoped neighborhood. In particular, hidden View/MV/Buffer nodes have
      // zero semantic depth cost and therefore require a fresh scope.
      refresh(false, { reflow: true });
    } else if (projectionChanged) recomputePreservingFocusAnchorOnly(anchor);
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
    model.view?.cancel();
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
    model.layout.clear();
    model.focusedId = null;
    model.pendingEnsureVisible = false;
    model.expansions.clear();
    model.expandedGroups.clear();
    model.groupsVersion += 1;
    model.definitionCache.clear();
    model.columnsCache.clear();
    closePanel();
    if (model.active) refresh(false);
  }

  function init(options = {}) {
    model.openTable = typeof options.openTable === "function" ? options.openTable : null;
    model.openCard = typeof options.openCard === "function" ? options.openCard : null;
    model.onStateChange = typeof options.onStateChange === "function" ? options.onStateChange : null;
    const canvas = dom.explorerGraphCanvas;
    if (!canvas) return;
    buildGraphChrome();

    model.view = kit.mount({
      canvas,
      view: model,
      active: () => model.active,
      draw,
      bounds: () => (model.layout.size ? model.worldBounds : null),
      minScale: minimumZoomScale,
      fit: () => fitToScreen(),
      hit: hitTarget,
      onHover: hoverTarget,
      onClick: clickTarget,
      nodes: () => [...model.layout.values()].filter((item) => nodeIsClickable(item.node))
        .map((item) => ({ id: item.node.id, x: item.x, y: item.y, width: item.width, height: item.height })),
      selectedId: () => (model.panel?.type === "node" ? model.panel.id : model.focusedId),
      target: nodeTarget,
      describe: describeNode,
      onActivate: (id) => clickTarget(nodeTarget(id)),
      onEscape: () => {
        if (!model.panel) return false;
        closePanel();
        return true;
      },
      onViewChange: (kind) => {
        model.isFitted = kind === "zoom" ? Math.abs(model.scale - model.fitScale) < 1e-9 : false;
        syncFocusControls();
      },
      panel: () => chrome.panel,
      toolbar: { zoomIn: dom.explorerGraphZoomInButton, zoomOut: dom.explorerGraphZoomOutButton, fit: dom.explorerGraphFitButton },
    });
    // Lineage | Tiers: the shared segmented control (app_ui_segmented.js).
    ns.segmented?.bind(dom.explorerGraphTypeSelect, { onChange: (mode) => { setDetailMode(mode); return false; } });
    dom.explorerGraphContractButton?.addEventListener("click", contractNeighborhood);
    dom.explorerGraphExpandButton?.addEventListener("click", expandNeighborhood);
    dom.explorerGraphRefreshButton?.addEventListener("click", () => refresh(true, { reflow: true }));
    setDetailMode(model.detailMode);
    renderGraphChrome();
  }

  // Read-only geometry of the last drawn frame in client (CSS pixel)
  // coordinates: lets browser tests click real nodes, edge labels and
  // expand controls on the canvas instead of guessing pixels.
  function inspect() {
    const rect = dom.explorerGraphCanvas?.getBoundingClientRect();
    const toClient = (box) => {
      const a = worldToScreen(box.x, box.y);
      return { x: (rect?.left || 0) + a.x, y: (rect?.top || 0) + a.y, width: box.width * model.scale, height: box.height * model.scale };
    };
    const labelCache = model.edgeLabelCache;
    const compact = compactCards();
    return {
      kit: true,
      compact,
      scale: model.scale,
      offsetX: model.offsetX,
      offsetY: model.offsetY,
      fitScale: model.fitScale,
      overviewScale: overviewScale(),
      readableScale: readableScale(),
      fitFloor: kit.FIT_FLOOR,
      gridSpacing: kit.GRID_SPACING,
      focusedId: model.focusedId,
      hoveredId: model.hoveredId,
      hoveredEdgeId: model.hoveredEdgeId,
      keyboardId: model.view?.keyboardId() || null,
      animating: !!model.view?.animating(),
      minimapVisible: !!dom.explorerGraphMinimap && !dom.explorerGraphMinimap.hidden,
      edgeLabelsPlaced: labelCache ? labelCache.placed.size : 0,
      edgeLabelsDropped: labelCache ? labelCache.dropped.slice() : [],
      panel: model.panel ? { ...model.panel } : null,
      expansions: [...model.expansions],
      showIsolated: model.showIsolated,
      nodes: [...model.layout.values()].map((item) => ({
        id: item.node.id, kind: item.node.kind, database: item.node.database, name: item.node.name,
        hiddenUpstream: Number(item.node.hidden_upstream) || 0, hiddenDownstream: Number(item.node.hidden_downstream) || 0,
        // The box drawn on screen (a compact card's is its title row).
        ...toClient(drawnBox(item, compact)),
      })),
      edges: visibleEdges().map((edge) => ({
        id: edge.id, kind: edge.kind, from: edge.from, to: edge.to, aggregated: !!edge.aggregated, collapsed: !!edge.collapsed,
        points: (model.edgeGeometry?.get(edge.id) || []).map((point) => toClient({ x: point.x, y: point.y, width: 0, height: 0 })),
      })),
      edgeLabels: (model.edgeLabelHits || []).map((hit) => ({ id: hit.edge.id, kind: hit.edge.kind, from: hit.edge.from, to: hit.edge.to, text: edgeShortLabel(hit.edge), ...toClient(hit) })),
      controls: (model.controlHits || []).map((hit) => ({ key: hit.key, direction: hit.direction, nodeId: hit.node.id, label: hit.label, ...toClient(hit) })),
    };
  }

  ns.explorerGraph = {
    inspect,
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
