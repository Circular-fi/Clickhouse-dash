(() => {
  "use strict";

  const ns = window.ChDash;
  if (!ns) return;

  function normalizeStatementText(sql) {
    let s = String(sql || "").trim();
    while (s.endsWith(";")) s = s.slice(0, -1).trimEnd();
    return s;
  }

  function splitSqlStatementsJs(sqlText) {
    const s = String(sqlText || "");
    const out = [];
    let buf = "";

    let inSingle = false;
    let inDouble = false;
    let inBacktick = false;
    let inLineComment = false;
    let inBlockComment = false;

    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      const nx = i + 1 < s.length ? s[i + 1] : "";

      if (inLineComment) {
        buf += ch;
        if (ch === "\n") inLineComment = false;
        continue;
      }

      if (inBlockComment) {
        buf += ch;
        if (ch === "*" && nx === "/") {
          buf += nx;
          i++;
          inBlockComment = false;
        }
        continue;
      }

      if (inSingle) {
        buf += ch;
        if (ch === "\\") {
          if (nx) {
            buf += nx;
            i++;
          }
          continue;
        }
        if (ch === "'" && nx === "'") {
          buf += nx;
          i++;
          continue;
        }
        if (ch === "'") inSingle = false;
        continue;
      }

      if (inDouble) {
        buf += ch;
        if (ch === "\\") {
          if (nx) {
            buf += nx;
            i++;
          }
          continue;
        }
        if (ch === "\"") inDouble = false;
        continue;
      }

      if (inBacktick) {
        buf += ch;
        if (ch === "`") inBacktick = false;
        continue;
      }

      if (ch === "-" && nx === "-") {
        buf += ch + nx;
        i++;
        inLineComment = true;
        continue;
      }

      if (ch === "#") {
        buf += ch;
        inLineComment = true;
        continue;
      }

      if (ch === "/" && nx === "*") {
        buf += ch + nx;
        i++;
        inBlockComment = true;
        continue;
      }

      if (ch === "'") {
        buf += ch;
        inSingle = true;
        continue;
      }

      if (ch === "\"") {
        buf += ch;
        inDouble = true;
        continue;
      }

      if (ch === "`") {
        buf += ch;
        inBacktick = true;
        continue;
      }

      if (ch === ";") {
        const stmt = normalizeStatementText(buf);
        if (stmt) out.push(stmt);
        buf = "";
        continue;
      }

      buf += ch;
    }

    const tail = normalizeStatementText(buf);
    if (tail) out.push(tail);
    return out;
  }

  // A long script is cut by src/wasm/sqlscan.c (the same pieces: tests/frontend/specs/wasm-sql.spec.js); a short one by the
  // loop above, which is instant. Without the kernel the loop answers. The kernel loads with the editor's checks.
  const SPLIT_WASM_MIN_CHARS = 20000;

  // [start, end) pairs of the pieces between the ";" of the script, or null.
  function splitRangesWasm(text, minChars = SPLIT_WASM_MIN_CHARS) {
    if (text.length < minChars) return null;
    const kernel = ns.wasm && ns.wasm.get("sqlscan");
    if (!kernel || !ns.wasm.ops.sqlscan) return null;
    try {
      return ns.wasm.ops.sqlscan.split(kernel, { text });
    } catch (error) {
      return null;
    }
  }

  // The statements from the kernel, or null (no kernel yet, or the script is shorter than minChars).
  function splitSqlStatementsWasm(s, minChars = SPLIT_WASM_MIN_CHARS) {
    const rows = splitRangesWasm(s, minChars);
    if (!rows) return null;
    const out = [];
    for (let i = 0; i < rows.length; i += 2) {
      const stmt = normalizeStatementText(s.slice(rows[i], rows[i + 1]));
      if (stmt) out.push(stmt);
    }
    return out;
  }

  function splitSqlStatements(sqlText) {
    const s = String(sqlText || "");
    return splitSqlStatementsWasm(s) || splitSqlStatementsJs(s);
  }

  function joinSqlStatements(statements) {
    const parts = Array.isArray(statements) ? statements.map(normalizeStatementText).filter(Boolean) : [];
    if (parts.length === 0) return "";
    if (parts.length === 1) return parts[0];
    return parts.join(";\n\n");
  }

  // Leading spaces to tabs, as the editor shows a formatted query.
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

  // The text as the server's formatter writes it (POST /api/format, one statement at a time), in the
  // editor's layout. The History and the Save dialog use it for a query that was not formatted when
  // it was typed. It rejects when the formatter does (a script that does not parse): the caller
  // keeps the raw text.
  async function formatText(hostId, text) {
    const statements = splitSqlStatements(String(text || "").trim());
    if (!statements.length) return "";
    const formatted = await ns.api.formatSqls(hostId, statements);
    if (!Array.isArray(formatted) || formatted.length !== statements.length) throw new Error("Invalid format response.");
    return tabifyLeadingIndent(joinSqlStatements(formatted), 4);
  }

  ns.sql = { normalizeStatementText, splitSqlStatements, joinSqlStatements, splitSqlStatementsJs, splitSqlStatementsWasm, splitRangesWasm, splitWasmMinChars: SPLIT_WASM_MIN_CHARS, tabifyLeadingIndent, formatText };
})();