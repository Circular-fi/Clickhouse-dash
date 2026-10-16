// The Columns tab of the table card shows the columns with their types, keys, codecs and sizes.
// The size band is above the columns. It is a treemap of the column bytes.

import { dom, h } from "./app_dom.js";
import { cardMaps, emptyNote, exprEl, gaugeCell, numericCell, staticTable, unavailableMessage } from "./app_explorer_detail_cells.js";
import { COLUMN_MEASURES, DASH, columnMax, columnRows, columnSizeTree, percentText, ratioLabel, sectionUnavailable } from "./app_explorer_detail_model.js";
import { model, parts } from "./app_explorer_store.js";
import { format } from "./app_format.js";
import { badge as badgeMod } from "./app_ui_badge.js";
import { icon as iconMod } from "./app_ui_icon.js";
import { segmented } from "./app_ui_segmented.js";

const { $, $$ } = dom;

function renderColumnsTab(container, detail) {
  if (sectionUnavailable(detail, "columns")) container.appendChild(unavailableMessage("Column metadata"));
  const rows = columnRows(detail);
  if (!rows.length) {
    if (!sectionUnavailable(detail, "columns")) container.appendChild(emptyNote("No readable columns."));
    return;
  }
  const topLevel = rows.filter((row) => !row.is_subcolumn);
  // Distributed and View columns report 0 bytes. In that case, the table has no byte columns at all.
  const hasBytes = rows.some((row) => Number(row.compressed) > 0);
  const hasKeys = topLevel.some((row) => row.keys.length);
  // One shared default codec is stated one time, in About > Compression.
  // The codec column appears only when some column declares its own CODEC().
  const codecs = new Set(topLevel.map((row) => `${row.codec || ""}\0${row.codec_note || ""}`));
  const hasCodec = topLevel.some((row) => row.explicit_codec) || codecs.size > 1;
  const compressedMax = columnMax(rows.filter((row) => !row.is_subcolumn), (row) => row.compressed);
  const uncompressedMax = columnMax(rows.filter((row) => !row.is_subcolumn), (row) => row.uncompressed);
  const tupleExpanded = new Set();
  let table = null;

  const specs = [
    {
      label: "Column",
      value: (item) => item.name,
      render: (td, item) => {
        td.classList.add("explorerColumns__name");
        if (item.tuple_root) {
          const open = tupleExpanded.has(item.tuple_root);
          const toggle = h("button", { class: "explorerTreeDatabaseToggle explorerStorageTupleToggle" }, iconMod.el("chevron-right", { size: "sm", className: "icon--disclosure" }));
          toggle.type = "button";
          toggle.setAttribute("aria-expanded", String(open));
          toggle.setAttribute("aria-label", `${open ? "Collapse" : "Expand"} ${item.tuple_root}`);
          toggle.title = toggle.getAttribute("aria-label");
          toggle.addEventListener("click", (event) => {
            event.stopPropagation();
            const opening = !tupleExpanded.has(item.tuple_root);
            if (opening) tupleExpanded.add(item.tuple_root);
            else tupleExpanded.delete(item.tuple_root);
            toggle.setAttribute("aria-expanded", String(opening));
            toggle.setAttribute("aria-label", `${opening ? "Collapse" : "Expand"} ${item.tuple_root}`);
            toggle.title = toggle.getAttribute("aria-label");
            for (const row of $$("tbody tr[data-tuple-parent]", table) || []) {
              if (row.dataset.tupleParent === item.tuple_root) row.hidden = !opening;
            }
          });
          td.append(toggle, h("span", { class: "explorerStorageTupleName" }, item.name));
        } else {
          td.appendChild(h("span", { class: item.tuple_parent ? "explorerStorageTupleName explorerStorageTupleName--child" : "explorerStorageTupleName" }, item.name));
        }
        td.title = item.comment ? `${item.name}\n${item.comment}` : item.name;
        // The comment appears under the name. It wraps to two lines at most.
        if (item.comment) td.appendChild(h("span", { class: "explorerColumns__comment" }, item.comment));
      },
    },
    {
      label: "Type",
      head: "Type, then its DEFAULT / MATERIALIZED / ALIAS / EPHEMERAL expression",
      value: (item) => item.type,
      render: (td, item) => {
        td.classList.add("explorerColumns__type");
        td.appendChild(h("span", { class: "explorerColumns__typeName" }, item.type || DASH));
        td.title = item.type || "";
        const lines = [item.type];
        for (const [kind, expression] of [[item.default_kind, item.default_expression], [item.ttl_expression ? "TTL" : "", item.ttl_expression]]) {
          if (!kind) continue;
          const line = h("span", { class: "explorerColumns__default" });
          line.append(badgeMod.el(kind, { tone: "key", className: "explorerBadge explorerBadge--default" }), exprEl(expression, "explorerColumns__expr"));
          td.appendChild(line);
          lines.push(`${kind} ${expression}`);
        }
        td.title = lines.join("\n");
      },
    },
  ];
  if (hasKeys) specs.push({
    label: "Keys",
    head: "Sorting (ORDER BY), primary, partition and sampling key membership",
    value: (item) => item.keys.map(([label]) => label).join(" "),
    render: (td, item) => {
      td.classList.add("explorerColumns__keys");
      // Put one key on each line. This keeps room for the sizes beside About.
      const list = h("span", { class: "explorerColumns__keyList" });
      for (const [label, title, kind] of item.keys) {
        const badge = badgeMod.el(label, { tone: "key", className: `explorerBadge explorerBadge--key explorerBadge--${kind}` });
        badge.title = title;
        list.appendChild(badge);
      }
      td.appendChild(list);
    },
  });
  if (hasCodec) specs.push({
    label: "Codec",
    priority: "low",
    value: (item) => item.codec || "",
    render: (td, item) => {
      td.classList.add("explorerColumns__codec");
      if (!item.codec) { td.textContent = DASH; return; }
      td.appendChild(exprEl(item.codec));
      if (item.codec_note) td.appendChild(h("span", { class: "explorerColumns__codecNote" }, ` (${item.codec_note})`));
      td.title = item.codec_note ? `${item.codec} (${item.codec_note})` : item.codec;
    },
  });
  if (hasBytes) {
    specs.push({
      label: "Compressed",
      type: "Float64",
      numeric: true,
      head: "Compressed bytes on disk (bar: share of the largest column)",
      value: (item) => item.compressed,
      render: (td, item) => {
        gaugeCell(td, item.compressed, compressedMax, item.compressed == null ? DASH : format.bytes(item.compressed));
      },
    });
    specs.push({
      label: "Uncompressed",
      priority: "low",
      type: "Float64",
      numeric: true,
      head: "Uncompressed bytes of the column data (system.columns data_uncompressed_bytes; bar: share of the largest column)",
      value: (item) => item.uncompressed,
      render: (td, item) => {
        gaugeCell(td, item.uncompressed, uncompressedMax, item.uncompressed == null ? DASH : format.bytes(item.uncompressed));
        td.classList.add("explorerColumns__uncompressed");
        // The compression ratio is in the tooltip. A third figure does not fit in the row beside the About panel.
        const ratio = ratioLabel(item.uncompressed, item.compressed);
        if (ratio) td.title = `${ratio} compression (${format.bytes(item.uncompressed)} \u2192 ${format.bytes(item.compressed)})`;
      },
    });
    specs.push({
      label: "% table",
      priority: "mid",
      type: "Float64",
      numeric: true,
      head: "Compressed bytes / table bytes on disk",
      value: (item) => item.percent,
      render: (td, item) => {
        td.classList.add("explorerStoragePercentCell");
        numericCell(td, item.percent == null ? DASH : percentText(item.percent));
      },
    });
  }

  table = staticTable({
    className: "explorerStorageResultTable--columns explorerColumnsTable",
    specs,
    items: rows,
    rowIndexValue: (item) => item?.position ?? "",
    decorateRow: (tr, item) => {
      if (!item?.tuple_parent) return;
      tr.dataset.tupleParent = item.tuple_parent;
      tr.classList.add("explorerStorageTupleChild");
      tr.hidden = !tupleExpanded.has(item.tuple_parent);
      const indexCell = $(".dataTable__rowNum", tr);
      if (indexCell) {
        indexCell.textContent = "";
        indexCell.setAttribute("aria-hidden", "true");
      }
    },
  });
  // The size band comes first, then the table (docs/explorer.md, "Size views").
  if (hasBytes) renderColumnSizes(container, detail, rows);
  container.appendChild(table);

  if (sectionUnavailable(detail, "wide_column_sizes")) {
    container.appendChild(emptyNote("Wide per-column storage counters are unavailable on this server; a dash is shown instead of fabricating 0%."));
  } else if (sectionUnavailable(detail, "wide_subcolumn_sizes")) {
    container.appendChild(emptyNote("Tuple subcolumn names are available, but this server does not expose per-subcolumn Wide byte counters."));
  }
}

