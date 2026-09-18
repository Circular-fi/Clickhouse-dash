(() => {
  "use strict";

  const ns = window.ChDash;
  if (!ns) return;

  const { dom, api } = ns;
  const encoder = new TextEncoder();
  const queries = [];
  let runHostId = null;
  let multiQuery = false;
  let downloading = false;

  const EXECUTION_COLUMNS = [
    "query_id",
    "native_query_id",
    "status",
    "event_time",
    "duration_ms",
    "read_rows",
    "read_bytes",
    "written_rows",
    "written_bytes",
    "result_rows",
    "result_bytes",
    "memory_usage",
    "peak_threads_usage",
    "database",
    "tables",
    "projections",
    "exception_code",
    "exception",
    "partial_execution",
    "run_mode",
  ];

  function csvEscape(value) {
    const text = value == null ? "" : String(value);
    if (!/[",\r\n]/.test(text) && !/^\s|\s$/.test(text)) return text;
    return `"${text.replace(/"/g, '""')}"`;
  }

  function csvValue(value) {
    if (value == null) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  function rowsToCsv(snapshot) {
    const snap = snapshot && typeof snapshot === "object" ? snapshot : {};
    const columns = Array.isArray(snap.columns) ? snap.columns.map((x) => String(x ?? "")) : [];
    const rows = Array.isArray(snap.rows) ? snap.rows : [];
    const lines = [];
    if (columns.length) lines.push(columns.map(csvEscape).join(","));
    for (const row of rows) {
      if (Array.isArray(row)) {
        const width = columns.length || row.length;
        const fields = [];
        for (let i = 0; i < width; i++) fields.push(csvEscape(csvValue(row[i])));
        lines.push(fields.join(","));
      } else if (columns.length <= 1) {
        lines.push(csvEscape(csvValue(row)));
      } else {
        const fields = new Array(columns.length).fill("");
        lines.push(fields.join(","));
      }
    }
    return lines.join("\n");
  }

  function rowsForJson(snapshot) {
    const snap = snapshot && typeof snapshot === "object" ? snapshot : {};
    const columns = Array.isArray(snap.columns) ? snap.columns.map((x) => String(x ?? "")) : [];
    const rows = Array.isArray(snap.rows) ? snap.rows : [];
    const uniqueColumns = columns.length > 0 && new Set(columns).size === columns.length;
    if (!uniqueColumns) return rows;
    return rows.map((row) => {
      if (!Array.isArray(row)) return columns.length === 1 ? { [columns[0]]: row } : row;
      const out = {};
      for (let i = 0; i < columns.length; i++) out[columns[i]] = row[i] === undefined ? null : row[i];
      return out;
    });
  }

  function executionCsv(payload) {
    const header = EXECUTION_COLUMNS.join(",");
    if (!payload || payload.available !== true) return header;
    const database = Array.isArray(payload.databases) ? payload.databases.join(";") : "";
    const tables = Array.isArray(payload.tables) ? payload.tables.join(";") : "";
    const projections = Array.isArray(payload.projections) ? payload.projections.join(";") : "";
    const values = [
      payload.query_id,
      payload.native_query_id,
      payload.status,
      payload.event_time,
      payload.duration_ms,
      payload.read_rows,
      payload.read_bytes,
      payload.written_rows,
      payload.written_bytes,
      payload.result_rows,
      payload.result_bytes,
      payload.memory_usage,
      payload.peak_threads_usage,
      database,
      tables,
      projections,
      payload.exception_code,
      payload.exception,
      payload.partial_execution === true,
      payload.run_mode,
    ];
    return `${header}\n${values.map((x) => csvEscape(x == null ? "" : x)).join(",")}`;
  }

  async function loadExecutionPayload(entry) {
    if (!entry.queryId) {
      throw new Error(`Export metadata failed for statement ${Number(entry.index || 0) + 1}: no query_id was produced.`);
    }

    let payload = null;
    try {
      payload = await api.getQueryExecution(entry.hostId || runHostId, entry.queryId);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e || "Execution statistics request failed.");
      throw new Error(`Export metadata failed for statement ${Number(entry.index || 0) + 1}: ${detail}`);
    }

    if (!payload || payload.available !== true) {
      const detail = payload && payload.logs_pending
        ? "ClickHouse query_log did not publish the execution before the bounded lookup window expired."
        : String((payload && payload.error) || "ClickHouse execution statistics are unavailable.");
      throw new Error(`Export metadata failed for statement ${Number(entry.index || 0) + 1}: ${detail}`);
    }
    return payload;
  }

  function executionFiles(payload, prefix) {
    return [{ name: `${prefix}execution.csv`, text: executionCsv(payload) }];
  }

  async function profilingFiles(entry, prefix) {
    if (String(entry?.runMode || "normal") !== "profiling") return [];
    if (!entry?.queryId) {
      throw new Error(`Profiling export failed for statement ${Number(entry?.index || 0) + 1}: no query_id was produced.`);
    }
    try {
      const analysis = await api.analyzeQuery(entry.hostId || runHostId, entry.queryId, { includeOriginalTrace: true });
      if (!analysis || typeof analysis !== "object") {
        throw new Error("Invalid profiling response.");
      }
      // Debug JSON deliberately keeps both representations: trace_compact is
      // the exact 4K temporal-LOD JSON used by the live UI, while
      // trace_spans_original preserves the ungrouped ClickHouse spans for
      // offline diagnostics and exact timing inspection.
      return [{ name: `${prefix}profiling.json`, text: JSON.stringify(analysis, null, 2) }];
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e || "Profiling request failed.");
      throw new Error(`Profiling export failed for statement ${Number(entry.index || 0) + 1}: ${detail}`);
    }
  }

  function unquoteIdentifierPart(value) {
    const text = String(value || "").trim();
    if (text.length >= 2 && text.startsWith("`") && text.endsWith("`")) {
      return text.slice(1, -1).replace(/``/g, "`");
    }
    return text;
  }

  function parseQualifiedTableName(value) {
    const text = String(value || "").trim();
    if (!text) return null;
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "`") {
        if (quoted && text[i + 1] === "`") {
          i += 1;
          continue;
        }
        quoted = !quoted;
        continue;
      }
      if (ch !== "." || quoted) continue;
      const database = unquoteIdentifierPart(text.slice(0, i));
      const table = unquoteIdentifierPart(text.slice(i + 1));
      return database && table ? { database, table } : null;
    }
    return null;
  }

  function safePathPart(value) {
    const text = String(value || "");
    const safe = text.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+$/, "_");
    return safe || "_";
  }

  function definitionManifestCsv(rows) {
    const header = ["depth", "relation", "database", "table", "parent_database", "parent_table", "file"].join(",");
    const lines = [header];
    for (const row of rows) {
      lines.push([
        row.depth,
        row.relation,
        row.database,
        row.table,
        row.parentDatabase || "",
        row.parentTable || "",
        row.file,
      ].map(csvEscape).join(","));
    }
    return lines.join("\n");
  }

  async function tableDefinitionFiles(entry, prefix, executionPayload) {
    const roots = Array.isArray(executionPayload?.tables) ? executionPayload.tables : [];
    if (!roots.length) return [];

    const queue = [];
    for (const raw of roots) {
      const parsed = parseQualifiedTableName(raw);
      if (!parsed) continue;
      queue.push({ ...parsed, depth: 0, relation: "query", parentDatabase: "", parentTable: "" });
    }
    if (!queue.length) return [];

    const visited = new Set();
    const files = [];
    const manifest = [];
    const hostId = entry.hostId || runHostId;
    const maxDefinitions = 256;

    while (queue.length) {
      const current = queue.shift();
      const key = `${current.database}\0${current.table}`;
      if (visited.has(key)) continue;
      if (visited.size >= maxDefinitions) {
        throw new Error(`Recursive table-definition export exceeded ${maxDefinitions} objects for statement ${Number(entry.index || 0) + 1}.`);
      }
      visited.add(key);

      let detail = null;
      try {
        detail = await api.getExplorerTable(hostId, current.database, current.table);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e || "Table metadata request failed.");
        throw new Error(`Table-definition export failed for ${current.database}.${current.table}: ${reason}`);
      }

      const ddl = String(detail?.ddl || "").trim();
      if (!ddl) throw new Error(`Table-definition export failed for ${current.database}.${current.table}: CREATE definition is unavailable.`);

      const relativeFile = `tables/${safePathPart(current.database)}/${safePathPart(current.table)}.sql`;
      files.push({ name: `${prefix}${relativeFile}`, text: ddl.endsWith("\n") ? ddl : `${ddl}\n` });
      manifest.push({ ...current, file: relativeFile });

      const dependencies = Array.isArray(detail?.dependencies) ? detail.dependencies : [];
      const engine = String(detail?.summary?.engine || "");
      for (const dep of dependencies) {
        const relation = String(dep?.relation || "").toLowerCase();
        // Recursive query dependencies flow upstream. Buffer is the exception:
        // reading a Buffer also depends on its flush target, which Explorer
        // models as downstream, so include that target as part of the definition
        // closure as well.
        const include = relation === "upstream" || (engine === "Buffer" && relation === "downstream");
        if (!include) continue;
        const database = String(dep?.database || "");
        const table = String(dep?.table || "");
        if (!database || !table) continue;
        queue.push({
          database,
          table,
          depth: Number(current.depth || 0) + 1,
          relation,
          parentDatabase: current.database,
          parentTable: current.table,
        });
      }
    }

    files.unshift({ name: `${prefix}tables/manifest.csv`, text: definitionManifestCsv(manifest) });
    return files;
  }

  function crc32Table() {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  }

  const CRC_TABLE = crc32Table();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function set16(view, offset, value) {
    view.setUint16(offset, value & 0xffff, true);
  }

  function set32(view, offset, value) {
    view.setUint32(offset, value >>> 0, true);
  }

  function dosDateTime(date = new Date()) {
    const year = Math.max(1980, date.getFullYear());
    const time = ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | ((Math.floor(date.getSeconds() / 2)) & 31);
    const day = ((year - 1980) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31);
    return { time, date: day };
  }

  function buildStoreZip(files) {
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    let centralSize = 0;
    const stamp = dosDateTime();

    for (const file of files) {
      const nameBytes = encoder.encode(String(file.name || "file"));
      const dataBytes = encoder.encode(String(file.text ?? ""));
      if (dataBytes.length > 0xffffffff || offset > 0xffffffff) {
        throw new Error("Received-results archive exceeds the browser ZIP32 limit. Use Run → Download for a full streamed export.");
      }
      const crc = crc32(dataBytes);
      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      set32(lv, 0, 0x04034b50);
      set16(lv, 4, 20);
      set16(lv, 6, 0x0800);
      set16(lv, 8, 0);
      set16(lv, 10, stamp.time);
      set16(lv, 12, stamp.date);
      set32(lv, 14, crc);
      set32(lv, 18, dataBytes.length);
      set32(lv, 22, dataBytes.length);
      set16(lv, 26, nameBytes.length);
      set16(lv, 28, 0);
      local.set(nameBytes, 30);
      localParts.push(local, dataBytes);

      const central = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(central.buffer);
      set32(cv, 0, 0x02014b50);
      set16(cv, 4, 20);
      set16(cv, 6, 20);
      set16(cv, 8, 0x0800);
      set16(cv, 10, 0);
      set16(cv, 12, stamp.time);
      set16(cv, 14, stamp.date);
      set32(cv, 16, crc);
      set32(cv, 20, dataBytes.length);
      set32(cv, 24, dataBytes.length);
      set16(cv, 28, nameBytes.length);
      set16(cv, 30, 0);
      set16(cv, 32, 0);
      set16(cv, 34, 0);
      set16(cv, 36, 0);
      set32(cv, 38, 0);
      set32(cv, 42, offset);
      central.set(nameBytes, 46);
      centralParts.push(central);
      centralSize += central.length;
      offset += local.length + dataBytes.length;
    }

    if (files.length > 0xffff || centralSize > 0xffffffff || offset > 0xffffffff) {
      throw new Error("Received-results archive exceeds the browser ZIP32 limit. Use Run → Download for a full streamed export.");
    }

    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    set32(ev, 0, 0x06054b50);
    set16(ev, 4, 0);
    set16(ev, 6, 0);
    set16(ev, 8, files.length);
    set16(ev, 10, files.length);
    set32(ev, 12, centralSize);
    set32(ev, 16, offset);
    set16(ev, 20, 0);

    return new Blob([...localParts, ...centralParts, end], { type: "application/zip" });
  }

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function sortedQueries() {
    return queries.slice().sort((a, b) => Number(a.index || 0) - Number(b.index || 0));
  }

  function buildGlobalJson() {
    return JSON.stringify({
      queries: sortedQueries().map((entry, position) => ({
        index: Number(entry.index ?? position) + 1,
        query: String(entry.sql || ""),
        columns: Array.isArray(entry.snapshot && entry.snapshot.columns) ? entry.snapshot.columns : [],
        data: rowsForJson(entry.snapshot),
        ...(entry.errorText ? { error: String(entry.errorText) } : {}),
        ...(entry.partial ? { partial: true } : {}),
      })),
    }, null, 2);
  }

  function debugArchiveReadme(many) {
    const lines = [
      "# ChDash Debug Archive",
      "",
      "This archive is a self-contained diagnostic snapshot produced by **Run → Download Debug**.",
      many
        ? "Each `query-NNN/` directory contains the files for one statement. Paths below are relative to that directory."
        : "The files below are stored at the archive root for this single-query export.",
      "",
      "## Files",
      "",
      "### `query.sql`",
      "The exact SQL statement executed by ChDash.",
      "",
      "### `results.csv`",
      "The rows received by the browser preview, encoded as CSV. This can be a partial result when preview limits or cancellation stopped the execution early.",
      "",
      "### `execution.csv`",
      "One-row execution summary read from ClickHouse `system.query_log`. Columns include duration, read/write/result rows and bytes, memory usage, tables, projections, status, and exception metadata.",
      "",
      "### `profiling.json`",
      "Profiling metadata collected for a query executed in profiling mode. It contains query attempts, processor profiling, view/distributed metadata, availability/error information, and two trace representations:",
      "",
      "- `trace_compact`: the exact compact JSON trace representation used by the live UI. It uses dictionaries for hosts, trace IDs, and operation names plus local integer parent references instead of ClickHouse span IDs. Trailing `_N` instance suffixes are removed from operation names. Leaf spans are grouped when they have the same trace, parent, and normalized operation name; the viewer also recursively merges normalized sibling branches while preserving their activity intervals and descendants.",
      "- `processors_compact` (`chdash.processors.json.v1`): the live Pipeline representation. `strings` is a shared dictionary. `rows` follow `row_schema`; identities and parent IDs reference exact decimal strings. Summary windows are grouped in `summary_series` by host, trace, query, parent and operation. Their flat `windows` follow `summary_window_schema`: start offset, finish offset, active time and event count. Add `summary_origin_us` to the offsets to recover exact microsecond timestamps. These windows have no additional temporal LOD. Values beyond JavaScript's safe integer range use decimal strings.",
      "- `processor_trace_summary`: expanded original activity summaries, included only in Debug exports. `processor_trace_bucket_us` gives the adaptive bucket width; gaps within a bucket are unknown. Collection is independent of the detailed span cap; `processor_trace_summary_truncated` reports its own 65,536-row cap.",
      "- `processors`: expanded original processor counters and graph links, included only in Debug exports. `id`, `parent_ids`, `plan_step` and `plan_group` use decimal strings to preserve UInt64 precision. `processors_truncated` reports the 10,000-row cap.",
      "- `trace_spans_original`: the original ungrouped spans collected from ClickHouse before leaf grouping or temporal LOD. Each object contains `hostname`, `trace_id`, `span_id`, `parent_span_id`, `operation_name`, `start_time_us`, `finish_time_us`, `duration_us`, `query_id`, `thread_id`, and `thread_number`.",
      "",
      "The normal live API does not send `trace_spans_original`, `processors` or `processor_trace_summary`; it sends their compact representations. Expanded originals are requested only while building a Debug archive.",
      "",
      "### `error.txt`",
      "Present only when the query finished with a browser-visible error. It contains the error text associated with the statement.",
      "",
      "### `tables/manifest.csv`",
      "Manifest of table definitions recursively associated with the query. It records dependency depth, relation direction, database/table names, parent object, and the path to the exported DDL.",
      "",
      "### `tables/<database>/<table>.sql`",
      "`CREATE` definition returned by Explorer for each table/view included by the recursive dependency export.",
      "",
      "## Compact live trace JSON (`chdash.trace.json.lod.v2`)",
      "",
      "`POST /api/query/analysis` returns ordinary `application/json`. The heavy trace portion is stored in `trace_compact` rather than repeated span objects.",
      "",
      "`trace_compact` contains:",
      "",
      "- `timeline_px`: fixed at 3840, matching a 4K horizontal timeline resolution.",
      "- `origin_us`: the minimum original span start timestamp, transmitted once.",
      "- `duration_us`: the full trace time range used to map timestamps to the 3840 temporal buckets.",
      "- `hosts`, `traces`, `operations`: string dictionaries.",
      "- `node_schema`: positional schema for each entry in `nodes`.",
      "- `segment_schema`: positional schema for timeline segments.",
      "- `nodes`: compact positional rows. `parent_ref` is `0` when unresolved/root, otherwise `parent_node_index + 1`. `flags & 1` identifies an aggregated leaf group.",
      "",
      "Each `segments_px` value is a flat list `[start_px, finish_px, start_px, finish_px, ...]`. Original microsecond intervals are projected to a 3840-pixel timeline. Leaf intervals that become indistinguishable at that resolution are merged. No structural/tree LOD is applied: parent/child nodes remain represented. Exact original timings and real span IDs remain available in `trace_spans_original` in this Debug archive.",
    ];
    return lines.join("\n");
  }

  async function buildArchiveFiles() {
    const entries = sortedQueries();
    if (!entries.length) throw new Error("No received results are available to download.");
    const files = [];
    const many = multiQuery || entries.length > 1;
    files.push({ name: "README.md", text: debugArchiveReadme(many) });
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const prefix = many ? `query-${String(i + 1).padStart(3, "0")}/` : "";
      const execution = await loadExecutionPayload(entry);
      files.push({ name: `${prefix}query.sql`, text: String(entry.sql || "") });
      // Debug archives keep one canonical tabular result representation. The
      // normal Download JSON action remains available separately from Run.
      files.push({ name: `${prefix}results.csv`, text: rowsToCsv(entry.snapshot) });
      if (entry.errorText) files.push({ name: `${prefix}error.txt`, text: String(entry.errorText) });
      files.push(...executionFiles(execution, prefix));
      files.push(...await profilingFiles(entry, prefix));
      files.push(...await tableDefinitionFiles(entry, prefix, execution));
    }
    return files;
  }

  function updateUi() {
    if (!dom.downloadReceivedZipButton && !dom.downloadReceivedJsonButton) return;
    const entries = sortedQueries();
    const hasEntries = entries.length > 0;
    const partial = entries.some((x) => x.partial === true);
    if (dom.downloadReceivedZipButton) dom.downloadReceivedZipButton.disabled = !hasEntries || downloading;
    if (dom.downloadReceivedJsonButton) dom.downloadReceivedJsonButton.disabled = !hasEntries || downloading;
    if (multiQuery) {
      if (dom.copyJsonButton) dom.copyJsonButton.disabled = !hasEntries;
      if (dom.copyMenuButton) dom.copyMenuButton.disabled = !hasEntries;
      if (dom.copyCsvButton) dom.copyCsvButton.hidden = true;
    }
    const text = dom.downloadReceivedZipButton ? dom.downloadReceivedZipButton.querySelector(".runMenu__optText") : null;
    if (text) {
      if (partial) text.textContent = "Download Debug (partial)";
      else text.textContent = "Download Debug";
    }
  }

  function resetRun({ hostId = null, multi = false } = {}) {
    queries.length = 0;
    runHostId = hostId ? String(hostId) : null;
    multiQuery = !!multi;
    updateUi();
  }

  function recordQuery(entry) {
    if (!entry || typeof entry !== "object") return;
    const normalized = {
      index: Number(entry.index || 0),
      sql: String(entry.sql || ""),
      queryId: entry.queryId ? String(entry.queryId) : null,
      hostId: entry.hostId ? String(entry.hostId) : runHostId,
      runMode: String(entry.runMode || "normal"),
      status: String(entry.status || ""),
      partial: entry.partial === true,
      errorText: String(entry.errorText || ""),
      snapshot: entry.snapshot && typeof entry.snapshot === "object" ? entry.snapshot : { columns: [], rows: [] },
    };
    const existing = queries.findIndex((x) => x.index === normalized.index);
    if (existing >= 0) queries[existing] = normalized;
    else queries.push(normalized);
    updateUi();
  }


  function flashDownloadLabel(text, durationMs = 1200) {
    const button = dom.downloadReceivedZipButton;
    if (!button) return;
    const label = button.querySelector(".runMenu__optText");
    if (!label) return;
    const previous = label.textContent;
    label.textContent = String(text || "");
    setTimeout(() => {
      label.textContent = previous;
      updateUi();
    }, durationMs);
  }

  function downloadJson() {
    const entries = sortedQueries();
    if (!entries.length) {
      if (ns.results && typeof ns.results.setError === "function") ns.results.setError("No received results are available to download.");
      return;
    }
    try {
      const many = multiQuery || entries.length > 1;
      const text = many ? buildGlobalJson() : JSON.stringify(rowsForJson(entries[0].snapshot), null, 2);
      const blob = new Blob([text], { type: "application/json;charset=utf-8" });
      saveBlob(blob, many ? "queries.json" : "results.json");
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e || "Download JSON failed.");
      if (ns.results && typeof ns.results.setError === "function") ns.results.setError(message);
      return false;
    }
  }

  function downloadCsv() {
    const entries = sortedQueries();
    if (entries.length !== 1 || multiQuery) {
      if (ns.results && typeof ns.results.setError === "function") ns.results.setError("CSV download is available only for a single query.");
      return;
    }
    try {
      const blob = new Blob([rowsToCsv(entries[0].snapshot)], { type: "text/csv;charset=utf-8" });
      saveBlob(blob, "results.csv");
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e || "Download CSV failed.");
      if (ns.results && typeof ns.results.setError === "function") ns.results.setError(message);
      return false;
    }
  }

  async function downloadDebug({ throwOnError = false } = {}) {
    if (downloading) return;
    downloading = true;
    updateUi();
    const button = dom.downloadReceivedZipButton;
    try {
      const files = await buildArchiveFiles();
      const blob = buildStoreZip(files);
      saveBlob(blob, (multiQuery || queries.length > 1) ? "queries.zip" : "query.zip");
      if (button) flashDownloadLabel("Downloaded", 1200);
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e || "Download failed.");
      if (button) flashDownloadLabel("Download failed", 1600);
      if (ns.results && typeof ns.results.setError === "function") ns.results.setError(message);
      if (throwOnError) throw e instanceof Error ? e : new Error(message);
      return false;
    } finally {
      downloading = false;
      updateUi();
    }
  }

  function init() {
    if (dom.downloadReceivedJsonButton) dom.downloadReceivedJsonButton.addEventListener("click", downloadJson);
    if (dom.downloadReceivedZipButton) dom.downloadReceivedZipButton.addEventListener("click", downloadDebug);
    updateUi();
  }

  ns.download = {
    init,
    resetRun,
    recordQuery,
    buildGlobalJson,
    downloadJson,
    downloadCsv,
    downloadDebug,
    downloadZip: downloadDebug,
    _buildStoreZip: buildStoreZip,
    _rowsToCsv: rowsToCsv,
    _executionCsv: executionCsv,
  };
})();
