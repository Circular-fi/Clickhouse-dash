// The About panel of the table card shows value and context tiles. The tiles cover the engine, settings, size, compression, keys, TTL, replicas, lineage ...
// The panel appears beside the tab body. On a narrow pane, it appears above the tab body.

import { h } from "./app_dom.js";
import { dependencyChip, exprEl } from "./app_explorer_detail_cells.js";
import { engineArguments, engineSettingsOf, extractTableTtl, hasOperations, isEmptyRowSummary, keyElements, objectType, operationSectionList, optionalNumber, percentText, percentValue, prettyTtlParts, ratioLabel, shortName, splitTopLevel, visibleDependencies } from "./app_explorer_detail_model.js";
import { actions, model } from "./app_explorer_store.js";
import { humanEngine, isDictionarySummary, isLogFamilySummary, isMergeTreeSummary, isResidentMemorySummary, isViewLikeSummary, summaryFootprintBytes, summaryRowsLabel } from "./app_explorer_summary.js";
import { format } from "./app_format.js";
import { header } from "./app_header.js";

function ttlRuleEl(rule) {
  const [base, action] = prettyTtlParts(rule);
  const line = h("span", { class: "explorerTtlRule" });
  line.append(exprEl(base), h("span", { class: "explorerTtlRule__arrow" }, " \u2192 "), exprEl(action));
  return line;
}

function aboutTile(label, value, context = null, { mono = false, title = "", id = "", wide = false, block = false } = {}) {
  // A stat tile uses the stat.tile classes. It has a label, a value and context lines.
  // The About panel shows every value in full. Long values wrap in CSS, and no value is cut.
  // So the title adds only what the tile does not show.
  const tile = h("div", { class: `statTile explorerAboutTile${wide ? " explorerAboutTile--wide" : ""}` });
  if (id) tile.dataset.tile = id;
  tile.appendChild(h("div", { class: "statTile__label explorerAboutTile__label" }, label));
  const valueEl = h("div", { class: `statTile__value explorerAboutTile__value${mono ? " is-code" : ""}${block ? " is-block" : ""}` });
  if (value instanceof Node) valueEl.appendChild(value);
  else valueEl.textContent = String(value);
  if (title) valueEl.title = title;
  tile.appendChild(valueEl);
  const contexts = (Array.isArray(context) ? context : [context]).filter((item) => item != null && item !== "");
  for (const item of contexts) {
    tile.appendChild(item instanceof Node ? item : h("div", { class: "statTile__sub explorerAboutTile__context" }, item));
  }
  return tile;
}

// This is the key list: ORDER BY, PRIMARY KEY (when it differs), PARTITION BY and SAMPLE BY.
// Each element goes on its own line, in key order.
function keysTile(summary) {
  const sorting = String(summary.sorting_key || "").trim();
  const primary = String(summary.primary_key || "").trim();
  const groups = [
    ["ORDER BY", sorting, "order_by", primary && primary === sorting ? "also the primary key" : ""],
    ["PRIMARY KEY", primary && primary !== sorting ? primary : "", "primary_key", ""],
    ["PARTITION BY", String(summary.partition_key || "").trim(), "partition_by", ""],
    ["SAMPLE BY", String(summary.sampling_key || "").trim(), "sample_by", ""],
  ].map(([label, expression, id, note]) => ({ label, id, note, elements: keyElements(expression) }))
    .filter((group) => group.elements.length);
  if (!groups.length) return null;
  const list = h("div", { class: "explorerKeys" });
  for (const group of groups) {
    const section = h("div", { class: "explorerKeys__group" });
    section.dataset.key = group.id;
    const head = h("div", { class: "explorerKeys__name" }, group.label);
    if (group.note) head.appendChild(h("span", { class: "explorerKeys__note" }, group.note));
    const items = h("ol", { class: "explorerKeys__list" });
    group.elements.forEach((element, index) => {
      const item = h("li", { class: "explorerKeys__item" });
      item.dataset.position = String(index);
      item.append(h("span", { class: "explorerKeys__position" }, String(index)), exprEl(element, "explorerKeys__expr"));
      items.appendChild(item);
    });
    section.append(head, items);
    list.appendChild(section);
  }
  return aboutTile("Keys", list, null, { id: "keys", wide: true, block: true });
}

