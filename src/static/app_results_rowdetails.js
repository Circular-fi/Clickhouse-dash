// What a row of a result table offers: the right-click menu (copy the cell, the row, the column; the links to the traces that
// the row names) and the row details that open under the row, the keyboard rows, and the virtual body that keeps the details
// in place (docs/ui-foundations.md, "Row details").

import { api } from "./app_api.js";
import { renderSingleValueCell } from "./app_results_cells.js";
import { buildCopyValue, jsonText, rowsAst } from "./app_results_values.js";
import { router } from "./app_router.js";
import { features } from "./app_state.js";
import { copy as copyMod } from "./app_ui_copy.js";
import { icon } from "./app_ui_icon.js";
import { kv } from "./app_ui_kv.js";
import { menu } from "./app_ui_menu.js";
import { table as tableMod } from "./app_ui_table.js";

function findVerticalScrollOwner(el) {
  let current = el?.parentElement || null;
  while (current && current !== document.body && current !== document.documentElement) {
    const style = window.getComputedStyle ? window.getComputedStyle(current) : null;
    const overflowY = String(style?.overflowY || "");
    if (/(auto|scroll|overlay)/.test(overflowY) && current.scrollHeight > current.clientHeight + 1) return current;
    current = current.parentElement;
  }
  return null;
}

// --- Row details: right-click a result row > "Details" ------------------
// The row expands in place: a detail <tr> (one <td colspan>) is inserted
// right after its data row and shows the row vertically, like a one-row
// result. Rows are bound to their data through a WeakMap instead of being
// referenced by DOM node: virtualized tables unmount/remount <tr> elements
// on scroll, so the detail row follows the row *data* and is re-inserted
// after whichever <tr> currently renders it. Virtualized renderers add the
// detail's measured height to their range math and spacers (see
// rowDetailsVirtualSlot). Shift+right-click keeps the native menu (not
// advertised in the menu).
const rowDetailsBindings = new WeakMap(); // <tr> -> { row, label }
const rowDetailsSources = new WeakMap(); // <table> -> { getContext, rowCount, viewRows, relayout }
let rowDetailsMenu = null;
let rowDetailsView = null;

// `rowCount()` gates the menu (single-row results are already vertical);
// `viewRows()` returns the virtualized view rows (null when not virtual);
// `relayout()` re-runs the virtual range after the detail height changed.
// `allRows()` returns every data row (Copy column).
function registerRowDetailsSource(table, getContext, { rowCount = null, viewRows = null, relayout = null, allRows = null } = {}) {
  if (table && typeof getContext === "function") rowDetailsSources.set(table, { getContext, rowCount, viewRows, relayout, allRows });
  if (table && table.tBodies[0]) bindKeyboardRows(table.tBodies[0]);
}

// Keyboard rows (ns.table.rovingRows): every data row is focusable with a roving
// tabindex, Right / Left step into its cells, Up / Down keep the column,
// Enter opens the row's Details; Shift+F10 or the ContextMenu key opens the
// row menu on the focused row or cell. Virtual windows rebuild their rows:
// data-row-key brings focus back to the same row.
function markKeyboardRow(tr, key) {
  if (!tr || key == null || key === "") return;
  tr.tabIndex = -1;
  tr.dataset.rowKey = String(key);
}

const keyboardBodies = new WeakSet();
function bindKeyboardRows(tbody) {
  if (!tbody || keyboardBodies.has(tbody) || !tableMod) return;
  keyboardBodies.add(tbody);
  tableMod.rovingRows(tbody, {
    rows: "tr[data-row-key]",
    cells: true,
    key: (tr) => tr.dataset.rowKey,
    onOpen: (tr) => {
      const table = tr.closest("table");
      const binding = rowDetailsBindings.get(tr);
      if (binding && table && rowDetailsSources.get(table)) openRowDetails(binding, table, tr);
    },
  });
}

function bindRowDetails(tr, row, label) {
  if (tr && Array.isArray(row)) rowDetailsBindings.set(tr, { row, label });
}

