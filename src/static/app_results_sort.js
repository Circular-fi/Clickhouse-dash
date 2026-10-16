// The sort of the rows of a result. A numeric column is sorted as numbers. The text of a Decimal or of a big integer is compared as a number, and NaN goes last.
// A text column is sorted as text. The WebAssembly kernel sorts the numeric keys of a long result.

import { loader } from "./app_loader.js";
import { NUMERIC_RE } from "./app_results_values.js";
import { wasm } from "./app_wasm.js";

// The text of a Float value is sent by the API as a string (docs/telemetry.md, "Result values"). The infinities sort as numbers.
// NaN sorts with the NULLs, last.
const FLOAT_WORDS = new Map([["inf", Infinity], ["+inf", Infinity], ["-inf", -Infinity], ["nan", NaN], ["-nan", NaN], ["+nan", NaN]]);
const DECIMAL_TEXT = /^([+-]?)0*(\d*?)(?:\.(\d*?)0*)?$/;

// A double cannot hold these digits. A Decimal(38, 9) text is compared as text (compareDecimalText).
function longDecimalText(text) {
  if (text.indexOf(".") < 0 || !NUMERIC_RE.test(text) || /[eE]/.test(text)) return false;
  return text.replace(/[^0-9]/g, "").replace(/^0+/, "").length > 15;
}

// Two decimal texts (digits, one dot, a sign) are compared exactly.
function compareDecimalText(a, b) {
  const ma = DECIMAL_TEXT.exec(a);
  const mb = DECIMAL_TEXT.exec(b);
  if (!ma || !mb) return a < b ? -1 : a > b ? 1 : 0;
  const zero = (m) => !m[2] && !m[3];
  const sa = ma[1] === "-" && !zero(ma) ? -1 : 1;
  const sb = mb[1] === "-" && !zero(mb) ? -1 : 1;
  if (sa !== sb) return sa < sb ? -1 : 1;
  let cmp = 0;
  if (ma[2].length !== mb[2].length) cmp = ma[2].length < mb[2].length ? -1 : 1;
  else if (ma[2] !== mb[2]) cmp = ma[2] < mb[2] ? -1 : 1;
  else {
    const fa = ma[3] || "";
    const fb = mb[3] || "";
    cmp = fa < fb ? -1 : fa > fb ? 1 : 0;
  }
  return sa < 0 ? -cmp : cmp;
}

function normalizeNumericForSort(raw) {
  if (raw === null || raw === undefined) return { t: "z", v: null };
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return { t: "z", v: null };
    return { t: "n", v: raw };
  }
  const s = typeof raw === "string" ? raw.trim() : String(raw).trim();
  if (!s) return { t: "z", v: null };
  const word = FLOAT_WORDS.get(s.toLowerCase());
  if (word !== undefined) return Number.isNaN(word) ? { t: "z", v: null } : { t: "n", v: word };
  if (longDecimalText(s)) return { t: "d", v: s };
  if (/^[+-]?\d+$/.test(s)) {
    try {
      return { t: "bi", v: BigInt(s) };
    } catch {
      return { t: "s", v: s.toLowerCase() };
    }
  }
  if (NUMERIC_RE.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return { t: "n", v: n };
  }
  return { t: "s", v: s.toLowerCase() };
}

function compareNumericForSort(a, b) {
  const na = normalizeNumericForSort(a);
  const nb = normalizeNumericForSort(b);

  if (na.t === "z" && nb.t === "z") return 0;
  if (na.t === "z") return 1;
  if (nb.t === "z") return -1;

  if (na.t === "bi" && nb.t === "bi") return na.v < nb.v ? -1 : na.v > nb.v ? 1 : 0;

  if (na.t === "d" || nb.t === "d") {
    if (na.t !== "s" && nb.t !== "s") {
      const text = (x) => (x.t === "bi" ? x.v.toString() : x.t === "n" && Number.isFinite(x.v) && !/e/i.test(String(x.v)) ? String(x.v) : null);
      const ta = na.t === "d" ? na.v : text(na);
      const tb = nb.t === "d" ? nb.v : text(nb);
      if (ta !== null && tb !== null) return compareDecimalText(ta, tb);
      const an = Number(na.v);
      const bn = Number(nb.v);
      return an < bn ? -1 : an > bn ? 1 : 0;
    }
  }

  if (na.t === "n" && nb.t === "n") return na.v < nb.v ? -1 : na.v > nb.v ? 1 : 0;

  if (na.t === "bi" && nb.t === "n") {
    if (Number.isSafeInteger(nb.v)) {
      const bbi = BigInt(nb.v);
      return na.v < bbi ? -1 : na.v > bbi ? 1 : 0;
    }
    const an = Number(na.v);
    if (Number.isFinite(an)) return an < nb.v ? -1 : an > nb.v ? 1 : 0;
  }

  if (na.t === "n" && nb.t === "bi") {
    if (Number.isSafeInteger(na.v)) {
      const abi = BigInt(na.v);
      return abi < nb.v ? -1 : abi > nb.v ? 1 : 0;
    }
    const bn = Number(nb.v);
    if (Number.isFinite(bn)) return na.v < bn ? -1 : na.v > bn ? 1 : 0;
  }

  const sa = na.t === "bi" ? na.v.toString() : String(na.v);
  const sb = nb.t === "bi" ? nb.v.toString() : String(nb.v);

  if (sa.length !== sb.length) return sa.length < sb.length ? -1 : 1;
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return 0;
}

