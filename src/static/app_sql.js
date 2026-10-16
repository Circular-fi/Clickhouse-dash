import { api } from "./app_api.js";
import { sqlLex } from "./app_sql_lex.js";
import { wasm } from "./app_wasm.js";

function normalizeStatementText(sql) {
  let s = String(sql || "").trim();
  while (s.endsWith(";")) s = s.slice(0, -1).trimEnd();
  return s;
}

// The statements of a script. The one SQL lexer (app_sql_lex.js) cuts the script at each ";".
// A ";" in a string, a name or a comment cuts nothing.
// Each statement is trimmed. It has the place of its text in the script: { text, start, end }.
// Empty statements are dropped.
// `ranges`: the [start, end) pieces of the script between its ";".
function statementSpans(s, ranges) {
  const out = [];
  for (const [a, b] of ranges) {
    const raw = s.slice(a, b);
    const text = normalizeStatementText(raw);
    if (!text) continue;
    let from = 0;
    while (from < raw.length && isBlank(raw[from])) from += 1;
    let to = raw.length;
    while (to > from && isBlank(raw[to - 1])) to -= 1;
    out.push({ text, start: a + from, end: a + to });
  }
  return out;
}

const isBlank = (c) => c === " " || c === "\t" || c === "\n" || c === "\r";

function splitStatementSpansJs(sqlText) {
  const s = String(sqlText || "");
  return statementSpans(s, sqlLex.splitRanges(s));
}

function splitSqlStatementsJs(sqlText) {
  return splitStatementSpansJs(sqlText).map((span) => span.text);
}

// The kernel in src/wasm/sqlscan.c cuts a long script. It gives the same pieces as tests/frontend/specs/wasm-sql.spec.js.
// The loop above cuts a short script. The loop is quick. Without the kernel, the loop gives the answer. The editor checks load the kernel.
const SPLIT_WASM_MIN_CHARS = 20000;

// [start, end) pairs of the pieces between the ";" of the script, or null.
function splitRangesWasm(text, minChars = SPLIT_WASM_MIN_CHARS) {
  if (text.length < minChars) return null;
  const kernel = wasm && wasm.get("sqlscan");
  if (!kernel || !wasm.ops.sqlscan) return null;
  try {
    return wasm.ops.sqlscan.split(kernel, { text });
  } catch (error) {
    return null;
  }
}

// The statements of the script, with their places, from the kernel.
// The result is null when the kernel is not loaded yet.
// The result is also null when the script is shorter than minChars.
function splitStatementSpansWasm(s, minChars = SPLIT_WASM_MIN_CHARS) {
  const rows = splitRangesWasm(s, minChars);
  if (!rows) return null;
  const pairs = [];
  for (let i = 0; i < rows.length; i += 2) pairs.push([rows[i], rows[i + 1]]);
  return statementSpans(s, pairs);
}

// The statements from the kernel, or null.
function splitSqlStatementsWasm(s, minChars = SPLIT_WASM_MIN_CHARS) {
  const spans = splitStatementSpansWasm(s, minChars);
  return spans ? spans.map((span) => span.text) : null;
}

function splitStatementSpans(sqlText) {
  const s = String(sqlText || "");
  return splitStatementSpansWasm(s) || splitStatementSpansJs(s);
}

function splitSqlStatements(sqlText) {
  return splitStatementSpans(sqlText).map((span) => span.text);
}

function joinSqlStatements(statements) {
  const parts = Array.isArray(statements) ? statements.map(normalizeStatementText).filter(Boolean) : [];
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  return parts.join(";\n\n");
}

// Convert leading spaces to tabs. The editor shows a formatted query this way.
function tabifyLeadingIndent(text, tabWidth = 4) {
  const lines = String(text ?? "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const lead = lines[i].match(/^( +)/);
    if (!lead) continue;
    const tabs = Math.floor(lead[1].length / tabWidth);
    if (tabs > 0) lines[i] = "\t".repeat(tabs) + " ".repeat(lead[1].length % tabWidth) + lines[i].slice(lead[1].length);
  }
  return lines.join("\n");
}

// The server formatter writes the text in the editor layout. The formatter gets one statement at a time (POST /api/format).
// The History and the Save dialog use this text for a query that was not formatted when it was typed.
// The function rejects when the formatter does, for example for a script that does not parse.
// The caller then keeps the raw text.
async function formatText(hostId, text) {
  const statements = splitSqlStatements(String(text || "").trim());
  if (!statements.length) return "";
  const formatted = await api.formatSqls(hostId, statements);
  if (!Array.isArray(formatted) || formatted.length !== statements.length) throw new Error("Invalid format response.");
  return tabifyLeadingIndent(joinSqlStatements(formatted), 4);
}

export const sql = { normalizeStatementText, splitSqlStatements, joinSqlStatements, splitSqlStatementsJs, splitSqlStatementsWasm, splitStatementSpans, splitStatementSpansJs, splitStatementSpansWasm, splitRangesWasm, splitWasmMinChars: SPLIT_WASM_MIN_CHARS, tabifyLeadingIndent, formatText };
