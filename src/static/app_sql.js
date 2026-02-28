(() => {
  "use strict";

  const ns = window.ChDash;
  if (!ns) return;

  function normalizeStatementText(sql) {
    let s = String(sql || "").trim();
    while (s.endsWith(";")) s = s.slice(0, -1).trimEnd();
    return s;
  }

  function splitSqlStatements(sqlText) {
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

  function joinSqlStatements(statements) {
    const parts = Array.isArray(statements) ? statements.map(normalizeStatementText).filter(Boolean) : [];
    if (parts.length === 0) return "";
    if (parts.length === 1) return parts[0];
    return parts.join(";\n\n\n");
  }

  ns.sql = { normalizeStatementText, splitSqlStatements, joinSqlStatements };
})();