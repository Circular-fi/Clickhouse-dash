// The one SQL lexer of the page (ARCH-F-089). Everything on the page that has to tell the code of a statement from its
// comments, its strings and its names reads the text through this module: the highlighter (app_highlight.js), the
// autocomplete and its diagnostics (app_autocomplete.js), the cut of a script into statements (app_sql.js, app_run.js),
// the types of a result column (app_results.js) and the SQL of the Explorer card (app_explorer_detail_model.js).
//
// It is the reference of the WebAssembly kernels. src/wasm/highlight.c and src/wasm/sqlscan.c read the text with the same
// rules, byte for byte (tests/frontend/model/sql-lex-vectors.json holds cases that this module, the kernels and the native
// test of the backend lexer read): a change here is a change there.
//
// The rules are those of the text that a person types in the editor. The backend lexer (src/sql_lexer.hpp) follows
// ClickHouse; the page and the backend differ on purpose in four places (and in the line break of a comment), because
// the page colours and cuts text that the server has not read yet:
//   1. A "#" starts a line comment wherever it is (ClickHouse: only before a blank or "!"). The page shows a "#" that
//      is not a comment as one, which tells the person that the server will refuse it.
//   2. A block comment does not nest: /* a /* b */ c */ ends at the first "*/" (ClickHouse: it nests).
//   3. $tag$ ... $tag$ is not a text (ClickHouse: it is). A $ is a letter of a word.
//   4. A backslash in a name in backticks is a character (ClickHouse: it escapes). Text that the server wrote
//      (the DDL of a table) uses the ClickHouse rules: spans(text, { clickhouse: true }) escapes there, and a doubled
//      quote is part of the name.
//   And a line comment ends at "\n" only; ClickHouse ends it at "\r" too.
//
// The spans, in the order of the text (a position is a UTF-16 index, as in the editor):
//   LINE       "--" or "#" to the end of the line (the line break is part of it)
//   BLOCK      /* ... */
//   STRING     'text': a backslash escapes the next character, '' is one quote
//   DQUOTE     "name": a backslash escapes the next character ("" is two names side by side)
//   BACKTICK   `name`: no escape
// A span that the text ends before it closes runs to the end of the text.
//
// A function of this module takes `text` and does not keep it; none changes it.

const LINE = 1;
const BLOCK = 2;
const STRING = 3;
const DQUOTE = 4;
const BACKTICK = 5;

// What can start a span: the code units to look for between two spans.
const STARTS = /[-#/'"`]/g;

// Whether the run that quotedEnd() read last found its closing quote.
let quoteClosed = false;

// The end of the quoted run that starts at text[at] (one of ' " `): the index after its closing quote, or the length.
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
      // '' is one quote of the text; "" and `` are two names side by side, but one name of the DDL of the server.
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

// The span that starts exactly at `at`: [kind, end, closed], or null. closed: the text holds the end of the span.
function spanAt(text, at, clickhouse = false) {
  const c = text.charCodeAt(at);
  if (c === 45) {
    if (text.charCodeAt(at + 1) !== 45) return null;
  } else if (c === 47) {
    if (text.charCodeAt(at + 1) !== 42) return null;
    const close = text.indexOf("*/", at + 2);
    return [BLOCK, close < 0 ? text.length : close + 2, close >= 0];
  } else if (c === 35) {
    // falls to the line comment below
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

// The next span that starts at or after `from`: { kind, start, end, closed }, or null. Scanning from a position that is inside a span
// reads the rest of it as text: start from a position that is not (0, the end of a span, the start of a token).
function nextSpan(text, from = 0, clickhouse = false) {
  STARTS.lastIndex = from;
  let match;
  while ((match = STARTS.exec(text))) {
    const found = spanAt(text, match.index, clickhouse);
    if (found) return { kind: found[0], start: match.index, end: found[1], closed: found[2] };
    // A "-" that is not "--" or a "/" that is not "/*": the scan goes on after it.
  }
  return null;
}

// Every span of the text, in order: an array of { kind, start, end, closed }.
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

// The text with its comments and its strings written as spaces (a line break stays: positions and lines are the text's).
// The names ("..." and `...`) stay: the diagnostics look for the tables and the columns that they name. They are read as
// units, so a quote or a "--" inside a name is nothing. `names: true` blanks them too.
function mask(text, { names = false } = {}) {
  const s = String(text ?? "");
  let out = "";
  let written = 0;
  let scan = 0;
  for (let span = nextSpan(s, scan); span; span = nextSpan(s, scan)) {
    scan = span.end;
    // A name is read as a unit, and written as it is unless the caller asks for it blank.
    if ((span.kind === DQUOTE || span.kind === BACKTICK) && !names) continue;
    out += s.slice(written, span.start) + s.slice(span.start, span.end).replace(/[^\n]/g, " ");
    written = span.end;
  }
  return out + s.slice(written);
}

// The scan that the statement functions share. It calls visit(index, character) for every character of the text that
// is code (not inside a span), in order, and stops when visit returns true. Returns the index where it stopped, or the
// length.
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

// { start, end } of the statement around `pos`: it starts after the last ";" that is code at depth 0 before pos and ends at
// the first one at or after it (the end of the text without one). The depth counts the parentheses of the code from the
// start of the text.
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

// The start of the last statement of the text (what is before the cursor, when the text ends at the cursor).
function statementStart(text) {
  const s = String(text ?? "");
  return statementAt(s, s.length).start;
}

// The pieces of a script between its ";" that are code, as [start, end) pairs (a script with n ";" has n + 1 pieces, empty
// ones included; a ";" inside a parenthesis cuts too).
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

// The index of the parenthesis that closes the one at text[open], or -1. Parentheses in a string, a name or a comment
// do not count.
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

// The text cut at the separator where it is code at depth 0 (the depth counts "(" and ")"; brackets and braces when
// `brackets` is true: a type, a default, a key). Each piece is trimmed, with its place in the text (+ base); the empty
// pieces are dropped. Returns [{ text, start, end }].
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
