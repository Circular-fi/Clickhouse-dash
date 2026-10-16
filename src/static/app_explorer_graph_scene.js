// This module holds the scene of the Explorer graph.
// It has the projections of the payload and their caches. It has the visible nodes and edges, which are the neighbourhood of the focus or the database groups of the overview. It also has the layout of the visible objects and the routing of the Lineage edges.

import { isStorageRouteEdge as storageRouteKind } from "./app_explorer_graph_geometry.js";
import { layoutNodes } from "./app_explorer_graph_layout.js";
import { buildLogicalProjection, buildStorageProjection, canUseStorage, graphRequestKey, graphRequestOptions, groupOverview, isLogicalDependencyEdge, neighborhoodIds } from "./app_explorer_graph_model.js";
import { actions, currentFocusScope, model, scheduleDraw } from "./app_explorer_graph_store.js";
import { graphKit } from "./app_graph_kit.js";

const kit = graphKit;

// The request that the scope on screen makes. See graphRequestOptions in app_explorer_graph_model.js.
function scopeRequest(refresh = false) {
  return graphRequestOptions({
    detailMode: model.detailMode,
    includeSystem: model.includeSystem,
    includeNonStoring: model.includeNonStoring,
    focus: currentFocusScope(),
    focusDepth: model.focusDepth,
    expansions: model.expansions,
    database: model.database,
  }, refresh);
}

// A projection depends only on the payload object and the visibility inputs of the model. Yet draw, minimap and status ask for it about 11 times per frame.
// Each call sorts every edge with localeCompare. Payloads are replaced, never mutated. So object identity is a valid cache key.
function cachedProjection(slot, build) {
  const cache = model[slot];
  if (cache
      && cache.graph === model.graph
      && cache.focusedId === model.focusedId
      && cache.includeSystem === model.includeSystem
      && cache.includeNonStoring === model.includeNonStoring) {
    return cache.projection;
  }
  const projection = build(model.graph, model);
  model[slot] = {
    graph: model.graph,
    focusedId: model.focusedId,
    includeSystem: model.includeSystem,
    includeNonStoring: model.includeNonStoring,
    projection,
  };
  return projection;
}

function logicalProjection() {
  return cachedProjection("logicalProjectionCache", buildLogicalProjection);
}

function storageProjection() {
  return cachedProjection("storageProjectionCache", buildStorageProjection);
}

function canUseStorageForId(id) {
  return canUseStorage(model.graph, id);
}

function isStorageRouteEdge(edge) {
  return storageRouteKind(edge, model.detailMode);
}

function canUseStorageForTable(database, table) {
  if (!model.graph) return null;
  const id = `table:${String(database || "")}.${String(table || "")}`;
  // A table from another database can be absent from the scoped graph. Absence does not prove that the table has no storage.
  // Return null, which means unknown. Explorer can then change the scope or the database and refresh the graph.
  // After that, Explorer evaluates the table in the new payload.
  const exists = (model.graph.nodes || []).some((node) => node.id === id && node.layer === "logical");
  if (!exists) return null;
  return canUseStorageForId(id);
}

// visibleNodes()/visibleEdges() run several times per animated frame, for edges, minimap, the animation check and the status.
// Memoise them on the projection object and the neighbourhood inputs. Callers must treat the returned arrays as read-only.
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
    // A payload that has exactly the scope of the current request (focus, depth and per-node expansions) is already the neighbourhood.
    // The client-side ring covers the time until a new focus or depth arrives.
    const exactScope = !!model.focusedId && model.graphRequestKey === graphRequestKey(scopeRequest(false));
    const logicalIds = exactScope || !model.focusedId || !model.graph ? null : neighborhoodIds(logicalProjection(), model.focusedId, model.focusDepth);
    if (logicalIds) nodes = projection.nodes.filter((node) => logicalIds.has(node.id));
    const ids = new Set(nodes.map((node) => node.id));
    edges = projection.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
    if (!model.focusedId) {
      const grouped = groupOverview(nodes, edges, model);
      ({ nodes, edges } = grouped);
      model.groupStats = grouped.stats;
    }
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

function visibleNodes() {
  const projection = visibleSet();
  return projection.nodes;
}

function visibleEdges() {
  return visibleSet().edges;
}

function computeLayout({ preserveExisting = false, preserveIds = null } = {}) {
  const { positions, bounds } = layoutNodes({
    nodes: visibleNodes(),
    edges: visibleEdges(),
    detailMode: model.detailMode,
    focus: currentFocusScope(),
    focusedId: model.focusedId,
    previousLayout: preserveExisting ? new Map(model.layout) : null,
    preserveIds,
  });
  model.layout = positions;
  model.routeJob?.cancel();
  model.routeJob = null;
  model.lineageRouteCache = null;
  // A layout that routes in a Worker starts at once. So the status shows "Routing edges" from the first frame.
  if (model.detailMode === "logical" && kit.routeEdgesJobWanted(visibleEdges().length)) ensureLineageRouteCache();
  model.worldBounds = bounds;
}

function focusedSet() {
  if (!model.focusedId) return null;
  return new Set(visibleNodes().map((node) => node.id));
}

function ensureLineageRouteCache() {
  if (model.detailMode !== "logical") return new Map();
  if (model.lineageRouteCache instanceof Map) return model.lineageRouteCache;
  const edges = visibleEdges().filter((edge) => !isStorageRouteEdge(edge));
  const options = { isSecondary: isLogicalDependencyEdge };
  // A large layout routes in a Worker. Until the Worker answers, the edges are drawn as curves and have no labels.
  // A placeholder stands for the routes, so the label cache stays valid. Then the routes replace the placeholder and the graph redraws.
  // A small layout routes here at once. So does a browser that has no Worker or no kernel.
  const layout = model.layout;
  const job = model.detailMode === "logical" ? kit.routeEdgesJob(layout, edges, options) : null;
  if (job) {
    const placeholder = new Map();
    model.lineageRouteCache = placeholder;
    model.routeJob = job;
    actions.updateStatus();
    const finish = (routes) => {
      if (model.lineageRouteCache !== placeholder) return;
      model.routeJob = null;
      model.lineageRouteCache = routes;
      actions.updateStatus();
      scheduleDraw();
    };
    job.promise.then((routes) => {
      if (model.lineageRouteCache !== placeholder) return;
      if (routes) return finish(routes);
      // The Worker could not route (it is absent, stopped, or failed). Route here, in slices on the main thread.
      // Do not route in one block. One block freezes the page for seconds on a large database.
      const run = kit.runSliced(kit.routeEdgesSteps(layout, edges, options));
      if (run.done) return finish(run.value);
      model.routeJob = run;
      run.promise.then((routed) => { if (routed) finish(routed); });
    });
    return placeholder;
  }
  model.lineageRouteCache = kit.routeEdges(model.layout, edges, { isSecondary: isLogicalDependencyEdge });
  return model.lineageRouteCache;
}

export { canUseStorageForId, canUseStorageForTable, computeLayout, ensureLineageRouteCache, focusedSet, isStorageRouteEdge, logicalProjection, scopeRequest, visibleEdges, visibleNodes };