function listenUntilClosed(disposers, target, type, handler, options) {
  target.addEventListener(type, handler, options);
  disposers.push(() => target.removeEventListener(type, handler, options));
}

function runDisposers(disposers) {
  while (disposers.length) {
    const dispose = disposers.pop();
    try { dispose(); } catch { /* teardown must not block closing */ }
  }
}

function selectedTextWithin(el) {
  const sel = window.getSelection ? window.getSelection() : null;
  if (!sel || sel.isCollapsed || !sel.rangeCount) return "";
  const range = sel.getRangeAt(0);
  if (!el.contains(range.commonAncestorContainer) && !range.intersectsNode(el)) return "";
  return String(sel.toString() || "");
}

// The expanded row of a virtualized tbody: `{ index, height }` in view-row
// coordinates, or null. Rows after `index` sit `height` px lower.
function rowDetailsVirtualSlot(tbody) {
  const view = rowDetailsView;
  if (!view || !tbody || !view.table.contains(tbody)) return null;
  const rows = typeof view.source.viewRows === "function" ? view.source.viewRows() : null;
  if (!Array.isArray(rows) || !rows.length) return null;
  if (rows[view.index] !== view.row) view.index = rows.indexOf(view.row);
  return view.index >= 0 ? view : null;
}

// Extra spacer height for a virtual window [start, end): the detail height
// lives in the top spacer while its row is above the window, in the bottom
// spacer while below, and in the real detail <tr> while mounted.
function rowDetailsSpacerExtra(slot, start, end) {
  if (!slot) return { top: 0, bottom: 0 };
  slot.side = slot.index < start ? -1 : slot.index >= end ? 1 : 0;
  const height = Math.max(0, Number(slot.height) || 0);
  return { top: slot.side < 0 ? height : 0, bottom: slot.side > 0 ? height : 0 };
}

// Maps a y offset (px from the tbody top) to a fractional view-row index.
function virtualRowAt(y, rowH, slot) {
  if (!slot) return y / rowH;
  const detailTop = (slot.index + 1) * rowH;
  if (y <= detailTop) return y / rowH;
  const height = Math.max(0, Number(slot.height) || 0);
  if (y <= detailTop + height) return slot.index + 1;
  return (y - height) / rowH;
}

// Swaps a virtual window's rows while the mounted detail <tr> stays in the
// DOM (no re-layout of its content, text selection inside it survives).
function replaceVirtualBodyRows(tbody, frag) {
  const view = rowDetailsView;
  const keep = view && view.el.parentNode === tbody ? view.el : null;
  let anchor = null;
  if (keep) {
    for (const tr of frag.children) {
      if (rowDetailsBindings.get(tr)?.row === view.row) { anchor = tr; break; }
    }
  }
  if (!anchor) {
    tbody.replaceChildren(frag);
    return;
  }
  const range = document.createRange();
  range.setStartBefore(tbody.firstChild);
  range.setEndBefore(keep);
  range.deleteContents();
  range.setStartAfter(keep);
  range.setEndAfter(tbody.lastChild);
  range.deleteContents();
  const before = document.createDocumentFragment();
  while (frag.firstChild) {
    const node = frag.firstChild;
    before.appendChild(node);
    if (node === anchor) break;
  }
  tbody.insertBefore(before, keep);
  tbody.appendChild(frag);
}

function findRowDetailsAnchor(table, row) {
  if (!table) return null;
  for (const body of table.tBodies) {
    for (const tr of body.rows) {
      if (rowDetailsBindings.get(tr)?.row === row) return tr;
    }
  }
  return null;
}

function setRowDetailsAnchor(view, anchor) {
  if (view.anchor === anchor) return;
  if (view.anchor) {
    view.anchor.classList.remove("is-rowExpanded", "is-selected");
    view.anchor.removeAttribute("aria-expanded");
  }
  view.anchor = anchor;
  if (anchor) {
    anchor.classList.add("is-rowExpanded", "is-selected");
    anchor.setAttribute("aria-expanded", "true");
  }
}

