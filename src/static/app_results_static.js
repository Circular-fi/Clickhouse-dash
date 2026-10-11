// The result table of a static answer (the Explorer's previews and tables of the cards, the System tables): the same cells, sort
// and row details as the Query result, for rows that are already complete.

import { renderSingleValueCell, setCellTextFlat, setDisplayCell, setGaugeCell } from "./app_results_cells.js";
import { bindKeyboardRows, bindRowDetails, markKeyboardRow, refreshRowDetailsAfterRender, registerRowDetailsSource } from "./app_results_rowdetails.js";
import { compareNumericForSort, compareTextForSort } from "./app_results_sort.js";
import { decodeStructuredText, extractDecimalScale, extractFiniteNumber, formatCellForDisplayWithTypes, formatNumericCellText, isScalarNumericType, isStructuredType, parseChType } from "./app_results_values.js";
import { table as tableMod } from "./app_ui_table.js";

function createStaticResultTable({
  columns = [],
  types = [],
  rows = [],
  className = "",
  decorateHeader = null,
  decorateRow = null,
  renderCell = null,
  indexSortable = true,
  rowIndexValue = null,
  rowDetails = false,
  nullsLast = false,
  compact = false,
  bars = true,
} = {}) {
  const safeColumns = Array.isArray(columns) ? columns.map((value) => String(value ?? "")) : [];
  const safeTypes = Array.isArray(types) ? types.map((value) => String(value ?? "")) : [];
  const typeAsts = safeColumns.map((_, index) => parseChType(safeTypes[index] || ""));
  // A structured column sent as JSON text is read like a Query result (decodeStructuredText); a row
  // without such text stays the caller's row.
  const decodeIndexes = typeAsts.map((ast, index) => (isStructuredType(ast) ? index : -1)).filter((index) => index >= 0);
  const safeRows = (Array.isArray(rows) ? rows : []).map((row) => {
    if (!decodeIndexes.length || !Array.isArray(row) || !decodeIndexes.some((index) => typeof row[index] === "string")) return row;
    const out = row.slice();
    for (const index of decodeIndexes) out[index] = decodeStructuredText(row[index], typeAsts[index]);
    return out;
  });
  const staticNumericCols = typeAsts.map(isScalarNumericType);
  const staticMax = new Array(staticNumericCols.length).fill(0);
  const staticMin = new Array(staticNumericCols.length).fill(0);
  const staticMaxScale = new Array(staticNumericCols.length).fill(0);
  if (safeRows.length > 1 && staticNumericCols.some(Boolean)) {
    for (const row of safeRows) {
      if (!Array.isArray(row)) continue;
      for (let index = 0; index < staticNumericCols.length; index++) {
        if (!staticNumericCols[index]) continue;
        const scale = extractDecimalScale(row[index]);
        if (scale > staticMaxScale[index]) staticMaxScale[index] = scale;
        const n = extractFiniteNumber(row[index]);
        if (n == null) continue;
        if (n < staticMin[index]) staticMin[index] = n;
        if (n > staticMax[index]) staticMax[index] = n;
      }
    }
  }

  const wrap = document.createElement("div");
  wrap.className = `tableWrap ${String(className || "").trim()}`.trim();
  tableMod.scrollCues(wrap);
  const table = document.createElement("table");
  table.className = `resultTable dataTable dataTable--grid${compact ? " dataTable--compact" : ""}`;
  const thead = document.createElement("thead");
  const tbody = document.createElement("tbody");
  table.append(thead, tbody);
  wrap.appendChild(table);
  bindKeyboardRows(tbody);
  if (rowDetails) {
    registerRowDetailsSource(table, () => ({ columns: safeColumns, types: safeTypes, typeAsts }), {
      rowCount: () => safeRows.length,
      allRows: () => safeRows,
    });
  }

  let sortKey = null;
  let sortDir = "";

  function compareRows(a, b, key) {
    if (key === -1) return a.index - b.index;
    const ast = typeAsts[key] || null;
    if (isScalarNumericType(ast)) {
      // Exact for the digits of a UInt64 or a Decimal (compareNumericForSort); NULL last.
      return compareNumericForSort(Array.isArray(a.row) ? a.row[key] : null, Array.isArray(b.row) ? b.row[key] : null);
    }
    const av = Array.isArray(a.row) ? formatCellForDisplayWithTypes(a.row[key], key, typeAsts) : String(a.row ?? "");
    const bv = Array.isArray(b.row) ? formatCellForDisplayWithTypes(b.row[key], key, typeAsts) : String(b.row ?? "");
    return compareTextForSort(av, bv);
  }

  function nextDirection(key) {
    const numeric = key === -1 || isScalarNumericType(typeAsts[key] || null);
    if (sortKey !== key) return numeric ? "desc" : "asc";
    if (numeric) return sortDir === "desc" ? "asc" : sortDir === "asc" ? "" : "desc";
    return sortDir === "asc" ? "desc" : sortDir === "desc" ? "" : "asc";
  }

  function render() {
    thead.replaceChildren();
    tbody.replaceChildren();

    if (safeRows.length === 1 && safeColumns.length === 1) {
      table.classList.add("resultTable--singleValue");
      const head = document.createElement("tr");
      const th = document.createElement("th");
      th.textContent = safeColumns[0];
      if (safeTypes[0]) th.title = safeTypes[0];
      if (typeof decorateHeader === "function") decorateHeader(th, { column: safeColumns[0], type: safeTypes[0] || "", columnIndex: 0 });
      head.appendChild(th);
      thead.appendChild(head);

      const tr = document.createElement("tr");
      const td = document.createElement("td");
      const row = safeRows[0];
      const value = Array.isArray(row) ? row[0] : row;
      const handled = typeof renderCell === "function" && renderCell(td, {
        value, row, sourceRowIndex: 0, column: safeColumns[0], type: safeTypes[0] || "", columnIndex: 0,
      }) === true;
      if (!handled) renderSingleValueCell(td, value, 0, typeAsts);
      tr.appendChild(td);
      if (typeof decorateRow === "function") decorateRow(tr, { row, sourceRowIndex: 0, displayIndex: 1 });
      tbody.appendChild(tr);
      return;
    }

    table.classList.remove("resultTable--singleValue");
    const head = document.createElement("tr");
    const indexHead = document.createElement("th");
    indexHead.textContent = "#";
    indexHead.className = "dataTable__rowNum";
    if (indexSortable) {
      tableMod.sortHeader(indexHead, {
        key: -1, dir: sortKey === -1 ? sortDir : "", title: "Sort by row number",
        onSort: () => {
          const next = nextDirection(-1);
          sortKey = next ? -1 : null;
          sortDir = next;
          render();
        },
      });
    }
    head.appendChild(indexHead);

    safeColumns.forEach((column, index) => {
      const th = document.createElement("th");
      th.textContent = column;
      if (safeTypes[index]) th.title = safeTypes[index];
      // A number's header is over its figures, on the right with them (the cells are .num).
      if (staticNumericCols[index]) th.classList.add("num");
      tableMod.sortHeader(th, {
        key: index, dir: sortKey === index ? sortDir : "",
        onSort: () => {
          const next = nextDirection(index);
          sortKey = next ? index : null;
          sortDir = next;
          render();
        },
      });
      if (typeof decorateHeader === "function") {
        decorateHeader(th, {
          column,
          type: safeTypes[index] || "",
          columnIndex: index,
        });
      }
      head.appendChild(th);
    });
    thead.appendChild(head);

    let display = safeRows.map((row, index) => ({ row, index: index + 1 }));
    if (sortKey !== null && sortDir) {
      const key = sortKey;
      // nullsLast: missing values (null / undefined / "") stay below every
      // present value in both directions, like ClickHouse's default
      // NULLS LAST, instead of rising to the top of a descending sort.
      const missing = (entry) => {
        if (key === -1 || !Array.isArray(entry.row)) return false;
        const value = entry.row[key];
        return value == null || value === "";
      };
      display.sort((a, b) => {
        if (nullsLast) {
          const am = missing(a);
          const bm = missing(b);
          if (am !== bm) return am ? 1 : -1;
          if (am) return a.index - b.index;
        }
        const cmp = compareRows(a, b, key);
        if (cmp === 0) return a.index - b.index;
        return sortDir === "desc" ? -cmp : cmp;
      });
    }

    for (const entry of display) {
      const tr = document.createElement("tr");
      markKeyboardRow(tr, entry.index);
      const indexCell = document.createElement("td");
      indexCell.className = "dataTable__rowNum";
      const customIndex = typeof rowIndexValue === "function"
        ? rowIndexValue(entry.row, entry.index - 1, entry.index)
        : entry.index;
      indexCell.textContent = customIndex == null ? "" : String(customIndex);
      tr.appendChild(indexCell);
      if (Array.isArray(entry.row)) {
        if (rowDetails) bindRowDetails(tr, entry.row, customIndex);
        for (let index = 0; index < safeColumns.length; index++) {
          const td = document.createElement("td");
          const ast = typeAsts[index] || null;
          if (isScalarNumericType(ast)) td.classList.add("num");
          const handled = typeof renderCell === "function" && renderCell(td, {
            value: entry.row[index],
            row: entry.row,
            sourceRowIndex: entry.index - 1,
            column: safeColumns[index],
            type: safeTypes[index] || "",
            columnIndex: index,
          }) === true;
          if (!handled) {
            if (bars && staticNumericCols[index] && safeRows.length > 1) {
              const text = formatNumericCellText(entry.row[index], index, staticMaxScale);
              setGaugeCell(td, entry.row[index], index, text, staticMax, staticMin, safeColumns[index]);
            } else {
              setDisplayCell(td, entry.row[index], formatCellForDisplayWithTypes(entry.row[index], index, typeAsts));
            }
          }
          tr.appendChild(td);
        }
      } else {
        const td = document.createElement("td");
        td.colSpan = Math.max(1, safeColumns.length);
        setCellTextFlat(td, entry.row);
        tr.appendChild(td);
      }
      if (typeof decorateRow === "function") decorateRow(tr, {
        row: entry.row,
        sourceRowIndex: entry.index - 1,
        displayIndex: entry.index,
      });
      tbody.appendChild(tr);
    }
    refreshRowDetailsAfterRender(tbody);
  }

  render();
  return wrap;
}

export { createStaticResultTable };
