// What a catalog entry is and how the Explorer names it (ARCH-F-155): the engine families, the size and the rows an object reports, the
// kind of a tree row, the groups of a catalog, the function categories. Pure: no DOM, no state (tests/frontend/model/explorer-summary.test.cjs).
// Numbers, sizes, percentages and instants come from ns.format (docs/ui-foundations.md): "120,064", "120.1K", "1.7 KB", "12.3%",
// EMPTY (\u2014) for an absent value.

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
  // Keep sidebar eligibility independent from the currently loaded graph so
  // changing databases cannot transiently grey valid tables. The catalog has
  // enough durable signals to classify every engine supported by the Storage
  // graph: MergeTree families, Log families, explicit disk/policy placement,
  // and Buffer as the one non-persistent routing exception. System* virtual
  // engines (for example system.columns / system.data_type_families) expose
  // none of these signals and are therefore visibly disabled in Storage.
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
  return labels[compact] || value || "metadata pending";
}

function isViewLikeSummary(summary) {
  const engine = String(summary?.engine || "").toLowerCase().replace(/[^a-z]/g, "");
  return engine === "view" || engine === "parameterizedview" || engine === "materializedview";
}

function functionKey(item) {
  return `${item.kind || "Function"}\0${item.name || ""}`;
}

// Category names come from system.functions.categories, with the kind
// ("Function", "Aggregate Function", "Table Function") as the backend
// fallback when a function has none. Fold the spelling variants into one
// group: "Aggregate Functions" + "Aggregate Function" -> "Aggregate",
// uncategorized plain functions -> "Other" (ClickHouse's own catch-all).
const FUNCTION_CATEGORY_LABELS = new Map([
  ["aggregate", "Aggregate"],
  ["table", "Table functions"],
  ["", "Other"],
  ["other", "Other"],
]);

function functionCategory(item) {
  let value = String(item?.category || "").trim();
  // system.functions.categories is represented as text by the native client
  // on some versions. Keep the first meaningful category for navigation.
  value = value.replace(/^\[|\]$/g, "").trim();
  const first = value.split(",").map((part) => part.trim().replace(/^['\"]|['\"]$/g, "")).find(Boolean) || "";
  const kind = String(item?.kind || "");
  const raw = first === kind ? "" : first;
  if (!raw && kind === "Aggregate Function") return "Aggregate";
  if (!raw && kind === "Table Function") return "Table functions";
  const key = raw.toLowerCase().replace(/\bfunctions?\b/g, "").replace(/\s+/g, " ").trim();
  return FUNCTION_CATEGORY_LABELS.get(key) || raw;
}

// Kind badge shown only where the group does not already say it.
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

// Functions most queries use, offered as shortcuts while nothing is
// selected (only those the server actually exposes are listed).
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

// Catalog payloads are replaced, never mutated in place, so their arrays are
// stable cache keys. renderTableList() runs on every search keystroke and
// previously re-filtered all tables and re-searched all summaries once per
// database (O(databases x tables)).
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

// Tree icon per object family: a sprite drawing (ns.icon) in the kind's colour.
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

// Right-aligned badge of a tree row: bytes only, the one unit of the
// column (on disk, or "RAM" for what Memory, Buffer and dictionaries hold
// in memory); rows and the rest are in the row's title. Nothing for
// objects that hold no data (views, MVs) or no measurable memory.
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
