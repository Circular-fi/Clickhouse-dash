// This module covers the values of a result (docs/telemetry.md, "Result values").
// It covers how the API sends the values, and how the module parses them.
// It covers how the module writes them as text (a cell, a copy, JSON, CSV).
// It also covers their types, the flattening of a tuple, and the figures of a numeric column.
// The Node unit tests run this module in a bare context (tests/frontend/model/results-values.test.cjs).

import { sqlLex } from "./app_sql_lex.js";
import { state } from "./app_state.js";

const NUMERIC_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

// A JSON number that a double cannot keep as written (12345678901234567890, 1.500, 1e100). The value is its text.
class JsonNumber {
  constructor(text) { this.text = text; }
  toString() { return this.text; }
  valueOf() { return Number(this.text); }
}

// A JSON object read from text, as [key, value] pairs in their order.
// A JavaScript object puts the keys that are numbers first. For example, {"10":1,"2":2} reads as {"2":2,"10":1}.
class JsonObject {
  constructor(entries) { this.entries = entries; }
}

const JSON_NUMBER_STICKY = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const INDEX_KEY = /^(?:0|[1-9]\d{0,9})$/;

function exactNumber(text) {
  const n = Number(text);
  return Number.isFinite(n) && String(n) === text;
}

// Check whether JSON.parse changes the text. It changes a number that a double does not keep as written.
// It also changes an object key that JavaScript reorders. The check uses one linear scan. The usual text has neither.
function jsonParseChanges(text) {
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 34) {
      let j = i + 1;
      while (j < n) {
        const d = text.charCodeAt(j);
        if (d === 92) { j += 2; continue; }
        if (d === 34) break;
        j += 1;
      }
      let k = j + 1;
      while (k < n && (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 10 || text.charCodeAt(k) === 13 || text.charCodeAt(k) === 9)) k += 1;
      if (text.charCodeAt(k) === 58 && INDEX_KEY.test(text.slice(i + 1, j))) return true;
      i = j + 1;
      continue;
    }
    if (c === 45 || (c >= 48 && c <= 57)) {
      JSON_NUMBER_STICKY.lastIndex = i;
      const m = JSON_NUMBER_STICKY.exec(text);
      if (!m) return true;
      if (!exactNumber(m[0])) return true;
      i += m[0].length;
      continue;
    }
    i += 1;
  }
  return false;
}

// Parse JSON text to values without loss. An object becomes a JsonObject. A number that a double cannot keep becomes a JsonNumber.
// The function throws on text that is not JSON.
function parseJsonLossless(text) {
  const n = text.length;
  let i = 0;
  const fail = () => { throw new SyntaxError(`JSON at position ${i}`); };
  const ws = () => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 10 || c === 13 || c === 9) i += 1;
      else break;
    }
  };
  const str = () => {
    let j = i + 1;
    let escaped = false;
    while (j < n) {
      const d = text.charCodeAt(j);
      if (d === 92) { escaped = true; j += 2; continue; }
      if (d === 34) break;
      j += 1;
    }
    if (j >= n) fail();
    const raw = text.slice(i, j + 1);
    i = j + 1;
    return escaped ? JSON.parse(raw) : raw.slice(1, -1);
  };
  const value = (depth) => {
    if (depth > 512) fail();
    ws();
    const c = text.charCodeAt(i);
    if (c === 34) return str();
    if (c === 123) {
      i += 1;
      const entries = [];
      ws();
      if (text.charCodeAt(i) === 125) { i += 1; return new JsonObject(entries); }
      for (;;) {
        ws();
        if (text.charCodeAt(i) !== 34) fail();
        const key = str();
        ws();
        if (text.charCodeAt(i) !== 58) fail();
        i += 1;
        entries.push([key, value(depth + 1)]);
        ws();
        const d = text.charCodeAt(i++);
        if (d === 44) continue;
        if (d === 125) return new JsonObject(entries);
        fail();
      }
    }
    if (c === 91) {
      i += 1;
      const out = [];
      ws();
      if (text.charCodeAt(i) === 93) { i += 1; return out; }
      for (;;) {
        out.push(value(depth + 1));
        ws();
        const d = text.charCodeAt(i++);
        if (d === 44) continue;
        if (d === 93) return out;
        fail();
      }
    }
    if (c === 45 || (c >= 48 && c <= 57)) {
      JSON_NUMBER_STICKY.lastIndex = i;
      const m = JSON_NUMBER_STICKY.exec(text);
      if (!m) fail();
      i += m[0].length;
      return exactNumber(m[0]) ? Number(m[0]) : new JsonNumber(m[0]);
    }
    if (text.startsWith("true", i)) { i += 4; return true; }
    if (text.startsWith("false", i)) { i += 5; return false; }
    if (text.startsWith("null", i)) { i += 4; return null; }
    return fail();
  };
  const out = value(0);
  ws();
  if (i !== n) fail();
  return out;
}

