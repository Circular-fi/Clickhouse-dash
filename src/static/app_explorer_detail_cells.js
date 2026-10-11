// The DOM pieces that the tabs of the table card share: the SQL expression of the card, the cells of a table (gauge, number, text, time), the
// table itself (the shared result table with column specs), a collapsible section and its list, the object icon and the lineage chip.

import { dom, h } from "./app_dom.js";
import { DASH, DEPENDENCY_KINDS, objectType, optionalNumber, shortName } from "./app_explorer_detail_model.js";
import { renderHighlightedCode } from "./app_explorer_doc.js";
import { actions } from "./app_explorer_store.js";
import { humanEngine } from "./app_explorer_summary.js";
import { format } from "./app_format.js";
import { header } from "./app_header.js";
import { results } from "./app_results.js";
import { icon as iconMod } from "./app_ui_icon.js";
import { table } from "./app_ui_table.js";

const { $$ } = dom;

// An SQL expression of the card, coloured by the Query editor's
// highlighter (renderHighlightedCode, app_explorer_doc.js: ns.highlight, the
// same .tok-* classes and theme colours).
// Function names need the host's function list (ns.meta): the
// expressions repaint when it arrives (chdash:meta-changed).
function paintExpr(code) {
  renderHighlightedCode(code, code.dataset.sql || "");
}

function exprEl(text, className = "") {
  const code = h("code", { class: `explorerExpr${className ? ` ${className}` : ""}` });
  code.dataset.sql = String(text ?? "");
  paintExpr(code);
  return code;
}

// Repaints the expressions of the card when the function list arrives; called once, by the card's init.
function watchExpressions() {
  window.addEventListener("chdash:meta-changed", () => {
    for (const code of $$(".explorerExpr[data-sql]", dom.explorerDetailContent) || []) paintExpr(code);
  });
}

// Treemaps of the card (partitions, column sizes): destroyed with the body.
const cardMaps = [];
function destroyCardMaps() {
  while (cardMaps.length) cardMaps.pop()?.destroy?.();
}

// The one empty / unavailable style of the card: a muted line, no box.
function emptyNote(text) {
  return h("div", { class: "explorerEmptyNote" }, text);
}

function unavailableMessage(label) {
  return emptyNote(`${label} is unavailable on this server or is not enabled.`);
}

// A DateTime text of the server's system tables: browser-local text, the
// server value (and ISO) in the tooltip (decision 48).
function timeCell(td, value) {
  const time = header.serverTime(value);
  td.textContent = time.text;
  if (time.title) td.title = time.title;
}

// In-cell bar normalised to the column maximum (ns.table.cellBar); the
// callers pass measures only (sizes, bytes, progress).
function gaugeCell(td, value, max, text) {
  td.classList.add("num");
  table.cellBar(td, table.barPercent(optionalNumber(value), max));
  td.textContent = text;
}

function numericCell(td, text) {
  td.classList.add("num");
  td.textContent = text;
}

// Text cell that ellipsises in CSS and keeps the full value as tooltip.
function textCell(td, value, className = "") {
  const text = value == null || value === "" ? DASH : String(value);
  td.textContent = text;
  if (className) td.classList.add(...className.split(" ").filter(Boolean));
  if (text.length > 12) td.title = text;
}

// The shared Query result table with column specs instead of positional
// renderers: { label, type, value(item), render(td, item, value), head }.
// Row numbers always start at 1 per table.
// A spec's `priority` ("low", "mid" or "xs") names the width below which its column leaves the table (table.css, "Priority columns").
function staticTable({ className, specs, items, rowIndexValue = null, decorateRow = null, rowDetails = false }) {
  const rows = items.map((item) => {
    const row = specs.map((spec) => spec.value(item));
    row.__explorerItem = item;
    return row;
  });
  const table = results?.createStaticResultTable?.({
    columns: specs.map((spec) => spec.label),
    types: specs.map((spec) => spec.type || "String"),
    rows,
    className: `explorerTable ${className}`,
    compact: true,
    indexSortable: false,
    nullsLast: true,
    priorities: specs.map((spec) => spec.priority || null),
    rowDetails,
    rowIndexValue: rowIndexValue ? (row) => rowIndexValue(row?.__explorerItem) : null,
    decorateHeader: (th, headCtx) => {
      const spec = specs[headCtx.columnIndex];
      th.title = spec?.head || spec?.label || "";
      if (spec?.numeric) th.classList.add("num");
    },
    decorateRow: (tr, rowCtx) => decorateRow?.(tr, rowCtx.row?.__explorerItem || null),
    renderCell: (td, cellCtx) => {
      const spec = specs[cellCtx.columnIndex];
      const item = cellCtx.row?.__explorerItem;
      if (spec?.render) spec.render(td, item, cellCtx.value);
      else if (spec?.numeric) numericCell(td, cellCtx.value == null ? DASH : format.count(cellCtx.value));
      else textCell(td, cellCtx.value, spec?.cellClass || "");
      return true;
    },
  });
  if (!table) throw new Error("Shared result table component is unavailable.");
  return table;
}