// Keeps the sticky detail content as wide as the visible table area.
function syncRowDetailsWidth(view) {
  const wrap = view.table.parentElement;
  const width = wrap ? wrap.clientWidth : 0;
  if (width > 0) view.content.style.width = `${width}px`;
}

// Returns true when the measured height changed (virtual math must follow).
function measureRowDetails(view) {
  if (!view.el.isConnected) return false;
  const height = view.el.getBoundingClientRect().height;
  if (!(height > 0) || Math.abs(height - view.height) < 0.5) return false;
  view.height = height;
  return true;
}

function relayoutRowDetails(view) {
  if (typeof view.source.relayout === "function") view.source.relayout();
}

// Every renderer calls this after (re)building a tbody: re-insert the detail
// right after the <tr> now rendering its row, or close it when that row is
// gone. A virtualized row that is merely unmounted keeps the detail open.
function refreshRowDetailsAfterRender(tbody) {
  const view = rowDetailsView;
  if (!view || !tbody || !view.table.contains(tbody)) return;
  let anchor = view.anchor;
  if (!anchor || anchor.parentNode !== tbody || rowDetailsBindings.get(anchor)?.row !== view.row) {
    anchor = null;
    for (const tr of tbody.rows) {
      if (rowDetailsBindings.get(tr)?.row === view.row) { anchor = tr; break; }
    }
  }
  if (!anchor) {
    setRowDetailsAnchor(view, null);
    if (rowDetailsVirtualSlot(tbody)) {
      if (view.el.parentNode) view.el.remove();
      return;
    }
    closeRowDetails({ silent: true });
    return;
  }
  setRowDetailsAnchor(view, anchor);
  if (anchor.nextSibling !== view.el) anchor.after(view.el);
  if (measureRowDetails(view) && rowDetailsVirtualSlot(tbody)) relayoutRowDetails(view);
}

// Portion of the detail above the scroll viewport: removing it would pull
// the rows the user is looking at upward, so closing scrolls back by it.
function rowDetailsHeightAboveViewport(view) {
  if (!view.el.isConnected) {
    return view.side < 0 && rowDetailsVirtualSlot(view.table.tBodies[0] || null) ? view.height : 0;
  }
  const owner = findVerticalScrollOwner(view.table);
  const viewportTop = owner ? Math.max(0, owner.getBoundingClientRect().top) : 0;
  const rect = view.el.getBoundingClientRect();
  return Math.max(0, Math.min(rect.height, viewportTop - rect.top));
}

function scrollRowDetailsOwnerBy(table, dy) {
  const owner = findVerticalScrollOwner(table) || document.scrollingElement || document.documentElement;
  if (owner) owner.scrollTop += dy;
}

function closeRowDetailsMenu({ restoreFocus = false } = {}) {
  rowDetailsMenu?.close({ focus: restoreFocus });
}

// The cells an action applies to, lit while its menu item is hovered or
// focused: the cell, the row, or the column (mounted cells and header).
function rowMenuTargetCells(table, tr, columnIndex, scope) {
  const offset = tr && tr.cells[0] && tr.cells[0].classList.contains("dataTable__rowNum") ? 1 : 0;
  const col = columnIndex + offset;
  if (scope === "row") return tr ? [...tr.cells] : [];
  if (scope === "cell") return tr && tr.cells[col] ? [tr.cells[col]] : [];
  if (scope !== "column") return [];
  const cells = [];
  const head = table.tHead && table.tHead.rows[0];
  if (head && head.cells[col]) cells.push(head.cells[col]);
  for (const body of table.tBodies) {
    for (const row of body.rows) {
      if (rowDetailsBindings.has(row) && row.cells[col]) cells.push(row.cells[col]);
    }
  }
  return cells;
}

// The column as a JSON array of its values, in data order, spelled
// like Copy row / Copy JSON.
function columnCopyText(ctx, rows, columnIndex) {
  const ast = ctx.typeAsts[columnIndex] || null;
  const values = [];
  for (const row of rows || []) {
    if (Array.isArray(row)) values.push(row[columnIndex]);
  }
  return jsonText(values, { kind: "Array", inner: ast }, 2);
}

