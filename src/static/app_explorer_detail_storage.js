// The Storage tab of the table card.
// It shows how the bytes split (Wide, Compact, projections, indexes).
// It also shows the disks, the partitions (a treemap and the share list), the parts, the skipping indexes and the projections.

import { h } from "./app_dom.js";
import { cardMaps, emptyNote, exprEl, gaugeCell, numericCell, renderSections, staticTable } from "./app_explorer_detail_cells.js";
import { DASH, columnMax, optionalNumber, partitionTree, percentText, percentValue, sectionUnavailable, storageComposition, structureItems } from "./app_explorer_detail_model.js";
import { parts } from "./app_explorer_store.js";
import { isLogFamilySummary, isMergeTreeSummary, summaryFootprintBytes } from "./app_explorer_summary.js";
import { format } from "./app_format.js";
import { badge as badgeMod } from "./app_ui_badge.js";
import { table } from "./app_ui_table.js";

function buildStorageComposition(detail, { embedded = false } = {}) {
  const composition = storageComposition(detail);
  const wrap = h("div", { class: `explorerStorageComposition explorerStorageComposition--stacked${embedded ? " is-embedded" : ""}` });
  const bar = h("div", { class: `explorerStorageStackedBar${composition.known ? "" : " is-unknown"}` });

  if (composition.known) {
    let consumed = 0;
    const visible = composition.items.filter((item) => item.percent > 0);
    visible.forEach((item, index) => {
      const width = index === visible.length - 1
        ? Math.max(0, 100 - consumed)
        : Math.max(0, Math.min(item.percent, 100 - consumed));
      const segment = h("div", { class: `explorerStorageStackedBar__segment explorerStorageStackedBar__segment--${item.variant}` });
      segment.style.width = `${width}%`;
      segment.title = `${item.label}: ${percentText(item.percent)} \u00b7 ${format.bytes(item.bytes)}`;
      bar.appendChild(segment);
      consumed += width;
    });
  } else {
    bar.appendChild(h("span", { class: "explorerStorageStackedBar__unknown" }, "unknown"));
  }
  wrap.appendChild(bar);

  const legend = h("div", { class: "explorerStorageCompositionLegend" });
  const legendItems = composition.known
    ? composition.items.filter((item) => Number(item.bytes) > 0)
    : [];
  for (const item of legendItems) {
    const entry = h("div", { class: "explorerStorageCompositionLegend__item" });
    entry.append(
      h("i", { class: `explorerStorageCompositionLegend__swatch explorerStorageCompositionLegend__swatch--${item.variant}` }),
      h("span", { class: "explorerStorageCompositionLegend__label" }, item.label),
      h("span", { class: "explorerStorageCompositionLegend__percent" }, item.percent == null || item.bytes == null
          ? "unknown"
          : `${percentText(item.percent)} \u00b7 ${format.bytes(item.bytes)}`),
    );
    if (item.bytes != null) entry.title = `${item.label}: ${percentText(item.percent)} \u00b7 ${format.bytes(item.bytes)}`;
    legend.appendChild(entry);
  }
  if (legendItems.length) wrap.appendChild(legend);
  return wrap;
}

function renderStorageCompositionCard(container, detail) {
  const tableBytes = summaryFootprintBytes(detail.summary || {});
  const card = h("div", { class: "explorerStorageCompositionCard" });
  const head = h("div", { class: "explorerStorageCompositionCard__head" });
  head.append(
    h("span", { class: "explorerStorageCompositionCard__label" }, "Table storage"),
    h("span", { class: "explorerStorageCompositionCard__bytes" }, tableBytes == null ? "unknown" : format.bytes(tableBytes)),
  );
  card.append(head, buildStorageComposition(detail, { embedded: true }));
  container.appendChild(card);
}

