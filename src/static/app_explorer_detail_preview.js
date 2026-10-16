// The Preview tab of the table card.
// It shows the first rows of the table (50, 100 or 500), as the Query result table shows them.
// It also gives a way to open the SELECT in Query.
// A table or a limit that arrives while a preview loads replaces that preview (ARCH-F-102).

import { api } from "./app_api.js";
import { h } from "./app_dom.js";
import { emptyNote, staticTable } from "./app_explorer_detail_cells.js";
import { DASH, PREVIEW_LIMITS, aggregatePreviewColumn, buildPreviewSelectSql, optionalNumber } from "./app_explorer_detail_model.js";
import { appRoute } from "./app_explorer_route.js";
import { actions, model, setError } from "./app_explorer_store.js";
import { format } from "./app_format.js";
import { results } from "./app_results.js";
import { state, storage } from "./app_state.js";
import { icon as iconMod } from "./app_ui_icon.js";
import { menu as menuMod } from "./app_ui_menu.js";
import { segmented } from "./app_ui_segmented.js";
import { uiState } from "./app_ui_state.js";
import { util } from "./app_util.js";

const previewLimitPref = () => storage.pref(storage.KEYS.explorerPreviewLimit, 100);

function previewLimit() {
  const current = Number(model.previewLimit);
  if (PREVIEW_LIMITS.includes(current)) return current;
  const stored = previewLimitPref().get() || 100;
  model.previewLimit = PREVIEW_LIMITS.includes(stored) ? stored : 100;
  return model.previewLimit;
}

function setPreviewLimit(limit) {
  model.previewLimit = limit;
  previewLimitPref().set(limit);
  model.preview = null;
  actions.renderTabContent();
}

// The preview in flight is named by its table and its limit.
// A table or a limit that arrives while another preview loads aborts that preview.
// Then it loads its own preview. The card never waits for a preview that was asked for something else.
let previewing = "";
const previewWanted = () => `${model.selectedKey}\0${previewLimit()}`;

async function loadPreview() {
  if (model.preview) return;
  const detail = model.detail;
  if (!detail) return;
  const s = detail.summary || {};
  const key = model.selectedKey;
  const limit = previewLimit();
  const want = previewWanted();
  if (previewing === want) return;
  previewing = want;
  const req = util.latest("explorer.preview");
  actions.renderTabContent();
  let result;
  try {
    result = await api.getExplorerTableData(state.selectedHostId, s.database, s.name, limit, { signal: req.signal });
  } catch (e) {
    if (util.isAbort(e)) {
      // This preview is superseded. Another preview took the slot and set `previewing`.
      // A host change can also cut it.
      if (previewing === want && !req.isCurrent()) previewing = "";
      return;
    }
    result = { error: e };
  }
  if (previewing !== want) return;
  previewing = "";
  // The code drops a late answer for another table or limit.
  if (model.selectedKey !== key || model.detail?.summary?.name !== s.name) return;
  if (result && !result.error) result.requested_limit = limit;
  if (limit === previewLimit()) model.preview = result;
  if (model.tab === "Preview") actions.renderTabContent();
}

// Explorer and Query are separate HTML documents.
// The SQL waits in the session draft. Query reads the draft when it opens.
// Otherwise the textarea does not exist yet, and the statement is lost.
function openSqlInQuery(sql) {
  const text = String(sql || "");
  storage.pref(storage.KEYS.editorDraft, "", { session: true }).set(text);
  window.location.assign(appRoute("/query"));
}

async function openFormattedSqlInQuery(sql) {
  const formatted = await api.formatSqls(state.selectedHostId, [String(sql || "")]);
  if (!Array.isArray(formatted) || !formatted.length || !String(formatted[0] || "").trim()) {
    throw new Error("Formatter returned an empty query.");
  }
  openSqlInQuery(formatted[0]);
}

function appendFinalizePreviewInfo(th) {
  const text = "finalizeAggregation() used so Explorer can display the value of a single row";
  th.classList.add("has-finalize-info");
  const info = h("span", { class: "explorerFinalizeInfo" });
  info.tabIndex = 0;
  info.setAttribute("aria-label", text);
  info.addEventListener("click", (event) => event.stopPropagation());
  const icon = iconMod.el("info-circle", { size: "sm", className: "explorerFinalizeInfo__icon" });
  info.append(icon, h("div", { class: "explorerFinalizeInfo__tooltip" }, text));
  th.appendChild(info);
}