// --- Trace links: a row that holds OpenTelemetry trace ids ----------------
// A value is a trace id when, read raw (never the displayed text) and
// trimmed, it is exactly 32 hex digits (W3C trace-context: 16 bytes) and
// not all zeros; an id inside a longer string does not count. The values
// looked at are String / FixedString cells and the elements of their
// arrays (Links.TraceId, groupArray(TraceId)). The same id found again is
// one link (its first place names it); distinct ids are one link each, in
// column order. A span id (16 hex digits, not all zeros) goes with the
// trace column it belongs to by name: TraceId with SpanId (span_id,
// spanId), Links.TraceId[i] with Links.SpanId[i], <prefix>trace_id with
// <prefix>span_id; two different candidates leave the span out. Only
// offered when the traces feature is on.
const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const SPAN_ID_RE = /^[0-9a-f]{16}$/;
const TEXT_TYPE_RE = /^(?:(?:LowCardinality|Nullable)\()*(?:String|FixedString\(\d+\))\)*$/;
const TRACE_MENU_MAX = 10;
const AMBIGUOUS = Symbol("ambiguous");

function hexId(value, pattern) {
  if (typeof value !== "string") return "";
  const id = value.replace(/^[\s\0]+|[\s\0]+$/g, "").toLowerCase();
  return pattern.test(id) && /[1-9a-f]/.test(id) ? id : "";
}

// "TraceId", "trace_id" and "traceId" read "traceid"; "Links.TraceId"
// reads "links.traceid".
const idColumnKey = (name) => String(name ?? "").replace(/_/g, "").toLowerCase();

// "text" (String, FixedString), "array" (an Array of them) or "" for a
// column; a column of unknown type is judged by its value.
function idColumnShape(type, value) {
  const t = String(type || "").replace(/\s+/g, "");
  if (!t) return Array.isArray(value) ? "array" : "text";
  if (TEXT_TYPE_RE.test(t)) return "text";
  const inner = /^Array\((.+)\)$/.exec(t);
  return inner && TEXT_TYPE_RE.test(inner[1]) ? "array" : "";
}

function arrayElements(value) {
  return Array.isArray(value) ? value : [];
}

// Every trace id of the row, in column order: { label, columnIndex,
// element (1-based array index, 0 for a plain cell), key, traceId }.
function traceCandidates(ctx, row) {
  const out = [];
  for (let i = 0; i < ctx.columns.length; i++) {
    const column = String(ctx.columns[i] ?? "");
    const key = idColumnKey(column);
    if (key.endsWith("spanid")) continue;
    const shape = idColumnShape(ctx.types[i], row[i]);
    if (shape === "text") {
      const traceId = hexId(row[i], TRACE_ID_RE);
      if (traceId) out.push({ label: column, columnIndex: i, element: 0, key, traceId });
    } else if (shape === "array") {
      arrayElements(row[i]).forEach((value, j) => {
        const traceId = hexId(value, TRACE_ID_RE);
        if (traceId) out.push({ label: `${column}[${j + 1}]`, columnIndex: i, element: j + 1, key, traceId });
      });
    }
  }
  return out;
}

// The span of one trace id place: "", a span id, or AMBIGUOUS.
function spanOf(ctx, row, place) {
  if (!place.key.endsWith("traceid")) return "";
  const spanKey = `${place.key.slice(0, -"traceid".length)}spanid`;
  const spans = new Set();
  for (let j = 0; j < ctx.columns.length; j++) {
    if (idColumnKey(ctx.columns[j]) !== spanKey) continue;
    const shape = idColumnShape(ctx.types[j], row[j]);
    const value = place.element ? (shape === "array" ? arrayElements(row[j])[place.element - 1] : undefined) : (shape === "text" ? row[j] : undefined);
    const spanId = hexId(value, SPAN_ID_RE);
    if (spanId) spans.add(spanId);
  }
  if (spans.size > 1) return AMBIGUOUS;
  return spans.size ? [...spans][0] : "";
}

