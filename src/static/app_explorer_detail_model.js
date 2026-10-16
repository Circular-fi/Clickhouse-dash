// This is the pure part of the table card (ARCH-F-127). It gives the data that the table card shows for a detail payload.
// The data covers these parts: the SQL expressions of the card, the rows of the Columns tab, and the split of the storage.
// It also covers the tabs of an object, the sections of Operations and the SELECT of the preview. The SQL expressions cover keys, defaults, codecs and TTL.
// This file has no DOM and no state. The test is tests/frontend/model/explorer-detail-model.test.cjs.
// Numbers, sizes and percentages come from ns.format (docs/ui-foundations.md). EMPTY marks an absent value.

import { humanEngine, isDictionarySummary, isDistributedSummary, isLogFamilySummary, isMergeTreeSummary, isViewLikeSummary, quoteIdent, summaryFootprintBytes } from "./app_explorer_summary.js";
import { format } from "./app_format.js";
import { sqlLex } from "./app_sql_lex.js";

const DASH = format.EMPTY;
const PREVIEW_LIMITS = [50, 100, 500];

// ---- SQL expressions of the card (keys, defaults, codecs, TTL) -----------
//
// These pure helpers are also exported for the harness unit test (tests/harness/explorer_card_unit.js).

const OPENERS = { "(": ")", "[": "]", "{": "}" };
const CLOSERS = new Set([")", "]", "}"]);

// Returns the index just past a quoted run that starts at text[at] (' " or `).
// The text comes from the server (the DDL of a table). The code reads it with the rules of ClickHouse.
// In ClickHouse, a backslash escapes the next character. A doubled quote is the quote in a name, as in a string.
// The one SQL lexer (app_sql_lex.js) finds the spans with { clickhouse: true }.
function skipQuoted(text, at) {
  return sqlLex.spanAt(text, at, true)[1];
}