// Collapsible section with a count; returns its body.
function section(container, { id, title, count = null, open = true, note = "" }) {
  const details = h("details", { class: "explorerSection" });
  details.dataset.section = id;
  details.open = open;
  const summary = h("summary", { class: "explorerSection__summary" });
  summary.appendChild(h("span", { class: "explorerSection__title" }, title));
  if (count != null) summary.appendChild(h("span", { class: "explorerSection__count" }, format.count(count)));
  if (note) summary.appendChild(h("span", { class: "explorerSection__note" }, note));
  const body = h("div", { class: "explorerSection__body" });
  details.append(summary, body);
  container.appendChild(details);
  return body;
}

// Renders sections with data first, then one muted line naming the empty
// ones ("No active merges \u00b7 No mutations").
function renderSections(container, sections) {
  const shown = sections.filter((item) => item && item.hasData);
  const idle = sections.filter((item) => item && !item.hasData && item.emptyText);
  for (const item of shown) {
    const body = section(container, { id: item.id, title: item.title, count: item.count ?? null, note: item.note || "" });
    item.render(body);
  }
  if (idle.length) {
    const line = h("div", { class: "explorerIdleLine" });
    line.dataset.sections = idle.map((item) => item.id).join(" ");
    line.textContent = idle.map((item) => item.emptyText).join(" \u00b7 ");
    container.appendChild(line);
  }
  if (!shown.length && !idle.length) container.appendChild(emptyNote("Nothing to show for this object."));
}

// The sprite drawing of each object family (the Explorer tree's, app_explorer.js).
const OBJECT_ICONS = {
  table: "table", view: "eye", mv: "eye-table", dictionary: "vocabulary",
  buffer: "stack", distributed: "table-share", unknown: "table",
};

function objectIcon(engine) {
  const type = objectType(engine);
  return iconMod.el(OBJECT_ICONS[type] || OBJECT_ICONS.unknown, { size: "sm", className: `explorerObjIcon explorerObjIcon--${type}` });
}

function dependencyChip(dep, contextDatabase, { cluster = "" } = {}) {
  const button = h("button", { class: "explorerLineageChip" });
  button.type = "button";
  const qualified = `${dep.database || DASH}.${dep.table || DASH}`;
  const [kindLabel, kindTitle] = DEPENDENCY_KINDS[dep.kind] || DEPENDENCY_KINDS.dependency;
  button.dataset.kind = dep.kind || "dependency";
  button.title = [qualified, dep.engine ? humanEngine(dep.engine) : "", kindTitle].filter(Boolean).join(" \u00b7 ");
  button.appendChild(objectIcon(dep.engine));
  button.appendChild(h("span", { class: "explorerLineageChip__name" }, shortName(dep.database, dep.table, contextDatabase)));
  if (dep.kind === "distributed_route" && cluster) button.appendChild(h("span", { class: "explorerLineageChip__meta" }, `on ${cluster}`));
  else if (kindLabel) button.appendChild(h("span", { class: "explorerLineageChip__meta" }, kindLabel));
  button.addEventListener("click", () => void actions.selectTable(dep.database, dep.table));
  return button;
}

export { cardMaps, destroyCardMaps, dependencyChip, emptyNote, exprEl, gaugeCell, numericCell, objectIcon, renderSections, section, staticTable, textCell, timeCell, unavailableMessage, watchExpressions };