// [{ traceId, spanId, label, columnIndex, others: [labels], href }], one
// per distinct trace id.
function rowTraceLinks(ctx, row) {
  if (!features.get("traces.enabled") || !ctx || !Array.isArray(row)) return [];
  const itemById = new Map();
  for (const place of traceCandidates(ctx, row)) {
    let link = itemById.get(place.traceId);
    if (!link) {
      link = { traceId: place.traceId, label: place.label, columnIndex: place.columnIndex, others: [], spans: new Set(), ambiguous: false };
      itemById.set(place.traceId, link);
    } else {
      link.others.push(place.label);
    }
    const span = spanOf(ctx, row, place);
    if (span === AMBIGUOUS) link.ambiguous = true;
    else if (span) link.spans.add(span);
  }
  return [...itemById.values()].map(({ spans, ambiguous, ...link }) => {
    const spanId = !ambiguous && spans.size === 1 ? [...spans][0] : "";
    const path = `observability/traces/${encodeURIComponent(link.traceId)}${spanId ? `?span=${encodeURIComponent(spanId)}` : ""}`;
    return { ...link, spanId, href: api ? api.resolveUrl(path) : `/${path}` };
  });
}

// The row menu and its submenus: an ns.menu context menu at the pointer
// (app_ui_menu.js: keys, focus, the outside click / Escape layer, scroll,
// resize and blur close it). Items are role=menuitem buttons, or links for
// "Open trace" (a new tab). Arrows, Home and End move in the menu that has
// the focus; ArrowRight, Enter, a click or hovering opens a submenu,
// ArrowLeft and Escape close it back on its item.
function openRowDetailsMenu(clientX, clientY, binding, table, columnIndex = -1, tr = null) {
  closeRowDetailsMenu();
  const el = document.createElement("div");
  el.className = "runMenu rowDetailsMenu";
  el.setAttribute("role", "menu");
  el.setAttribute("aria-label", "Row actions");

  let lit = [];
  const clearHighlight = () => {
    for (const cell of lit) cell.classList.remove("is-copyTarget");
    lit = [];
  };
  const highlight = (scope, column) => {
    clearHighlight();
    lit = rowMenuTargetCells(table, tr, column, scope);
    for (const cell of lit) cell.classList.add("is-copyTarget");
  };
  const itemNode = (tag, text, { scope = "", column = columnIndex, title = "" } = {}) => {
    const node = document.createElement(tag);
    node.className = "runMenu__opt";
    node.setAttribute("role", "menuitem");
    if (tag === "button") node.type = "button";
    if (title) node.title = title;
    const label = document.createElement("span");
    label.className = "runMenu__optText";
    label.textContent = text;
    node.appendChild(label);
    node.addEventListener("pointerenter", () => highlight(scope, column));
    node.addEventListener("pointerleave", clearHighlight);
    node.addEventListener("focus", () => highlight(scope, column));
    node.addEventListener("blur", clearHighlight);
    return node;
  };
  // href: a link opened in a new tab (the results stay), else onPick runs;
  // the menu closes after the pick. column: the cell the item is about
  // (default: the right-clicked one).
  const addItem = (text, onPick, scope = "", { href = "", column = columnIndex, title = "", list = el } = {}) => {
    const node = itemNode(href ? "a" : "button", text, { scope, column, title });
    if (href) {
      node.href = href;
      node.target = "_blank";
      node.rel = "noopener";
    } else {
      node.addEventListener("click", () => onPick());
    }
    list.appendChild(node);
  };
  const addNote = (text, list) => {
    const node = itemNode("button", text);
    node.disabled = true;
    node.setAttribute("aria-disabled", "true");
    node.classList.add("runMenu__opt--note");
    list.appendChild(node);
  };
  const submenus = [];
  const addSubmenu = (text, fill) => {
    const trigger = itemNode("button", text);
    trigger.classList.add("runMenu__opt--submenu");
    trigger.appendChild(icon.el("chevron-right", { size: "sm", className: "runMenu__optArrow" }));
    el.appendChild(trigger);
    const list = document.createElement("div");
    list.className = "runMenu rowDetailsMenu rowDetailsMenu--sub";
    list.setAttribute("role", "menu");
    list.setAttribute("aria-label", text);
    submenus.push({ trigger, list, fill });
  };

  const returnFocus = document.activeElement;
  const copy = (text) => { void copyMod.text(text); };
  const absolute = (href) => new URL(href, window.location.href).href;
  addItem("Details", () => openRowDetails(binding, table, returnFocus));
  const ctx = rowDetailsContext(table);
  // The row's traces, in Observability: flat entries for one trace id, a
  // submenu of the distinct ids (column order, capped) for several.
  const traces = rowTraceLinks(ctx, binding.row);
  if (traces.length === 1) {
    const [link] = traces;
    const named = link.others.length ? ` (${link.label})` : "";
    const title = link.others.length ? `Also in ${link.others.join(", ")}` : "";
    addItem(`Open trace${named}`, null, "cell", { href: link.href, column: link.columnIndex, title });
    addItem(`Copy trace link${named}`, () => copy(absolute(link.href)), "cell", { column: link.columnIndex, title });
  } else if (traces.length > 1) {
    const fillTraces = (pick) => (list) => {
      list.replaceChildren();
      for (const link of traces.slice(0, TRACE_MENU_MAX)) {
        const title = `${link.traceId}${link.others.length ? `\nAlso in ${link.others.join(", ")}` : ""}`;
        addItem(`${link.label} \u00b7 ${link.traceId.slice(0, 8)}\u2026`, () => pick(link), "cell", { ...(pick ? {} : { href: link.href }), column: link.columnIndex, title, list });
      }
      if (traces.length > TRACE_MENU_MAX) addNote(`+${traces.length - TRACE_MENU_MAX} more`, list);
    };
    addSubmenu("Open trace", fillTraces(null));
    addSubmenu("Copy trace link", fillTraces((link) => copy(absolute(link.href))));
  }
  // The value of the cell under the pointer, spelled as the result copy
  // spells single values (strings raw, JSON pretty-printed, NULL empty).
  const onColumn = ctx && Number.isInteger(columnIndex) && columnIndex >= 0 && columnIndex < ctx.columns.length;
  if (onColumn) {
    addItem("Copy cell", () => copy(buildCopyValue(binding.row[columnIndex], ctx.typeAsts[columnIndex] || null)), "cell");
  }
  if (ctx) addItem("Copy row", () => copy(rowJsonText(ctx, binding.row)), "row");
  if (onColumn) {
    const source = rowDetailsSources.get(table);
    addItem("Copy column", () => copy(columnCopyText(ctx, source && typeof source.allRows === "function" ? source.allRows() : [], columnIndex)), "column");
  }
  const selection = selectedTextWithin(table);
  if (selection) addItem("Copy selection", () => copy(selection));

  // The right-clicked row shows its accent bar while its menu is open.
  if (tr) tr.classList.add("is-rowMenuTarget");
  const handle = menu.context(el, {
    x: clientX,
    y: clientY,
    within: table,
    returnFocus,
    onClose: () => {
      clearHighlight();
      if (tr) tr.classList.remove("is-rowMenuTarget");
      if (rowDetailsMenu === handle) rowDetailsMenu = null;
    },
  });
  rowDetailsMenu = handle;
  for (const { trigger, list, fill } of submenus) menu.submenu(trigger, list, { parent: handle, onOpen: fill });
}