function renderColumnSizes(container, detail, rows) {
  const storageView = parts.storage;
  if (!storageView?.renderTreemap) return;
  const s = detail.summary || {};
  let measure = COLUMN_MEASURES.some((item) => item.value === model.columnSizeMeasure) ? model.columnSizeMeasure : "compressed";
  const sectionEl = h("section", { class: "explorerSection explorerColumnSizes" });
  const head = h("div", { class: "explorerSectionHead" });
  head.appendChild(h("h3", { class: "explorerSectionTitle" }, "Column sizes"));
  const toggle = h("div", { class: "explorerColumnSizes__measure" });
  segmented?.render(toggle, COLUMN_MEASURES.map(({ value, label }) => ({ value, label, title: `${label} bytes` })), { attr: "measure", value: measure, size: "compact", label: "Column size measure" });
  head.appendChild(toggle);
  sectionEl.appendChild(head);
  const options = (value) => ({
    name: `${s.database}.${s.name}`,
    measure: COLUMN_MEASURES.find((item) => item.value === value).measure,
  });
  const map = storageView.renderTreemap(sectionEl, {
    tree: columnSizeTree(detail, rows, measure),
    id: "explorerColumnTreemap",
    ariaLabel: `${s.name} column size treemap`,
    scopeLabel: "the column bytes",
    unit: "columns",
    ...options(measure),
  });
  if (!map) return;
  cardMaps.push(map);
  container.appendChild(sectionEl);
  segmented?.bind(toggle, {
    attr: "measure",
    onChange: (value) => {
      measure = String(value || "compressed");
      model.columnSizeMeasure = measure;
      map.setTree(columnSizeTree(detail, rows, measure), options(measure));
    },
  });
}

export { renderColumnsTab };