function aboutTiles(detail) {
  const s = detail.summary || {};
  const r = s.replication || {};
  const tiles = [];
  const viewLike = isViewLikeSummary(s);
  const resident = isResidentMemorySummary(s);
  const mergeTree = isMergeTreeSummary(s);
  const database = s.database || "";

  // This is the Engine tile. It shows where the engine routes for Buffer, Distributed and replicas.
  // It also shows the arguments and the settings in full. The engine_full value omits the keys and the TTL, because these have tiles of their own.
  const engineContext = [];
  if (detail.distributed?.cluster) engineContext.push(`cluster ${detail.distributed.cluster}`);
  if (r.available && r.replica_name) engineContext.push(`replica ${r.replica_name}`);
  if (s.engine && humanEngine(s.engine).replace(/\s+/g, "") !== s.engine) engineContext.push(s.engine);
  const engineArgs = engineArguments(s);
  // The storage_policy value has its own tile (MergeTree).
  const engineSettings = engineSettingsOf(s).filter((setting) => !(mergeTree && s.storage_policy && /^storage_policy\s*=/.test(setting)));
  tiles.push(aboutTile("Engine", humanEngine(s.engine), [
    engineContext.join(" \u00b7 "),
    engineArgs ? exprEl(engineArgs, "explorerAboutTile__expr") : "",
  ], { id: "engine", wide: !!engineArgs }));
  if (engineSettings.length) {
    const list = h("ul", { class: "explorerAboutTile__settings" });
    for (const setting of engineSettings) list.appendChild(h("li", null, exprEl(setting)));
    tiles.push(aboutTile("Settings", format.countLabel(engineSettings.length, "setting"), list, { id: "settings", wide: true }));
  }

  const routeKind = objectType(s.engine) === "mv" ? "materialized_view" : objectType(s.engine) === "buffer" ? "buffer" : "";
  const targets = routeKind
    ? visibleDependencies(detail).filter((dep) => dep.relation === "downstream" && dep.kind === routeKind && objectType(dep.engine) !== "mv")
    : [];
  if (targets.length) {
    const list = h("div", { class: "explorerAboutTile__chips" });
    list.append(...targets.map((dep) => dependencyChip(dep, database)));
    tiles.push(aboutTile(routeKind === "buffer" ? "Flushes to" : "Writes to", list, null, { id: "target" }));
  }

  const footprint = summaryFootprintBytes(s);
  if (!viewLike && footprint != null && footprint > 0) {
    const rowsText = s.rows == null ? "" : summaryRowsLabel(s);
    tiles.push(aboutTile("Size", format.bytes(footprint), [resident ? "in RAM" : "on disk", rowsText].filter(Boolean).join(" \u00b7 "), { id: "size" }));
  } else if (!viewLike && s.rows != null) {
    tiles.push(aboutTile("Rows", format.count(s.rows), null, { id: "rows" }));
  }

  const ratio = mergeTree ? ratioLabel(s.uncompressed_bytes, s.compressed_bytes) : null;
  if (ratio) {
    const codecs = (detail.default_compression_codecs || []).filter(Boolean);
    tiles.push(aboutTile("Compression", ratio, [
      `${format.bytes(s.uncompressed_bytes)} \u2192 ${format.bytes(s.compressed_bytes)}`,
      codecs.length ? `default codec ${codecs.join(" / ")}` : "",
    ], { id: "compression", title: "Uncompressed / compressed bytes of the active parts" }));
  }

  // Log-family engines report the uncompressed total of ClickHouse, not the parts.
  if (!mergeTree && isLogFamilySummary(s) && s.uncompressed_bytes != null) {
    tiles.push(aboutTile("Uncompressed", format.bytes(s.uncompressed_bytes), "data before compression", { id: "uncompressed" }));
  }

  const parts = Number(s.active_parts || 0);
  if (parts > 0) tiles.push(aboutTile("Parts", format.countLabel(parts, "active part"), format.countLabel(Number(s.partitions || 0), "partition"), { id: "parts" }));

  const keys = keysTile(s);
  if (keys) tiles.push(keys);

  const ttl = extractTableTtl(detail);
  if (ttl) {
    const rules = splitTopLevel(ttl);
    const list = h("ol", { class: "explorerAboutTile__rules" });
    for (const rule of rules) {
      const item = h("li", null, ttlRuleEl(rule));
      item.title = rule;
      list.appendChild(item);
    }
    tiles.push(aboutTile("TTL", format.countLabel(rules.length, "rule"), list, { id: "ttl", wide: true }));
  }

  if (mergeTree && s.storage_policy) {
    const disks = [...new Set((detail.storage || []).map((disk) => disk.disk).filter(Boolean))];
    tiles.push(aboutTile("Storage policy", s.storage_policy, disks.length ? `disks ${disks.join(", ")}` : null, { mono: true, id: "storage_policy" }));
  }

  if (r.available && r.zookeeper_path) {
    tiles.push(aboutTile("Keeper path", r.zookeeper_path, null, { mono: true, id: "keeper_path" }));
  }

  if (r.available) {
    const list = h("div", { class: "explorerAboutTile__replicas" });
    for (const replica of r.replicas || []) {
      const chip = h("span", { class: "explorerReplicaChip" });
      const dot = h("i", { class: `explorerHealthDot explorerHealthDot--${replica.active ? "healthy" : "error"}` });
      dot.setAttribute("aria-hidden", "true");
      chip.append(dot, h("span", null, replica.name === r.replica_name ? `${replica.name} (this)` : replica.name));
      chip.title = replica.active ? "Active" : "Inactive";
      list.appendChild(chip);
    }
    tiles.push(aboutTile("Replicas", `${format.count(r.active_replicas)}/${format.count(r.total_replicas)} active`, (r.replicas || []).length ? list : null, { id: "replicas" }));
  }

  if (detail.distributed?.table) {
    const target = { database: detail.distributed.database, table: detail.distributed.table, kind: "distributed_route" };
    const visible = visibleDependencies(detail).find((dep) => dep.kind === "distributed_route" && dep.database === target.database && dep.table === target.table);
    const value = visible ? dependencyChip(visible, database) : shortName(target.database, target.table, database);
    tiles.push(aboutTile("Local table", value, `on every shard of ${detail.distributed.cluster}`, { mono: true, id: "local_table" }));
    const shards = new Set((detail.topology || []).map((member) => member.shard_num)).size;
    if ((detail.topology || []).length) {
      tiles.push(aboutTile("Cluster", detail.distributed.cluster, `${format.countLabel(shards, "shard")} \u00b7 ${format.countLabel(detail.topology.length, "replica")}`, { mono: true, id: "cluster" }));
    }
  }

  const dbBytes = optionalNumber(detail.footprint_scope?.database_bytes);
  const allBytes = optionalNumber(detail.footprint_scope?.clickhouse_bytes);
  if (!viewLike && !resident && footprint != null && footprint > 0 && dbBytes != null && dbBytes > 0) {
    const dbShare = percentValue(footprint, dbBytes);
    const allShare = allBytes ? percentValue(footprint, allBytes) : null;
    tiles.push(aboutTile("Share", `${percentText(dbShare)} of ${database}`, allShare == null ? null : `${percentText(allShare)} of all databases`, { id: "share" }));
  }

  const activeAges = (detail.parts || []).filter((part) => part.active).map((part) => optionalNumber(part.age_seconds)).filter((age) => age != null);
  const newest = activeAges.length ? Math.min(...activeAges) : null;
  const schemaTime = String(s.metadata_modification_time || "");
  if (newest != null || schemaTime) {
    tiles.push(aboutTile(
      "Last modified",
      newest != null ? `${format.duration.fromSeconds(newest)} ago` : header.serverTime(schemaTime).text,
      [newest != null ? "newest part written" : "schema changed", newest != null && schemaTime ? `schema changed ${header.serverTime(schemaTime).text}` : ""],
      { id: "modified", title: schemaTime ? header.serverTime(schemaTime).title : "" },
    ));
  }

  if (!isViewLikeSummary(s) && !isDictionarySummary(s) && !detail._loading && !hasOperations(detail) && !isEmptyRowSummary(s)) {
    const idle = operationSectionList(detail).filter((item) => item.emptyText).map((item) => item.emptyText);
    if (idle.length) tiles.push(aboutTile("Activity", "Idle", idle.join(" \u00b7 "), { id: "activity" }));
  }

  const deps = visibleDependencies(detail);
  if (deps.length) {
    const up = deps.filter((dep) => String(dep.relation) === "upstream").length;
    const down = deps.length - up;
    const link = h("button", { class: "explorerAboutTile__link" }, "Open lineage");
    link.type = "button";
    link.addEventListener("click", () => actions.openTab("Lineage"));
    tiles.push(aboutTile("Lineage", `${format.count(up)} upstream \u00b7 ${format.count(down)} downstream`, link, { id: "lineage" }));
  }
  return tiles;
}