// `silent`: the table is being cleared/rebuilt, skip scroll compensation and
// the virtual relayout.
function closeRowDetails({ restoreFocus = false, silent = false } = {}) {
  const view = rowDetailsView;
  if (!view) return;
  const shift = silent ? 0 : rowDetailsHeightAboveViewport(view);
  rowDetailsView = null;
  runDisposers(view.disposers);
  setRowDetailsAnchor(view, null);
  view.el.remove();
  if (!silent) {
    if (shift > 0) scrollRowDetailsOwnerBy(view.table, -shift);
    relayoutRowDetails(view);
  }
  if (restoreFocus && view.returnFocus && view.returnFocus.isConnected) {
    try { view.returnFocus.focus({ preventScroll: true }); } catch { null; }
  }
}

// Copy row and the details' Copy JSON: the row as one object (an array when two columns have
// the same name), its values spelled like Copy JSON.
function rowJsonText(ctx, row) {
  return jsonText(row, rowsAst(ctx.columns, ctx.typeAsts).row, 2);
}

function buildRowDetailsContent(ctx, row, label, onClose) {
  const content = document.createElement("div");
  content.className = "rowDetails";
  content.setAttribute("role", "region");
  content.setAttribute("aria-label", label ? `Row ${label} details` : "Row details");
  content.tabIndex = -1;
  if (label) content.dataset.row = String(label);

  // Exactly the one-row (LIMIT 1) vertical presentation; the only additions
  // are two small overlay actions that do not take a layout row.
  const actions = document.createElement("div");
  actions.className = "rowDetails__actions";
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "button button--small rowDetails__copy";
  copyBtn.textContent = "Copy JSON";
  copyBtn.title = label ? `Copy row ${label} as JSON` : "Copy row as JSON";
  copyBtn.addEventListener("click", () => {
    void copyMod.text(rowJsonText(ctx, row), copyBtn);
  });
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "closeCross rowDetails__close";
  closeBtn.setAttribute("aria-label", "Close row details");
  closeBtn.title = "Close (Esc)";
  closeBtn.appendChild(icon.el("x"));
  closeBtn.addEventListener("click", onClose);
  actions.append(copyBtn, closeBtn);

  // The shared key / value list (app_ui_kv.js): one row per column, the
  // value as the one-row view prints it (the raw single-value renderer:
  // pretty JSON / arrays / maps, NULL token), a copy action per value;
  // tuple-flattened columns arrive already flattened.
  const list = document.createElement("dl");
  list.className = "kvList rowDetails__list";
  for (let i = 0; i < ctx.columns.length; i++) {
    const raw = row[i];
    const line = document.createElement("div");
    line.className = "kvList__row rowDetails__line";
    const colName = String(ctx.columns[i] ?? "");
    line.dataset.kvKey = colName;
    line.dataset.kvText = buildCopyValue(raw, ctx.typeAsts[i] || null);
    line.dataset.kvJson = jsonText(raw === undefined ? null : raw, ctx.typeAsts[i] || null, 0);
    const name = document.createElement("dt");
    name.className = "kvList__key rowDetails__name";
    // Column name only, like the one-row view (no type line).
    name.textContent = colName;
    name.title = colName;
    const value = document.createElement("dd");
    value.className = "kvList__value rowDetails__value";
    value.insertAdjacentHTML("afterbegin", kv.actionsHtml(["copy"], colName));
    const valueContent = document.createElement("div");
    valueContent.className = "rowDetails__valueContent";
    renderSingleValueCell(valueContent, raw, i, ctx.typeAsts);
    value.appendChild(valueContent);
    line.append(name, value);
    list.appendChild(line);
  }
  kv.bind(list);
  content.append(list, actions);
  return content;
}

