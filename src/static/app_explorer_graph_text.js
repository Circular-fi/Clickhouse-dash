// This module gives the text of the Explorer graph for a node and an edge.
// The text has the kind and the engine of a card, the size line, the TTL rules in short form, and the labels of an edge.
// This module is pure. It has no DOM and no canvas. See tests/frontend/model/explorer-graph-model.test.cjs. Counts and sizes come from ns.format.

import { ttlRules } from "./app_explorer_graph_model.js";
import { format } from "./app_format.js";

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
  // These are the ClickHouse engine names, as system.tables spells them.
  // An engine that has another spelling (lower case or with spaces) is returned in that spelling. Any other name is shown as sent.
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

function diskCapacitySummary(disk) {
  if (disk?.disk_free_space == null || disk?.disk_total_space == null) return "";
  const free = Number(disk.disk_free_space);
  const total = Number(disk.disk_total_space);
  const used = Math.max(0, total - free);
  const pct = total > 0 ? `${format.percent(used / total)} used` : `capacity ${format.EMPTY}`;
  return `${pct} · ${format.bytes(free)} free`;
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

// Card texts for each payload node. Each card is formatted on each frame. On large catalogs, this used most of the time in pan and zoom frames.
// The cache avoids this cost.
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

export { diskCapacitySummary, edgeLongLabel, edgeShortLabel, humanEngine, kindCode, nodeKindLabel, nodeSizeLabel, nodeTexts, ttlActionSummary, ttlBaseSummary, ttlEdgeLabelLines, ttlTimingSummary };