function compareTextForSort(a, b) {
  const sa = String(a ?? "");
  const sb = String(b ?? "");
  const la = sa.toLowerCase();
  const lb = sb.toLowerCase();
  if (la < lb) return -1;
  if (la > lb) return 1;
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return 0;
}

// ----------------------------------------------------------- numeric sort keys
// A numeric column is sorted by compareNumericForSort. This function normalises both values on every comparison (a regular expression and a BigInt).
// The sort makes O(n log n) of these comparisons.
//
// When every value is null, a number, a numeric string, or an integer string of at most 2^53, the comparison uses plain doubles.
// This is the usual case. Nulls go last. The values are read once into a Float64Array.
//
// The rows are then ordered by these keys: orderByKeysJs, or the kernel of src/wasm/rowsort.c (orderByKeysWasm) for long results.
// Any other value (text in a numeric column, a huge integer) uses the comparator path. The order is therefore the same for every input.
const SORT_WASM_MIN_ROWS = 5000;
const SAFE_INTEGER_TEXT = /^[+-]?\d+$/;
let sortKernelAsked = false;
let sortWasmEnabled = true;

function requestSortKernel() {
  if (sortKernelAsked || typeof WebAssembly !== "object" || !loader) return;
  sortKernelAsked = true;
  Promise.resolve(loader.loadGroup("wasm-rowsort"))
    .then(() => (wasm && wasm.ops.rowsort ? wasm.load("rowsort") : null))
    .catch(() => {});
}

// { vals: Float64Array, nulls: Uint8Array }, or null when a value needs the comparator.
function numericSortKeys(rows, key) {
  const n = rows.length;
  const vals = new Float64Array(n);
  const nulls = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const row = rows[i];
    const raw = key === -1 ? row.__chdashRowIndex : row[key];
    if (typeof raw === "number") {
      if (Number.isFinite(raw)) vals[i] = raw; else nulls[i] = 1;
      continue;
    }
    if (raw === null || raw === undefined) { nulls[i] = 1; continue; }
    const text = typeof raw === "string" ? raw.trim() : String(raw).trim();
    if (!text) { nulls[i] = 1; continue; }
    const word = FLOAT_WORDS.get(text.toLowerCase());
    if (word !== undefined) {
      if (Number.isNaN(word)) nulls[i] = 1; else vals[i] = word;
      continue;
    }
    if (longDecimalText(text)) return null;
    if (SAFE_INTEGER_TEXT.test(text)) {
      const v = Number(text);
      if (!Number.isSafeInteger(v)) return null;
      vals[i] = v;
      continue;
    }
    if (!NUMERIC_RE.test(text)) return null;
    const v = Number(text);
    if (!Number.isFinite(v)) return null;
    vals[i] = v;
  }
  return { vals, nulls };
}

// The order (row positions) that rows.sort(compare) gives, from the keys. Values ascend, with nulls last. Equal keys
// are ordered by __chdashRowIndex. Descending is the reverse comparison. The ties are included.
function orderByKeysJs(rows, keys, desc) {
  const { vals, nulls } = keys;
  const n = rows.length;
  const rank = new Float64Array(n);
  for (let i = 0; i < n; i++) rank[i] = rows[i].__chdashRowIndex || 0;
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => {
    let cmp = 0;
    if (nulls[a] !== nulls[b]) cmp = nulls[a] ? 1 : -1;
    else if (!nulls[a]) cmp = vals[a] < vals[b] ? -1 : vals[a] > vals[b] ? 1 : 0;
    if (cmp === 0) cmp = rank[a] - rank[b];
    return desc ? -cmp : cmp;
  });
  return order;
}