function rowDetailsContext(table) {
  const source = table ? rowDetailsSources.get(table) : null;
  if (!source) return null;
  const raw = source.getContext() || {};
  return {
    columns: Array.isArray(raw.columns) ? raw.columns : [],
    types: Array.isArray(raw.types) ? raw.types : [],
    typeAsts: Array.isArray(raw.typeAsts) ? raw.typeAsts : [],
  };
}

function openRowDetails(binding, table, returnFocus = null) {
  const source = rowDetailsSources.get(table);
  if (!source || !binding) return;
  const ctx = rowDetailsContext(table);
  // Opening on another row replaces the current detail.
  closeRowDetails();
  const row = binding.row;
  // Closing a previous detail may have re-rendered a virtual window.
  const anchor = findRowDetailsAnchor(table, row);
  if (!anchor) return;
  const label = binding.label == null || binding.label === "" ? "" : String(binding.label);

  const el = document.createElement("tr");
  el.className = "resultTable__detailRow";
  const cell = document.createElement("td");
  cell.className = "resultTable__detailCell";
  cell.colSpan = Math.max(1, anchor.cells.length);
  const content = buildRowDetailsContent(ctx, row, label, () => closeRowDetails({ restoreFocus: true }));
  cell.appendChild(content);
  el.appendChild(cell);

  const disposers = [];
  const view = {
    el, content, row, table, source, anchor: null, index: -1, height: 0, side: 0, disposers,
    returnFocus: returnFocus || document.activeElement,
  };
  rowDetailsView = view;
  setRowDetailsAnchor(view, anchor);
  anchor.after(el);
  syncRowDetailsWidth(view);
  measureRowDetails(view);
  relayoutRowDetails(view);
  if (rowDetailsView !== view) return;

  // Only the close cross (or Escape from inside the detail) and opening
  // another row's Details close it: clicks elsewhere, selecting, sorting
  // or scrolling keep it open.
  listenUntilClosed(disposers, document, "keydown", (ev) => {
    if (ev.key !== "Escape" || rowDetailsMenu || !el.contains(document.activeElement)) return;
    ev.preventDefault();
    closeRowDetails({ restoreFocus: true });
  });
  // Back / Forward close it (ns.router: the one popstate listener).
  disposers.push(router.on("", () => closeRowDetails()));
  if (typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(() => {
      if (rowDetailsView !== view) return;
      syncRowDetailsWidth(view);
      if (measureRowDetails(view)) relayoutRowDetails(view);
    });
    observer.observe(content);
    if (table.parentElement) observer.observe(table.parentElement);
    disposers.push(() => observer.disconnect());
  }
  try { content.focus({ preventScroll: true }); } catch { null; }
}