function renderDisks(body, detail) {
  const disks = detail.storage || [];
  const max = columnMax(disks, (disk) => disk.bytes);
  // Log-family engines have no parts. Do not add a Parts column for them.
  const parts = isMergeTreeSummary(detail.summary);
  body.appendChild(staticTable({
    className: "explorerTable--disks",
    items: disks,
    specs: [
      { label: "Disk", value: (disk) => disk.disk || "unknown disk", cellClass: "explorerCell--code" },
      { label: "Path", value: (disk) => disk.path || "", cellClass: "explorerCell--path explorerCell--code" },
      {
        label: "Size", type: "UInt64", numeric: true, value: (disk) => optionalNumber(disk.bytes),
        render: (td, disk) => gaugeCell(td, disk.bytes, max, disk.bytes == null ? DASH : format.bytes(disk.bytes)),
      },
      { label: "Rows", priority: "mid", type: "UInt64", numeric: true, value: (disk) => optionalNumber(disk.rows) },
      parts && { label: "Parts", priority: "low", type: "UInt64", numeric: true, value: (disk) => optionalNumber(disk.parts) },
      {
        label: "Free", type: "UInt64", numeric: true, head: "Free space on the disk", value: (disk) => optionalNumber(disk.free_space),
        render: (td, disk) => numericCell(td, disk.free_space == null ? DASH : format.bytes(disk.free_space)),
      },
      {
        label: "Capacity", type: "UInt64", numeric: true, value: (disk) => optionalNumber(disk.total_space),
        render: (td, disk) => numericCell(td, disk.total_space == null ? DASH : format.bytes(disk.total_space)),
      },
    ].filter(Boolean),
  }));
}

function renderParts(body, detail) {
  const parts = detail.parts || [];
  const max = columnMax(parts, (part) => part.bytes);
  body.appendChild(staticTable({
    className: "explorerTable--parts",
    items: parts,
    specs: [
      { label: "Part", value: (part) => part.name, cellClass: "explorerCell--code explorerCell--part" },
      { label: "Partition", value: (part) => part.partition, cellClass: "explorerCell--code explorerCell--partition" },
      { label: "Disk", value: (part) => part.disk, cellClass: "explorerCell--code explorerCell--disk" },
      { label: "Rows", type: "UInt64", numeric: true, value: (part) => optionalNumber(part.rows) },
      {
        label: "Bytes", type: "UInt64", numeric: true, head: "Bytes on disk", value: (part) => optionalNumber(part.bytes),
        render: (td, part) => gaugeCell(td, part.bytes, max, format.bytes(part.bytes)),
      },
      { label: "Marks", priority: "low", type: "UInt64", numeric: true, value: (part) => optionalNumber(part.marks) },
      { label: "Files", priority: "low", type: "UInt64", numeric: true, value: (part) => optionalNumber(part.files) },
      { label: "Level", priority: "mid", type: "UInt64", numeric: true, head: "Merge level (0: never merged)", value: (part) => optionalNumber(part.level) },
      {
        label: "Age", type: "UInt64", numeric: true, head: "Time since the part was written", value: (part) => optionalNumber(part.age_seconds),
        render: (td, part) => { numericCell(td, format.duration.fromSeconds(part.age_seconds)); td.title = `${format.count(part.age_seconds)} s`; },
      },
      {
        label: "State", value: (part) => (part.active ? "active" : "inactive"),
        // Use a chip only for the exception. An active part (the norm) is a muted word.
        // An inactive part (outdated, that waits for cleanup) is a chip.
        render: (td, part) => {
          if (part.active) td.appendChild(h("span", { class: "explorerPartState" }, "active"));
          else td.appendChild(badgeMod.el("inactive", { tone: "neutral", className: "explorerBadge explorerBadge--inactive" }));
        },
      },
    ],
  }));
}

function renderPartitions(body, detail) {
  const partitions = (detail.partitions || []).slice().sort((a, b) => Number(b.bytes || 0) - Number(a.bytes || 0));
  const total = partitions.reduce((sum, p) => sum + Number(p.bytes || 0), 0);
  const max = columnMax(partitions, (partition) => partition.bytes);
  const s = detail.summary || {};
  const map = parts.storage?.renderTreemap?.(body, {
    tree: partitionTree(detail),
    name: `${s.database}.${s.name}`,
    id: "explorerPartitionTreemap",
    ariaLabel: `${s.name} partition size treemap`,
    scopeLabel: "the table",
    unit: "partitions",
  });
  if (map) cardMaps.push(map);
  body.appendChild(staticTable({
    className: "explorerTable--partitions",
    items: partitions,
    decorateRow: (tr, p) => { if (p) tr.dataset.partition = String(p.partition); },
    specs: [
      { label: "Partition", value: (p) => (p.partition === "" ? "(no partition)" : p.partition), cellClass: "explorerCell--code" },
      {
        label: "Size", type: "UInt64", numeric: true, head: "Bytes on disk of the partition's active parts", value: (p) => optionalNumber(p.bytes),
        render: (td, p) => numericCell(td, format.bytes(p.bytes)),
      },
      {
        label: "Share", type: "Float64", numeric: true, head: "Share of the table's bytes on disk (bar: share of the largest partition)",
        value: (p) => percentValue(p.bytes, total),
        render: (td, p, value) => {
          td.classList.add("num", "explorerCell--share");
          if (value == null) { td.textContent = DASH; return; }
          table.shareBar(td, max > 0 ? Math.max(Number(p.bytes) > 0 ? 1.5 : 0, Math.min(100, Number(p.bytes) / max * 100)) : 0, percentText(value));
        },
      },
      { label: "Rows", type: "UInt64", numeric: true, value: (p) => optionalNumber(p.rows) },
      { label: "Parts", priority: "mid", type: "UInt64", numeric: true, value: (p) => optionalNumber(p.parts) },
    ],
  }));
  if (partitions.length >= 1000) body.appendChild(emptyNote("Only the 1,000 most recently modified partitions are listed."));
}

