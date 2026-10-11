// The pure part of the table card (ARCH-F-127): what the Explorer's table card says about a detail payload, as data. The SQL expressions of the
// card (keys, defaults, codecs, TTL), the rows of the Columns tab, the split of the storage, the tabs an object has, the sections of Operations
// and the SELECT of the preview. No DOM, no state: tests/frontend/model/explorer-detail-model.test.cjs.
// Numbers, sizes and percentages come from ns.format (docs/ui-foundations.md); EMPTY marks an absent value.

import { humanEngine, isDictionarySummary, isDistributedSummary, isLogFamilySummary, isMergeTreeSummary, isViewLikeSummary, quoteIdent, summaryFootprintBytes } from "./app_explorer_summary.js";
import { format } from "./app_format.js";
import { sqlLex } from "./app_sql_lex.js";

const DASH = format.EMPTY;
const PREVIEW_LIMITS = [50, 100, 500];

// ---- SQL expressions of the card (keys, defaults, codecs, TTL) -----------
//
// Pure helpers, also exported for the harness unit test
// (tests/harness/explorer_card_unit.js).

const OPENERS = { "(": ")", "[": "]", "{": "}" };
const CLOSERS = new Set([")", "]", "}"]);

// Index just past a quoted run that starts at text[at] (' " or `). The text is the server's (the DDL of a table): it is
// read with the rules of ClickHouse, in which a backslash escapes the next character and a doubled quote is the quote
// in a name as in a string (the one SQL lexer, app_sql_lex.js, spans with { clickhouse: true }).
function skipQuoted(text, at) {
  return sqlLex.spanAt(text, at, true)[1];
}

// Index of the bracket that closes text[open], or -1.
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

// Top-level comma-separated elements: commas inside parentheses, brackets,
// braces, strings and quoted identifiers do not split.
function splitTopLevel(text) {
  return sqlLex.splitTopLevel(text, ",", { brackets: true, clickhouse: true }).map((part) => part.text);
}

// The elements of a key (ORDER BY, PRIMARY KEY, PARTITION BY, SAMPLE BY),
// in key order: "service, toStartOfHour(ts)" -> ["service",
// "toStartOfHour(ts)"]. One pair of parentheses, or tuple(...), around the
// whole key is the tuple itself; tuple() is an empty key.
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

// The identifiers an expression reads (not the functions it calls, not
// its strings): `a b`, "x", plain and dotted names (n.key).
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

// Positions (0-based) of the key elements that read a column; a subcolumn
// (n.key) counts for its column n.
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

// engine_full is "Engine(args) PARTITION BY ... ORDER BY ... TTL ...
// SETTINGS a = 1, b = 'x'": the arguments and the settings are the
// parts no other tile shows.
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
  // The last top-level SETTINGS clause (strings may hold the word).
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

// Shares are kept on a 0-100 scale for the bars; ns.format.percent takes a ratio.
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

// "observed_at + toIntervalDay(30) RECOMPRESS CODEC(ZSTD(3))" ->
// "observed_at + 30 d \u2192 RECOMPRESS ZSTD(3)"; a bare rule deletes.
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

// [badge text, title, kind] of each key a column is part of, with its
// position(s) in the key: "ORDER BY \u00b7 0" (About > Keys lists them).
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
  // The codec as SQL, and a note when it is the table's default.
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
  // Array(Tuple(...)) and deeper Array wrappers expose the same named
  // physical subcolumns and use the same disclosure control.
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

    // size0/sizeN are real on-disk Array offset streams. Keep the
    // implementation names out of the UI, but account for their bytes as
    // one explicit physical child so the children add up to the parent.
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

// The column sizes as a treemap (app_explorer_treemap.js): top-level
// columns, compressed or uncompressed bytes (a segmented switch, kept
// for the session), coloured by type family; drawn when three columns
// or more hold >= 1% of the table's column bytes.
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
  // ClickHouse exposes skipping-index compressed bytes, but not a standalone
  // bytes_on_disk counter. Account those known index files explicitly; all
  // remaining parent-part overhead stays in the Wide/Compact base footprint.
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
      // Allocate the reconciled parent-part residual using the exact
      // bytes_on_disk ratio of Wide vs Compact active parts. Keep one side as
      // the arithmetic remainder so the four categories sum exactly to the
      // table's bytes_on_disk footprint rather than merely approximately.
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

// Partitions: a treemap when three or more hold >= 1% of the table, then
// the list (largest first) with each partition's share of the table.
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

// The sections of the Operations tab, without their renderers (app_explorer_detail_operations.js adds them): what each has to say, and
// whether it has anything to show.
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

// Operations is shown when one of its sections has something to show;
// otherwise About carries the one-line idle summary.
function hasOperations(detail) {
  const summary = detail?.summary || {};
  if (isViewLikeSummary(summary) || isDictionarySummary(summary)) return false;
  if (detail?._loading) return true;
  return operationSectionList(detail).some((item) => item.hasData);
}

// The tabs of the card that an object has (a tab without content is hidden).
function availableTabs(detail) {
  const summary = detail?.summary || {};
  const loading = !!detail?._loading;
  const viewLike = isViewLikeSummary(summary);
  const empty = isEmptyRowSummary(summary);
  const tabs = ["Columns"];
  // An empty table has nothing to preview or inspect physically.
  if (!viewLike && !empty) tabs.push("Preview");
  if (!empty && (isMergeTreeSummary(summary) || isLogFamilySummary(summary))) tabs.push("Storage");
  if (!empty && hasOperations(detail)) tabs.push("Operations");
  if (loading || visibleDependencies(detail).length) tabs.push("Lineage");
  if (loading || detail?.ddl) tabs.push("DDL");
  return tabs;
}

// The SELECT that the preview opens in Query: every column of the table (an aggregate state through finalizeAggregation) and the limit of
// the preview. `previewColumns` are the columns that the preview answered with.
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
