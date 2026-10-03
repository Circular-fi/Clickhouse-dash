(() => {
  "use strict";

  // Explorer storage drawings of the cards: where the bytes of a database
  // (its tables) and of a table (its partitions, its columns) are.
  //
  //   renderDatabase(container, { root, residentBytes, name, disks, onOpen })
  //     the Storage tab of a database card: a treemap of its tables when at
  //     least three of them hold >= 1% of the database (otherwise one share
  //     strip: the dominant tables plus Others), the engine legend, the
  //     accounting footnote and the disks the database uses.
  //   renderTreemap(container, { tree, name, id, ariaLabel, className,
  //     scopeLabel, onOpen })
  //     a bounded treemap band with its legend and footnote, or null when
  //     the tree has fewer than three rectangles of >= 1% to draw (the table
  //     Storage tab's partitions, the Columns tab's column sizes).
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

  function percentText(value) {
    const n = Number(value);
    return value == null || !Number.isFinite(n) ? DASH : format.percent(n / 100);
  }

  // Rectangles of a materialized treemap that stand for real objects, i.e.
  // leaves that hold >= 1% of the root (everything smaller is in Others).
  function significantLeafCount(tree) {
    let count = 0;
    const visit = (item) => {
      if (!item || item.kind === "other") return;
      const children = Array.isArray(item.children) ? item.children : [];
      if (!children.length) { count += 1; return; }
      children.forEach(visit);
    };
    if (Array.isArray(tree?.children) && tree.children.length) tree.children.forEach(visit);
    return count;
  }

  function renderLegend(container, tree) {
    const families = ns.explorerTreemap?.engineLegend?.([tree]) || [];
    container.replaceChildren(...families.map((family) => {
      const item = h("span", { class: "explorerTreemapLegend__item" });
      const swatch = h("span", { class: "explorerTreemapLegend__swatch" });
      swatch.style.background = family.color;
      item.append(swatch, h("span", null, family.label));
      return item;
    }));
    container.hidden = !families.length;
  }

  function footnoteText({ threshold = 0, scopeLabel = "", resident = 0, treemapShown = false, measure = "On-disk bytes of active parts (local replica)", unit = "objects" }) {
    const bits = [measure];
    if (treemapShown && threshold > 0) bits.push(`the map groups ${unit} under 1% of ${scopeLabel} (< ${format.bytes(threshold)}) into Others`);
    if (resident > 0) bits.push(`RAM of Memory / Buffer / Dictionary not counted: ${format.bytes(resident)}`);
    return `${bits.join(" · ")}.`;
  }

  // A bounded treemap band, its legend and its footnote; null (nothing
  // drawn) when fewer than three rectangles of >= 1% would show.
  function renderTreemap(container, { tree, name = "", id = "", ariaLabel = "", className = "", scopeLabel = "", measure, unit, resident = 0, onOpen = null, minItems = TREEMAP_MIN_ITEMS } = {}) {
    const treemap = ns.explorerTreemap;
    if (!treemap || !tree || !(Number(tree.bytes) > 0)) return null;
    const built = treemap.buildTreemap(tree);
    if (significantLeafCount(built.tree) < minItems) return null;
    const wrap = h("div", { class: "explorerTreemapBand" });
    const host = h("div", { class: `explorerTreemapPanel${className ? ` ${className}` : ""}` });
    if (id) host.id = id;
    const footer = h("div", { class: "explorerTreemapFooter" });
    const legend = h("div", { class: "explorerTreemapLegend" });
    const footnote = h("div", { class: "explorerTreemapFootnote" }, footnoteText({ threshold: built.threshold, scopeLabel, resident, treemapShown: true, measure, unit }));
    footer.append(legend, footnote);
    wrap.append(host, footer);
    container.appendChild(wrap);
    renderLegend(legend, built.tree);
    const controller = treemap.mount(host, {
      ariaLabel: ariaLabel || `${name} size treemap`,
      formatBytes: (value) => format.bytes(value),
      onOpen: typeof onOpen === "function" ? onOpen : null,
    });
    controller?.setTree(built.tree, { name });
    return {
      element: wrap,
      // Same layout, new measure (the Columns tab's Compressed | Uncompressed).
      setTree(next, { name: nextName = name, measure: nextMeasure = measure } = {}) {
        const again = treemap.buildTreemap(next);
        controller?.setTree(again.tree, { name: nextName });
        renderLegend(legend, again.tree);
        footnote.textContent = footnoteText({ threshold: again.threshold, scopeLabel, resident, treemapShown: true, measure: nextMeasure, unit });
      },
      destroy() { controller?.destroy?.(); },
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

  // The share strip of a database whose bytes do not spread over three
  // tables of >= 1%: the materialized top level (tables >= 1% + Others).
  function renderStrip(container, { tree, total, name, onOpen }) {
    const treemap = ns.explorerTreemap;
    const top = Array.isArray(tree.children) && tree.children.length
      ? tree.children
      : [tree.kind === "table" ? tree : { kind: "other", name: "Others", members: Number(tree.count || 0), bytes: total }];
    const items = top.filter((item) => Number(item.bytes || 0) > 0);
    const strip = h("div", { class: "explorerStorageStrip" });
    strip.id = "explorerDatabaseStorageStrip";
    strip.setAttribute("role", "list");
    strip.setAttribute("aria-label", `${name} storage split`);
    const legend = h("div", { class: "explorerStorageStrip__legend" });
    for (const item of items) {
      const share = Number(item.bytes || 0) / total * 100;
      const other = item.kind === "other";
      const label = other ? `Others (${format.countLabel(Number(item.members || 0), "table")})` : item.name;
      const segment = h(other || !onOpen ? "span" : "button", { class: `explorerStorageStrip__segment${other ? " is-other" : ""}` });
      segment.setAttribute("role", "listitem");
      if (!other) {
        segment.dataset.table = item.table || item.name;
        segment.style.setProperty("--treemap-color", treemap.engineFamily(item.engine).color);
      }
      segment.style.flexGrow = String(Math.max(share, 0.6));
      segment.title = `${other ? `Others in ${name}` : `${name}.${item.name}`}\n${format.bytes(item.bytes)} · ${percentText(share)}`;
      if (share >= 12) segment.appendChild(h("span", { class: "explorerStorageStrip__label" }, `${label} · ${percentText(share)}`));
      if (!other && onOpen) {
        segment.type = "button";
        segment.addEventListener("click", () => onOpen(name, item.table || item.name));
      }
      strip.appendChild(segment);
      const entry = h("span", { class: "explorerStorageStrip__entry" });
      const swatch = h("span", { class: `explorerStorageStrip__swatch${other ? " is-other" : ""}` });
      if (!other) swatch.style.background = treemap.engineFamily(item.engine).color;
      entry.append(swatch, h("span", { class: "explorerStorageStrip__name" }, label), h("span", { class: "explorerStorageStrip__value" }, `${format.bytes(item.bytes)} · ${percentText(share)}`));
      legend.appendChild(entry);
    }
    container.append(strip, legend);
  }

  function sectionHead(title, meta = "") {
    const head = h("div", { class: "explorerSectionHead" });
    head.appendChild(h("h3", { class: "explorerSectionTitle" }, title));
    if (meta) head.appendChild(h("span", { class: "explorerSectionCount" }, meta));
    return head;
  }

  // The Storage tab of a database card.
  function renderDatabase(container, { root, residentBytes = 0, name = "", disks = [], onOpen = null } = {}) {
    const treemap = ns.explorerTreemap;
    const view = h("div", { class: "explorerDatabaseStorage" });
    container.appendChild(view);
    const total = Number(root?.bytes || 0);
    const tables = h("section", { class: "explorerSection explorerDatabaseStorage__tables" });
    const meta = [total > 0 ? `${format.bytes(total)} on disk` : "", Number(root?.count || 0) > 0 ? format.countLabel(Number(root.count), "table") + " with data" : "", residentBytes > 0 ? `${format.bytes(residentBytes)} RAM` : ""].filter(Boolean).join(" · ");
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
      controller = renderTreemap(tables, {
        tree: root,
        name,
        id: "explorerDatabaseTreemap",
        ariaLabel: `${name} table size treemap`,
        className: "explorerTreemapPanel--database",
        scopeLabel: "the database",
        resident: residentBytes,
        onOpen: (target) => {
          if (target.kind === "table" && target.database && target.table) onOpen?.(target.database, target.table);
        },
      });
      if (!controller) {
        renderStrip(tables, { tree: treemap.buildTreemap(root).tree, total, name, onOpen });
        const footer = h("div", { class: "explorerTreemapFooter" });
        footer.appendChild(h("div", { class: "explorerTreemapFootnote explorerTreemapFootnote--start" }, footnoteText({ resident: residentBytes })));
        tables.appendChild(footer);
      }
    }
    if ((disks || []).length) {
      const section = h("section", { class: "explorerSection explorerDatabaseStorage__disks" });
      section.appendChild(sectionHead("Disks", format.count(disks.length)));
      renderDisks(section, disks);
      view.appendChild(section);
    }
    return controller || { destroy() {} };
  }

  ns.explorerStorage = {
    renderDatabase,
    renderTreemap,
    significantLeafCount,
    footnoteText,
    TREEMAP_MIN_ITEMS,
  };
})();
