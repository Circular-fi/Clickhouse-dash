// This module draws the storage of the Explorer cards.
// The drawings show where the bytes of a database (its tables) and of a table (its partitions and its columns) are.
//
//   renderDatabase(container, { root, residentBytes, name, disks, onOpen, disksContainer })
//     Draws the storage of a database page. The storage is above the objects of the page. It has the size band first, then the table.
//     The size band shows the tables. It is a treemap when three or more tables hold 1% or more of the database, and no table holds most of it.
//     Otherwise, the band is one share strip. The strip shows the largest tables and Others.
//     The storage also has a legend, an accounting footnote, and the disks that the database uses.
//     If disksContainer is given, the disks go in that container. The page then puts the disks under its objects. Returns { element, destroy }.
//   renderTreemap(container, { tree, name, id, stripId, ariaLabel,
//     className, scopeLabel, onOpen, minItems, fallback, strip })
//     Draws a size band with its legend and footnote. The band uses ns.explorerTreemap.band.
//     The function returns null when the tree has fewer than minItems rectangles of 1% or more, and fallback is "none". The default for minItems is three.
//     The table Storage tab uses this for partitions, and the Columns tab uses it for column sizes. The databases overview asks for one.
//
// Byte accounting is the local on-disk accounting of the catalog.
// It uses bytes_on_disk of the active parts and total_bytes of the Log-family engines.
// The module reports the RAM of Memory, Buffer and Dictionary. It never draws this RAM as disk area.
// The layout and the groups are in app_explorer_treemap.js.

import { h } from "./app_dom.js";
import { explorerTreemap } from "./app_explorer_treemap.js";
import { format } from "./app_format.js";
import { results } from "./app_results.js";
import { uiState } from "./app_ui_state.js";
import { table as tableMod } from "./app_ui_table.js";

const TREEMAP_MIN_ITEMS = 3;
const DASH = format.EMPTY;

function footnoteText({ threshold = 0, scopeLabel = "", resident = 0, treemapShown = false, measure = "On-disk bytes of active parts (local replica)", unit = "objects" }) {
  const bits = [measure];
  if (treemapShown && threshold > 0) bits.push(`the map groups ${unit} under 1% of ${scopeLabel} (< ${format.bytes(threshold)}) into Others`);
  if (resident > 0) bits.push(`RAM of Memory / Buffer / Dictionary not counted: ${format.bytes(resident)}`);
  return `${bits.join(" · ")}.`;
}

// Draw a size band. The band is a treemap, or a share strip when one cell holds most of the bytes.
// The band has a legend and a footnote. Return null, and draw nothing, when fewer than minItems cells of 1% or more would show.
// This applies when the caller sets fallback to "none". The table tabs use this for partitions and columns.
function renderTreemap(container, { tree, name = "", id = "", stripId = "", ariaLabel = "", className = "", scopeLabel = "", measure, unit, resident = 0, onOpen = null, minItems = TREEMAP_MIN_ITEMS, fallback = "none", strip = "auto" } = {}) {
  const treemap = explorerTreemap;
  if (!treemap?.band || !tree || !(Number(tree.bytes) > 0)) return null;
  const note = (nextMeasure) => (built, mode) => footnoteText({ threshold: built.threshold, scopeLabel, resident, treemapShown: mode === "map", measure: nextMeasure, unit });
  const band = treemap.band(container, {
    tree,
    name,
    id,
    stripId,
    ariaLabel: ariaLabel || `${name} size treemap`,
    className,
    minItems,
    fallback,
    strip,
    footnote: note(measure),
    formatBytes: (value) => format.bytes(value),
    onOpen: typeof onOpen === "function" ? onOpen : null,
  });
  if (!band) return null;
  return {
    element: band.element,
    mode: band.mode,
    // Draw the same tree with a new measure. The Columns tab switches between Compressed and Uncompressed.
    setTree(next, { name: nextName = name, measure: nextMeasure = measure } = {}) {
      band.setTree(next, { name: nextName, footnote: note(nextMeasure) });
    },
    destroy() { band.destroy(); },
  };
}