// The menu a keyboard opened (onResultRowMenuKey) also gets the browser's
// contextmenu event of the same key press: it must not open twice or let
// the native menu through (Shift+F10 carries shiftKey).
let keyboardMenuAt = -Infinity;

function rowMenuAt(target, clientX, clientY) {
  if (!target || target.closest(".resultTable__detailRow, .rowDetailsMenu")) return false;
  const tr = target.closest("tr");
  const binding = tr ? rowDetailsBindings.get(tr) : null;
  if (!binding) return false;
  const table = tr.closest("table");
  const source = table ? rowDetailsSources.get(table) : null;
  if (!source) return false;
  // A single-row result is already shown vertically: keep the native menu.
  const count = typeof source.rowCount === "function" ? Number(source.rowCount()) || 0 : 0;
  if (count < 2) return false;
  // Data cells follow the row-number cell.
  const td = target.closest("td");
  const offset = tr.cells[0] && tr.cells[0].classList.contains("dataTable__rowNum") ? 1 : 0;
  const columnIndex = td && td.parentElement === tr ? td.cellIndex - offset : -1;
  openRowDetailsMenu(clientX, clientY, binding, table, columnIndex, tr);
  return true;
}

function onResultRowMenuKey(ev) {
  const hit = tableMod ? tableMod.keyboardMenuTarget(ev) : null;
  if (!hit || !hit.el.closest(".resultTable")) return;
  if (rowMenuAt(hit.el, hit.x, hit.y)) {
    ev.preventDefault();
    keyboardMenuAt = performance.now();
  }
}

function onResultRowContextMenu(ev) {
  if (performance.now() - keyboardMenuAt < 800) {
    ev.preventDefault();
    return;
  }
  if (ev.shiftKey || ev.defaultPrevented) return;
  const target = ev.target instanceof Element ? ev.target : null;
  if (rowMenuAt(target, ev.clientX, ev.clientY)) ev.preventDefault();
}

document.addEventListener("contextmenu", onResultRowContextMenu);
document.addEventListener("keydown", onResultRowMenuKey);
export { bindKeyboardRows, bindRowDetails, closeRowDetails, closeRowDetailsMenu, findVerticalScrollOwner, markKeyboardRow, refreshRowDetailsAfterRender, registerRowDetailsSource, replaceVirtualBodyRows, rowDetailsSpacerExtra, rowDetailsVirtualSlot, virtualRowAt };