// Returns the index of the bracket that closes text[open], or -1.
function matchingClose(text, open) {
  const stack = [];
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "'" || ch === "\"" || ch === "`") { i = skipQuoted(text, i) - 1; continue; }
    if (OPENERS[ch]) stack.push(OPENERS[ch]);
    else if (CLOSERS.has(ch)) {
      if (stack.pop() !== ch) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

// Returns the top-level comma-separated elements. Commas inside parentheses, brackets, braces, strings and quoted identifiers do not split an element.
function splitTopLevel(text) {
  return sqlLex.splitTopLevel(text, ",", { brackets: true, clickhouse: true }).map((part) => part.text);
}

// Returns the elements of a key (ORDER BY, PRIMARY KEY, PARTITION BY, SAMPLE BY), in key order.
// Example: "service, toStartOfHour(ts)" -> ["service", "toStartOfHour(ts)"].
// One pair of parentheses, or tuple(...), around the whole key is the tuple itself. tuple() is an empty key.
function keyElements(expression) {
  let text = String(expression || "").trim();
  for (;;) {
    const call = text.match(/^tuple\s*\(/i);
    const open = call ? call[0].length - 1 : (text.startsWith("(") ? 0 : -1);
    if (open < 0 || matchingClose(text, open) !== text.length - 1) break;
    text = text.slice(open + 1, -1).trim();
  }
  return splitTopLevel(text);
}

// Returns the identifiers that an expression reads. It does not return the functions that the expression calls, or its strings.
// Examples: `a b`, "x", plain names and dotted names (n.key).
function expressionIdentifiers(expression) {
  const text = String(expression || "");
  const names = new Set();
  for (let i = 0; i < text.length;) {
    const ch = text[i];
    if (ch === "'") { i = skipQuoted(text, i); continue; }
    if (ch === "`" || ch === "\"") {
      const end = skipQuoted(text, i);
      names.add(text.slice(i + 1, end - 1).split(ch + ch).join(ch));
      i = end;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(text.slice(i));
    if (word && (i === 0 || !/[A-Za-z0-9_.]/.test(text[i - 1]))) {
      const after = text.slice(i + word[0].length).match(/^\s*\(/);
      if (!after) names.add(word[0]);
      i += word[0].length;
      continue;
    }
    i += 1;
  }
  return names;
}

// Returns the positions (0-based) of the key elements that read a column.
// A subcolumn (n.key) counts for its column n.
function keyColumnPositions(expression, column) {
  const name = String(column || "");
  if (!name) return [];
  const positions = [];
  keyElements(expression).forEach((element, index) => {
    for (const identifier of expressionIdentifiers(element)) {
      if (identifier === name || identifier.startsWith(`${name}.`)) { positions.push(index); break; }
    }
  });
  return positions;
}

// engine_full has this form: "Engine(args) PARTITION BY ... ORDER BY ... TTL ... SETTINGS a = 1, b = 'x'".
// The arguments and the settings are the parts that no other tile shows.
function engineArguments(summary) {
  const full = String(summary.engine_full || "").trim();
  const engine = String(summary.engine || "");
  if (!engine || !full.startsWith(engine)) return "";
  const open = engine.length;
  if (full[open] !== "(") return "";
  const close = matchingClose(full, open);
  if (close < 0) return "";
  const args = full.slice(open + 1, close).trim();
  return args ? `${engine}(${args})` : "";
}

function engineSettingsOf(summary) {
  const full = String(summary.engine_full || "");
  // Returns the last top-level SETTINGS clause. Strings can hold the word too.
  let at = -1;
  for (let i = 0; i < full.length; i += 1) {
    const ch = full[i];
    if (ch === "'" || ch === "\"" || ch === "`") { i = skipQuoted(full, i) - 1; continue; }
    if ((i === 0 || /\s/.test(full[i - 1])) && /^SETTINGS\s/i.test(full.slice(i, i + 9))) at = i;
  }
  return at < 0 ? [] : splitTopLevel(full.slice(at + 8));
}

function optionalNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function percentValue(value, total) {
  const v = Number(value);
  const t = Number(total);
  if (!Number.isFinite(v) || !Number.isFinite(t) || t <= 0) return null;
  return Math.max(0, Math.min(100, (v / t) * 100));
}

function sectionUnavailable(detail, name) {
  const unavailable = new Set(detail?.unavailable_sections || []);
  return unavailable.has(name);
}

function visibleDependencies(detail) {
  return (detail?.dependencies || []).filter((d) => !/^_?row$/i.test(String(d.table || "")));
}

function isEmptyRowSummary(summary) {
  return optionalNumber(summary?.rows) === 0;
}

function ratioLabel(uncompressed, compressed) {
  const u = optionalNumber(uncompressed);
  const c = optionalNumber(compressed);
  if (u == null || c == null || c <= 0 || u <= 0) return null;
  const ratio = u / c;
  return `${ratio >= 10 ? ratio.toFixed(0) : ratio.toFixed(1)}\u00d7`;
}

// Shares use a 0-100 scale for the bars. ns.format.percent takes a ratio instead.
function percentText(value) {
  return value == null ? DASH : format.percent(Number(value) / 100);
}

function columnMax(items, read) {
  let max = 0;
  for (const item of items) {
    const n = optionalNumber(read(item));
    if (n != null && Math.abs(n) > max) max = Math.abs(n);
  }
  return max;
}

function objectType(engine) {
  const key = String(engine || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (key === "materializedview") return "mv";
  if (key === "view" || key === "parameterizedview" || key === "liveview" || key === "windowview") return "view";
  if (key === "dictionary") return "dictionary";
  if (key === "buffer") return "buffer";
  if (key === "distributed") return "distributed";
  if (!key) return "unknown";
  return "table";
}

function shortName(database, table, contextDatabase) {
  return String(database || "") === String(contextDatabase || "") ? String(table || "") : `${database}.${table}`;
}

const DEPENDENCY_KINDS = {
  materialized_view: ["MV", "Materialized View trigger / target"],
  view: ["View", "View reads this object at query time"],
  buffer: ["Buffer", "Buffer flushes into its destination table"],
  distributed_route: ["Route", "Distributed routes reads and writes to this local table on every shard"],
  dependency: ["", "Dependency recorded by ClickHouse"],
};

function extractTableTtl(detail) {
  if (detail?.table_ttl) return String(detail.table_ttl);
  const ddl = String(detail?.formatted_ddl || detail?.ddl || "");
  if (!ddl) return "";
  const match = ddl.match(/(?:^|\n)TTL\s+([\s\S]*?)(?=\n(?:SETTINGS|COMMENT|AS\s+SELECT|POPULATE|EMPTY\s+AS)\b|;?\s*$)/i);
  return match ? String(match[1] || "").trim().replace(/\s+/g, " ") : "";
}

// Example: "observed_at + toIntervalDay(30) RECOMPRESS CODEC(ZSTD(3))" ->
// "observed_at + 30 d -> RECOMPRESS ZSTD(3)". A bare rule deletes the data.
// The two sides around the arrow are coloured as SQL (ttlRuleEl).
function prettyTtlParts(rule) {
  const units = { Second: "s", Minute: "min", Hour: "h", Day: "d", Week: "w", Month: "mo", Quarter: "q", Year: "y" };
  let text = String(rule || "").replace(/toInterval(Second|Minute|Hour|Day|Week|Month|Quarter|Year)\((\d+)\)/g, (_, unit, n) => `${n} ${units[unit]}`);
  text = text.replace(/INTERVAL\s+(\d+)\s+(SECOND|MINUTE|HOUR|DAY|WEEK|MONTH|QUARTER|YEAR)S?\b/gi, (_, n, unit) => `${n} ${units[unit.charAt(0) + unit.slice(1).toLowerCase()]}`);
  const action = text.match(/\s+(RECOMPRESS|TO\s+VOLUME|TO\s+DISK|DELETE|GROUP\s+BY)\b([\s\S]*)$/i);
  if (!action) return [text.trim(), "DELETE"];
  const base = text.slice(0, action.index).trim();
  let rest = `${action[1].toUpperCase().replace(/\s+/g, " ")}${action[2]}`.trim();
  rest = rest.replace(/^RECOMPRESS\s+CODEC\(([\s\S]*)\)$/i, "RECOMPRESS $1");
  return [base, rest];
}

function isImplementationSubcolumn(column) {
  if (!column?.is_subcolumn) return false;
  return /(?:^|\.)(?:size|size\d+)$/i.test(String(column.name || ""));
}

// Returns [badge text, title, kind] for each key that a column is part of. The result includes the position or positions in the key.
// Example: "ORDER BY · 0". The About > Keys list shows them.
function columnKeyBadges(column, summary) {
  const badges = [];
  const pk = String(summary?.primary_key || "");
  const pkDiffers = !!pk && pk !== String(summary?.sorting_key || "");
  const badge = (flag, label, kind, expression, what) => {
    if (!flag) return;
    const positions = keyColumnPositions(expression, column.name);
    const at = positions.length ? ` \u00b7 ${positions.join(", ")}` : "";
    const title = positions.length
      ? `${positions.length > 1 ? "Positions" : "Position"} ${positions.join(", ")} in ${what}`
      : `Part of ${what}`;
    badges.push([`${label}${at}`, title, kind]);
  };
  badge(column.is_in_sorting_key, "ORDER BY", "order-by", summary?.sorting_key, "the sorting key (ORDER BY)");
  badge(column.is_in_primary_key && (pkDiffers || !column.is_in_sorting_key), "PK", "pk", summary?.primary_key, "the primary key (sparse index)");
  badge(column.is_in_partition_key, "PARTITION", "partition", summary?.partition_key, "the partition key (PARTITION BY)");
  badge(column.is_in_sampling_key, "SAMPLE", "sample", summary?.sampling_key, "the sampling key (SAMPLE BY)");
  return badges;
}

// "CODEC(Delta(8), ZSTD(1))" -> "Delta(8), ZSTD(1)".
function shortCodec(codec) {
  const text = String(codec || "").trim();
  const match = text.match(/^CODEC\(([\s\S]*)\)$/i);
  return match ? match[1].trim() : text;
}

function columnRows(detail) {
  const tableFootprint = summaryFootprintBytes(detail.summary || {});
  const observedDefaults = (detail.default_compression_codecs || []).map((value) => String(value || "").trim()).filter(Boolean);
  // The codec appears as SQL. A note appears when the codec is the default of the table.
  const defaultCodec = !isMergeTreeSummary(detail.summary)
    ? ["", ""]
    : observedDefaults.length === 1
      ? [observedDefaults[0], "default"]
      : observedDefaults.length > 1
        ? [observedDefaults.join(" / "), "part defaults"]
        : ["DEFAULT", ""];
  const allColumns = Array.isArray(detail.columns) ? detail.columns : [];
  const visibleColumns = allColumns.filter((column) => !isImplementationSubcolumn(column));
  // A storage Tuple hierarchy is not limited to a top-level Tuple(...).
  // Array(Tuple(...)) and deeper Array wrappers show the same named physical subcolumns. They use the same disclosure control.
  const tupleRoots = allColumns
    .filter((column) => !column?.is_subcolumn && /Tuple\s*\(/i.test(String(column?.type || "")))
    .map((column) => String(column.name || ""))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const implementationByRoot = new Map();
  for (const c of allColumns) {
    if (!isImplementationSubcolumn(c)) continue;
    const name = String(c.name || "");
    const root = tupleRoots.find((candidate) => name.startsWith(`${candidate}.`));
    if (!root) continue;
    if (!implementationByRoot.has(root)) implementationByRoot.set(root, []);
    implementationByRoot.get(root).push(c);
  }

  let topLevelColumnPosition = 0;
  const rows = [];
  for (const c of visibleColumns) {
    const compressed = optionalNumber(c.compressed_bytes);
    const uncompressed = optionalNumber(c.uncompressed_bytes);
    const name = String(c.name || DASH);
    const tupleParent = c.is_subcolumn ? (tupleRoots.find((root) => name.startsWith(`${root}.`)) || null) : null;
    const tupleRoot = tupleRoots.includes(name) ? name : null;
    rows.push({
      position: c.is_subcolumn ? null : ++topLevelColumnPosition,
      name,
      type: String(c.type || ""),
      default_kind: String(c.default_kind || ""),
      default_expression: String(c.default_expression || ""),
      ttl_expression: String(c.ttl_expression || ""),
      comment: String(c.comment || ""),
      keys: c.is_subcolumn ? [] : columnKeyBadges(c, detail.summary),
      codec: shortCodec(c.codec) || defaultCodec[0],
      codec_note: shortCodec(c.codec) ? "" : defaultCodec[1],
      explicit_codec: !!c.codec && !c.is_subcolumn,
      compressed,
      uncompressed,
      percent: compressed == null ? null : percentValue(compressed, tableFootprint),
      is_subcolumn: !!c.is_subcolumn,
      tuple_root: tupleRoot,
      tuple_parent: tupleParent,
    });

    // size0 and sizeN are real on-disk Array offset streams. Do not show the implementation names in the UI.
    // Count their bytes as one explicit physical child. So the children add up to the parent.
    if (tupleRoot) {
      const implementation = implementationByRoot.get(tupleRoot) || [];
      if (implementation.length) {
        const compressedValues = implementation.map((item) => optionalNumber(item.compressed_bytes)).filter((value) => value != null);
        const uncompressedValues = implementation.map((item) => optionalNumber(item.uncompressed_bytes)).filter((value) => value != null);
        const implementationCompressed = compressedValues.length ? compressedValues.reduce((sum, value) => sum + value, 0) : null;
        const implementationUncompressed = uncompressedValues.length ? uncompressedValues.reduce((sum, value) => sum + value, 0) : null;
        rows.push({
          position: null,
          name: `${tupleRoot}.[offsets]`,
          type: `Physical Array offset stream${implementation.length === 1 ? "" : "s"}: ${implementation.map((item) => item.name).join(", ")}`,
          default_kind: "",
          default_expression: "",
          ttl_expression: "",
          comment: "",
          keys: [],
          codec: shortCodec(c.codec) || defaultCodec[0],
          codec_note: shortCodec(c.codec) ? "" : defaultCodec[1],
          compressed: implementationCompressed,
          uncompressed: implementationUncompressed,
          percent: implementationCompressed == null ? null : percentValue(implementationCompressed, tableFootprint),
          is_subcolumn: true,
          tuple_root: null,
          tuple_parent: tupleRoot,
        });
      }
    }
  }
  return rows;
}

// The column sizes appear as a treemap (app_explorer_treemap.js).
// The treemap shows the top-level columns, in compressed or uncompressed bytes. A segmented switch selects the mode. The switch keeps this mode for the session.
// The columns are coloured by type family. The treemap is drawn when three columns or more hold >= 1% of the table's column bytes.
const COLUMN_MEASURES = [
  { value: "compressed", label: "Compressed", measure: "Compressed bytes of the column data (local replica)" },
  { value: "uncompressed", label: "Uncompressed", measure: "Uncompressed bytes of the column data (local replica)" },
];

function columnSizeTree(detail, rows, measure) {
  const s = detail.summary || {};
  const path = `${s.database || ""}.${s.name || ""}`;
  const children = rows
    .filter((row) => !row.is_subcolumn && Number(row[measure]) > 0)
    .map((row) => ({ kind: "column", name: row.name, path, type: row.type, bytes: Number(row[measure]), count: 1 }));
  return { kind: "server", name: path, path, bytes: children.reduce((sum, child) => sum + child.bytes, 0), count: children.length, children };
}

function structureCompressedBytes(detail, prefix, summaryValue) {
  const fromSummary = optionalNumber(summaryValue);
  if (fromSummary != null) return fromSummary;
  const matching = (detail.indexes_and_projections || []).filter((item) => String(item.kind || "").startsWith(prefix));
  if (!matching.length) return 0;
  let total = 0;
  for (const item of matching) {
    const value = optionalNumber(item.compressed_bytes);
    if (value == null) return null;
    total += value;
  }
  return total;
}

function structureOnDiskBytes(detail, prefix) {
  const matching = (detail.indexes_and_projections || []).filter((item) => String(item.kind || "").startsWith(prefix));
  if (!matching.length) return 0;
  let total = 0;
  for (const item of matching) {
    const value = optionalNumber(item.on_disk_bytes);
    if (value == null) return null;
    total += value;
  }
  return total;
}

function storageComposition(detail) {
  const storage = detail.column_storage || {};
  const footprint = summaryFootprintBytes(detail.summary || {});
  const wideParts = Number(storage.wide_parts || 0);
  const compactParts = Number(storage.compact_parts || 0);
  const rawWide = wideParts > 0 ? optionalNumber(storage.wide_on_disk_bytes) : (compactParts > 0 ? 0 : null);
  const rawCompact = compactParts > 0 ? optionalNumber(storage.compact_on_disk_bytes) : (wideParts > 0 ? 0 : null);
  const projectionBytes = structureOnDiskBytes(detail, "projection:");
  // ClickHouse exposes the compressed bytes of skipping indexes. It has no separate bytes_on_disk counter for them.
  // Count these known index files explicitly. All other parent-part overhead stays in the Wide/Compact base footprint.
  const indexBytes = structureCompressedBytes(detail, "index:", detail.summary?.secondary_indices_bytes);

  const known = [footprint, rawWide, rawCompact, projectionBytes, indexBytes].every((value) => value != null);
  if (!known || footprint <= 0) return { known: false, footprint, items: [] };

  const structureBytes = projectionBytes + indexBytes;
  if (structureBytes < 0 || structureBytes > footprint) return { known: false, footprint, items: [] };
  const baseBytes = footprint - structureBytes;
  const rawBase = rawWide + rawCompact;
  if (baseBytes > 0 && rawBase <= 0) return { known: false, footprint, items: [] };

  let wideBytes = 0;
  let compactBytes = 0;
  if (baseBytes > 0) {
    if (wideParts > 0 && compactParts <= 0) {
      wideBytes = baseBytes;
    } else if (compactParts > 0 && wideParts <= 0) {
      compactBytes = baseBytes;
    } else {
      // Allocate the reconciled parent-part residual with the exact bytes_on_disk ratio of the Wide and Compact active parts.
      // Use one side as the arithmetic remainder. So the four categories give an exact sum for the table's bytes_on_disk footprint.
      // The sum is not an approximation.
      wideBytes = baseBytes * (rawWide / rawBase);
      compactBytes = baseBytes - wideBytes;
    }
  }

  const rawItems = [
    ["Wide", wideBytes, "wide"],
    ["Compact", compactBytes, "compact"],
    ["Projections", projectionBytes, "projection"],
    ["Indexes", indexBytes, "index"],
  ];
  return {
    known: true,
    footprint,
    items: rawItems.map(([label, bytes, variant]) => ({
      label,
      bytes,
      variant,
      percent: (bytes / footprint) * 100,
    })),
  };
}

// Partitions: the code draws a treemap when three or more partitions hold >= 1% of the table.
// Then it draws the list, largest first. The list shows the share of the table for each partition.
function partitionTree(detail) {
  const s = detail.summary || {};
  const path = `${s.database || ""}.${s.name || ""}`;
  const children = (detail.partitions || []).map((p) => ({
    kind: "partition",
    name: p.partition === "" ? "(no partition)" : String(p.partition),
    path,
    database: s.database,
    table: s.name,
    engine: humanEngine(s.engine),
    rows: p.rows == null ? null : Number(p.rows),
    bytes: Number(p.bytes || 0),
    count: 1,
  }));
  return { kind: "server", name: path, path, bytes: children.reduce((sum, child) => sum + child.bytes, 0), count: children.length, children };
}

function structureItems(detail, prefix) {
  const tableFootprint = summaryFootprintBytes(detail.summary || {});
  return (detail.indexes_and_projections || [])
    .filter((item) => String(item.kind || "").startsWith(prefix))
    .map((item) => {
      const compressed = optionalNumber(item.compressed_bytes);
      return {
        name: item.name || DASH,
        type: String(item.kind || "").slice(prefix.length) || "unknown",
        expression: item.expression || "",
        compressed,
        uncompressed: optionalNumber(item.uncompressed_bytes),
        percent: compressed == null ? null : percentValue(compressed, tableFootprint),
      };
    });
}

function ingestionState(summary) {
  const client = summary.client_ingress || {};
  const physical = summary.physical_ingress || {};
  const keys = ["rows_per_second_1m", "rows_per_second_5m", "rows_per_second_1h", "bytes_per_second_1m", "bytes_per_second_5m", "bytes_per_second_1h"];
  const values = [...keys.map((key) => optionalNumber(client[key])), ...keys.map((key) => optionalNumber(physical[key]))];
  if (values.every((value) => value == null)) return "unavailable";
  return values.some((value) => value != null && value > 0) ? "active" : "idle";
}

function aggregatePreviewColumn(column) {
  if (!column) return false;
  if (column.finalized_for_preview === true) return true;
  return /^AggregateFunction\s*\(/i.test(String(column.type || "").trim());
}

// This list gives the sections of the Operations tab, without their renderers. app_explorer_detail_operations.js adds the renderers.
// For each section, the list gives what the section says, and whether the section has anything to show.
function operationSectionList(detail) {
  const s = detail.summary || {};
  const r = s.replication || {};
  const merges = detail.merges || [];
  const mutations = detail.mutations || [];
  const pending = mutations.filter((m) => !m.done).length;
  const queue = detail.replication_queue || [];
  const mergeTree = isMergeTreeSummary(s);
  const distributed = isDistributedSummary(s);
  const ingestion = ingestionState(s);
  return [
    r.available && {
      id: "replication", title: "Replication", hasData: true, note: `${format.count(r.active_replicas)}/${format.count(r.total_replicas)} active`,
    },
    r.available && {
      id: "replication_queue", title: "Replication queue", count: queue.length, hasData: queue.length > 0,
      emptyText: sectionUnavailable(detail, "replication_queue") ? "Replication queue unavailable" : "Replication queue empty",
    },
    mergeTree && {
      id: "merges", title: "Active merges", count: merges.length, hasData: merges.length > 0,
      emptyText: sectionUnavailable(detail, "merges") ? "Merge metadata unavailable" : "No active merges",
    },
    mergeTree && {
      id: "mutations", title: "Mutations", count: mutations.length, hasData: mutations.length > 0, note: pending ? `${format.count(pending)} pending` : "",
      emptyText: sectionUnavailable(detail, "mutations") ? "Mutation metadata unavailable" : "No mutations",
    },
    !distributed && {
      id: "ingestion", title: "Ingestion", hasData: ingestion === "active",
      emptyText: ingestion === "unavailable" ? "Write activity unavailable (query_log / part_log)" : "No writes in the last 1 h",
    },
    distributed && {
      id: "distribution_queue", title: "Distribution queue", count: (detail.distribution_queue || []).length,
      hasData: (detail.distribution_queue || []).length > 0,
      emptyText: sectionUnavailable(detail, "distribution_queue") ? "Distribution queue unavailable" : "Distribution queue empty",
    },
    distributed && {
      id: "cluster", title: detail.distributed?.cluster ? `Cluster ${detail.distributed.cluster}` : "Cluster",
      count: (detail.topology || []).length, hasData: (detail.topology || []).length > 0,
      emptyText: sectionUnavailable(detail, "topology") ? "Cluster topology unavailable" : "No cluster members resolved",
    },
  ].filter(Boolean);
}

// The Operations tab appears when one of its sections has something to show.
// Otherwise, the About panel shows the one-line idle summary.
function hasOperations(detail) {
  const summary = detail?.summary || {};
  if (isViewLikeSummary(summary) || isDictionarySummary(summary)) return false;
  if (detail?._loading) return true;
  return operationSectionList(detail).some((item) => item.hasData);
}

// The tabs of the card that an object has. A tab without content is hidden.
function availableTabs(detail) {
  const summary = detail?.summary || {};
  const loading = !!detail?._loading;
  const viewLike = isViewLikeSummary(summary);
  const empty = isEmptyRowSummary(summary);
  const tabs = ["Columns"];
  // An empty table has nothing to preview. It also has nothing to inspect physically.
  if (!viewLike && !empty) tabs.push("Preview");
  if (!empty && (isMergeTreeSummary(summary) || isLogFamilySummary(summary))) tabs.push("Storage");
  if (!empty && hasOperations(detail)) tabs.push("Operations");
  if (loading || visibleDependencies(detail).length) tabs.push("Lineage");
  if (loading || detail?.ddl) tabs.push("DDL");
  return tabs;
}

// The preview opens a SELECT in Query. The SELECT has every column of the table. An aggregate state goes through finalizeAggregation.
// The SELECT also has the limit of the preview. `previewColumns` are the columns that the preview answered with.
function buildPreviewSelectSql(detail, previewColumns, limit) {
  const s = detail?.summary || {};
  const previewByName = new Map(
    (previewColumns || []).map((column) => [String(column?.name || ""), column]),
  );
  const columns = (detail?.columns || []).filter((column) => column?.is_subcolumn !== true);
  const projection = columns.map((column) => {
    const name = String(column?.name || "");
    const quoted = quoteIdent(name);
    const previewColumn = previewByName.get(name);
    return aggregatePreviewColumn(previewColumn || column)
      ? `finalizeAggregation(${quoted}) AS ${quoted}`
      : quoted;
  });
  return `SELECT ${projection.length ? projection.join(", ") : "*"}\nFROM ${quoteIdent(s.database)}.${quoteIdent(s.name)}\nLIMIT ${limit}`;
}

export {
  COLUMN_MEASURES, DASH, DEPENDENCY_KINDS, PREVIEW_LIMITS, aggregatePreviewColumn, availableTabs, buildPreviewSelectSql, columnKeyBadges, columnMax,
  columnRows, columnSizeTree, engineArguments, engineSettingsOf, expressionIdentifiers, extractTableTtl, hasOperations, ingestionState,
  isEmptyRowSummary, keyColumnPositions, keyElements, matchingClose, objectType, operationSectionList, optionalNumber, partitionTree,
  percentText, percentValue, prettyTtlParts, ratioLabel, sectionUnavailable, shortName, skipQuoted, splitTopLevel, storageComposition,
  structureItems, visibleDependencies,
};