function persistFlattenTuple(enabled) {
  state.runOptFlattenTuple = enabled !== false;
  storage?.saveRunOptions?.({
    autoFormat: state.runOptAutoFormat,
    multiQuery: state.runOptMultiQuery,
    executionStats: state.runOptExecutionStats,
    flattenTuple: state.runOptFlattenTuple,
  });
  window.dispatchEvent(new CustomEvent("chdash:flatten-tuple-change", { detail: { enabled: state.runOptFlattenTuple } }));
}

function createDataSettingsControl() {
  const root = h("div", { class: "themeSelect explorerDataSettings" });
  const button = h("button", { class: "themeSelect__button editorAutocompleteControl__button explorerDataSettings__button" });
  button.type = "button";
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-label", "Data display settings");
  button.title = "Data display settings";
  button.appendChild(iconMod.el("settings", { className: "editorAutocompleteControl__gear" }));

  const menu = h("div", { class: "themeSelect__menu explorerDataSettings__menu" });
  menu.setAttribute("role", "menu");
  menu.tabIndex = -1;
  menu.hidden = true;
  const option = h("button", { class: "runMenu__opt" });
  option.type = "button";
  option.setAttribute("role", "menuitemcheckbox");
  const check = h("span", { class: "runMenu__optCheck" }, iconMod.el("check", { size: "sm" }));
  check.setAttribute("aria-hidden", "true");
  option.append(check, h("span", { class: "runMenu__optText" }, "Flatten tuple"));
  const sync = () => option.setAttribute("aria-checked", String(state.runOptFlattenTuple !== false));
  sync();
  menu.appendChild(option);
  root.append(button, menu);

  // The ns.menu menu (app_ui_menu.js) sits in a portal. The card re-renders and clips the menu.
  // The list opens fixed under the gear, right-aligned.
  const settings = menuMod?.bind(button, menu, { root, portal: true, portalAlign: "end", closeOnSelect: true });

  option.addEventListener("click", () => {
    persistFlattenTuple(!(state.runOptFlattenTuple !== false));
    sync();
    settings?.close({ immediate: true, focus: false });
    actions.renderTabContent();
  });
  return root;
}

