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
    animationFrame: 0,
    lastPointerX: 0,
    lastPointerY: 0,
    flowMarkerState: new Map(),
    storageProjectionCache: null,
    logicalProjectionCache: null,
    visibleSetCache: null,
    lineageRouteCache: null,
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
    // "canvas" | "list"; null until the user picks one (mobile defaults to list).
    viewMode: null,
  };

  const NODE_HEIGHT = 80;
  const NODE_WIDTH = 264;
  const PHYSICAL_WIDTH = 180;
  const PHYSICAL_HEIGHT = 60;
  const X_GAP = 92;
  const Y_GAP = 34;
  // Smallest canvas font is 12px in Lineage and 11px in Storage: Fit never
  // zooms below the scale that keeps it at 11px on screen. Further zoom-out
  // stays possible and switches to the compact level of detail.
  const LINEAGE_FONT_MIN = 12;
  const STORAGE_FONT_MIN = 11;
  const READABLE_TEXT_PX = 11;
  const FONT = "Arial, Helvetica, sans-serif";
  const MOBILE_QUERY = "(max-width: 720px)";

  function readableScale() {
    return READABLE_TEXT_PX / (model.detailMode === "physical" ? STORAGE_FONT_MIN : LINEAGE_FONT_MIN);
  }

  function mobileLayout() {
    return !!window.matchMedia?.(MOBILE_QUERY)?.matches;
  }

  // Canvas colours are resolved from CSS variables. getComputedStyle() on the
  // root element per edge/node made every frame pay hundreds of style lookups,
  // so resolved values are cached until the theme can have changed: any root
  // attribute change (data-theme, class) or an OS colour-scheme switch.
  const themeCache = { colors: new Map(), light: null };
  function invalidateThemeCache() {
    themeCache.colors.clear();
    themeCache.light = null;
  }
  const colorSchemeQuery = window.matchMedia?.("(prefers-color-scheme: light)") || null;
  colorSchemeQuery?.addEventListener?.("change", invalidateThemeCache);
  if (typeof MutationObserver === "function" && document.documentElement) {
    new MutationObserver(invalidateThemeCache).observe(document.documentElement, { attributes: true });
  }

  function css(name, fallback) {
    let value = themeCache.colors.get(name);
    if (value === undefined) {
      value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      themeCache.colors.set(name, value);
    }
    return value || fallback;
  }

  function lightThemeActive() {
    if (themeCache.light !== null) return themeCache.light;
    const explicit = String(document.documentElement.dataset.theme || "");
    let light;
    if (explicit === "light") light = true;
    else if (explicit === "dark") light = false;
    else light = !!colorSchemeQuery?.matches;
    themeCache.light = light;
    return light;
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
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const outgoing = new Map();
    for (const edge of edges) {
      if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
      outgoing.get(edge.from).push(edge);
    }
    const root = byId.get(id);
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

      const storedAnchorY = storedLogicalIds
        .map((id) => positions.get(id)?.y)
        .filter((value) => Number.isFinite(value))
        .reduce((best, value) => Math.min(best, value), Number.POSITIVE_INFINITY);
      const storageRowY = Number.isFinite(storedAnchorY) ? storedAnchorY : cursorY;
      const middleIds = component.filter((id) => {
        const node = byId.get(id);
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
        const node = byId.get(id);
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
    // crossingScore() above is the reference metric, but re-evaluating it twice
    // per adjacent swap is O(swaps x E^2) and froze the tab for a minute on a
    // 2k-node catalog. Swapping neighbours u,v of one layer only flips the
    // crossing state of edge pairs (u-edge, v-edge) that share the same
    // adjacent layer, so after - before is exactly
    //   #(p_u < p_v) - #(p_u > p_v)
    // over those pairs (p = far endpoint position). Same decisions, same order.
    const swapLevelById = new Map();
    for (const [l, group] of columns.entries()) for (const node of group) swapLevelById.set(node.id, l);
    const swapPosById = new Map();
    for (const group of columns.values()) group.forEach((node, index) => swapPosById.set(node.id, index));
    const swapNeighbors = new Map();
    for (const edge of edges) {
      const fromLevel = swapLevelById.get(edge.from);
      const toLevel = swapLevelById.get(edge.to);
      if (!Number.isFinite(fromLevel) || !Number.isFinite(toLevel) || Math.abs(fromLevel - toLevel) !== 1) continue;
      if (!swapNeighbors.has(edge.from)) swapNeighbors.set(edge.from, []);
      if (!swapNeighbors.has(edge.to)) swapNeighbors.set(edge.to, []);
      swapNeighbors.get(edge.from).push({ id: edge.to, level: toLevel });
      swapNeighbors.get(edge.to).push({ id: edge.from, level: fromLevel });
    }
    const swapDelta = (leftId, rightId) => {
      const left = swapNeighbors.get(leftId);
      const right = swapNeighbors.get(rightId);
      if (!left || !right) return 0;
      let delta = 0;
      for (const a of left) {
        const pa = swapPosById.get(a.id);
        for (const b of right) {
          if (a.level !== b.level) continue;
          const pb = swapPosById.get(b.id);
          if (pa < pb) delta += 1;
          else if (pa > pb) delta -= 1;
        }
      }
      return delta;
    };
    for (let pass = 0; pass < 4; pass += 1) {
      let improved = false;
      for (const l of levels) {
        const group = columns.get(l) || [];
        for (let i = 0; i + 1 < group.length; i += 1) {
          if (swapDelta(group[i].id, group[i + 1].id) < 0) {
            improved = true;
            [group[i], group[i + 1]] = [group[i + 1], group[i]];
            swapPosById.set(group[i].id, i);
            swapPosById.set(group[i + 1].id, i + 1);
          }
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
        // Typed rows: a 2k-node column allocates n x slots cells per sweep.
        const dp = Array.from({ length: n }, () => new Float64Array(slots).fill(inf));
        const prev = Array.from({ length: n }, () => new Int32Array(slots).fill(-1));
        for (let row = 0; row < slots; row += 1) {
          if (slots - row < n) break;
          dp[0][row] = (row - ideals[0]) ** 2;
        }
        for (let i = 1; i < n; i += 1) {
          // Running prefix minimum of dp[i - 1][i - 1 .. row - 1]. Scanning pr
          // upward with a strict < keeps the lowest predecessor on ties, exactly
          // as the former O(slots^2) inner loop did.
          let bestCost = inf;
          let bestPrev = -1;
          for (let row = i; row < slots; row += 1) {
            const pr = row - 1;
            if (dp[i - 1][pr] < bestCost) { bestCost = dp[i - 1][pr]; bestPrev = pr; }
            if (slots - row < n - i) continue;
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

    groupLogicalPositionsByDatabase(positions);
    alignPhysicalStorageRows(positions, nodes, edges, level);
    alignPhysicalHorizontalPeers(positions, edges);

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

  // Scale at which the whole graph fits the canvas (may be unreadable).
  function overviewScale() {
    const { width, height } = canvasSize();
    const bounds = model.worldBounds;
    if (!bounds || !width || !height) return 1;
    const cap = model.detailMode === "physical" ? 1.5 : 1.15;
    return Math.max(0.02, Math.min(cap, Math.min(width / bounds.width, height / bounds.height) * 0.92));
  }

  function fitToScreen({ anchorId = null, anchorBox = null } = {}) {
    const { width, height } = canvasSize();
    const bounds = model.worldBounds;
    if (!bounds || !width || !height) return;
    const overview = overviewScale();
    // Fit never shrinks text below READABLE_TEXT_PX. When the whole graph is
    // larger than that, Fit shows the focused object (or the requested anchor,
    // else the top-left of the graph) at the readable scale and the minimap
    // gives the rest; zooming out further is still possible.
    model.scale = Math.max(overview, readableScale());
    model.fitScale = model.scale;
    const anchor = (anchorId && model.layout.get(anchorId)) || (model.focusedId && model.layout.get(model.focusedId)) || null;
    if (model.scale > overview + 1e-9 && anchorBox) {
      // Below the toolbar, from the box's top-left corner (an expanded band).
      model.offsetX = 24 - anchorBox.x * model.scale;
      model.offsetY = 64 - anchorBox.y * model.scale;
    } else if (model.scale > overview + 1e-9 && anchor) {
      model.offsetX = width / 2 - (anchor.x + anchor.width / 2) * model.scale;
      model.offsetY = height / 2 - (anchor.y + anchor.height / 2) * model.scale;
    } else if (model.scale > overview + 1e-9) {
      model.offsetX = 24 - bounds.x * model.scale;
      model.offsetY = 64 - bounds.y * model.scale;
    } else {
      model.offsetX = width / 2 - (bounds.x + bounds.width / 2) * model.scale;
      model.offsetY = height / 2 - (bounds.y + bounds.height / 2) * model.scale;
    }
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

  function edgeDashPattern(edge) {
    if (edge.kind === "view" || edge.kind === "dependency") return { dash: [7, 7], width: 1 };
    if (edge.kind === "dictionary_source") return { dash: [2, 4, 7, 4], width: 1.1 };
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
      // Disjoint segments cannot cross or overlap (see routeBox()).
      if (segmentsApart(a, b, segment.a, segment.b)) continue;
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
    // Distance to the nearest preferred lane, by binary search over the sorted
    // lanes and memoized per y. It is evaluated on every horizontal A* step;
    // scanning every row lane each time dominated routing on graphs with
    // thousands of rows. The value is identical to min(|lane - y|).
    const sortedLaneYs = preferredHorizontalYs.slice().sort((a, b) => a - b);
    const lanePenaltyFactor = isLogicalDependencyEdge(edge) ? 1.35 : 0.55;
    const lanePenaltyByY = new Map();
    const horizontalLanePenalty = (y) => {
      if (!sortedLaneYs.length) return 0;
      const cached = lanePenaltyByY.get(y);
      if (cached !== undefined) return cached;
      let lo = 0;
      let hi = sortedLaneYs.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sortedLaneYs[mid] < y) lo = mid + 1;
        else hi = mid;
      }
      let nearest = Infinity;
      if (lo < sortedLaneYs.length) nearest = Math.abs(sortedLaneYs[lo] - y);
      if (lo > 0) nearest = Math.min(nearest, Math.abs(sortedLaneYs[lo - 1] - y));
      const penalty = nearest * lanePenaltyFactor;
      lanePenaltyByY.set(y, penalty);
      return penalty;
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
    // The sparse grid is |xs| x |ys| points, each tested against every
    // corridor obstacle, then searched with a re-sorted A* queue. On very large
    // lineage graphs a single corridor can span thousands of rows (millions of
    // points) and freeze the tab for minutes. Past this budget the edge gets a
    // plain orthogonal H-V-H route; ordinary graphs stay far below it and are
    // routed exactly as before.
    if (gridX.length * gridY.length > ROUTE_GRID_POINT_BUDGET) {
      const midX = sourceFan.x + (targetFan.x - sourceFan.x) / 2;
      return assembleOrthogonalRoute(sourcePort, sourceFan, compressOrthogonalRoute([
        sourceFan,
        { x: midX, y: sourceFan.y },
        { x: midX, y: targetFan.y },
        targetFan,
      ]), targetFan, targetPort);
    }
    // Every grid point lies inside [gridX] x [gridY], so a routed segment whose
    // box is apart from that rectangle is apart from every candidate step and
    // contributes exactly 0 in routeConflictPenalty(). Filter once per edge
    // instead of scanning all routed segments on every A* relaxation (the
    // dominant cost on large lineage graphs).
    const gridCornerA = { x: gridX[0], y: gridY[0] };
    const gridCornerB = { x: gridX[gridX.length - 1], y: gridY[gridY.length - 1] };
    const corridorSegments = usedSegments.filter((segment) => !segmentsApart(gridCornerA, gridCornerB, segment.a, segment.b));
    const corridorSegmentIndex = createSegmentYIndex(corridorSegments, gridCornerA.y, gridCornerB.y);
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
    // Bucket the grid once per axis. Filtering every point for every lane was
    // O(lanes x points) and dominated routing on tall columns. connectLine()
    // sorts each lane by coordinate, so bucket order cannot change the result.
    const keysByY = new Map();
    const keysByX = new Map();
    for (const [key, point] of points) {
      if (!keysByY.has(point.y)) keysByY.set(point.y, []);
      keysByY.get(point.y).push(key);
      if (!keysByX.has(point.x)) keysByX.set(point.x, []);
      keysByX.get(point.x).push(key);
    }
    for (const y of gridY) connectLine((keysByY.get(y) || []).slice(), true);
    for (const x of gridX) connectLine((keysByX.get(x) || []).slice(), false);

    const startKey = pointKey(sourceFan.x, sourceFan.y);
    const endKey = pointKey(targetFan.x, targetFan.y);
    const best = new Map([[`${startKey}\u0000N`, 0]]);
    const previous = new Map();
    let finalState = null;
    const heuristic = (point) => Math.abs(point.x - targetFan.x) + Math.abs(point.y - targetFan.y);
    // Min-heap on (f = cost + heuristic, insertion order). It pops exactly the
    // element the previous "stable sort the whole queue, then shift()" picked
    // (lowest f, earliest pushed on ties) in O(log n) instead of
    // O(n log n) per step, which made large corridors take minutes.
    const queue = createRouteQueue();
    const pushState = (state) => queue.push(state, state.cost + heuristic(points.get(state.key)));
    pushState({ key: startKey, dir: "N", cost: 0 });

    while (queue.size()) {
      const current = queue.pop();
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
        const conflict = routeConflictPenalty(currentPoint, nextPoint, corridorSegmentIndex.near(currentPoint, nextPoint), edge);
        const reverse = next.dir === "H" && direction * (nextPoint.x - currentPoint.x) < -0.001 ? 1400 : 0;
        const boundary = nextPoint.x < localLeft - 0.01 || nextPoint.x > localRight + 0.01
          || nextPoint.y < localTop - 0.01 || nextPoint.y > localBottom + 0.01 ? 20_000 : 0;
        const lane = next.dir === "H" ? horizontalLanePenalty(nextPoint.y) : 0;
        const cost = current.cost + next.length + bend + conflict + reverse + boundary + lane;
        const nextStateKey = `${next.key}\u0000${next.dir}`;
        if (cost + 0.001 >= (best.get(nextStateKey) ?? Infinity)) continue;
        best.set(nextStateKey, cost);
        previous.set(nextStateKey, stateKey);
        pushState({ key: next.key, dir: next.dir, cost });
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

    return assembleOrthogonalRoute(sourcePort, sourceFan, body, targetFan, targetPort);
  }

  const ROUTE_GRID_POINT_BUDGET = 40000;

  // Buckets routed segments by y so an A* step only examines segments whose
  // vertical extent can touch it. near() returns them in their original order:
  // skipped segments are exactly those segmentsApart() would reject (they add
  // 0), so routeConflictPenalty() sums the same terms in the same order.
  function createSegmentYIndex(segments, minY, maxY) {
    const margin = 0.02;
    if (segments.length <= 32 || !(maxY > minY)) {
      return { near: () => segments };
    }
    const bucketCount = Math.min(512, Math.max(1, Math.ceil(segments.length / 8)));
    const bucketHeight = (maxY - minY) / bucketCount;
    const bucketOf = (y) => Math.max(0, Math.min(bucketCount - 1, Math.floor((y - minY) / bucketHeight)));
    const buckets = Array.from({ length: bucketCount }, () => []);
    segments.forEach((segment, index) => {
      const lo = bucketOf(Math.min(segment.a.y, segment.b.y) - margin);
      const hi = bucketOf(Math.max(segment.a.y, segment.b.y) + margin);
      for (let bucket = lo; bucket <= hi; bucket += 1) buckets[bucket].push(index);
    });
    return {
      near(a, b) {
        const lo = bucketOf(Math.min(a.y, b.y) - margin);
        const hi = bucketOf(Math.max(a.y, b.y) + margin);
        if (lo === hi) return buckets[lo].map((index) => segments[index]);
        const seen = new Set();
        for (let bucket = lo; bucket <= hi; bucket += 1) for (const index of buckets[bucket]) seen.add(index);
        return [...seen].sort((x, y) => x - y).map((index) => segments[index]);
      },
    };
  }

  function createRouteQueue() {
    const heap = [];
    let serial = 0;
    const less = (a, b) => a.f < b.f || (a.f === b.f && a.seq < b.seq);
    return {
      size: () => heap.length,
      push(value, f) {
        heap.push({ value, f, seq: serial++ });
        let i = heap.length - 1;
        while (i > 0) {
          const parent = (i - 1) >> 1;
          if (!less(heap[i], heap[parent])) break;
          [heap[i], heap[parent]] = [heap[parent], heap[i]];
          i = parent;
        }
      },
      pop() {
        const top = heap[0];
        const last = heap.pop();
        if (heap.length) {
          heap[0] = last;
          let i = 0;
          for (;;) {
            const left = 2 * i + 1;
            const right = left + 1;
            let smallest = i;
            if (left < heap.length && less(heap[left], heap[smallest])) smallest = left;
            if (right < heap.length && less(heap[right], heap[smallest])) smallest = right;
            if (smallest === i) break;
            [heap[i], heap[smallest]] = [heap[smallest], heap[i]];
            i = smallest;
          }
        }
        return top.value;
      },
    };
  }

  function assembleOrthogonalRoute(sourcePort, sourceFan, body, targetFan, targetPort) {
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

  // Bounding boxes of routed polylines, keyed by the (immutable) points array.
  // orthogonalSegmentConflict() can only report a crossing or an overlap when
  // two segments touch within its 0.001 tolerance, so pairs of routes whose
  // boxes are further apart contribute exactly 0 and can be skipped. Without
  // this the O(E^2) route scoring took minutes on a 550-edge lineage graph.
  const routeBoxCache = new WeakMap();
  function routeBox(points) {
    let box = routeBoxCache.get(points);
    if (box) return box;
    box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const point of points) {
      if (point.x < box.minX) box.minX = point.x;
      if (point.x > box.maxX) box.maxX = point.x;
      if (point.y < box.minY) box.minY = point.y;
      if (point.y > box.maxY) box.maxY = point.y;
    }
    routeBoxCache.set(points, box);
    return box;
  }

  function routeBoxesApart(a, b) {
    const margin = 0.01;
    return a.maxX + margin < b.minX || b.maxX + margin < a.minX || a.maxY + margin < b.minY || b.maxY + margin < a.minY;
  }

  function segmentsApart(a, b, c, d) {
    const margin = 0.01;
    return Math.max(a.x, b.x) + margin < Math.min(c.x, d.x) || Math.max(c.x, d.x) + margin < Math.min(a.x, b.x)
      || Math.max(a.y, b.y) + margin < Math.min(c.y, d.y) || Math.max(c.y, d.y) + margin < Math.min(a.y, b.y);
  }

  function routePairConflictScore(routeA, edgeA, routeB, edgeB) {
    let score = 0;
    if (routeBoxesApart(routeBox(routeA), routeBox(routeB))) return score;
    const segmentsA = routeSegmentMeta(routeA, edgeA);
    const segmentsB = routeSegmentMeta(routeB, edgeB);
    for (const a of segmentsA) {
      for (const b of segmentsB) {
        if (segmentsApart(a.a, a.b, b.a, b.b)) continue;
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
      if (ctx.measureText(`${text.slice(0, mid)}\u2026`).width <= maxWidth) low = mid;
      else high = mid - 1;
    }
    return `${text.slice(0, low)}\u2026`;
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

  // Graph-specific colour tokens (style.css "Explorer graph" block). The
  // shared --accent is a translucent tint in the light theme, so canvas text,
  // halos and edges use dedicated tokens with readable values in both themes.
  function graphColor(role) {
    switch (role) {
      case "text": return css("--text", "#edf2f7");
      case "muted": return css("--graphMuted", lightThemeActive() ? "#3d4f78" : "#a3adbb");
      case "accentText": return css("--graphAccentText", lightThemeActive() ? "#1d4ed8" : "#93b4ff");
      case "halo": return css("--graphHalo", lightThemeActive() ? "#2563eb" : "#7c9cff");
      case "edge": return css("--graphEdge", lightThemeActive() ? "#2563eb" : "#6b8cff");
      case "edgeMuted": return css("--graphEdgeMuted", lightThemeActive() ? "#5b6b8c" : "#8b96a8");
      case "border": return css("--graphNodeBorder", lightThemeActive() ? "rgba(15, 23, 42, 0.34)" : "rgba(148, 163, 184, 0.34)");
      case "nodeBg": return css("--graphNodeBg", lightThemeActive() ? "#ffffff" : "#141b27");
      case "groupBg": return css("--graphGroupBg", lightThemeActive() ? "#eef3ff" : "#172033");
      case "warn": return css("--graphWarn", lightThemeActive() ? "#b45309" : "#f0a33a");
      case "error": return css("--graphError", lightThemeActive() ? "#b91c1c" : "#f87171");
      default: return css("--text", "#edf2f7");
    }
  }

  // Alpha of objects outside the focused neighbourhood: faint but legible.
  function dimAlpha() {
    return lightThemeActive() ? 0.34 : 0.26;
  }

  function roundedRectPath(ctx, x, y, width, height, radius) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, width, height, radius);
    else ctx.rect(x, y, width, height);
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
    const pct = total > 0 ? `${(used / total * 100).toFixed(1)}% used` : "capacity \u2014";
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
    ctx.fillStyle = css("--panelBg", "#0f1623");
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
      : `${util.formatInt(node.rows)}${node.kind === "buffer" ? " buffered rows" : " rows"}`;
    const bytes = rawBytes == null ? "\u2014" : `${util.formatBytes(rawBytes)}${memoryResident ? " RAM" : " logical"}`;
    return `${rows} · ${bytes}`;
  }

  function drawFocusHalo(ctx, item, radius, dashed) {
    ctx.save();
    // Outer translucent ring + crisp inner stroke: visible on white without
    // relying on a blur that the light theme washes out.
    roundedRectPath(ctx, item.x - 6, item.y - 6, item.width + 12, item.height + 12, radius + 6);
    ctx.strokeStyle = graphColor("halo");
    ctx.globalAlpha = lightThemeActive() ? 0.22 : 0.28;
    ctx.lineWidth = 6;
    ctx.stroke();
    roundedRectPath(ctx, item.x - 3, item.y - 3, item.width + 6, item.height + 6, radius + 3);
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1.6;
    if (!lightThemeActive()) {
      ctx.shadowColor = graphColor("halo");
      ctx.shadowBlur = 12;
    }
    if (dashed) ctx.setLineDash([5, 4]);
    ctx.stroke();
    ctx.restore();
  }

  // Below the readable scale a card keeps only its title, drawn larger so it
  // stays legible while zooming out; below that, cards are plain blocks.
  function compactTitleFont() {
    const scale = Math.max(0.01, Number(model.scale) || 1);
    const size = Math.min(26, Math.max(14, 12 / scale));
    return size * scale >= 7 ? size : 0;
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
    ctx.save();
    ctx.globalAlpha = selected ? 1 : dimAlpha();
    const radius = node.layer === "physical" ? 8 : 10;
    if (isFocus && node.layer === "logical") drawFocusHalo(ctx, item, radius, viewLike);
    roundedRectPath(ctx, item.x, item.y, item.width, item.height, radius);
    ctx.fillStyle = storageDisabled ? css("--panelBg", "#0b0f16") : graphColor("nodeBg");
    ctx.fill();
    ctx.strokeStyle = isFocus || isHover || inPanel ? graphColor("halo") : graphColor("border");
    ctx.lineWidth = isFocus ? 2.4 : isHover || inPanel ? 1.8 : node.kind === "materialized_view" ? 1.8 : 1.2;
    if (viewLike || storageDisabled) ctx.setLineDash([5, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    const pad = 12;
    const titleFont = compact ? compactTitleFont() : 14;
    const baseName = String(node.label || node.name || "");
    if (compact) {
      if (titleFont) {
        ctx.fillStyle = storageDisabled ? graphColor("muted") : graphColor("text");
        ctx.font = `600 ${titleFont}px ${FONT}`;
        ctx.fillText(canvasEllipsis(ctx, baseName, item.width - pad * 2), item.x + pad, item.y + Math.min(item.height - 10, 12 + titleFont));
      }
      ctx.restore();
      return;
    }

    if (node.layer === "physical") {
      ctx.fillStyle = graphColor("muted");
      ctx.font = `11px ${FONT}`;
      ctx.fillText(kindCode(node.kind), item.x + pad, item.y + 17);
      ctx.fillStyle = graphColor("text");
      ctx.font = `600 12px ${FONT}`;
      ctx.fillText(canvasEllipsis(ctx, baseName, item.width - pad * 2), item.x + pad, item.y + 34);
      if (node.kind === "disk") {
        const capacity = diskCapacitySummary(node);
        if (capacity) {
          ctx.fillStyle = graphColor("muted");
          ctx.font = `11px ${FONT}`;
          ctx.fillText(canvasEllipsis(ctx, capacity, item.width - pad * 2), item.x + pad, item.y + 51);
        }
      }
      ctx.restore();
      return;
    }

    // Title = the object's own name; the database is the subtitle so a long
    // database prefix never truncates the part that tells objects apart.
    const badge = String(node.topology_badge || "");
    const health = String(node.health || "healthy");
    let rightEdge = item.x + item.width - pad;
    if (health !== "healthy") {
      ctx.fillStyle = health === "error" || health === "critical" ? graphColor("error") : graphColor("warn");
      ctx.beginPath();
      ctx.arc(rightEdge - 4, item.y + 17, 4, 0, Math.PI * 2);
      ctx.fill();
      rightEdge -= 14;
    }
    if (badge) {
      ctx.font = `600 12px ${FONT}`;
      ctx.fillStyle = graphColor("muted");
      ctx.textAlign = "right";
      ctx.fillText(badge, rightEdge, item.y + 22);
      ctx.textAlign = "left";
      rightEdge -= ctx.measureText(badge).width + 8;
    }
    ctx.fillStyle = storageDisabled ? graphColor("muted") : graphColor("text");
    ctx.font = `600 14px ${FONT}`;
    ctx.fillText(canvasEllipsis(ctx, baseName, rightEdge - item.x - pad), item.x + pad, item.y + 22);
    ctx.fillStyle = graphColor("muted");
    ctx.font = `12px ${FONT}`;
    const subtitle = `${node.database || ""} · ${nodeKindLabel(node)}`;
    ctx.fillText(canvasEllipsis(ctx, subtitle, item.width - pad * 2), item.x + pad, item.y + 41);
    if (!viewLike) {
      ctx.fillText(canvasEllipsis(ctx, nodeSizeLabel(node), item.width - pad * 2), item.x + pad, item.y + 60);
      if (model.detailMode === "physical" && node.storage_policy) {
        ctx.fillText(canvasEllipsis(ctx, `Storage policy · ${node.storage_policy}`, item.width - pad * 2), item.x + pad, item.y + 78);
      } else if (node.kind === "buffer") {
        const minTime = node.buffer_min_time == null ? "\u2014" : `${util.formatInt(node.buffer_min_time)}s`;
        const maxTime = node.buffer_max_time == null ? "\u2014" : `${util.formatInt(node.buffer_max_time)}s`;
        const minRows = node.buffer_min_rows == null ? "\u2014" : util.formatInt(node.buffer_min_rows);
        const maxRows = node.buffer_max_rows == null ? "\u2014" : util.formatInt(node.buffer_max_rows);
        ctx.fillText(canvasEllipsis(ctx, `flush ${minTime}\u2013${maxTime} · ${minRows}\u2013${maxRows} rows`, item.width - pad * 2), item.x + pad, item.y + 78);
      }
    }
    drawTtlSummary(ctx, item, node);
    ctx.restore();
  }

  function groupStat(database) {
    return model.groupStats?.get(database) || null;
  }

  function drawGroupNode(ctx, item, compact) {
    const node = item.node;
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
    if (compact) {
      const size = compactTitleFont();
      if (size) {
        ctx.fillStyle = graphColor("text");
        ctx.font = `700 ${size}px ${FONT}`;
        ctx.fillText(canvasEllipsis(ctx, node.database, item.width - pad * 2), item.x + pad, item.y + Math.min(item.height - 10, 12 + size));
      }
      ctx.restore();
      return;
    }
    ctx.fillStyle = graphColor("text");
    ctx.font = `700 15px ${FONT}`;
    ctx.fillText(canvasEllipsis(ctx, `\u25b8 ${node.database}`, item.width - pad * 2), item.x + pad, item.y + 24);
    ctx.fillStyle = graphColor("muted");
    ctx.font = `12px ${FONT}`;
    const objects = `${util.formatInt(stat.total)} object${stat.total === 1 ? "" : "s"}`;
    const linked = stat.connected ? `${util.formatInt(stat.connected)} with dependencies` : "no dependencies";
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
      ctx.fillStyle = css("--tableBg", "#10141d");
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
        ? `${util.formatInt(stat.shown)} of ${util.formatInt(stat.total)} objects`
        : `${util.formatInt(stat ? stat.total : box.count)} objects`;
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
      ctx.font = `700 ${Math.max(15, 13 / scale)}px ${FONT}`;
      ctx.fillText(database, box.minX, box.minY + Math.max(6, 13 / scale));
      ctx.fillStyle = graphColor("muted");
      ctx.font = `${Math.max(11, 11 / scale)}px ${FONT}`;
      ctx.fillText(`${box.count} objects`, box.minX, box.minY + Math.max(25, 30 / scale));
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // Edge labels, per-node expand controls and canvas hit testing.

  function fmtInt(value) {
    return value == null || !Number.isFinite(Number(value)) ? "\u2014" : util.formatInt(Number(value));
  }

  function fmtBytes(value) {
    return value == null || !Number.isFinite(Number(value)) ? "\u2014" : util.formatBytes(Number(value));
  }

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

  // Label positions to try, best first: the middle of each horizontal run
  // (the gaps between columns), longest first, then the middle of the route.
  function edgeLabelAnchors(points) {
    if (!Array.isArray(points) || points.length < 2) return [];
    const runs = [];
    for (let i = 1; i < points.length; i += 1) {
      const a = points[i - 1];
      const b = points[i];
      if (Math.abs(a.y - b.y) > 0.5) continue;
      const length = Math.abs(b.x - a.x);
      if (length < 36) continue;
      runs.push({ length, x: (a.x + b.x) / 2, y: a.y });
      // Long runs also offer their two thirds, so siblings sharing the first
      // part of a fan do not all compete for the same middle.
      if (length >= 150) {
        runs.push({ length: length - 1, x: a.x + (b.x - a.x) * 0.72, y: a.y });
        runs.push({ length: length - 2, x: a.x + (b.x - a.x) * 0.28, y: a.y });
      }
    }
    runs.sort((p, q) => q.length - p.length);
    runs.push(storageRoutePoint(points, 0.5));
    return runs;
  }

  function drawEdgeLabels(ctx, edges, focused) {
    if (model.detailMode !== "logical" || !model.edgeGeometry) return;
    // Every edge is labelled on small graphs; on big ones only the edges that
    // are hovered, selected or touch the focused / hovered object.
    const all = edges.length <= 60;
    const items = [...model.layout.values()];
    const placed = [];
    // Highlighted edges first so their labels win the free spots.
    edges = edges.slice().sort((a, b) => Number(edgeIsHighlighted(b)) - Number(edgeIsHighlighted(a)));
    ctx.save();
    ctx.font = `600 12px ${FONT}`;
    for (const edge of edges) {
      const highlighted = edgeIsHighlighted(edge);
      const touchesFocus = !!model.focusedId && (edge.from === model.focusedId || edge.to === model.focusedId);
      if (!all && !highlighted && !touchesFocus) continue;
      const text = edgeShortLabel(edge);
      const width = ctx.measureText(text).width + 12;
      // First candidate that neither covers a card nor another label; a
      // highlighted edge always gets its label.
      const candidates = edgeLabelAnchors(model.edgeGeometry.get(edge.id));
      const boxOf = (candidate) => ({ x: candidate.x - width / 2, y: candidate.y - 9, width, height: 18 });
      let anchor = candidates.find((candidate) => {
        const box = boxOf(candidate);
        return !items.some((item) => rectsOverlap(box, item, 2)) && !placed.some((other) => rectsOverlap(box, other, 3));
      }) || null;
      if (!anchor && highlighted) anchor = candidates[0] || null;
      if (!anchor) continue;
      const rect = boxOf(anchor);
      placed.push(rect);
      const selected = !focused || (focused.has(edge.from) && focused.has(edge.to));
      ctx.globalAlpha = highlighted || selected ? 1 : dimAlpha();
      roundedRectPath(ctx, rect.x, rect.y, rect.width, rect.height, 9);
      ctx.fillStyle = css("--panelBg", "#0f1623");
      ctx.fill();
      ctx.strokeStyle = highlighted ? graphColor("halo") : graphColor("border");
      ctx.lineWidth = highlighted ? 1.4 : 0.9;
      ctx.stroke();
      ctx.fillStyle = highlighted ? graphColor("accentText") : graphColor("muted");
      ctx.textAlign = "center";
      ctx.fillText(text, anchor.x, anchor.y + 4.5);
      ctx.textAlign = "left";
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
    ctx.font = `700 12px ${FONT}`;
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
        ctx.fillStyle = hover ? css("--panelBg", "#0f1623") : graphColor("accentText");
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
    const byId = new Map(visibleEdges().map((edge) => [edge.id, edge]));
    for (const hit of model.edgeLabelHits || []) {
      if (pointInRect(point, hit, 2 / model.scale) && byId.has(hit.edge.id)) return byId.get(hit.edge.id);
    }
    const tolerance = 6 / model.scale;
    let best = null;
    for (const [id, points] of model.edgeGeometry) {
      const edge = byId.get(id);
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
  // Graph chrome: Graph / List switch, "objects without dependencies" toggle,
  // side panel (node or edge) and the impact list. All of it lives inside
  // #explorerGraphPane and is created once by init().

  const chrome = {
    root: null, viewSwitch: null, canvasButton: null, listButton: null,
    isolatedLabel: null, isolatedInput: null, panel: null, panelBody: null, list: null,
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function currentViewMode() {
    if (model.viewMode) return model.viewMode;
    return mobileLayout() ? "list" : "canvas";
  }

  function buildGraphChrome() {
    const pane = dom.explorerGraphPane;
    if (!pane || chrome.root) return;
    chrome.root = pane;
    const controls = pane.querySelector(".explorerGraphViewportControls");

    const group = el("div", "explorerGraphViewportGroup explorerGraphViewSwitch");
    group.setAttribute("role", "tablist");
    group.setAttribute("aria-label", "Graph view");
    chrome.canvasButton = el("button", "explorerGraphViewportControl explorerGraphViewportControl--text explorerGraphViewSwitch__option", "Graph");
    chrome.listButton = el("button", "explorerGraphViewportControl explorerGraphViewportControl--text explorerGraphViewSwitch__option", "List");
    for (const [button, mode] of [[chrome.canvasButton, "canvas"], [chrome.listButton, "list"]]) {
      button.type = "button";
      button.setAttribute("role", "tab");
      button.dataset.graphView = mode;
      button.addEventListener("click", () => setViewMode(mode));
    }
    chrome.canvasButton.id = "explorerGraphCanvasViewButton";
    chrome.listButton.id = "explorerGraphListViewButton";
    group.append(chrome.canvasButton, chrome.listButton);
    chrome.viewSwitch = group;

    const isolated = el("label", "explorerGraphViewportGroup explorerGraphIsolatedToggle");
    chrome.isolatedInput = el("input");
    chrome.isolatedInput.type = "checkbox";
    chrome.isolatedInput.id = "explorerGraphShowIsolated";
    chrome.isolatedInput.addEventListener("change", () => setShowIsolated(chrome.isolatedInput.checked));
    isolated.append(chrome.isolatedInput, el("span", null, "Show objects without dependencies"));
    chrome.isolatedLabel = isolated;
    if (controls) controls.append(group, isolated);
    else pane.append(group, isolated);

    const panel = el("aside", "explorerGraphPanel");
    panel.id = "explorerGraphPanel";
    panel.hidden = true;
    panel.setAttribute("aria-label", "Graph object details");
    chrome.panelBody = el("div", "explorerGraphPanel__body");
    panel.append(chrome.panelBody);
    chrome.panel = panel;

    const list = el("section", "explorerGraphImpact");
    list.id = "explorerGraphImpact";
    list.hidden = true;
    list.setAttribute("aria-label", "Lineage impact list");
    chrome.list = list;
    pane.append(list, panel);

    window.matchMedia?.(MOBILE_QUERY)?.addEventListener?.("change", () => renderGraphChrome());
  }

  function setViewMode(mode) {
    model.viewMode = mode === "list" ? "list" : "canvas";
    renderGraphChrome();
    if (model.viewMode === "canvas") {
      canvasSize();
      if (!model.isFitted) scheduleDraw();
      else fitToScreen();
    }
  }

  function renderGraphChrome() {
    updateStatus();
    if (!chrome.root) return;
    const listMode = currentViewMode() === "list";
    const lineage = model.detailMode === "logical";
    chrome.root.classList.toggle("explorerGraphPane--list", listMode);
    chrome.root.classList.toggle("explorerGraphPane--panel", !!model.panel && !chrome.panel.hidden);
    chrome.canvasButton?.setAttribute("aria-selected", String(!listMode));
    chrome.listButton?.setAttribute("aria-selected", String(listMode));
    if (chrome.viewSwitch) chrome.viewSwitch.hidden = !lineage;
    if (chrome.isolatedLabel) chrome.isolatedLabel.hidden = !lineage || !!model.focusedId || listMode;
    if (chrome.isolatedInput) chrome.isolatedInput.checked = model.showIsolated;
    if (chrome.list) {
      chrome.list.hidden = !(listMode && lineage);
      if (!chrome.list.hidden) renderImpactList();
    }
  }

  // Directed hop distances from the focused object over the visible
  // projection: upstream through incoming edges, downstream through outgoing.
  function impactRows() {
    const nodes = visibleNodes().filter((node) => node.layer === "logical" && !node.synthetic);
    const edges = visibleEdges().filter((edge) => !edge.aggregated);
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const focus = model.focusedId && byId.has(model.focusedId) ? model.focusedId : null;
    const walk = (forward, both = false) => {
      const distance = new Map();
      if (!focus) return distance;
      const links = new Map();
      const link = (from, to) => {
        if (!links.has(from)) links.set(from, []);
        links.get(from).push(to);
      };
      for (const edge of edges) {
        if (both || forward) link(edge.from, edge.to);
        if (both || !forward) link(edge.to, edge.from);
      }
      let frontier = [focus];
      distance.set(focus, 0);
      while (frontier.length) {
        const next = [];
        for (const id of frontier) {
          for (const target of links.get(id) || []) {
            if (distance.has(target)) continue;
            distance.set(target, distance.get(id) + 1);
            next.push(target);
          }
        }
        frontier = next;
      }
      return distance;
    };
    const down = walk(true);
    const up = walk(false);
    // Siblings (another consumer of an upstream source, ...) are neither
    // upstream nor downstream: listed as "related" at their hop distance.
    const any = walk(true, true);
    const rows = nodes.map((node) => {
      const u = node.id === focus ? null : up.get(node.id);
      const d = node.id === focus ? null : down.get(node.id);
      let direction = "\u2014";
      if (node.id === focus) direction = "selected";
      else if (u != null && d != null) direction = "upstream · downstream";
      else if (u != null) direction = "upstream";
      else if (d != null) direction = "downstream";
      else if (any.has(node.id)) direction = "related";
      const depth = node.id === focus ? 0 : Math.min(u ?? Infinity, d ?? Infinity, any.get(node.id) ?? Infinity);
      const order = node.id === focus ? 0 : u != null && d == null ? -1 : d != null ? 1 : 2;
      return { node, direction, depth: Number.isFinite(depth) ? depth : null, order };
    });
    rows.sort((a, b) => a.order - b.order
      || (a.order < 0 ? (b.depth ?? 0) - (a.depth ?? 0) : (a.depth ?? 0) - (b.depth ?? 0))
      || `${a.node.database}.${a.node.name}`.localeCompare(`${b.node.database}.${b.node.name}`));
    return { rows, focus: focus ? byId.get(focus) : null, upstream: up.size ? up.size - 1 : 0, downstream: down.size ? down.size - 1 : 0 };
  }

  function renderImpactList() {
    const list = chrome.list;
    if (!list) return;
    list.replaceChildren();
    const { rows, focus, upstream, downstream } = impactRows();
    const header = el("div", "explorerGraphImpact__header");
    if (focus) {
      header.append(
        el("span", "explorerGraphImpact__title", `Impact of ${focus.database}.${focus.name}`),
        el("span", "explorerGraphImpact__meta", `${fmtInt(upstream)} upstream · ${fmtInt(downstream)} downstream · depth ${model.focusDepth}${model.expansions.size ? " + expanded" : ""}`),
      );
    } else {
      header.append(
        el("span", "explorerGraphImpact__title", "Objects with dependencies"),
        el("span", "explorerGraphImpact__meta", "Select an object to list what it reads from and what depends on it."),
      );
    }
    list.append(header);
    if (!rows.length) {
      list.append(el("p", "explorerGraphImpact__empty", model.loading ? "Loading graph\u2026" : "No objects in this scope."));
      return;
    }
    const wrap = el("div", "explorerGraphImpact__wrap");
    const table = el("table", "explorerGraphImpact__table");
    const head = el("thead");
    const headRow = el("tr");
    for (const [label, column] of [["Object", "name"], ["Type", "type"], ["Direction", "direction"], ["Depth", "depth"], ["Database", "database"]]) {
      headRow.append(el("th", `explorerGraphImpact__col--${column}`, label));
    }
    head.append(headRow);
    const body = el("tbody");
    for (const row of rows) {
      const tr = el("tr", row.node.id === model.focusedId ? "is-selected" : "");
      tr.dataset.nodeId = row.node.id;
      const name = el("button", "explorerGraphImpact__open", row.node.name);
      name.type = "button";
      name.title = `${row.node.database}.${row.node.name}`;
      name.addEventListener("click", () => selectGraphNode(row.node.id));
      const nameCell = el("td", "explorerGraphImpact__name");
      nameCell.append(name);
      tr.append(
        nameCell,
        el("td", "explorerGraphImpact__col--type", nodeKindLabel(row.node)),
        el("td", `explorerGraphImpact__direction explorerGraphImpact__direction--${row.order === -1 ? "up" : row.order === 1 ? "down" : "none"}`, row.direction),
        el("td", "explorerGraphImpact__depth", row.depth == null ? "\u2014" : String(row.depth)),
        el("td", "explorerGraphImpact__col--database", row.node.database),
      );
      body.append(tr);
    }
    table.append(head, body);
    wrap.append(table);
    list.append(wrap);
  }

  // Same path as a canvas click on a logical node: focus, tree/URL sync and
  // the side panel.
  function selectGraphNode(id) {
    const node = (model.graph?.nodes || []).find((candidate) => candidate.id === id && candidate.layer === "logical");
    if (!node) return;
    setFocus(node.id);
    if (model.openTable && node.database && node.name) model.openTable(node.database, node.name);
    openPanel({ type: "node", id: node.id });
  }

  function openPanel(target) {
    model.panel = target;
    model.panelSerial += 1;
    renderPanel();
    keepNodeBesidePanel(target);
    scheduleDraw();
  }

  // The panel covers the right of the canvas: pan just enough that the
  // object it describes stays visible to its left (desktop only; on phones
  // the panel is a bottom sheet).
  function keepNodeBesidePanel(target) {
    if (target?.type !== "node" || mobileLayout() || !chrome.panel || chrome.panel.hidden) return;
    const item = model.layout.get(target.id);
    const canvas = dom.explorerGraphCanvas;
    if (!item || !canvas) return;
    const canvasRect = canvas.getBoundingClientRect();
    const panelLeft = chrome.panel.getBoundingClientRect().left - canvasRect.left;
    const right = worldToScreen(item.x + item.width, item.y).x;
    const overlap = right + 24 - panelLeft;
    if (overlap <= 0) return;
    const left = worldToScreen(item.x, item.y).x;
    model.offsetX -= Math.min(overlap, Math.max(0, left - 24));
    model.isFitted = false;
    syncFocusControls();
  }

  function closePanel() {
    if (!model.panel) return;
    model.panel = null;
    model.panelSerial += 1;
    renderPanel();
    scheduleDraw();
  }

  function panelSection(title) {
    const section = el("section", "explorerGraphPanel__section");
    if (title) section.append(el("h3", "explorerGraphPanel__sectionTitle", title));
    return section;
  }

  function panelFacts(pairs) {
    const list = el("dl", "explorerGraphPanel__facts");
    for (const [label, value] of pairs) {
      if (value == null || value === "") continue;
      list.append(el("dt", null, label), el("dd", null, value));
    }
    return list;
  }

  function objectButton(id, fallback) {
    const node = (model.graph?.nodes || []).find((candidate) => candidate.id === id);
    const label = node ? `${node.database}.${node.name}` : (parseLogicalTableId(id) ? `${parseLogicalTableId(id).database}.${parseLogicalTableId(id).table}` : fallback || id);
    const button = el("button", "explorerGraphPanel__link", label);
    button.type = "button";
    button.title = label;
    button.addEventListener("click", () => selectGraphNode(id));
    return button;
  }

  function sqlBlock(sql, truncated) {
    const pre = el("pre", "explorerGraphPanel__sql");
    const code = el("code");
    if (ns.highlight && typeof ns.highlight.renderInto === "function") ns.highlight.renderInto(code, sql);
    else code.textContent = sql;
    pre.append(code);
    const wrap = el("div", "explorerGraphPanel__sqlWrap");
    wrap.append(pre);
    if (truncated) wrap.append(el("p", "explorerGraphPanel__note", "Truncated at 32 KB: the full text is in the object's DDL."));
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
    const status = el("p", "explorerGraphPanel__note", "Loading definition\u2026");
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
        facts.push(["Flush after", `${fmtInt(node.buffer_min_time)}\u2013${fmtInt(node.buffer_max_time)} s`]);
        facts.push(["Flush rows", `${fmtInt(node.buffer_min_rows)}\u2013${fmtInt(node.buffer_max_rows)}`]);
        facts.push(["Flush bytes", `${fmtBytes(node.buffer_min_bytes)}\u2013${fmtBytes(node.buffer_max_bytes)}`]);
        facts.push(["Layers", fmtInt(node.buffer_layers)]);
      } else if (node.kind === "dictionary" && definition.dictionary) {
        facts.push(["Source", [definition.dictionary.source_kind, target].filter(Boolean).join(" · ") || "\u2014"]);
        facts.push(["Layout", definition.dictionary.layout || "\u2014"]);
        facts.push(["Lifetime", definition.dictionary.lifetime || "\u2014"]);
      } else if (node.kind === "distributed" && definition.distributed) {
        const d = definition.distributed;
        facts.push(["Cluster", d.cluster || "\u2014"]);
        facts.push(["Local table", target || "not visible"]);
        facts.push(["Sharding key", d.sharding_key || "none (single shard writes)"]);
        if (d.shards) facts.push(["Topology", `${fmtInt(d.shards)} shard${d.shards === 1 ? "" : "s"} × ${fmtInt(d.replicas_per_shard)} replica${d.replicas_per_shard === 1 ? "" : "s"}`]);
      }
      if (facts.length) container.append(panelFacts(facts));
      if (definition.select_sql) {
        if (!compact) container.append(el("h4", "explorerGraphPanel__subTitle", "SELECT"));
        container.append(sqlBlock(definition.select_sql, definition.select_sql_truncated));
      }
      if (!facts.length && !definition.select_sql) container.append(el("p", "explorerGraphPanel__note", "No definition beyond the table structure."));
    }).catch((error) => {
      if (serial !== model.panelSerial) return;
      status.textContent = error instanceof Error ? error.message : String(error);
    });
  }

  function renderColumnsInto(container, node) {
    const serial = model.panelSerial;
    const status = el("p", "explorerGraphPanel__note", "Loading columns\u2026");
    container.append(status);
    loadColumns(node).then((columns) => {
      if (serial !== model.panelSerial) return;
      status.remove();
      if (!columns.length) { container.append(el("p", "explorerGraphPanel__note", "No columns.")); return; }
      const limit = 40;
      const table = el("table", "explorerGraphPanel__columns");
      const body = el("tbody");
      for (const column of columns.slice(0, limit)) {
        const tr = el("tr");
        tr.append(el("td", "explorerGraphPanel__columnName", column.name), el("td", "explorerGraphPanel__columnType", column.type));
        body.append(tr);
      }
      table.append(body);
      container.append(table);
      if (columns.length > limit) container.append(el("p", "explorerGraphPanel__note", `${fmtInt(columns.length - limit)} more columns in the table card.`));
    }).catch((error) => {
      if (serial !== model.panelSerial) return;
      status.textContent = error instanceof Error ? error.message : String(error);
    });
  }

  function neighborIds(id, direction) {
    const edges = visibleEdges().filter((edge) => !edge.aggregated);
    return [...new Set(edges.filter((edge) => (direction === "up" ? edge.to === id : edge.from === id))
      .map((edge) => (direction === "up" ? edge.from : edge.to)))];
  }

  function renderNodePanel(body, node) {
    const header = el("header", "explorerGraphPanel__header");
    const titles = el("div", "explorerGraphPanel__titles");
    titles.append(
      el("span", "explorerGraphPanel__kind", nodeKindLabel(node)),
      el("h2", "explorerGraphPanel__title", node.name),
      el("span", "explorerGraphPanel__subtitle", node.database),
    );
    header.append(titles, panelCloseButton());
    body.append(header);

    const actions = el("div", "explorerGraphPanel__actions");
    const open = el("button", "button button--small explorerGraphPanel__openCard", "Open card");
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
      ["Rows", viewLike ? null : fmtInt(node.rows)],
      ["Size", viewLike ? null : (node.kind === "buffer" || node.kind === "memory" || node.kind === "dictionary"
        ? `${fmtBytes(node.resident_bytes)} RAM` : fmtBytes(node.logical_bytes))],
      ["Parts", viewLike || !node.active_parts ? null : fmtInt(node.active_parts)],
      ["Replication", node.topology_badge || null],
      ["Health", node.health && node.health !== "healthy" ? node.health : null],
      ["TTL", ttlRules(node).length ? `${ttlRules(node).length} rule${ttlRules(node).length === 1 ? "" : "s"} · ${ttlBaseSummary(node)}` : null],
    ]));
    body.append(summary);

    const lineage = panelSection("Lineage");
    for (const [label, direction] of [["Reads from", "up"], ["Used by", "down"]]) {
      const ids = neighborIds(node.id, direction);
      const hidden = Number(direction === "up" ? node.hidden_upstream : node.hidden_downstream) || 0;
      const row = el("div", "explorerGraphPanel__lineageRow");
      row.append(el("span", "explorerGraphPanel__lineageLabel", label));
      const values = el("div", "explorerGraphPanel__lineageValues");
      for (const id of ids.slice(0, 12)) values.append(objectButton(id));
      if (ids.length > 12) values.append(el("span", "explorerGraphPanel__note", `+${ids.length - 12} more`));
      if (!ids.length && !hidden) values.append(el("span", "explorerGraphPanel__note", "\u2014"));
      if (hidden) {
        const more = el("button", "explorerGraphPanel__link explorerGraphPanel__expand", `Show ${fmtInt(hidden)} more`);
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
    const header = el("header", "explorerGraphPanel__header");
    const titles = el("div", "explorerGraphPanel__titles");
    titles.append(el("span", "explorerGraphPanel__kind", "Dependency"), el("h2", "explorerGraphPanel__title", edgeLongLabel(edge)));
    header.append(titles, panelCloseButton());
    body.append(header);

    const route = panelSection(null);
    const fromTo = el("div", "explorerGraphPanel__route");
    const groupLabel = (id) => {
      const node = visibleNodes().find((candidate) => candidate.id === id);
      return node?.kind === "database_group" ? el("span", "explorerGraphPanel__routeGroup", `${node.database} (database)`) : objectButton(id);
    };
    fromTo.append(groupLabel(edge.from), el("span", "explorerGraphPanel__arrow", "\u2192"), groupLabel(edge.to));
    route.append(fromTo);
    if (edge.collapsed) route.append(el("p", "explorerGraphPanel__note", `Through ${edge.collapsed_path.length} hidden object${edge.collapsed_path.length === 1 ? "" : "s"} (non-storing objects are hidden).`));
    body.append(route);

    if (edge.aggregated) {
      const members = panelSection("Dependencies");
      const list = el("ul", "explorerGraphPanel__members");
      for (const member of edge.members.slice(0, 40)) {
        const item = el("li");
        item.append(objectButton(member.from), el("span", "explorerGraphPanel__arrow", "\u2192"), objectButton(member.to),
          el("span", "explorerGraphPanel__memberKind", edgeShortLabel(member)));
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
      body.append(el("p", "explorerGraphPanel__note explorerGraphPanel__note--block", "A View is evaluated at query time: no data is copied along this edge."));
    }
  }

  function panelCloseButton() {
    const close = el("button", "explorerGraphPanel__close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Close details");
    close.addEventListener("click", closePanel);
    return close;
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
    panel.hidden = !rendered;
    if (!rendered) model.panel = null;
    chrome.root?.classList.toggle("explorerGraphPane--panel", rendered);
    panel.dataset.panelType = rendered ? model.panel.type : "";
    if (keepScroll) body.scrollTop = scrollTop;
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
    // Also shown as soon as the zoom is below the readable scale: the cards
    // are then compact and the minimap is the orientation aid.
    const hasClippedElements = graphHasClippedElements() || (model.layout.size > 1 && model.scale < readableScale() - 1e-6);
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
    // Draw the same routed geometry as the main canvas. The minimap is small,
    // but direction and bends must match what the user sees in the graph rather
    // than falling back to misleading centre-to-centre diagonals.
    ctx.save();
    ctx.strokeStyle = graphColor("edge");
    ctx.fillStyle = ctx.strokeStyle;
    ctx.globalAlpha = 0.48;
    const lineageRoutes = model.detailMode === "logical" ? ensureLineageRouteCache() : null;
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
      if (!Array.isArray(points) || points.length < 2) continue;
      const mapped = points.map((point) => ({ x: ox + point.x * scale, y: oy + point.y * scale }));
      const style = edgeDashPattern(edge);
      ctx.lineWidth = Math.max(0.7, Math.min(1.4, style.width));
      ctx.setLineDash(style.dash.map((value) => Math.max(1, value * Math.max(0.25, scale))));
      ctx.beginPath();
      ctx.moveTo(mapped[0].x, mapped[0].y);
      for (let i = 1; i < mapped.length; i += 1) ctx.lineTo(mapped[i].x, mapped[i].y);
      ctx.stroke();
      ctx.setLineDash([]);
      const tip = mapped[mapped.length - 1];
      const near = mapped[mapped.length - 2];
      const angle = Math.atan2(tip.y - near.y, tip.x - near.x);
      const arrow = 3;
      ctx.beginPath();
      ctx.moveTo(tip.x, tip.y);
      ctx.lineTo(tip.x - arrow * Math.cos(angle - 0.55), tip.y - arrow * Math.sin(angle - 0.55));
      ctx.lineTo(tip.x - arrow * Math.cos(angle + 0.55), tip.y - arrow * Math.sin(angle + 0.55));
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    ctx.fillStyle = graphColor("muted");
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
      const viewportX = ox + worldLeft * scale;
      const viewportY = oy + worldTop * scale;
      const viewportWidth = worldWidth * scale;
      const viewportHeight = worldHeight * scale;
      if (lightThemeActive()) {
        ctx.fillStyle = "rgba(15, 23, 42, 0.10)";
        ctx.fillRect(viewportX, viewportY, viewportWidth, viewportHeight);
      }
      ctx.strokeStyle = lightThemeActive() ? "rgba(15, 23, 42, 0.92)" : graphColor("halo");
      ctx.lineWidth = lightThemeActive() ? 1.6 : 1;
      ctx.strokeRect(viewportX, viewportY, viewportWidth, viewportHeight);
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
      ctx.fillStyle = graphColor("muted");
      ctx.font = "13px Arial, Helvetica, sans-serif";
      ctx.fillText(model.loading ? "Loading graph\u2026" : "No accessible objects in this scope", 24, 34);
      return;
    }

    ctx.save();
    ctx.translate(model.offsetX, model.offsetY);
    ctx.scale(model.scale, model.scale);
    if (model.scale < 0.23 && model.detailMode === "logical" && !model.focusedId) {
      drawDatabaseLod(ctx);
    } else {
      const focused = focusedSet();
      drawDatabaseGroups(ctx);
      const edges = visibleEdges();
      model.edgeLabelHits = [];
      model.edgeGeometry = new Map();
      for (const edge of edges) drawEdge(ctx, edge, now, focused);
      const compact = model.scale < readableScale() - 1e-6;
      for (const item of model.layout.values()) drawNode(ctx, item, focused, compact);
      if (!compact) drawEdgeLabels(ctx, edges, focused);
      drawNodeExpandControls(ctx, compact);
    }
    ctx.restore();
    drawMinimap();

    const animationEdges = visibleEdges();
    const hasActive = model.detailMode === "logical"
      && animationEdges.some((edge) => lineageEdgeShouldAnimate(edge));
    const hasStorageAnimation = model.detailMode === "physical" && !reducedMotionPreferred()
      && visibleEdges().some((edge) => isStorageRouteEdge(edge));
    if ((hasActive || hasStorageAnimation) && model.active) model.animationFrame = requestAnimationFrame(draw);
  }

  function scheduleDraw() {
    if (!model.active || model.animationFrame) return;
    model.animationFrame = requestAnimationFrame(draw);
  }

  function redrawThemeNow() {
    // Called synchronously by the theme switch, before MutationObserver
    // callbacks run: drop resolved colours so this redraw uses the new theme.
    invalidateThemeCache();
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
      const scopeMatches = model.graph?.scope_focus_id === model.focusedId
        && Number(model.graph?.scope_depth) === model.focusDepth;
      const canGrow = scopeMatches && model.focusDepth < 8 && model.graph?.scope_has_more === true;
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
    const match = visibleNodes().find((node) => node.layer === "logical" && `${node.database}.${node.name} ${node.engine || ""}`.toLowerCase().includes(query));
    if (match) setFocus(match.id, true);
  }

  function updateStatus() {
    if (!dom.explorerGraphStatus) return;
    if (model.loading) {
      dom.explorerGraphStatus.textContent = "Loading graph\u2026";
      return;
    }
    const visible = visibleNodes();
    const nodes = visible.filter((node) => !node.synthetic).length;
    const groups = visible.length - nodes;
    const edges = visibleEdges().length;
    const focusedScope = currentFocusScope();
    const scope = focusedScope ? `${focusedScope.database}.${focusedScope.table}` : (model.database || "all databases");
    const focus = model.focusedId && model.detailMode === "logical"
      ? ` · neighborhood depth ${model.focusDepth}${model.expansions.size ? ` + ${model.expansions.size} expanded` : ""}` : "";
    const parts = [];
    if (groups) parts.push(`${groups} collapsed database${groups === 1 ? "" : "s"}`);
    if (nodes || !groups) parts.push(`${nodes} nodes`);
    parts.push(`${edges} edges`, `${scope}${focus}`);
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
      if (stale) return;

      model.graph = payload;
      model.graphRequestKey = requestKey;
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
        model.layout.clear();
        if (dom.explorerGraphStatus) dom.explorerGraphStatus.textContent = e instanceof Error ? e.message : String(e);
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
    dom.explorerGraphLogicalButton?.setAttribute("aria-selected", String(next === "logical"));
    dom.explorerGraphPhysicalButton?.setAttribute("aria-selected", String(next === "physical"));
    if (dom.explorerGraphTypeSelectButton) dom.explorerGraphTypeSelectButton.textContent = next === "physical" ? "Storage" : "Lineage";
    // TTL lifecycle only exists in the Storage projection. Keep the legend
    // contextual so Lineage does not advertise an edge type it never renders.
    const ttlLegend = document.getElementById("explorerGraphLegendTtl");
    if (ttlLegend) ttlLegend.hidden = next !== "physical";
    closeGraphTypeMenu({ immediate: true });
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
    const bounds = model.worldBounds;
    const canvas = dom.explorerGraphCanvas;
    if (!bounds || !canvas || !model.layout.size || model.scale <= 0) return;
    const rect = canvas.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    if (!width || !height) return;
    const marginX = Math.min(72, Math.max(24, width * 0.18));
    const marginY = Math.min(72, Math.max(24, height * 0.18));
    const minX = marginX - (bounds.x + bounds.width) * model.scale;
    const maxX = width - marginX - bounds.x * model.scale;
    const minY = marginY - (bounds.y + bounds.height) * model.scale;
    const maxY = height - marginY - bounds.y * model.scale;
    model.offsetX = Math.max(Math.min(minX, maxX), Math.min(Math.max(minX, maxX), model.offsetX));
    model.offsetY = Math.max(Math.min(minY, maxY), Math.min(Math.max(minY, maxY), model.offsetY));
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
    clampViewportToGraph();
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
        clampViewportToGraph();
        model.isFitted = false;
        syncFocusControls();
        model.dragX = event.clientX;
        model.dragY = event.clientY;
        scheduleDraw();
        return;
      }
      const control = hitControl(event.clientX, event.clientY);
      const node = control ? null : hitNode(event.clientX, event.clientY);
      const clickable = nodeIsClickable(node);
      const edge = control || node ? null : hitEdge(event.clientX, event.clientY);
      const next = clickable ? node.id : null;
      const nextEdge = edge ? edge.id : null;
      const controlKey = control ? `${control.type}\u0000${control.key || control.database}` : null;
      const previousControlKey = model.hoveredControl ? `${model.hoveredControl.type}\u0000${model.hoveredControl.key || model.hoveredControl.database}` : null;
      updateCanvasPointerState(clickable ? node : null);
      canvas.classList.toggle("is-node-clickable", !!(control || edge || clickable));
      if (next !== model.hoveredId || nextEdge !== model.hoveredEdgeId || controlKey !== previousControlKey) {
        model.hoveredId = next;
        model.hoveredEdgeId = nextEdge;
        model.hoveredControl = control;
        scheduleDraw();
      }
    });
    const endDrag = (event) => {
      if (!model.dragging) return;
      model.dragging = false;
      canvas.releasePointerCapture?.(event.pointerId);
      canvas.classList.remove("is-dragging");
      const control = hitControl(event.clientX, event.clientY);
      const node = control ? null : hitNode(event.clientX, event.clientY);
      updateCanvasPointerState(node);
      if (model.dragMoved) return;
      if (control?.type === "expand") { toggleExpansion(control.key); return; }
      if (control?.type === "band") { setGroupExpanded(control.database, false); return; }
      if (node?.kind === "database_group") { setGroupExpanded(node.database, true); return; }
      if (nodeIsClickable(node)) {
        setFocus(node.id);
        if (node.layer === "logical" && model.openTable && node.database && node.name) {
          model.openTable(node.database, node.name);
        }
        if (node.layer === "logical") openPanel({ type: "node", id: node.id });
        return;
      }
      if (node) return;
      const edge = hitEdge(event.clientX, event.clientY);
      if (edge && model.detailMode === "logical") openPanel({ type: "edge", id: edge.id });
      else closePanel();
    };
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);
    canvas.addEventListener("pointerleave", () => {
      if (!model.dragging) {
        model.hoveredId = null;
        model.hoveredEdgeId = null;
        model.hoveredControl = null;
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
      if (event.key === "Escape" && model.active && model.panel && !graphTypeMenuOpen()) closePanel();
    });
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
    return {
      scale: model.scale,
      fitScale: model.fitScale,
      readableScale: readableScale(),
      viewMode: currentViewMode(),
      focusedId: model.focusedId,
      panel: model.panel ? { ...model.panel } : null,
      expansions: [...model.expansions],
      showIsolated: model.showIsolated,
      nodes: [...model.layout.values()].map((item) => ({
        id: item.node.id, kind: item.node.kind, database: item.node.database, name: item.node.name,
        hiddenUpstream: Number(item.node.hidden_upstream) || 0, hiddenDownstream: Number(item.node.hidden_downstream) || 0,
        ...toClient(item),
      })),
      edges: visibleEdges().map((edge) => ({ id: edge.id, kind: edge.kind, from: edge.from, to: edge.to, aggregated: !!edge.aggregated, collapsed: !!edge.collapsed })),
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
