(() => {
  "use strict";

  // Explorer storage drawings of the cards: where the bytes of a database
  // (its tables) and of a table (its partitions, its columns) are.
  //
  //   renderDatabase(container, { root, residentBytes, name, disks, onOpen })
  //     the storage of a database page, under its objects: the size band of
  //     its tables (a treemap when at least three of them hold >= 1% of the
  //     database and none holds most of it, otherwise one share strip: the
  //     largest tables plus Others), its legend, the accounting footnote and
  //     the disks the database uses. Returns { element, destroy }.
  //   renderTreemap(container, { tree, name, id, stripId, ariaLabel,
  //     className, scopeLabel, onOpen, minItems, fallback, strip })
  //     a size band (ns.explorerTreemap.band) with its legend and footnote,
  //     or null when the tree has fewer than minItems (three by default)
  //     rectangles of >= 1% to draw and fallback is "none" (the table Storage
  //     tab's partitions, the Columns tab's column sizes; the databases
  //     overview asks for one).
  //
  // Byte accounting is the local on-disk accounting of the catalog
  // (bytes_on_disk of active parts, total_bytes of Log-family engines).
  // Memory / Buffer / Dictionary RAM is reported, never drawn as disk area.
  // The layout and grouping are app_explorer_treemap.js.

  const ns = window.ChDash;
  if (!ns) return;

  const TREEMAP_MIN_ITEMS = 3;
  const DASH = ns.format.EMPTY;
  const { h } = ns;
  const format = ns.format;

  function footnoteText({ threshold = 0, scopeLabel = "", resident = 0, treemapShown = false, measure = "On-disk bytes of active parts (local replica)", unit = "objects" }) {
    const bits = [measure];
    if (treemapShown && threshold > 0) bits.push(`the map groups ${unit} under 1% of ${scopeLabel} (< ${format.bytes(threshold)}) into Others`);
    if (resident > 0) bits.push(`RAM of Memory / Buffer / Dictionary not counted: ${format.bytes(resident)}`);
    return `${bits.join(" · ")}.`;
  }

  // A size band (ns.explorerTreemap.band: the treemap, or the share strip
  // when one cell dominates), its legend and its footnote; null (nothing
  // drawn) when fewer than minItems cells of >= 1% would show and the caller
  // wants no strip (fallback "none", the table tabs' partitions and columns).
  function renderTreemap(container, { tree, name = "", id = "", stripId = "", ariaLabel = "", className = "", scopeLabel = "", measure, unit, resident = 0, onOpen = null, minItems = TREEMAP_MIN_ITEMS, fallback = "none", strip = "auto" } = {}) {
    const treemap = ns.explorerTreemap;
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
      // Same drawing, new measure (the Columns tab's Compressed | Uncompressed).
      setTree(next, { name: nextName = name, measure: nextMeasure = measure } = {}) {
        band.setTree(next, { name: nextName, footnote: note(nextMeasure) });
      },
      destroy() { band.destroy(); },
    };
  }

  // The disks a database uses (the catalog's database summary).
  function renderDisks(container, disks) {
    const rows = (disks || []).map((disk) => {
      const row = [String(disk.name || ""), String(disk.path || ""), String(disk.type || ""), Number(disk.bytes || 0),
        disk.free_space == null ? null : Number(disk.free_space), disk.total_space == null ? null : Number(disk.total_space)];
      row.__disk = disk;
      return row;
    });
    const max = Math.max(0, ...rows.map((row) => row[3] || 0));
    const table = ns.results?.createStaticResultTable?.({
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
        if (ctx.columnIndex === 3 && rows.length > 1) ns.table.cellBar(td, ns.table.barPercent(value, max));
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

  // The storage of a database page. The page header carries the database's
  // size and the footnote its RAM: the section head only counts the tables
  // that hold data.
  function renderDatabase(container, { root, residentBytes = 0, name = "", disks = [], onOpen = null } = {}) {
    const treemap = ns.explorerTreemap;
    const view = h("div", { class: "explorerDatabaseStorage", id: "explorerDatabaseStorage" });
    container.appendChild(view);
    const total = Number(root?.bytes || 0);
    const tables = h("section", { class: "explorerSection explorerDatabaseStorage__tables" });
    const meta = Number(root?.count || 0) > 0 ? `${format.countLabel(Number(root.count), "table")} with data` : "";
    tables.appendChild(sectionHead("Tables by size", meta));
    view.appendChild(tables);
    let controller = null;
    if (!treemap || !(total > 0)) {
      tables.appendChild(ns.uiState.block("empty", {
        compact: true,
        body: residentBytes > 0
          ? `No on-disk data. Resident memory: ${format.bytes(residentBytes)} (Memory / Buffer / Dictionary).`
          : "No on-disk data in this database.",
      }));
    } else {
      // The treemap of its tables, or the share strip when fewer than three
      // hold >= 1% or one holds most of the bytes.
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
      view.appendChild(section);
    }
    return { element: view, destroy() { controller?.destroy?.(); } };
  }

  ns.explorerStorage = {
    renderDatabase,
    renderTreemap,
    footnoteText,
    TREEMAP_MIN_ITEMS,
  };
})();
