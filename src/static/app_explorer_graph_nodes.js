// The cards of the Explorer graph on the canvas: a table, a Storage tier, a TTL terminal, a collapsed database, the band of an expanded one,
// the level of detail and the per-node expand controls.

import { NODE_HEIGHT, PHYSICAL_HEIGHT, ttlRules } from "./app_explorer_graph_model.js";
import { FONT, LINEAGE_FONT_MIN, STORAGE_FONT_MIN, canvasEllipsis, dimAlpha, graphColor, model, roundedRectPath } from "./app_explorer_graph_store.js";
import { diskCapacitySummary, kindCode, nodeTexts, ttlActionSummary, ttlBaseSummary, ttlTimingSummary } from "./app_explorer_graph_text.js";
import { databaseBounds } from "./app_explorer_graph_viewport.js";
import { format } from "./app_format.js";
import { graphKit } from "./app_graph_kit.js";

const kit = graphKit;

function drawTtlSummary(ctx, item, node) {
  if (model.detailMode !== "physical" || node.layer !== "logical") return;
  const rules = ttlRules(node);
  const storageDisabled = node.storage_disabled === true;
  const hasPolicy = !!String(node.storage_policy || "");
  if (!storageDisabled && !rules.length) return;

  const dividerY = item.y + (hasPolicy && !storageDisabled ? 85 : 67);
  ctx.strokeStyle = graphColor("border");
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(item.x + 12, dividerY);
  ctx.lineTo(item.x + item.width - 12, dividerY);
  ctx.stroke();
  ctx.fillStyle = graphColor("muted");
  ctx.font = `12px ${FONT}`;
  if (storageDisabled) {
    ctx.fillText("No persistent storage", item.x + 12, item.y + 85);
    return;
  }
  const count = `${rules.length} lifecycle rule${rules.length === 1 ? "" : "s"}`;
  ctx.fillStyle = graphColor("accentText");
  ctx.fillText(canvasEllipsis(ctx, `TTL · ${ttlBaseSummary(node)} · ${count}`, item.width - 24), item.x + 12, item.y + (hasPolicy ? 103 : 85));
}

