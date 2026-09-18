(() => {
  "use strict";
  const ns = window.ChDash;
  if (!ns) return;

  const processorSchema = ["hostname_ref", "initial_query_id_ref", "query_id_ref", "id_ref",
    "parent_id_refs", "plan_step_ref", "plan_step_name_ref", "plan_step_description_ref",
    "plan_group_ref", "name_ref", "elapsed_us", "input_wait_elapsed_us",
    "output_wait_elapsed_us", "input_rows", "input_bytes", "output_rows", "output_bytes"];
  const seriesSchema = ["hostname_ref", "trace_id_ref", "query_id_ref", "parent_span_id_ref", "operation_name_ref", "windows"];
  const windowSchema = ["start_offset_us", "finish_offset_us", "active_time_us", "event_count"];
  const maxUint64 = 18446744073709551615n;
  const fail = (message) => { throw new Error(`Invalid processor profiling data: ${message}`); };
  const list = (value, label) => Array.isArray(value) ? value : fail(`${label} must be an array`);
  const uint = (value, label) => {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
    if (typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= maxUint64) return value;
    return fail(`${label} must be an exact UInt64`);
  };
  const timestamp = (origin, offset) => {
    if (typeof origin === "number" && typeof offset === "number" && Number.isSafeInteger(origin + offset)) return origin + offset;
    const result = BigInt(origin) + BigInt(offset);
    if (result > maxUint64) return fail("timestamp overflows UInt64");
    return result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : String(result);
  };

  function decodeProcessors(data) {
    const compact = data?.processors_compact;
    if (!Object.prototype.hasOwnProperty.call(data || {}, "processors_compact")) return {
      processors: list(data?.processors ?? [], "processors"),
      processorTraceSummary: list(data?.processor_trace_summary ?? [], "processor_trace_summary"),
    };
    if (!compact || typeof compact !== "object" || Array.isArray(compact)) return fail("compact block must be an object");
    if (compact.format !== "chdash.processors.json.v1") return fail(`unsupported format ${String(compact.format)}`);
    for (const [name, expected] of [["row_schema", processorSchema], ["summary_series_schema", seriesSchema], ["summary_window_schema", windowSchema]]) {
      const schema = list(compact[name], name);
      if (schema.length !== expected.length || schema.some((field, index) => field !== expected[index])) return fail(`${name} does not match v1`);
    }
    const strings = list(compact.strings, "strings");
    if (strings[0] !== "" || strings.some(value => typeof value !== "string")) return fail("invalid string dictionary");
    const ref = (value) => {
      if (!Number.isSafeInteger(value) || value < 0 || value >= strings.length) return fail("string reference is out of range");
      return strings[value];
    };
    const id = (value) => {
      const text = ref(value);
      uint(text, "identity");
      return text;
    };
    const rows = list(compact.rows, "rows");
    if (rows.length > 10000) return fail("processor row limit exceeded");
    const processors = rows.map(row => {
      if (!Array.isArray(row) || row.length !== processorSchema.length) return fail("invalid processor row width");
      for (let i = 10; i < row.length; i += 1) uint(row[i], processorSchema[i]);
      return {
        hostname: ref(row[0]), initial_query_id: ref(row[1]), query_id: ref(row[2]),
        id: id(row[3]), parent_ids: list(row[4], "parent_id_refs").map(id),
        plan_step: id(row[5]), plan_step_name: ref(row[6]), plan_step_description: ref(row[7]),
        plan_group: id(row[8]), name: ref(row[9]), elapsed_us: row[10],
        input_wait_elapsed_us: row[11], output_wait_elapsed_us: row[12],
        input_rows: row[13], input_bytes: row[14], output_rows: row[15], output_bytes: row[16],
      };
    });
    const origin = uint(compact.summary_origin_us, "summary_origin_us");
    const series = list(compact.summary_series, "summary_series");
    if (series.length > 65536) return fail("summary series limit exceeded");
    let rowCount = 0;
    for (const entry of series) {
      if (!Array.isArray(entry) || entry.length !== seriesSchema.length) return fail("invalid summary series width");
      for (let i = 0; i < 5; i += 1) ref(entry[i]);
      const windows = list(entry[5], "windows");
      if (!windows.length || windows.length % 4 !== 0) return fail("incomplete summary window");
      rowCount += windows.length / 4;
      if (rowCount > 65536) return fail("summary window limit exceeded");
      for (let i = 0; i < windows.length; i += 4) {
        for (let j = 0; j < 4; j += 1) uint(windows[i + j], windowSchema[j]);
        if (BigInt(windows[i + 1]) < BigInt(windows[i])) return fail("activity finishes before its start");
        timestamp(origin, windows[i + 1]);
      }
    }
    if (compact.summary_row_count !== rowCount) return fail("summary row count mismatch");
    // A restartable iterable avoids retaining a second 65K-row object payload.
    const processorTraceSummary = {
      length: rowCount,
      *[Symbol.iterator]() {
        for (const entry of series) {
          const windows = entry[5];
          for (let i = 0; i < windows.length; i += 4) yield {
            hostname: strings[entry[0]], trace_id: strings[entry[1]], query_id: strings[entry[2]],
            parent_span_id: strings[entry[3]], operation_name: strings[entry[4]],
            first_start_time_us: timestamp(origin, windows[i]), last_finish_time_us: timestamp(origin, windows[i + 1]),
            active_time_us: windows[i + 2], event_count: windows[i + 3],
          };
        }
      },
    };
    return { processors, processorTraceSummary };
  }

  ns.analysisData = { decodeProcessors };
})();