// The values of JSON text. The function returns undefined when the text is not JSON. The caller then shows the text as it is.
function parseJsonText(text) {
  try {
    return jsonParseChanges(text) ? parseJsonLossless(text) : JSON.parse(text);
  } catch {
    return undefined;
  }
}

// A column with a structure: Array, Map, Tuple, or a type that holds any JSON value.
function isStructuredType(ast) {
  if (!ast) return false;
  if (ast.kind !== "Scalar") return true;
  return /^(?:JSON|Object\s*\(|Dynamic|Variant\s*\(|Nested\s*\()/i.test(String(ast.name || ""));
}

// Parse the value of a cell in a structured column when the value arrived as JSON text.
// Any other value stays as it is.
function decodeStructuredText(value, ast) {
  if (typeof value !== "string" || !isStructuredType(ast)) return value;
  const parsed = parseJsonText(value);
  return parsed === undefined ? value : parsed;
}

// The text of a scalar value. A string stays as it is. A number or a boolean is written as JavaScript writes it.
function scalarText(value) {
  if (typeof value === "string") return value;
  if (value instanceof JsonNumber) return value.text;
  return String(value);
}

function isScalarValue(value) {
  return value === null || typeof value !== "object" || value instanceof JsonNumber;
}

// The [key, value] pairs of a value that is written as a JSON object. The function returns null for a list.
// A Map arrives as pairs, and is written as an object in its stored order. A named Tuple is written as an object of its fields.
function objectEntries(value, ast) {
  if (value instanceof JsonObject) return value.entries;
  if (Array.isArray(value)) {
    if (ast && ast.kind === "Map" && value.every((pair) => Array.isArray(pair) && pair.length === 2)) {
      return value.map(([key, item]) => [typeof key === "string" ? key : (key == null ? "null" : valueText(key, ast.key)), item]);
    }
    if (ast && ast.kind === "Tuple" && ast.named && Array.isArray(ast.fields) && value.length === ast.fields.length) {
      return ast.fields.map((field, index) => [String(field.name ?? `_${index}`), value[index]]);
    }
    if (ast && ast.kind === "Row") return ast.columns.map((column, index) => [column, value[index]]);
    return null;
  }
  if (value && typeof value === "object") return Object.entries(value);
  return null;
}

// The type of the value at `key` or `index` inside a value of type `ast`.
function childType(ast, index, key) {
  if (!ast) return null;
  if (ast.kind === "Array") return ast.inner || null;
  if (ast.kind === "Map") return ast.value || null;
  if (ast.kind === "Row") return ast.types[index] || null;
  if (ast.kind === "Rows") return ast.row || null;
  if (ast.kind === "Tuple") {
    const fields = Array.isArray(ast.fields) ? ast.fields : [];
    if (key !== undefined) {
      const field = fields.find((item) => String(item.name) === key);
      if (field) return field.type || null;
    }
    return fields[index] ? fields[index].type || null : null;
  }
  return null;
}

const JSON_NUMBER_TEXT = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

// A value as JSON text. The `indent` value 0 gives compact text, as JSON.stringify writes it.
// Any other `indent` value gives that many spaces per level.
// The API sends the digits of a number type (a UInt64, a Decimal) as strings. The writer writes these digits, and a JsonNumber, as a JSON number, exactly.
// nan and inf stay strings, because JSON has no such number. A value of a Map type or a named Tuple type is an object.
function jsonText(value, ast = null, indent = 0) {
  const out = [];
  const colon = indent ? ": " : ":";
  const write = (v, t, pad) => {
    if (v === null || v === undefined) { out.push("null"); return; }
    switch (typeof v) {
      case "string": out.push(isScalarNumericType(t) && JSON_NUMBER_TEXT.test(v) ? v : JSON.stringify(v)); return;
      case "number": out.push(Number.isFinite(v) ? String(v) : JSON.stringify(String(v))); return;
      case "boolean": out.push(v ? "true" : "false"); return;
      case "bigint": out.push(String(v)); return;
      default: break;
    }
    if (v instanceof JsonNumber) { out.push(v.text); return; }
    const entries = objectEntries(v, t);
    const items = entries || (Array.isArray(v) ? v : null);
    if (!items) { out.push(JSON.stringify(String(v))); return; }
    const [open, close] = entries ? ["{", "}"] : ["[", "]"];
    if (!items.length) { out.push(open, close); return; }
    const inner = indent ? pad + " ".repeat(indent) : "";
    out.push(open);
    for (let i = 0; i < items.length; i++) {
      if (i) out.push(",");
      if (indent) out.push("\n", inner);
      if (entries) {
        const [key, item] = items[i];
        out.push(JSON.stringify(String(key)), colon);
        write(item, childType(t, i, String(key)), inner);
      } else {
        write(items[i], childType(t, i), inner);
      }
    }
    if (indent) out.push("\n", pad);
    out.push(close);
  };
  write(value, ast, "");
  return out.join("");
}

// The text of a cell. A scalar stays as it is. A structure becomes compact JSON. The function returns null for SQL NULL.
function valueText(value, ast) {
  if (value === null || value === undefined) return null;
  return isScalarValue(value) ? scalarText(value) : jsonText(value, ast, 0);
}

// The rows of a result as JSON. The result is an array of objects (column: value).
// It is an array of arrays when two columns have the same name, because an object would lose one. Copy JSON, Download JSON, Copy row and Debug use this function.
function rowsAst(columns, asts) {
  const names = columns.map((column) => String(column ?? ""));
  const unique = new Set(names).size === names.length;
  const row = unique ? { kind: "Row", columns: names, types: asts } : { kind: "Tuple", fields: asts.map((type, index) => ({ name: `_${index}`, type })), named: false };
  return { kind: "Rows", row };
}

function resultJsonText(columns, asts, rows, indent = 2) {
  return jsonText(rows, rowsAst(columns, asts), indent);
}

// The text that Copy JSON puts on the clipboard. It has the same values, without the wrapping.
// One row gives its object, not a list of one row. One column gives its values, not objects of one key.
// One row of one column gives the value itself. Download JSON keeps the list of objects. A program reads the same shape for every result.
function resultCopyJsonText(columns, asts, rows, indent = 2) {
  const oneRow = rows.length === 1;
  if (columns.length === 1) {
    const cell = (row) => (Array.isArray(row) ? row[0] : row);
    const ast = asts[0] || null;
    return oneRow ? jsonText(cell(rows[0]), ast, indent) : jsonText(rows.map(cell), { kind: "Array", inner: ast }, indent);
  }
  if (!oneRow) return resultJsonText(columns, asts, rows, indent);
  return jsonText(rows[0], rowsAst(columns, asts).row, indent);
}

// CSV (RFC 4180). A field is quoted only when it must be quoted.
// A NULL is a bare \N, as ClickHouse writes CSV. A text that is exactly \N is quoted, so it never reads as NULL.
// A structure is its compact JSON. Copy CSV, Download CSV and the Debug archive use this function.
function csvField(text) {
  if (text === null) return "\\N";
  const quote = text === "\\N" || /[",\r\n]/.test(text) || /^[ \t]|[ \t]$/.test(text);
  return quote ? `"${text.replace(/"/g, '""')}"` : text;
}

function resultCsvText(columns, asts, rows) {
  const names = columns.map((column) => String(column ?? ""));
  const lines = [];
  if (names.length) lines.push(names.map(csvField).join(","));
  for (const row of rows) {
    if (Array.isArray(row)) {
      const width = names.length || row.length;
      const fields = new Array(width);
      for (let i = 0; i < width; i++) fields[i] = csvField(valueText(row[i], asts[i] || null));
      lines.push(fields.join(","));
    } else if (names.length <= 1) {
      lines.push(csvField(valueText(row, asts[0] || null)));
    } else {
      lines.push(new Array(names.length).fill("").join(","));
    }
  }
  return lines.join("\n");
}

// The function converts a result snapshot (getSnapshot: flattened columns, their types, the rows) to JSON or CSV.
function snapshotParts(snapshot) {
  const snap = snapshot && typeof snapshot === "object" ? snapshot : {};
  const columns = Array.isArray(snap.columns) ? snap.columns.map((column) => String(column ?? "")) : [];
  const types = Array.isArray(snap.types) ? snap.types : [];
  return { columns, asts: columns.map((_, index) => parseChType(types[index] || "")), rows: Array.isArray(snap.rows) ? snap.rows : [] };
}

const serialize = {
  json(snapshot, indent = 2) {
    const { columns, asts, rows } = snapshotParts(snapshot);
    return resultJsonText(columns, asts, rows, indent);
  },
  csv(snapshot) {
    const { columns, asts, rows } = snapshotParts(snapshot);
    return resultCsvText(columns, asts, rows);
  },
};

// The parts of a type's arguments. The function cuts the text at each separator that is outside a parenthesis, a string and a name.
// It uses the one SQL lexer (app_sql_lex.js). For example, Enum8('a,b' = 1, 'c' = 2) has two parts.
function splitTopLevel(str, sepChar) {
  return sqlLex.splitTopLevel(str, sepChar).map((part) => part.text);
}

function stripIdentifierQuotes(name) {
  const t = String(name ?? "").trim();
  if (t.length >= 2) {
    const first = t[0];
    const last = t[t.length - 1];
    if ((first === "`" && last === "`") || (first === "\"" && last === "\"")) {
      return t.slice(1, -1);
    }
  }
  return t;
}

function parseChType(typeStr) {
  const s = String(typeStr ?? "").trim();
  if (!s) return null;

  const unwrap = (prefix) => {
    if (!s.startsWith(prefix + "(") || !s.endsWith(")")) return null;
    return s.slice(prefix.length + 1, -1).trim();
  };

  const innerNullable = unwrap("Nullable");
  if (innerNullable) return parseChType(innerNullable);

  const innerLc = unwrap("LowCardinality");
  if (innerLc) return parseChType(innerLc);

  const innerArray = unwrap("Array");
  if (innerArray) return { kind: "Array", inner: parseChType(innerArray) };

  const innerMap = unwrap("Map");
  if (innerMap) {
    const parts = splitTopLevel(innerMap, ",");
    return { kind: "Map", key: parseChType(parts[0]), value: parseChType(parts[1]) };
  }

  const innerTuple = unwrap("Tuple");
  if (innerTuple) {
    const parts = splitTopLevel(innerTuple, ",");
    let hasNamedFields = false;
    const fields = parts.map((part, idx) => {
      let depth = 0;
      let splitAt = -1;
      for (let i = 0; i < part.length; i++) {
        const ch = part[i];
        if (ch === "(") depth++;
        else if (ch === ")") depth = Math.max(0, depth - 1);
        else if (depth === 0 && /\s/.test(ch)) {
          splitAt = i;
          break;
        }
      }

      if (splitAt > 0) {
        const maybeNameRaw = part.slice(0, splitAt).trim();
        const maybeName = stripIdentifierQuotes(maybeNameRaw);
        const rest = part.slice(splitAt).trim();
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(maybeName) && rest) {
          hasNamedFields = true;
          return { name: maybeName, type: parseChType(rest), rawType: rest, named: true };
        }
      }
      return { name: `_${idx}`, type: parseChType(part), rawType: part, named: false };
    });
    return { kind: "Tuple", fields, named: hasNamedFields };
  }

  return { kind: "Scalar", name: s };
}

function tupleFieldValue(value, field, index) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value[index];
  const entries = value instanceof JsonObject ? value.entries : (typeof value === "object" ? Object.entries(value) : null);
  if (!entries) return null;
  const name = String(field?.name ?? `_${index}`);
  const synthetic = `_${index}`;
  const byName = entries.find(([key]) => key === name) || entries.find(([key]) => key === synthetic);
  if (byName) return byName[1];
  return entries[index] ? entries[index][1] : null;
}

function typeAstLabel(ast) {
  if (!ast) return "String";
  if (ast.kind === "Scalar") return String(ast.name || "String");
  if (ast.kind === "Array") return `Array(${typeAstLabel(ast.inner)})`;
  if (ast.kind === "Map") return `Map(${typeAstLabel(ast.key)}, ${typeAstLabel(ast.value)})`;
  if (ast.kind === "Tuple") {
    const fields = Array.isArray(ast.fields) ? ast.fields : [];
    return `Tuple(${fields.map((field) => field.named ? `${field.name} ${field.rawType || typeAstLabel(field.type)}` : (field.rawType || typeAstLabel(field.type))).join(", ")})`;
  }
  return "String";
}

function createTupleFlattenPlan(columns, types, enabled = state.runOptFlattenTuple !== false) {
  const safeColumns = Array.isArray(columns) ? columns.map((column) => String(column ?? "")) : [];
  const safeTypes = Array.isArray(types) ? types.map((type) => String(type ?? "")) : [];
  const descriptors = [];
  const tupleColumnIndexes = [];
  // Structured columns that can arrive as JSON text (decodeStructuredText).
  const decodes = [];
  let changed = false;

  const containsTuple = (ast) => {
    if (!ast) return false;
    if (ast.kind === "Tuple") return Array.isArray(ast.fields) && ast.fields.length > 0;
    if (ast.kind === "Array") return containsTuple(ast.inner);
    return false;
  };

  // Return the leaf projections of every Tuple. The Tuple is nested directly, or below one or more Array wrappers.
  // The function keeps the Array wrappers.
  // For example, Array(Tuple(a UInt64, b String)) gives two display columns. Their names are .a and .b.
  // Their types are Array(UInt64) and Array(String). The rows do not explode.
  const collectTupleLeaves = (ast) => {
    if (!ast) return [];

    if (ast.kind === "Tuple") {
      const fields = Array.isArray(ast.fields) ? ast.fields : [];
      const leaves = [];
      for (let fieldIndex = 0; fieldIndex < fields.length; fieldIndex += 1) {
        const field = fields[fieldIndex];
        const fieldName = String(field?.name ?? `_${fieldIndex}`);
        const nested = containsTuple(field?.type) ? collectTupleLeaves(field.type) : [];
        if (nested.length) {
          for (const leaf of nested) {
            leaves.push({
              path: [fieldName, ...leaf.path],
              type: leaf.type,
              extract: (value) => leaf.extract(tupleFieldValue(value, field, fieldIndex)),
            });
          }
        } else {
          leaves.push({
            path: [fieldName],
            type: String(field?.rawType || typeAstLabel(field?.type)),
            extract: (value) => tupleFieldValue(value, field, fieldIndex),
          });
        }
      }
      return leaves;
    }

    if (ast.kind === "Array" && containsTuple(ast.inner)) {
      return collectTupleLeaves(ast.inner).map((leaf) => ({
        path: leaf.path,
        type: `Array(${leaf.type})`,
        extract: (parsed) => {
          if (parsed === null || parsed === undefined) return null;
          if (!Array.isArray(parsed)) return [];
          return parsed.map((item) => leaf.extract(item));
        },
      }));
    }

    return [];
  };

  for (let columnIndex = 0; columnIndex < safeColumns.length; columnIndex += 1) {
    const ast = parseChType(safeTypes[columnIndex] || "");
    if (isStructuredType(ast)) decodes.push({ index: columnIndex, ast });
    const baseGetter = (row) => Array.isArray(row) ? row[columnIndex] : (columnIndex === 0 ? row : null);
    const leaves = enabled && containsTuple(ast) ? collectTupleLeaves(ast) : [];
    if (leaves.length) {
      changed = true;
      tupleColumnIndexes.push(columnIndex);
      for (const leaf of leaves) {
        descriptors.push({
          columnIndex,
          name: `${safeColumns[columnIndex]}.${leaf.path.join(".")}`,
          type: leaf.type,
          get: (row) => leaf.extract(baseGetter(row)),
        });
      }
    } else {
      descriptors.push({
        columnIndex,
        name: safeColumns[columnIndex],
        type: safeTypes[columnIndex] || "",
        get: baseGetter,
      });
    }
  }

  return {
    changed,
    descriptors,
    tupleColumnIndexes,
    decodes,
    columns: descriptors.map((descriptor) => descriptor.name),
    types: descriptors.map((descriptor) => descriptor.type),
  };
}

// The function returns a row as the tables keep it.
// It parses the JSON text of a structured column once (decodeStructuredText).
// Then it splits the Tuple columns into their fields, when the plan flattens them. A row that needs neither change stays as the server sent it.
function flattenTupleRow(row, plan) {
  if (!plan) return row;
  const decodes = Array.isArray(plan.decodes) ? plan.decodes : [];
  if (!plan.changed && !(decodes.length && Array.isArray(row))) return row;
  let source = row;
  if (decodes.length && Array.isArray(row)) {
    source = row.slice();
    for (const { index, ast } of decodes) source[index] = decodeStructuredText(row[index], ast);
  }
  const out = plan.changed ? plan.descriptors.map((descriptor) => descriptor.get(source)) : source;
  if (row && typeof row === "object" && row.__chdashRowIndex) out.__chdashRowIndex = row.__chdashRowIndex;
  return out;
}

function flattenTupleTableData(columns, types, rows, enabled = state.runOptFlattenTuple !== false) {
  const plan = createTupleFlattenPlan(columns, types, enabled);
  const safeRows = Array.isArray(rows) ? rows : [];
  return {
    columns: plan.columns,
    types: plan.types,
    rows: plan.changed || plan.decodes.length ? safeRows.map((row) => flattenTupleRow(row, plan)) : safeRows,
    sourceColumnIndexes: plan.descriptors.map((descriptor) => descriptor.columnIndex),
    changed: plan.changed,
  };
}

function formatCellForDisplayWithTypes(raw, colIndex, typeAsts) {
  const text = valueText(raw, (typeAsts && typeAsts[colIndex]) || null);
  return text === null ? "null" : text;
}

function extractFiniteNumber(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const s = typeof raw === "string" ? raw.trim() : String(raw).trim();
  if (!s) return null;
  if (s.length > 2 && s[0] === "0" && (s[1] === "x" || s[1] === "X")) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// The bar spans the range of the column, from its baseline.
// The baseline is 0 for a column without negatives. Then the bars stay proportional to the values.
// Otherwise, the baseline is the most negative value.
// With -10, -3, 0, 5, 12, the -10 cell is empty and the 12 cell is full.
// `max` and `min` are the column's max(0, largest) and min(0, smallest).
function computeGaugeScale(n, max, min) {
  const range = max - min;
  if (!(range > 0) || n === null || n === undefined) return 0;
  let ratio = (n - min) / range;
  if (!Number.isFinite(ratio) || ratio <= 0) return 0;
  if (ratio > 1) ratio = 1;
  if (ratio < 0.001) ratio = 0.001;
  return ratio;
}

function extractDecimalScale(raw) {
  if (raw === null || raw === undefined) return 0;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return 0;
    const s = String(raw);
    if (s.includes("e") || s.includes("E")) return 0;
    const dot = s.indexOf(".");
    return dot >= 0 ? Math.max(0, s.length - dot - 1) : 0;
  }
  if (typeof raw !== "string") return 0;
  // Most cells have no dot, because they are integers. The code skips the trim and the RegExp for them.
  if (raw.indexOf(".") < 0) return 0;
  const s = raw.trim();
  if (!s) return 0;
  if (s.includes("e") || s.includes("E")) return 0;
  const m = s.match(/^[+-]?(?:\d+)?\.(\d+)$/);
  return m ? m[1].length : 0;
}

function formatNumericWithScale(raw, scale) {
  if (raw === null || raw === undefined) return "null";
  if (!scale) return String(raw);
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return String(raw);
    try {
      return raw.toFixed(scale);
    } catch {
      return String(raw);
    }
  }
  if (typeof raw !== "string") return String(raw);
  const s0 = raw.trim();
  if (!s0) return s0;
  if (!NUMERIC_RE.test(s0)) return s0;
  if (s0.includes("e") || s0.includes("E")) return s0;
  const dot = s0.indexOf(".");
  if (dot < 0) return s0 + "." + "0".repeat(scale);
  const head = s0.slice(0, dot);
  const tail = s0.slice(dot + 1);
  if (tail.length >= scale) return s0;
  return head + "." + tail + "0".repeat(scale - tail.length);
}

function formatNumericCellText(raw, colIndex, scaleArr) {
  const scale = (scaleArr && scaleArr[colIndex]) || 0;
  return formatNumericWithScale(raw, scale);
}

// The in-cell bar of a Query result cell (ns.table.cellBar).
// The bar starts at the lowest value of the column: (v - min) / (max - min).
// So the lowest value has an empty bar. A constant column has no fill.
// The bars are drawn once, when the stream has ended (gaugesEnabled).
// They use the minimum and maximum of the final rows. NULL has no bar.
function queryBarPercent(n, min, max) {
  if (n === null || n === undefined) return null;
  const range = max - min;
  if (!(range > 0)) return 0;
  return Math.max(0, Math.min(100, ((n - min) / range) * 100));
}

function isScalarNumericType(typeAst) {
  if (!typeAst || typeAst.kind !== "Scalar") return false;
  const name = String(typeAst.name ?? "");
  if (/^(?:U?Int)(?:8|16|32|64|128|256)$/.test(name)) return true;
  if (/^Float(?:32|64)$/.test(name)) return true;
  if (/^Decimal(?:32|64|128|256)?\(/.test(name)) return true;
  return false;
}

// Copy cell. A scalar stays as it is (a string raw, the digits of a UInt64). A structure becomes indented JSON.
// NULL becomes nothing.
function buildCopyValue(value, ast) {
  if (value === null || value === undefined) return "";
  return isScalarValue(value) ? scalarText(value) : jsonText(value, ast, 2);
}

export { resultCopyJsonText, JsonNumber, NUMERIC_RE, buildCopyValue, computeGaugeScale, createTupleFlattenPlan, decodeStructuredText, extractDecimalScale, extractFiniteNumber, flattenTupleRow, flattenTupleTableData, formatCellForDisplayWithTypes, formatNumericCellText, isScalarNumericType, isScalarValue, isStructuredType, jsonText, parseChType, parseJsonText, queryBarPercent, resultCsvText, resultJsonText, rowsAst, scalarText, serialize, valueText };
