// The focus of the Explorer graph and everything that changes it: a card clicked, a table or a database chosen in the tree, the depth, the
// expansions, the groups, the mode (Lineage | Storage), the visibility switches and the refresh from the server. It provides to the modules
// below what they call back (`actions`).

import { api } from "./app_api.js";
import { dom } from "./app_dom.js";
import { graphRequestKey, logicalFocusId, logicalNodeAllowed, requiredVisibility } from "./app_explorer_graph_model.js";
import { databaseBandHeader } from "./app_explorer_graph_nodes.js";
import { closePanel, openPanel, renderGraphChrome, renderPanel, selectGraphNode } from "./app_explorer_graph_panel.js";
import { canUseStorageForId, computeLayout, logicalProjection, scopeRequest, visibleEdges, visibleNodes } from "./app_explorer_graph_scene.js";
import { actions, currentFocusScope, model, scheduleDraw } from "./app_explorer_graph_store.js";
import { nodeKindLabel } from "./app_explorer_graph_text.js";
import { captureViewportAnchor, centerOnNode, databaseBounds, fitToScreen, nodeIsOnScreen, restoreViewportAnchor } from "./app_explorer_graph_viewport.js";
import { state } from "./app_state.js";
import { segmented } from "./app_ui_segmented.js";
import { util } from "./app_util.js";

const { byId } = dom;

function visibilityRequirements() {
  return requiredVisibility(model.graph, model.focusedId);
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

function describeNode(id) {
  const node = model.layout.get(id)?.node;
  if (!node) return "";
  if (node.kind === "database_group") return `${node.database}, collapsed database. Enter expands it.`;
  return `${node.name || node.label || node.id}, ${nodeKindLabel(node)}${node.database ? ` in ${node.database}` : ""}. Enter selects it.`;
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

function setFocus(id, center = false, { preserveDepth = true } = {}) {
  // Storage-topology nodes are implementation details of a logical object.
  // Keep the logical table/view as the neighbourhood anchor so selecting a
  // disk/replica/shard cannot accidentally expand back to the whole graph.
  const nextId = logicalFocusId(model.graph, model.focusedId, id);
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
    // The request in flight is already out of date: it stops, and the queued one runs when it ends.
    util.latest.cancel("explorer.graph");
    model.refreshQueued = true;
    model.refreshQueuedForce = model.refreshQueuedForce || !!force;
    model.refreshQueuedReflow = model.refreshQueuedReflow || !!reflow;
    return;
  }

  const hostId = String(state.selectedHostId || "");
  if (!hostId) return;
  const requestOptions = scopeRequest(force);
  const requestKey = graphRequestKey(requestOptions);
  const hadLayout = model.layout.size > 0;
  model.loading = true;
  updateStatus();
  scheduleDraw();
  try {
    const req = util.latest("explorer.graph");
    const payload = await api.getExplorerGraph(hostId, requestOptions, { signal: req.signal });
    const stale = !model.active
      || serial !== model.refreshSerial
      || String(state.selectedHostId || "") !== hostId
      || graphRequestKey(scopeRequest(false)) !== requestKey;
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
        segmented?.set(dom.explorerGraphTypeSelect, "logical");
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
      || graphRequestKey(scopeRequest(false)) !== requestKey;
    if (!stale && !util.isAbort(e)) {
      model.graph = null;
      model.lastError = util.errorText(e);
      model.layout.clear();
      if (dom.explorerGraphStatus) dom.explorerGraphStatus.textContent = util.errorText(e);
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
  segmented?.set(dom.explorerGraphTypeSelect, next);
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

function getRouteState() { return { mode: model.detailMode, depth: model.focusDepth }; }

function applyRouteState(route = {}) {
  const depth = Number(route.depth);
  if (Number.isFinite(depth)) model.focusDepth = Math.max(0, Math.min(8, Math.trunc(depth)));
  setDetailMode(route.mode === "physical" ? "physical" : "logical", { notify: false });
  syncFocusControls();
}

function isStorageMode() { return model.detailMode === "physical"; }

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
    if (node && !logicalNodeAllowed(node, model)) model.focusedId = null;
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

Object.assign(actions, { setFocus, setShowIsolated, syncFocusControls, toggleExpansion, updateStatus });

export { activate, applyRouteState, clickTarget, contractNeighborhood, deactivate, describeNode, expandNeighborhood, focusDatabase, focusTable, getRouteState, hoverTarget, isStorageMode, onHostChanged, onScopeChanged, refresh, searchFocus, setDetailMode, setVisibilityOptions, syncFocusControls, visibilityRequirements };
