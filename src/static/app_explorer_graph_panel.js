// The chrome of the Explorer graph inside its pane ("objects without dependencies" toggle) and the side panel of a node or an edge (a bottom sheet
// on phones): the definition, the columns, the neighbours and the TTL rules of a node, the object that defines an edge.

import { api } from "./app_api.js";
import { dom, h } from "./app_dom.js";
import { parseLogicalTableId, ttlRules } from "./app_explorer_graph_model.js";
import { visibleEdges, visibleNodes } from "./app_explorer_graph_scene.js";
import { actions, model, scheduleDraw } from "./app_explorer_graph_store.js";
import { edgeLongLabel, edgeShortLabel, humanEngine, nodeKindLabel, ttlBaseSummary } from "./app_explorer_graph_text.js";
import { centerOnNode } from "./app_explorer_graph_viewport.js";
import { format } from "./app_format.js";
import { graphKit } from "./app_graph_kit.js";
import { state } from "./app_state.js";
import { kv } from "./app_ui_kv.js";
import { sqlBlock as sqlBlockMod } from "./app_ui_sql.js";
import { util } from "./app_util.js";

const kit = graphKit;
const { $ } = dom;

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
  chrome.isolatedInput.addEventListener("change", () => actions.setShowIsolated(chrome.isolatedInput.checked));
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
  actions.updateStatus();
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
  actions.setFocus(node.id);
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

// The shared read-only SQL block (sqlBlock): copy, the first 16 lines
// and "Show all".
function sqlBlock(sql, truncated) {
  const wrap = h("div", { class: "explorerGraphPanel__sqlWrap" });
  wrap.append(sqlBlockMod({ sql, copy: true, maxLines: 16, wrap: true, label: "SELECT", className: "explorerGraphPanel__sql" }));
  if (truncated) wrap.append(h("p", { class: "graphKitPanel__note" }, "Truncated at 32 KB: the full text is in the object's DDL."));
  return wrap;
}

async function loadDefinition(node) {
  const hostId = String(state.selectedHostId || "");
  const key = `${hostId}\u0000${node.id}`;
  if (!model.definitionCache.has(key)) {
    // One read for each object, cut when the host changes (the slots of the Explorer start with "explorer.").
    const req = util.latest(`explorer.graphdef.${key}`);
    model.definitionCache.set(key, api.getExplorerGraphDefinition(hostId, node.database, node.name, { signal: req.signal }).catch((error) => {
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
    const req = util.latest(`explorer.graphcolumns.${key}`);
    model.columnsCache.set(key, api.getExplorerTable(hostId, node.database, node.name, false, { signal: req.signal }).then((detail) => (
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
    if (serial !== model.panelSerial || util.isAbort(error)) return;
    status.textContent = util.errorText(error);
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
    // The shared key / value list (kv.list): name, type (mono), copy.
    const limit = 40;
    container.append(kv.list(columns.slice(0, limit).map((column) => ({
      key: column.name, value: column.type, json: false, text: true, mono: true, actions: ["copy"],
    })), { className: "explorerGraphPanel__columns", label: "Columns" }));
    if (columns.length > limit) container.append(h("p", { class: "graphKitPanel__note" }, `${format.count(columns.length - limit)} more columns in the table card.`));
  }).catch((error) => {
    if (serial !== model.panelSerial || util.isAbort(error)) return;
    status.textContent = util.errorText(error);
  });
}

function neighborIds(id, direction) {
  const edges = visibleEdges().filter((edge) => !edge.aggregated);
  return [...new Set(edges.filter((edge) => (direction === "up" ? edge.to === id : edge.from === id))
    .map((edge) => (direction === "up" ? edge.from : edge.to)))];
}

function renderNodePanel(body, node) {
  body.append(kit.panelHeader({ eyebrow: nodeKindLabel(node), title: node.name, subtitle: node.database, onClose: closePanel }));

  const buttons = h("div", { class: "graphKitPanel__actions" });
  const open = h("button", { class: "button button--small explorerGraphPanel__openCard" }, "Open card");
  open.type = "button";
  open.id = "explorerGraphPanelOpenCard";
  open.addEventListener("click", () => {
    if (typeof model.openCard === "function") model.openCard(node.database, node.name);
  });
  buttons.append(open);
  body.append(buttons);

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
      more.addEventListener("click", () => actions.toggleExpansion(`${direction}\u0000${node.id}`));
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

export { buildGraphChrome, chrome, closePanel, openPanel, renderGraphChrome, renderPanel, selectGraphNode };