// Preview cells are query results. Every value stays as the API sent it (decision 45).
// Do not group digits, do not use compact numbers and do not reformat dates.
// This matches the Query result table. Only a data NULL takes the NULL token.
// The result tables write a value as ns.results.cellText does.
// A Map is written as an object. The digits of a UInt64 stay as sent.
function previewCellText(value, type) {
  if (value == null) return "NULL";
  const text = results?.cellText?.(value, type);
  if (typeof text === "string") return text;
  if (typeof value === "object") {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

function renderPreviewToolbar(container, detail) {
  const toolbar = h("div", { class: "explorerDataToolbar explorerPreviewToolbar" });
  const info = h("div", { class: "explorerPreviewToolbar__info" });
  const limit = previewLimit();
  const rows = Array.isArray(model.preview?.rows) ? model.preview.rows.length : null;
  const total = optionalNumber(detail.summary?.rows);
  const count = h("span", { class: "explorerPreviewToolbar__count" }, rows == null ? `LIMIT ${limit}` : `${format.countLabel(rows, "row")} (LIMIT ${limit})`);
  info.appendChild(count);
  if (total != null && rows != null) info.appendChild(h("span", { class: "explorerPreviewToolbar__total" }, `of ${format.count(total)} in the table`));
  // The row limit uses the shared segmented control (app_ui_segmented.js).
  const limits = h("div", { class: "explorerPreviewLimits" });
  segmented?.render(limits, PREVIEW_LIMITS.map((value) => ({ value, label: String(value), title: `Preview the first ${value} rows` })), { attr: "limit", value: limit, size: "compact", label: "Preview row limit" });
  segmented?.bind(limits, { attr: "limit", onChange: (value) => { if (Number(value) !== previewLimit()) setPreviewLimit(Number(value)); return false; } });
  info.appendChild(limits);

  const open = h("button", { class: "button button--small" }, "Open in Query");
  open.type = "button";
  open.addEventListener("click", async () => {
    if (open.disabled) return;
    open.disabled = true;
    try {
      await openFormattedSqlInQuery(buildPreviewSelectSql(detail, model.preview?.columns, previewLimit()));
    } catch (error) {
      setError(error);
      open.disabled = false;
    }
  });
  const actions = h("div", { class: "explorerDataToolbar__actions" });
  actions.append(open, createDataSettingsControl());
  toolbar.append(info, actions);
  container.appendChild(toolbar);
}

function renderTransposedPreview(container, columns, types, row, previewColumns, sourceIndexes) {
  const items = columns.map((name, index) => ({ name, type: types[index] || "", value: row[index], source: previewColumns[sourceIndexes?.[index] ?? index] }));
  container.appendChild(staticTable({
    className: "explorerResultTable--preview explorerPreviewTable explorerPreviewTable--transposed",
    items,
    specs: [
      { label: "Column", value: (item) => item.name, cellClass: "explorerColumns__name" },
      { label: "Type", value: (item) => item.type, render: (td, item) => { td.classList.add("explorerColumns__type"); td.textContent = item.type || DASH; td.title = item.type; } },
      {
        label: "Value",
        value: (item) => previewCellText(item.value, item.type),
        render: (td, item) => {
          td.classList.add("explorerPreviewTable__value");
          if (item.value == null) {
            td.classList.add("is-null");
            // The result tables share this NULL token (ns.format.nullToken()).
            if (results?.setNullCell) results.setNullCell(td);
            else td.textContent = "NULL";
            return;
          }
          const text = previewCellText(item.value, item.type);
          td.textContent = text;
          if (text.length > 24) td.title = text;
        },
      },
    ],
  }));
}

function renderPreviewTab(container, detail) {
  renderPreviewToolbar(container, detail);
  if (!model.preview) {
    container.appendChild(uiState.block("loading", { label: "Loading the preview\u2026" }));
    // This preview does not wait for another table's preview. It is requested unless it is already in flight.
    if (previewing !== previewWanted()) setTimeout(loadPreview, 0);
    return;
  }
  if (model.preview.error) return container.appendChild(emptyNote(util.errorText(model.preview.error, "Preview failed.")));
  const previewColumns = Array.isArray(model.preview.columns) ? model.preview.columns : [];
  const sourceColumns = previewColumns.map((c) => c.name);
  const sourceRows = Array.isArray(model.preview.rows) ? model.preview.rows : [];
  if (!sourceRows.length) return container.appendChild(emptyNote("The table returned no rows."));
  // The server finalizes and stringifies AggregateFunction preview values.
  // Then clickhouse-cpp never has to decode aggregate states.
  // If every returned finalized value is numeric, the code exposes a numeric presentation type
  // to the shared result table. Explorer then gets the same background gauges as Query.
  const sourceTypes = previewColumns.map((c, columnIndex) => {
    if (!aggregatePreviewColumn(c)) return c.type;
    const values = sourceRows.map((row) => Array.isArray(row) ? row[columnIndex] : null).filter((value) => value != null && String(value).trim() !== "");
    return values.length && values.every((value) => Number.isFinite(Number(value))) ? "Float64" : c.type;
  });
  const projected = results?.flattenTupleTableData?.(sourceColumns, sourceTypes, sourceRows, state.runOptFlattenTuple !== false)
    || { columns: sourceColumns, types: sourceTypes, rows: sourceRows, sourceColumnIndexes: sourceColumns.map((_, index) => index) };
  if (projected.rows.length === 1) {
    renderTransposedPreview(container, projected.columns, projected.types, projected.rows[0], previewColumns, projected.sourceColumnIndexes);
    return;
  }
  const table = results?.createStaticResultTable?.({
    columns: projected.columns,
    types: projected.types,
    rows: projected.rows,
    className: "explorerTable explorerResultTable--preview explorerPreviewTable",
    rowDetails: true,
    decorateHeader: (th, headCtx) => {
      const sourceIndex = projected.sourceColumnIndexes?.[headCtx.columnIndex] ?? headCtx.columnIndex;
      // CSS draws the type sub-header from data-type.
      // The header text stays the column name. Row details, copy and tests read it.
      const type = projected.types[headCtx.columnIndex] || "";
      if (type) {
        th.dataset.type = type;
        if (!th.title) th.title = `${projected.columns[headCtx.columnIndex] ?? ""}\n${type}`;
      }
      if (aggregatePreviewColumn(previewColumns[sourceIndex])) appendFinalizePreviewInfo(th);
    },
  });
  if (!table) throw new Error("Shared result table component is unavailable.");
  container.appendChild(table);
}

export { renderPreviewTab };