function drawStorageTierNode(ctx, item, focused) {
  const node = item.node;
  const selected = !focused || focused.has(node.id);
  const isHover = model.hoveredId === node.id;
  const disks = Array.isArray(node.tier_disks) ? node.tier_disks : [];
  const events = Array.isArray(node.ttl_events) ? node.ttl_events : [];
  const visibleEvents = events.slice(0, 5);
  const volumeName = String(node.volume_name || node.name || "volume");

  ctx.save();
  ctx.globalAlpha = selected ? 1 : dimAlpha();
  roundedRectPath(ctx, item.x, item.y, item.width, item.height, 10);
  ctx.fillStyle = graphColor("nodeBg");
  ctx.fill();
  ctx.strokeStyle = isHover ? graphColor("halo") : graphColor("border");
  ctx.lineWidth = isHover ? 1.6 : 1.1;
  ctx.stroke();

  ctx.fillStyle = graphColor("muted");
  ctx.font = `11px ${FONT}`;
  ctx.fillText("Storage tier", item.x + 12, item.y + 17);
  if (Number(node.volume_priority || 0) > 0) {
    ctx.textAlign = "right";
    ctx.fillText(`priority ${node.volume_priority}`, item.x + item.width - 12, item.y + 17);
    ctx.textAlign = "left";
  }

  ctx.fillStyle = graphColor("text");
  ctx.font = `600 13px ${FONT}`;
  ctx.fillText(canvasEllipsis(ctx, `Volume · ${volumeName}`, item.width - 24), item.x + 12, item.y + 38);

  let y = item.y + 51;
  const diskRows = disks.length ? disks : [{ name: "No disk metadata" }];
  for (const disk of diskRows) {
    ctx.strokeStyle = graphColor("border");
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.moveTo(item.x + 12, y);
    ctx.lineTo(item.x + item.width - 12, y);
    ctx.stroke();

    const diskName = String(disk.disk_name || disk.name || "disk");
    ctx.fillStyle = graphColor("text");
    ctx.font = `600 12px ${FONT}`;
    ctx.fillText(canvasEllipsis(ctx, `Disk · ${diskName}`, item.width - 24), item.x + 12, y + 16);
    const capacity = diskCapacitySummary(disk);
    if (capacity) {
      ctx.fillStyle = graphColor("muted");
      ctx.font = `11px ${FONT}`;
      ctx.fillText(canvasEllipsis(ctx, capacity, item.width - 24), item.x + 12, y + 29);
    }
    y += 33;
  }

  if (visibleEvents.length) {
    ctx.strokeStyle = graphColor("border");
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(item.x + 12, y + 1);
    ctx.lineTo(item.x + item.width - 12, y + 1);
    ctx.stroke();

    ctx.fillStyle = graphColor("muted");
    ctx.font = `11px ${FONT}`;
    ctx.fillText(`TTL while in ${volumeName}`, item.x + 12, y + 18);
    y += 31;

    for (const event of visibleEvents) {
      ctx.fillStyle = graphColor("accentText");
      ctx.beginPath();
      ctx.arc(item.x + 15, y - 4, 2.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = `600 11px ${FONT}`;
      ctx.fillText(canvasEllipsis(ctx, ttlTimingSummary(event), item.width - 38), item.x + 23, y);
      ctx.fillStyle = graphColor("text");
      ctx.font = `11px ${FONT}`;
      const summary = event.unresolved_target ? `${ttlActionSummary(event)} · target unresolved` : ttlActionSummary(event);
      ctx.fillText(canvasEllipsis(ctx, summary, item.width - 38), item.x + 23, y + 14);
      y += 33;
    }
    if (events.length > visibleEvents.length) {
      ctx.fillStyle = graphColor("muted");
      ctx.font = `11px ${FONT}`;
      ctx.fillText(`+${events.length - visibleEvents.length} more`, item.x + 23, y - 2);
    }
  }
  ctx.restore();
}

function drawTtlExpiredNode(ctx, item, focused) {
  const node = item.node;
  const selected = !focused || focused.has(node.id);
  const isHover = model.hoveredId === node.id;
  ctx.save();
  ctx.globalAlpha = selected ? 1 : dimAlpha();
  roundedRectPath(ctx, item.x, item.y, item.width, item.height, 9);
  ctx.fillStyle = graphColor("nodeBg");
  ctx.fill();
  ctx.strokeStyle = isHover ? graphColor("halo") : graphColor("border");
  ctx.setLineDash([5, 4]);
  ctx.lineWidth = 1.1;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = graphColor("muted");
  ctx.font = `11px ${FONT}`;
  ctx.fillText("TTL terminal", item.x + 12, item.y + 17);
  ctx.fillStyle = graphColor("text");
  ctx.font = `600 13px ${FONT}`;
  ctx.fillText("Expired", item.x + 12, item.y + 38);
  ctx.fillStyle = graphColor("muted");
  ctx.font = `11px ${FONT}`;
  ctx.fillText("data deleted", item.x + 12, item.y + 57);
  ctx.restore();
}

// A compact card writes the object's name over two lines (kit.compactBox) rather than end it in an ellipsis.
const COMPACT_TITLE_LINES = 2;

// Level of detail (kit.isCompact): the cards turn compact once an ordinary
// card is under 40 px on screen or its smallest text under 7.5 px; a
// compact card is its title row only, in kit.compactBox().
function compactCards(scale = model.scale) {
  return model.detailMode === "physical"
    ? kit.isCompact(PHYSICAL_HEIGHT, scale, STORAGE_FONT_MIN)
    : kit.isCompact(NODE_HEIGHT, scale, LINEAGE_FONT_MIN);
}

// The box a card is drawn in: its own, or its compact box. Storage tiers
// and TTL terminals always draw in full.
function drawnBox(item, compact) {
  const kind = item.node.kind;
  if (!compact || kind === "storage_tier" || kind === "ttl_expired") return item;
  return kit.compactBox(item, model.scale, kind === "database_group" ? 1 : COMPACT_TITLE_LINES);
}

function drawNode(ctx, item, focused, compact) {
  const node = item.node;
  if (node.kind === "storage_tier") return drawStorageTierNode(ctx, item, focused);
  if (node.kind === "ttl_expired") return drawTtlExpiredNode(ctx, item, focused);
  if (node.kind === "database_group") return drawGroupNode(ctx, item, compact);
  const selected = !focused || focused.has(node.id);
  const storageDisabled = model.detailMode === "physical" && node.layer === "logical" && node.storage_disabled === true;
  const isFocus = !storageDisabled && model.focusedId === node.id;
  const isHover = !storageDisabled && model.hoveredId === node.id;
  const inPanel = model.panel?.type === "node" && model.panel.id === node.id;
  const viewLike = node.kind === "view" || node.kind === "materialized_view" || node.kind === "refreshable_materialized_view";
  const radius = kit.CARD_RADIUS;
  const baseName = String(node.label || node.name || "");
  const titleColor = storageDisabled ? graphColor("muted") : graphColor("text");
  const card = {
    radius,
    alpha: selected ? 1 : dimAlpha(),
    // The focused card: a 2 px accent border, dashed like any View / MV outline.
    focused: isFocus,
    fill: storageDisabled ? graphColor("disabledBg") : graphColor("nodeBg"),
    border: isHover || inPanel ? graphColor("halo") : graphColor("border"),
    borderWidth: isHover || inPanel ? 1.8 : node.kind === "materialized_view" ? 1.8 : 1.2,
    dashed: viewLike || storageDisabled,
    rows: [],
  };
  if (compact) {
    const box = kit.compactBox(item, model.scale, COMPACT_TITLE_LINES);
    if (box.titleSize) card.rows.push({ text: baseName, size: box.titleSize, weight: 600, color: titleColor, y: box.baseline, fit: "full", lines: COMPACT_TITLE_LINES, lineHeight: box.lineHeight });
    card.statusY = box.height / 2;
    kit.drawCard(ctx, box, card);
    return;
  } else if (node.layer === "physical") {
    card.rows.push(
      { text: kindCode(node.kind), size: 11, weight: 400, color: graphColor("muted"), y: 17, fit: "full" },
      { text: baseName, size: 12, weight: 600, color: graphColor("text"), y: 34 },
    );
    if (node.kind === "disk") card.rows.push({ text: diskCapacitySummary(node), size: 11, y: 51 });
  } else {
    // Title = the object's own name; the database is the subtitle so a long
    // database prefix never truncates the part that tells objects apart.
    const health = String(node.health || "healthy");
    if (health !== "healthy") card.status = health === "error" || health === "critical" ? "error" : "warn";
    card.badge = String(node.topology_badge || "");
    const texts = nodeTexts(node);
    card.rows.push(
      { text: baseName, size: 14, weight: 600, color: titleColor, y: 22 },
      { text: texts.subtitle, y: 41 },
    );
    if (!viewLike) {
      card.rows.push({ text: texts.size, y: 60 });
      if (model.detailMode === "physical" && node.storage_policy) {
        card.rows.push({ text: texts.policy, y: 78 });
      } else if (node.kind === "buffer") {
        card.rows.push({ text: texts.flush, y: 78 });
      }
    }
  }
  kit.drawCard(ctx, item, card);
  if (!compact && node.layer === "logical" && model.detailMode === "physical") {
    ctx.save();
    ctx.globalAlpha = card.alpha;
    drawTtlSummary(ctx, item, node);
    ctx.restore();
  }
}

function groupStat(database) {
  return model.groupStats?.get(database) || null;
}

function drawGroupNode(ctx, card, compact) {
  const node = card.node;
  const box = compact ? kit.compactBox(card, model.scale) : null;
  const item = box || card;
  const isHover = model.hoveredId === node.id;
  const stat = groupStat(node.database) || { total: 0, connected: 0 };
  ctx.save();
  // Two offset sheets behind the card read as "a stack of objects".
  for (const offset of [8, 4]) {
    roundedRectPath(ctx, item.x + offset, item.y - offset, item.width, item.height, 10);
    ctx.fillStyle = graphColor("nodeBg");
    ctx.fill();
    ctx.strokeStyle = graphColor("border");
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  roundedRectPath(ctx, item.x, item.y, item.width, item.height, 10);
  ctx.fillStyle = graphColor("groupBg");
  ctx.fill();
  ctx.strokeStyle = isHover ? graphColor("halo") : graphColor("border");
  ctx.lineWidth = isHover ? 1.8 : 1.2;
  ctx.stroke();
  const pad = 12;
  if (box) {
    if (box.titleSize) {
      ctx.fillStyle = graphColor("text");
      ctx.font = `600 ${box.titleSize}px ${FONT}`;
      ctx.fillText(canvasEllipsis(ctx, node.database, item.width - pad * 2), item.x + pad, item.y + box.baseline);
    }
    ctx.restore();
    return;
  }
  ctx.fillStyle = graphColor("text");
  ctx.font = `600 14px ${FONT}`;
  ctx.fillText(canvasEllipsis(ctx, `\u25b8 ${node.database}`, item.width - pad * 2), item.x + pad, item.y + 24);
  ctx.fillStyle = graphColor("muted");
  ctx.font = `12px ${FONT}`;
  const objects = format.countLabel(stat.total, "object");
  const linked = stat.connected ? `${format.count(stat.connected)} with dependencies` : "no dependencies";
  ctx.fillText(canvasEllipsis(ctx, `${objects} · ${linked}`, item.width - pad * 2), item.x + pad, item.y + 44);
  // What a click or Enter does, in the muted text of a hint (the link colour is for links).
  ctx.fillText("Expand \u00b7 Enter", item.x + pad, item.y + 64);
  ctx.restore();
}

// Header strip of an expanded database band (click target to collapse).
function databaseBandHeader(box) {
  const padX = 20;
  const header = 34;
  return { x: box.minX - padX, y: box.minY - header, width: box.maxX - box.minX + padX * 2, height: header };
}

function drawDatabaseGroups(ctx) {
  if (model.detailMode !== "logical") return;
  const groups = databaseBounds();
  if (groups.size <= 1 && !(model.groupStats && model.groupStats.size > 1)) return;
  ctx.save();
  for (const [database, box] of groups) {
    const padX = 20;
    const padBottom = 20;
    const header = 34;
    roundedRectPath(ctx, box.minX - padX, box.minY - header, box.maxX - box.minX + padX * 2, box.maxY - box.minY + header + padBottom, 12);
    ctx.fillStyle = graphColor("bandBg");
    ctx.globalAlpha = 0.36;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = graphColor("border");
    ctx.lineWidth = 0.9;
    ctx.stroke();
    const stat = groupStat(database);
    const collapsible = !!stat && !model.focusedId;
    const hover = collapsible && model.hoveredControl?.type === "band" && model.hoveredControl.database === database;
    ctx.fillStyle = hover ? graphColor("accentText") : graphColor("muted");
    ctx.font = `600 13px ${FONT}`;
    // DataHub-style "N of M": the band says when objects without
    // dependencies are filtered out of it.
    const count = stat && stat.shown !== stat.total
      ? `${format.count(stat.shown)} of ${format.count(stat.total)} objects`
      : `${format.count(stat ? stat.total : box.count)} objects`;
    ctx.fillText(`${collapsible ? "\u25be " : ""}${database} · ${count}`, box.minX, box.minY - 12);
  }
  ctx.restore();
}

function drawDatabaseLod(ctx) {
  const groups = databaseBounds({ includeGroupCards: true });
  ctx.save();
  for (const [database, box] of groups) {
    const pad = 24;
    roundedRectPath(ctx, box.minX - pad, box.minY - pad, box.maxX - box.minX + pad * 2, box.maxY - box.minY + pad * 2, 12);
    ctx.fillStyle = graphColor("groupBg");
    ctx.fill();
    ctx.strokeStyle = graphColor("border");
    ctx.lineWidth = 1.2;
    ctx.stroke();
    const scale = Math.max(0.01, Number(model.scale) || 1);
    ctx.fillStyle = graphColor("text");
    ctx.font = `600 ${Math.max(14, 13 / scale)}px ${FONT}`;
    ctx.fillText(database, box.minX, box.minY + Math.max(6, 13 / scale));
    ctx.fillStyle = graphColor("muted");
    ctx.font = `${Math.max(11, 11 / scale)}px ${FONT}`;
    ctx.fillText(`${box.count} objects`, box.minX, box.minY + Math.max(25, 30 / scale));
  }
  ctx.restore();
}

function nodeExpandControls(item) {
  const node = item.node;
  if (model.detailMode !== "logical" || !model.focusedId || node.layer !== "logical" || node.synthetic) return [];
  const controls = [];
  for (const direction of ["up", "down"]) {
    const hidden = Number(direction === "up" ? node.hidden_upstream : node.hidden_downstream) || 0;
    const key = `${direction}\u0000${node.id}`;
    const expanded = model.expansions.has(key);
    if (!hidden && !expanded) continue;
    controls.push({
      key, direction, hidden, expanded, node,
      label: expanded ? "\u2212" : `+${hidden}`,
      cx: direction === "up" ? item.x : item.x + item.width,
      cy: item.y + item.height - 18,
    });
  }
  return controls;
}

function drawNodeExpandControls(ctx, compact) {
  model.controlHits = [];
  if (compact || model.detailMode !== "logical" || !model.focusedId) return;
  ctx.save();
  ctx.font = `600 12px ${FONT}`;
  for (const item of model.layout.values()) {
    for (const control of nodeExpandControls(item)) {
      const width = Math.max(24, ctx.measureText(control.label).width + 14);
      const rect = { x: control.cx - width / 2, y: control.cy - 10, width, height: 20 };
      const hover = model.hoveredControl?.type === "expand" && model.hoveredControl.key === control.key;
      roundedRectPath(ctx, rect.x, rect.y, rect.width, rect.height, 10);
      ctx.fillStyle = hover ? graphColor("halo") : graphColor("nodeBg");
      ctx.fill();
      ctx.strokeStyle = graphColor("halo");
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.fillStyle = hover ? graphColor("labelBg") : graphColor("accentText");
      ctx.textAlign = "center";
      ctx.fillText(control.label, control.cx, control.cy + 4.5);
      ctx.textAlign = "left";
      model.controlHits.push({ ...control, ...rect });
    }
  }
  ctx.restore();
}

export { compactCards, databaseBandHeader, drawDatabaseGroups, drawDatabaseLod, drawNode, drawNodeExpandControls, drawnBox, nodeExpandControls };
