// This module defines what a catalog entry is. It also defines how the Explorer names an entry (ARCH-F-155).
// The module covers the engine families, the size and the rows of an object, the kind of a tree row, the groups of a catalog, and the function categories.
// This module is pure. It has no DOM and no state (tests/frontend/model/explorer-summary.test.cjs).
// Numbers, sizes, percentages and instants come from ns.format (docs/ui-foundations.md). Examples: "120,064", "120.1K", "1.7 KB", "12.3%". EMPTY (\u2014) marks an absent value.

import { format } from "./app_format.js";

function finiteOrNull(value) {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function quoteIdent(value) {
  return `\`${String(value).replace(/`/g, "``")}\``;
}

function nonStoringSummary(table) {
  const key = engineKey(table);
  return key === "view" || key === "parameterizedview" || key === "materializedview" || key === "buffer";
}

function filterKindOf(table) {
  const key = engineKey(table);
  if (key === "dictionary") return "dict";
  if (key === "materializedview") return "mv";
  if (key === "view" || key === "parameterizedview") return "views";
  return "tables";
}

function isSystemDatabaseName(database) {
  return ["system", "information_schema", "INFORMATION_SCHEMA"].includes(String(database || ""));
}

function objectKind(table) {
  const engine = String(table?.engine || "").toLowerCase();
  if (engine === "view") return "View";
  if (engine === "materializedview" || engine === "materialized view") return "Materialized View";
  if (engine === "dictionary") return "Dictionary";
  return "Table";
}