function renderAbout(detail) {
  const tiles = aboutTiles(detail);
  if (!tiles.length) return null;
  const aside = h("aside", { class: "explorerAbout" });
  aside.setAttribute("aria-label", "About this object");
  aside.appendChild(h("h3", { class: "explorerAbout__title" }, "About"));
  const grid = h("div", { class: "explorerAbout__tiles" });
  grid.append(...tiles);
  aside.appendChild(grid);
  // Narrow panes show the About tiles under the tab body. The first tiles stay visible.
  // The other tiles stay behind a toggle. On wide panes, CSS hides the toggle.
  if (tiles.length > 4) {
    const collapsed = model.aboutExpanded !== true;
    aside.classList.toggle("is-collapsed", collapsed);
    const toggle = h("button", { class: "explorerAbout__toggle" }, collapsed ? `Show all ${tiles.length}` : "Show less");
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.addEventListener("click", () => {
      model.aboutExpanded = aside.classList.contains("is-collapsed");
      aside.classList.toggle("is-collapsed", !model.aboutExpanded);
      toggle.textContent = model.aboutExpanded ? "Show less" : `Show all ${tiles.length}`;
      toggle.setAttribute("aria-expanded", String(model.aboutExpanded));
    });
    aside.appendChild(toggle);
  }
  return aside;
}

export { renderAbout };