// The disks that a database uses. The data comes from the catalog's database summary.
function renderDisks(container, disks) {
  const rows = (disks || []).map((disk) => {
    const row = [String(disk.name || ""), String(disk.path || ""), String(disk.type || ""), Number(disk.bytes || 0),
      disk.free_space == null ? null : Number(disk.free_space), disk.total_space == null ? null : Number(disk.total_space)];
    row.__disk = disk;
    return row;
  });
  const max = Math.max(0, ...rows.map((row) => row[3] || 0));
  const table = results?.createStaticResultTable?.({
    columns: ["Disk", "Path", "Type", "Size", "Free", "Capacity"],
    types: ["String", "String", "String", "UInt64", "UInt64", "UInt64"],
    rows,
    className: "explorerTable explorerTable--disks explorerDatabaseDisks",
    compact: true,
    indexSortable: false,
    nullsLast: true,
    decorateHeader: (th, ctx) => {
      th.title = { 3: "On-disk bytes of the database's active parts on this disk", 4: "Free space on the disk", 5: "Disk capacity" }[ctx.columnIndex] || "";
      if (ctx.columnIndex >= 3) th.classList.add("num");
    },
    renderCell: (td, ctx) => {
      const value = ctx.value;
      if (ctx.columnIndex <= 2) {
        td.textContent = value || DASH;
        td.classList.add("explorerCell--code");
        if (ctx.columnIndex === 1) td.classList.add("explorerCell--path");
        if (ctx.columnIndex === 0 && ctx.row?.__disk?.host_name) td.title = `${value} on ${ctx.row.__disk.host_name}`;
        return true;
      }
      td.classList.add("num");
      if (value == null) { td.textContent = DASH; return true; }
      if (ctx.columnIndex === 3 && rows.length > 1) tableMod.cellBar(td, tableMod.barPercent(value, max));
      td.textContent = format.bytes(value);
      return true;
    },
  });
  if (table) {
    table.id = "explorerDatabaseDisks";
    container.appendChild(table);
  }
}

function sectionHead(title, meta = "") {
  const head = h("div", { class: "explorerSectionHead" });
  head.appendChild(h("h3", { class: "explorerSectionTitle" }, title));
  if (meta) head.appendChild(h("span", { class: "explorerSectionCount" }, meta));
  return head;
}

// The storage of a database page. The page header shows the size of the database. The footnote shows its RAM.
// The section head counts only the tables that hold data.
function renderDatabase(container, { root, residentBytes = 0, name = "", disks = [], onOpen = null, disksContainer = null } = {}) {
  const treemap = explorerTreemap;
  const view = h("div", { class: "explorerDatabaseStorage", id: "explorerDatabaseStorage" });
  container.appendChild(view);
  const total = Number(root?.bytes || 0);
  const tables = h("section", { class: "explorerSection explorerDatabaseStorage__tables" });
  const meta = Number(root?.count || 0) > 0 ? `${format.countLabel(Number(root.count), "table")} with data` : "";
  tables.appendChild(sectionHead("Tables by size", meta));
  view.appendChild(tables);
  let controller = null;
  if (!treemap || !(total > 0)) {
    tables.appendChild(uiState.block("empty", {
      compact: true,
      body: residentBytes > 0
        ? `No on-disk data. Resident memory: ${format.bytes(residentBytes)} (Memory / Buffer / Dictionary).`
        : "No on-disk data in this database.",
    }));
  } else {
    // The treemap of the tables. Use the share strip when fewer than three tables hold 1% or more, or when one table holds most of the bytes.
    controller = renderTreemap(tables, {
      tree: root,
      name,
      id: "explorerDatabaseTreemap",
      stripId: "explorerDatabaseStorageStrip",
      ariaLabel: `${name} table size treemap`,
      scopeLabel: "the database",
      unit: "tables",
      resident: residentBytes,
      fallback: "strip",
      onOpen: (target) => {
        if (target.kind === "table" && target.database && target.table) onOpen?.(target.database, target.table);
      },
    });
  }
  if ((disks || []).length) {
    const section = h("section", { class: "explorerSection explorerDatabaseStorage__disks" });
    section.appendChild(sectionHead("Disks", format.count(disks.length)));
    renderDisks(section, disks);
    (disksContainer || view).appendChild(section);
  }
  return { element: view, destroy() { controller?.destroy?.(); } };
}

export const explorerStorage = {
  renderDatabase,
  renderTreemap,
  footnoteText,
  TREEMAP_MIN_ITEMS,
};
