// The one SQL lexer of the page (ARCH-F-089). Each part of the page that must tell the code of a statement from its
// comments, its strings and its names reads the text through this module.
// These parts are:
//   - the highlighter (app_highlight.js);
//   - the autocomplete and its diagnostics (app_autocomplete.js);
//   - the cut of a script into statements (app_sql.js, app_run.js);
//   - the types of a result column (app_results.js);
//   - the SQL of the Explorer card (app_explorer_detail_model.js).
//
// This module is the reference of the WebAssembly kernels. The files src/wasm/highlight.c and src/wasm/sqlscan.c read the
// text with the same rules, byte for byte. The file tests/frontend/model/sql-lex-vectors.json holds test cases. This module,
// the kernels and the native test of the backend lexer read these cases. A change here must also be a change in the kernels.
//
// The rules are those of the text that a person types in the editor. The backend lexer (src/sql_lexer.hpp) follows
// ClickHouse. The page and the backend differ on purpose in four places, and in the line break of a comment. This is
// because the page colours and cuts text that the server has not read yet:
//   1. A "#" starts a line comment wherever it is (ClickHouse: only before a blank or "!").
//      The page shows a "#" that is not a comment as a comment. This tells the person that the server refuses it.
//   2. A block comment does not nest: /* a /* b */ c */ ends at the first "*/" (ClickHouse: it nests).
//   3. $tag$ ... $tag$ is not a text (ClickHouse: it is). A $ is a letter of a word.
//   4. A backslash in a name in backticks is a character (ClickHouse: it escapes).
//      For text that the server wrote (the DDL of a table), call spans(text, { clickhouse: true }).
//      That call uses the ClickHouse escapes. In that text, a doubled quote is part of the name.
// A line comment ends at "\n" only. ClickHouse also ends it at "\r".
//
// The spans follow the order of the text. A position is a UTF-16 index, as in the editor:
//   LINE       "--" or "#" to the end of the line. The line break is part of the span.
//   BLOCK      /* ... */
//   STRING     'text'. A backslash escapes the next character. '' is one quote.
//   DQUOTE     "name". A backslash escapes the next character. "" is two names side by side.
//   BACKTICK   `name`. No escape.
// A span that the text does not close runs to the end of the text.

const LINE = 1;
const BLOCK = 2;
const STRING = 3;
const DQUOTE = 4;
const BACKTICK = 5;