function renderStructures(body, items, kind) {
  const max = columnMax(items, (item) => item.compressed);
  const specs = [
    { label: kind === "indexes" ? "Index" : "Projection", value: (item) => item.name, cellClass: "explorerCell--code" },
    { label: "Type", value: (item) => item.type },
  ];
  if (items.some((item) => item.expression)) {
    specs.push({
      label: "Expression", value: (item) => item.expression,
      render: (td, item) => {
        td.classList.add("explorerCell--code", "explorerCell--expr");
        if (!item.expression) { td.textContent = DASH; return; }
        td.appendChild(exprEl(item.expression));
        td.title = item.expression;
      },
    });
  }
  specs.push(
    {
      label: "Compressed", type: "Float64", numeric: true, value: (item) => item.compressed,
      render: (td, item) => gaugeCell(td, item.compressed, max, item.compressed == null ? DASH : format.bytes(item.compressed)),
    },
    {
      label: "Uncompressed", priority: "low", type: "Float64", numeric: true, value: (item) => item.uncompressed,
      render: (td, item) => numericCell(td, item.uncompressed == null ? DASH : format.bytes(item.uncompressed)),
    },
    {
      label: "% table", priority: "mid", type: "Float64", numeric: true, value: (item) => item.percent,
      render: (td, item) => { td.classList.add("explorerStoragePercentCell"); numericCell(td, item.percent == null ? DASH : percentText(item.percent)); },
    },
  );
  body.appendChild(staticTable({ className: `explorerStorageResultTable--${kind}`, items, specs }));
}

function renderStorageTab(container, detail) {
  const s = detail.summary || {};
  if (isMergeTreeSummary(s)) renderStorageCompositionCard(container, detail);
  const disks = detail.storage || [];
  const parts = detail.parts || [];
  const partitions = detail.partitions || [];
  const indexes = structureItems(detail, "index:");
  const projections = structureItems(detail, "projection:");
  const mergeTree = isMergeTreeSummary(s);
  const activeParts = parts.filter((part) => part.active).length;
  // The table storage in one tab.
  // It shows how the bytes split (composition) and where they are (disks).
  // It shows how they spread over partitions (the treemap and the share list of the former Storage mode).
  // Then it shows the parts, the skipping indexes and the projections.
  renderSections(container, [
    {
      id: "disks", title: isLogFamilySummary(s) ? "Disks (storage medium)" : "Disks", count: disks.length, hasData: disks.length > 0,
      emptyText: sectionUnavailable(detail, "storage") ? "Disk metadata unavailable" : "No local disk-backed storage",
      render: (body) => renderDisks(body, detail),
    },
    mergeTree && {
      id: "partitions", title: "Partitions", count: partitions.length, hasData: partitions.length > 0,
      emptyText: sectionUnavailable(detail, "partitions") ? "Partition metadata unavailable" : "No partitions",
      render: (body) => renderPartitions(body, detail),
    },
    mergeTree && {
      id: "parts", title: "Parts", count: parts.length, hasData: parts.length > 0,
      note: parts.length !== activeParts ? `${format.count(activeParts)} active` : "",
      emptyText: sectionUnavailable(detail, "parts") ? "Part metadata unavailable" : "No parts",
      render: (body) => renderParts(body, detail),
    },
    mergeTree && {
      id: "indexes", title: "Skipping indexes", count: indexes.length, hasData: indexes.length > 0,
      emptyText: "No skipping indexes",
      render: (body) => renderStructures(body, indexes, "indexes"),
    },
    mergeTree && {
      id: "projections", title: "Projections", count: projections.length, hasData: projections.length > 0,
      emptyText: "No projections",
      render: (body) => renderStructures(body, projections, "projections"),
    },
  ]);
}

export { renderStorageTab };
