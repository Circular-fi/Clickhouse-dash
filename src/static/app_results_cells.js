// The cells of a result table: a value as the table writes it (text, the NULL token, indented coloured JSON), and the gauge
// of a numeric column.

import { format } from "./app_format.js";
import { JsonNumber, computeGaugeScale, extractFiniteNumber, isScalarNumericType, isScalarValue, jsonText, queryBarPercent, scalarText } from "./app_results_values.js";
import { table as tableMod } from "./app_ui_table.js";

// A value in full, for the one-row view, a single value and the row details: a scalar as it is
// (a string keeps its backslashes and line breaks), a structure as indented, coloured JSON.
function renderValueInto(td, raw, ast) {
  if (raw === null || raw === undefined) {
    setNullCell(td);
    return;
  }
  if (!isScalarValue(raw)) {
    renderJsonHighlightedInto(td, jsonText(raw, ast, 4));
    td.removeAttribute("title");
    return;
  }
  const numeric = typeof raw === "number" || raw instanceof JsonNumber || isScalarNumericType(ast);
  const el = document.createElement("span");
  el.className = typeof raw === "boolean" ? "tok-kw" : numeric ? "tok-num" : "tok-str";
  el.textContent = scalarText(raw);
  td.replaceChildren(el);
  td.removeAttribute("title");
}

function renderSingleValueCell(td, raw, colIndex, typeAsts) {
  renderValueInto(td, raw, (typeAsts && typeAsts[colIndex]) || null);
}

function renderJsonHighlightedInto(td, text) {
  td.textContent = "";
  const frag = document.createDocumentFragment();

  function appendText(t) {
    if (!t) return;
    frag.appendChild(document.createTextNode(t));
  }

  function appendSpan(cls, t) {
    const el = document.createElement("span");
    el.className = cls;
    el.textContent = t;
    frag.appendChild(el);
  }

  const s = String(text ?? "");
  let i = 0;

  while (i < s.length) {
    const ch = s[i];

    if (ch === '"') {
      let j = i + 1;
      let esc = false;
      for (; j < s.length; j++) {
        const cj = s[j];
        if (esc) {
          esc = false;
          continue;
        }
        if (cj === "\\") {
          esc = true;
          continue;
        }
        if (cj === '"') {
          j++;
          break;
        }
      }
      let k = j;
      while (k < s.length) {
        const ck = s[k];
        if (ck === " " || ck === "\n" || ck === "\r" || ck === "\t") {
          k++;
          continue;
        }
        break;
      }
      const cls = k < s.length && s[k] === ":" ? "tok-kw" : "tok-str";
      appendSpan(cls, s.slice(i, j));
      i = j;
      continue;
    }

    if ((ch >= "0" && ch <= "9") || ch === "-") {
      const m = s.slice(i).match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/);
      if (m && m[0]) {
        appendSpan("tok-num", m[0]);
        i += m[0].length;
        continue;
      }
    }

    if (ch === "t" && s.startsWith("true", i)) {
      appendSpan("tok-kw", "true");
      i += 4;
      continue;
    }
    if (ch === "f" && s.startsWith("false", i)) {
      appendSpan("tok-kw", "false");
      i += 5;
      continue;
    }
    if (ch === "n" && s.startsWith("null", i)) {
      appendSpan("tok-null", "null");
      i += 4;
      continue;
    }

    if (ch === "{" || ch === "}" || ch === "[" || ch === "]" || ch === "(" || ch === ")" || ch === "," || ch === ":") {
      appendSpan("tok-com", ch);
      i++;
      continue;
    }

    appendText(ch);
    i++;
  }

  td.appendChild(frag);
}

function setCellTextFlat(td, text) {
  let s = "";
  if (text === null || text === undefined) s = "null";
  else if (typeof text === "string") s = text;
  else if (typeof text === "number" || typeof text === "boolean" || typeof text === "bigint") s = String(text);
  else if (typeof text === "object") {
    try { s = JSON.stringify(text); } catch { s = String(text); }
  } else s = String(text);

  const flat = s.replace(/\s+/g, " ").trim();
  td.textContent = flat;
  if (flat !== s && s.trim()) td.title = s;
  else td.removeAttribute("title");
}

// A SQL NULL cell shows the shared NULL token (ns.format.nullToken(), the
// chart tooltips' "NULL"); every other value stays as ClickHouse sent it.
let nullTemplate = null;

function setNullCell(td) {
  if (!nullTemplate) {
    nullTemplate = document.createElement("template");
    nullTemplate.innerHTML = format.nullToken();
  }
  td.replaceChildren(nullTemplate.content.cloneNode(true));
  td.removeAttribute("title");
}

function setDisplayCell(td, raw, text) {
  if (raw === null || raw === undefined) setNullCell(td);
  else setCellTextFlat(td, text);
}

function setQueryGaugeCell(td, raw, colIndex, text, maxArr, minArr) {
  td.classList.add("num");
  const percent = queryBarPercent(extractFiniteNumber(raw), minArr[colIndex], maxArr[colIndex]);
  if (percent !== null && tableMod) tableMod.cellBar(td, percent);
  setDisplayCell(td, raw, text);
}

// In-cell bar of a numeric cell of the other tables (createStaticResultTable:
// the Explorer, Traces): measures only, never on an identifier-like column
// or one holding a negative value (barEligible).
function setGaugeCell(td, raw, colIndex, text, maxArr, minArr, name = "") {
  td.classList.add("num");
  const min = minArr[colIndex] || 0;
  if (tableMod && tableMod.barEligible({ name, min })) {
    const n = extractFiniteNumber(raw);
    const scale = computeGaugeScale(n, maxArr[colIndex] || 0, min);
    tableMod.cellBar(td, scale > 0 ? scale * 100 : 0);
  }
  setDisplayCell(td, raw, text);
}

export { renderSingleValueCell, renderValueInto, setCellTextFlat, setDisplayCell, setGaugeCell, setNullCell, setQueryGaugeCell };