// The code units that can start a span. The scan looks for them between two spans.
const STARTS = /[-#/'"`]/g;

// True when the run that quotedEnd() read last found its closing quote.
let quoteClosed = false;

// The end of the quoted run that starts at text[at] (one of ' " `). It is the index after the closing quote, or the length.
function quotedEnd(text, at, clickhouse) {
  quoteClosed = false;
  const quote = text.charCodeAt(at);
  const length = text.length;
  const escapes = clickhouse || quote !== 96;
  let i = at + 1;
  while (i < length) {
    const c = text.charCodeAt(i);
    if (c === 92 && escapes) {
      i += 2;
      continue;
    }
    if (c === quote) {
      // '' is one quote of the text. "" and `` are two names side by side. In the DDL of the server, they are one name.
      if ((quote === 39 || clickhouse) && text.charCodeAt(i + 1) === quote) {
        i += 2;
        continue;
      }
      quoteClosed = true;
      return i + 1;
    }
    i += 1;
  }
  return length;
}

// The span that starts exactly at `at`: [kind, end, closed]. It returns null when no span starts there.
// closed is true when the text holds the end of the span.
function spanAt(text, at, clickhouse = false) {
  const c = text.charCodeAt(at);
  if (c === 45) {
    if (text.charCodeAt(at + 1) !== 45) return null;
  } else if (c === 47) {
    if (text.charCodeAt(at + 1) !== 42) return null;
    const close = text.indexOf("*/", at + 2);
    return [BLOCK, close < 0 ? text.length : close + 2, close >= 0];
  } else if (c === 35) {
    // Fall through to the line comment below.
  } else if (c === 39) {
    const end = quotedEnd(text, at, clickhouse);
    return [STRING, end, quoteClosed];
  } else if (c === 34) {
    const end = quotedEnd(text, at, clickhouse);
    return [DQUOTE, end, quoteClosed];
  } else if (c === 96) {
    const end = quotedEnd(text, at, clickhouse);
    return [BACKTICK, end, quoteClosed];
  } else {
    return null;
  }
  const nl = text.indexOf("\n", at);
  return [LINE, nl < 0 ? text.length : nl + 1, nl >= 0];
}

// The next span that starts at or after `from`: { kind, start, end, closed }. It returns null when no span is left.
// Do not start the scan inside a span. A scan from such a position reads the rest of the span as text.
// Start from 0, the end of a span or the start of a token.
function nextSpan(text, from = 0, clickhouse = false) {
  STARTS.lastIndex = from;
  let match;
  while ((match = STARTS.exec(text))) {
    const found = spanAt(text, match.index, clickhouse);
    if (found) return { kind: found[0], start: match.index, end: found[1], closed: found[2] };
    // A "-" that is not "--", or a "/" that is not "/*", does not start a span. The scan goes on after it.
  }
  return null;
}

// Every span of the text, in order. The result is an array of { kind, start, end, closed }.
function spans(text, { clickhouse = false } = {}) {
  const s = String(text ?? "");
  const out = [];
  let from = 0;
  for (let span = nextSpan(s, from, clickhouse); span; span = nextSpan(s, from, clickhouse)) {
    out.push(span);
    from = span.end;
  }
  return out;
}

// The text with its comments and its strings written as spaces. A line break stays, so positions and lines match the text.
// The names ("..." and `...`) stay. The diagnostics look for the tables and the columns that the names refer to.
// The names are read as units. A quote or a "--" inside a name is not a span. Set `names: true` to blank them too.
function mask(text, { names = false } = {}) {
  const s = String(text ?? "");
  let out = "";
  let written = 0;
  let scan = 0;
  for (let span = nextSpan(s, scan); span; span = nextSpan(s, scan)) {
    scan = span.end;
    // A name is read as a unit. It is written as it is, unless the caller asks for it blank.
    if ((span.kind === DQUOTE || span.kind === BACKTICK) && !names) continue;
    out += s.slice(written, span.start) + s.slice(span.start, span.end).replace(/[^\n]/g, " ");
    written = span.end;
  }
  return out + s.slice(written);
}

// The scan that the statement functions share. It calls visit(index, character) for each character of the text that is code.
// A character inside a span is skipped. The scan stops when visit returns true.
// It returns the index where it stopped, or the length.
function eachCode(text, visit, from = 0) {
  let i = from;
  const length = text.length;
  while (i < length) {
    const span = nextSpan(text, i);
    const stop = span ? span.start : length;
    for (; i < stop; i += 1) if (visit(i, text.charCodeAt(i))) return i;
    if (!span) break;
    i = span.end;
  }
  return length;
}

// { start, end } of the statement around `pos`. The statement starts after the last ";" that is code at depth 0 before pos.
// It ends at the first ";" at or after pos. Without such a ";", it ends at the end of the text.
// The depth counts the parentheses of the code from the start of the text.
function statementAt(text, pos = null) {
  const s = String(text ?? "");
  const cursor = Math.max(0, Math.min(s.length, pos == null ? s.length : Math.trunc(Number(pos)) || 0));
  let start = 0;
  let end = s.length;
  let depth = 0;
  eachCode(s, (i, c) => {
    if (c === 40) depth += 1;
    else if (c === 41) depth = depth > 0 ? depth - 1 : 0;
    else if (c === 59 && depth === 0) {
      if (i < cursor) {
        start = i + 1;
        return false;
      }
      end = i;
      return true;
    }
    return false;
  });
  return { start, end };
}

// The start of the last statement of the text. This is the statement before the cursor, when the text ends at the cursor.
function statementStart(text) {
  const s = String(text ?? "");
  return statementAt(s, s.length).start;
}

// The pieces of a script between its ";" that are code. Each piece is a [start, end) pair.
// A script with n ";" has n + 1 pieces, and empty pieces are included. A ";" inside a parenthesis also cuts the script.
function splitRanges(text) {
  const s = String(text ?? "");
  const out = [];
  let start = 0;
  eachCode(s, (i, c) => {
    if (c === 59) {
      out.push([start, i]);
      start = i + 1;
    }
    return false;
  });
  out.push([start, s.length]);
  return out;
}

// The index of the parenthesis that closes the one at text[open]. It returns -1 when no parenthesis closes it.
// Parentheses in a string, a name or a comment do not count.
function matchParen(text, open) {
  const s = String(text ?? "");
  let depth = 0;
  let found = -1;
  eachCode(s, (i, c) => {
    if (c === 40) depth += 1;
    else if (c === 41) {
      depth -= 1;
      if (depth === 0) {
        found = i;
        return true;
      }
    }
    return false;
  }, open);
  return found;
}

// The text cut at each separator that is code at depth 0. The depth counts "(" and ")".
// When `brackets` is true, it also counts brackets and braces: a type, a default or a key.
// Each piece is trimmed. Its place in the text is shown by `start` and `end`, plus base. Empty pieces are dropped.
// The function returns [{ text, start, end }].
function splitTopLevel(text, separator = ",", { base = 0, brackets = false, clickhouse = false } = {}) {
  const s = String(text ?? "");
  const out = [];
  const sep = String(separator).charCodeAt(0);
  let depth = 0;
  let start = 0;
  const push = (end) => {
    let a = start;
    let b = end;
    while (a < b && /\s/.test(s[a])) a += 1;
    while (b > a && /\s/.test(s[b - 1])) b -= 1;
    if (b > a) out.push({ text: s.slice(a, b), start: base + a, end: base + b });
  };
  let i = 0;
  const length = s.length;
  while (i < length) {
    const span = nextSpan(s, i, clickhouse);
    const stop = span ? span.start : length;
    for (; i < stop; i += 1) {
      const c = s.charCodeAt(i);
      if (c === 40 || (brackets && (c === 91 || c === 123))) depth += 1;
      else if (c === 41 || (brackets && (c === 93 || c === 125))) depth = depth > 0 ? depth - 1 : 0;
      else if (c === sep && depth === 0) {
        push(i);
        start = i + 1;
      }
    }
    if (!span) break;
    i = span.end;
  }
  push(length);
  return out;
}

export const sqlLex = Object.freeze({
  LINE, BLOCK, STRING, DQUOTE, BACKTICK,
  spanAt, nextSpan, spans, mask, statementAt, statementStart, splitRanges, matchParen, splitTopLevel,
});