function engineKey(summaryOrEngine) {
  const raw = typeof summaryOrEngine === "string" ? summaryOrEngine : summaryOrEngine?.engine;
  return String(raw || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isMergeTreeSummary(summary) { return engineKey(summary).includes("mergetree"); }
function isDictionarySummary(summary) { return engineKey(summary) === "dictionary"; }
function isMemorySummary(summary) { return engineKey(summary) === "memory"; }
function isBufferSummary(summary) { return engineKey(summary) === "buffer"; }
function isResidentMemorySummary(summary) {
  return isBufferSummary(summary) || isMemorySummary(summary) || isDictionarySummary(summary);
}
function isLogFamilySummary(summary) { return ["tinylog", "stripelog", "log"].includes(engineKey(summary)); }
function isDistributedSummary(summary) { return engineKey(summary) === "distributed"; }

function storageCatalogEligible(summary) {
  // Keep the sidebar eligibility independent of the loaded graph. So a change of database cannot disable valid tables for a moment.
  // The catalog has enough durable signals to classify every engine that the Storage graph supports.
  // These signals are: the MergeTree and Log families, explicit disk or policy placement, and Buffer. Buffer is the one non-persistent routing exception.
  // System* virtual engines (for example system.columns and system.data_type_families) have none of these signals. So they are disabled in Storage.
  if (!summary) return false;
  if (isBufferSummary(summary)) return true;
  if (isMergeTreeSummary(summary) || isLogFamilySummary(summary)) return true;
  if (String(summary.storage_policy || "").trim()) return true;
  if (Array.isArray(summary.disks) && summary.disks.length > 0) return true;
  return false;
}

function summaryFootprintBytes(summary) {
  if (!summary) return null;
  const raw = summary?.bytes != null
    ? summary.bytes
    : (isResidentMemorySummary(summary)
      ? summary.resident_bytes
      : (summary.logical_bytes ?? summary.compressed_bytes));
  if (raw == null) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function summaryRowsLabel(summary, { compact = false } = {}) {
  if (!summary || summary.rows == null) return null;
  const value = compact ? format.compact(summary.rows) : format.count(summary.rows);
  return isBufferSummary(summary) ? `${value} buffered rows` : `${value} rows`;
}

function sizeLabelForSummary(summary) {
  return isMergeTreeSummary(summary) ? "Compressed" : "Size";
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
  return labels[compact] || value || "metadata pending";
}

function isViewLikeSummary(summary) {
  const engine = String(summary?.engine || "").toLowerCase().replace(/[^a-z]/g, "");
  return engine === "view" || engine === "parameterizedview" || engine === "materializedview";
}

function functionKey(item) {
  return `${item.kind || "Function"}\0${item.name || ""}`;
}

// The category names come from system.functions.categories. The kind is the backend fallback, when a function has no category.
// The kind is "Function", "Aggregate Function" or "Table Function".
// Fold the spelling variants into one group. For example, "Aggregate Functions" and "Aggregate Function" become "Aggregate".
// Plain functions without a category go to "Other". This is the ClickHouse catch-all.
const FUNCTION_CATEGORY_LABELS = new Map([
  ["aggregate", "Aggregate"],
  ["table", "Table functions"],
  ["", "Other"],
  ["other", "Other"],
]);

function functionCategory(item) {
  let value = String(item?.category || "").trim();
  // Some versions of the native client send system.functions.categories as text. Keep the first meaningful category for navigation.
  value = value.replace(/^\[|\]$/g, "").trim();
  const first = value.split(",").map((part) => part.trim().replace(/^['\"]|['\"]$/g, "")).find(Boolean) || "";
  const kind = String(item?.kind || "");
  const raw = first === kind ? "" : first;
  if (!raw && kind === "Aggregate Function") return "Aggregate";
  if (!raw && kind === "Table Function") return "Table functions";
  const key = raw.toLowerCase().replace(/\bfunctions?\b/g, "").replace(/\s+/g, " ").trim();
  return FUNCTION_CATEGORY_LABELS.get(key) || raw;
}

// The kind badge shows only where the group does not already show the kind.
function functionKindBadge(item, category) {
  if (item?.user_defined) return "UDF";
  if (item?.kind === "Aggregate Function" && category !== "Aggregate") return "aggregate";
  if (item?.kind === "Table Function" && category !== "Table functions") return "table";
  return "";
}

function functionOrigin(item) {
  if (item?.user_defined) return "User-defined";
  const origin = String(item?.origin || "System").trim();
  return origin || "System";
}

function uniqueMetaBits(values) {
  const seen = new Set();
  const out = [];
  for (const raw of values) {
    const value = String(raw || "").trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

// These functions are used by most queries. They are shortcuts while nothing is selected. Only the functions that the server exposes are listed.
const POPULAR_FUNCTIONS = [
  "count", "sum", "avg", "uniq", "quantile", "argMax", "groupArray", "countIf",
  "if", "multiIf", "toDate", "toStartOfInterval", "formatDateTime", "dateDiff",
  "arrayJoin", "arrayMap", "has", "JSONExtract", "splitByChar", "replaceRegexpAll",
];

function validCatalogTime(value) {
  const text = String(value || "").trim();
  return text && !text.startsWith("1970-01-01") ? text : null;
}

function healthLabel(table) {
  const health = String(table?.health || "healthy");
  return health === "error" ? "Error" : health === "warning" ? "Warning" : "Healthy";
}

// Catalog payloads are replaced, never mutated in place. So their arrays are stable cache keys.
// renderTableList() runs on every search keystroke. Before this cache, it filtered all tables and searched all summaries once for each database.
// The cost was O(databases x tables).
const catalogTablesByDatabase = new WeakMap();
const catalogSummaryByDatabase = new WeakMap();
function tablesByDatabase(tables) {
  let grouped = catalogTablesByDatabase.get(tables);
  if (grouped) return grouped;
  grouped = new Map();
  for (const table of tables) {
    if (!grouped.has(table.database)) grouped.set(table.database, []);
    grouped.get(table.database).push(table);
  }
  catalogTablesByDatabase.set(tables, grouped);
  return grouped;
}
function summaryByDatabase(summaries) {
  let byName = catalogSummaryByDatabase.get(summaries);
  if (byName) return byName;
  byName = new Map();
  for (const item of summaries) {
    // Keep the first match, as the former .find() did.
    const name = String(item?.name || "");
    if (!byName.has(name)) byName.set(name, item);
  }
  catalogSummaryByDatabase.set(summaries, byName);
  return byName;
}

// The tree icon of each object family. The icon is a sprite image (ns.icon) in the color of the kind.
const TREE_KINDS = {
  table: { icon: "table", label: "Table" },
  distributed: { icon: "table-share", label: "Distributed table" },
  buffer: { icon: "stack", label: "Buffer" },
  memory: { icon: "cpu", label: "Memory table" },
  view: { icon: "eye", label: "View" },
  mv: { icon: "eye-table", label: "Materialized view" },
  dict: { icon: "vocabulary", label: "Dictionary" },
};

function treeKind(table) {
  const key = engineKey(table);
  if (key === "dictionary") return "dict";
  if (key === "materializedview") return "mv";
  if (key === "view" || key === "parameterizedview") return "view";
  if (key === "distributed") return "distributed";
  if (key === "buffer") return "buffer";
  if (key === "memory") return "memory";
  return "table";
}

function barPercent(value, max) {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0 || !(max > 0)) return 0;
  const pct = Math.min(100, (v / max) * 100);
  return pct < 1 ? 0 : pct;
}

// The right-aligned badge of a tree row shows bytes only. Bytes are the one unit of the column.
// The bytes are on disk, or "RAM" for the data that Memory, Buffer and dictionaries hold in memory.
// The rows and the other values are in the title of the row. The badge is empty for objects that hold no data (views and MVs).
// It is also empty for objects with no measurable memory.
function treeBadge(table) {
  const footprint = summaryFootprintBytes(table);
  const resident = isResidentMemorySummary(table);
  if (footprint != null && (footprint > 0 || (!resident && !isViewLikeSummary(table)))) {
    return { text: resident ? `${format.bytes(footprint)} RAM` : format.bytes(footprint), value: footprint };
  }
  return null;
}

function treeObjectTitle(table) {
  const footprint = summaryFootprintBytes(table);
  const bits = [humanEngine(table.engine)];
  const rows = summaryRowsLabel(table);
  if (rows) bits.push(rows);
  if (footprint != null) bits.push(isResidentMemorySummary(table) ? `${format.bytes(footprint)} in memory` : `${format.bytes(footprint)} on disk`);
  const health = String(table.health || "healthy");
  if (health !== "healthy") bits.push(healthLabel(table));
  return `${table.database}.${table.name}\n${bits.join(" · ")}`;
}

export { POPULAR_FUNCTIONS, TREE_KINDS, barPercent, engineKey, filterKindOf, functionCategory, functionKey, functionKindBadge, functionOrigin, healthLabel, humanEngine, isDictionarySummary, isDistributedSummary, isLogFamilySummary, isMergeTreeSummary, isResidentMemorySummary, isSystemDatabaseName, isViewLikeSummary, nonStoringSummary, objectKind, quoteIdent, storageCatalogEligible, summaryByDatabase, summaryFootprintBytes, summaryRowsLabel, tablesByDatabase, treeBadge, treeKind, treeObjectTitle, uniqueMetaBits, validCatalogTime };