function orderByKeysWasm(rows, keys, desc) {
  const kernel = wasm && wasm.get("rowsort");
  if (!kernel || !wasm.ops.rowsort) return null;
  try {
    const n = rows.length;
    const rank = new Float64Array(n);
    for (let i = 0; i < n; i++) rank[i] = rows[i].__chdashRowIndex || 0;
    return wasm.ops.rowsort.numeric(kernel, { vals: keys.vals, nulls: keys.nulls, rank, desc });
  } catch (error) {
    return null;
  }
}

// Sorts rows by one numeric column. The array order is the same as rows.slice().sort(comparator).
function sortNumericRows(allRows, key, dir) {
  const rows = allRows.slice();
  const desc = dir === "desc";
  const keys = rows.length > 1 ? numericSortKeys(rows, key) : null;
  if (keys) {
    if (rows.length >= SORT_WASM_MIN_ROWS) requestSortKernel();
    const order = (sortWasmEnabled && rows.length >= SORT_WASM_MIN_ROWS && orderByKeysWasm(rows, keys, desc)) || orderByKeysJs(rows, keys, desc);
    const out = new Array(rows.length);
    for (let i = 0; i < out.length; i++) out[i] = rows[order[i]];
    return out;
  }
  return sortNumericRowsByComparator(rows, key, desc);
}

// The reference. Every comparison normalises both values.
function sortNumericRowsByComparator(rows, key, desc) {
  rows.sort((a, b) => {
    const av = key === -1 ? a.__chdashRowIndex : a[key];
    const bv = key === -1 ? b.__chdashRowIndex : b[key];
    let cmp = compareNumericForSort(av, bv);
    if (cmp === 0) cmp = (a.__chdashRowIndex || 0) - (b.__chdashRowIndex || 0);
    return desc ? -cmp : cmp;
  });
  return rows;
}

// A text column is ordered by compareTextForSort. The order uses the lower-cased text, then the text, then the row number.
// The strings are made once. JavaScript lower-cases them, and it knows Unicode. The module orders them by orderTextJs.
// This gives the same order as the comparator path (sortTextRowsByComparator), in a third of the time.
//
// A WebAssembly merge sort of the same strings was measured. It is not faster, because the copy of the strings and the cache misses cost as much as the comparison.
// So text columns stay in JavaScript (docs/wasm.md).
function orderTextJs(lower, text, rank, desc) {
  const n = lower.length;
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => {
    let cmp = 0;
    if (lower[a] < lower[b]) cmp = -1;
    else if (lower[a] > lower[b]) cmp = 1;
    else if (text[a] < text[b]) cmp = -1;
    else if (text[a] > text[b]) cmp = 1;
    if (cmp === 0) cmp = rank[a] - rank[b];
    return desc ? -cmp : cmp;
  });
  return order;
}

// Sorts rows by the text of one column. textOf(row) gives the text that the comparator would compare.
function sortTextRows(allRows, key, dir, textOf) {
  const rows = allRows.slice();
  const desc = dir === "desc";
  const n = rows.length;
  if (n < 2) return rows;
  const text = new Array(n);
  const lower = new Array(n);
  const rank = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const s = String(textOf(rows[i], key) ?? "");
    text[i] = s;
    lower[i] = s.toLowerCase();
    rank[i] = rows[i].__chdashRowIndex || 0;
  }
  const order = orderTextJs(lower, text, rank, desc);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = rows[order[i]];
  return out;
}

// The reference. Every comparison lower-cases both texts.
function sortTextRowsByComparator(rows, key, desc, textOf) {
  rows.sort((a, b) => {
    let cmp = compareTextForSort(String(textOf(a, key) ?? ""), String(textOf(b, key) ?? ""));
    if (cmp === 0) cmp = (a.__chdashRowIndex || 0) - (b.__chdashRowIndex || 0);
    return desc ? -cmp : cmp;
  });
  return rows;
}

// The tests disable the kernel to compare both paths (tests/frontend/specs/wasm-rowsort.spec.js).
function setSortWasm(on) {
  sortWasmEnabled = !!on;
}

export { SORT_WASM_MIN_ROWS, compareNumericForSort, compareTextForSort, numericSortKeys, orderByKeysJs, orderByKeysWasm, requestSortKernel, setSortWasm, sortNumericRows, sortNumericRowsByComparator, sortTextRows, sortTextRowsByComparator };
