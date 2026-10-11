// The header of the table card: the name, the chips of what the object is (engine, health), its figures as one muted line, the warnings and the
// replication banner.

import { dom, h } from "./app_dom.js";
import { availableTabs } from "./app_explorer_detail_model.js";
import { actions, model } from "./app_explorer_store.js";
import { healthLabel, humanEngine, isResidentMemorySummary, isViewLikeSummary, summaryFootprintBytes, summaryRowsLabel } from "./app_explorer_summary.js";
import { format } from "./app_format.js";
import { badge as badgeMod } from "./app_ui_badge.js";

// A header chip: the shared badge (md, pill); the health in its status tone.
const HEALTH_TONES = { healthy: "ok", warning: "warn", error: "error" };

function metaChip(text, { kind = "", title = "", dot = "" } = {}) {
  const tone = dot ? HEALTH_TONES[dot] || "neutral" : "neutral";
  const chip = h("span", { class: `${badgeMod.classes({ tone, size: "md", shape: "pill" })} explorerMetaChip${kind ? ` explorerMetaChip--${kind}` : ""}` });
  if (dot) {
    const mark = h("i", { class: `explorerHealthDot explorerHealthDot--${dot}` });
    mark.setAttribute("aria-hidden", "true");
    chip.appendChild(mark);
  }
  chip.appendChild(h("span", null, text));
  if (title) chip.title = title;
  return chip;
}

function healthState(summary) {
  const health = String(summary?.health || "healthy");
  return health === "error" ? "error" : health === "warning" ? "warning" : "healthy";
}

// The header: chips for what the object IS (engine, health), then its
// figures (rows, size, parts) as one muted line of text, not chips.
function headerChips(detail) {
  const s = detail.summary || {};
  const viewLike = isViewLikeSummary(s);
  // The engine is a neutral chip (a chip in the accent colour reads as a link); only the health has a tone.
  const chips = [metaChip(humanEngine(s.engine), { kind: "engine", title: s.engine_full || s.engine || "" })];
  if (!detail._loading && !viewLike && s.health) {
    const warnings = Array.isArray(s.warnings) ? s.warnings : [];
    chips.push(metaChip(healthLabel(s), { kind: "health", dot: healthState(s), title: warnings.join("\n") || "No problem reported by system metadata." }));
  }
  return chips;
}

function headerFacts(detail) {
  const s = detail.summary || {};
  if (isViewLikeSummary(s)) return [];
  const facts = [];
  const fact = (text, kind, title = "") => {
    const el = h("span", { class: `explorerMetaFact explorerMetaFact--${kind}` }, text);
    if (title) el.title = title;
    facts.push(el);
  };
  if (s.rows != null) fact(summaryRowsLabel(s), "rows");
  const footprint = summaryFootprintBytes(s);
  if (footprint != null && footprint > 0) {
    const resident = isResidentMemorySummary(s);
    fact(`${format.bytes(footprint)} ${resident ? "RAM" : "on disk"}`, "size",
      resident ? "Resident memory on this server" : `Bytes on disk of this server's active parts (${detail.metric_scope || "local-replica"})`);
  }
  const parts = Number(s.active_parts || 0);
  if (parts > 0) fact(format.countLabel(parts, "part"), "parts", format.countLabel(Number(s.partitions || 0), "partition"));
  return facts;
}

function replicationStatus(r) {
  if (!r?.available) return null;
  // Same thresholds as the backend health classification.
  if (r.readonly || r.session_expired || Number(r.active_replicas) === 0) return "error";
  if (Number(r.active_replicas) < Number(r.total_replicas) || Number(r.queue_size) > 1000 || Number(r.absolute_delay_seconds) > 60) return "warning";
  return "healthy";
}

function renderReplicationBanner(detail) {
  const host = dom.explorerSummaryCards;
  if (!host) return;
  const r = detail.summary?.replication || {};
  if (!r.available) {
    host.hidden = true;
    host.classList.remove("explorerSummaryCards--banner");
    host.replaceChildren();
    return;
  }
  const status = replicationStatus(r);
  const banner = h("div", { class: `explorerReplicaBanner explorerReplicaBanner--${status}` });
  const dot = h("i", { class: `explorerHealthDot explorerHealthDot--${status}` });
  dot.setAttribute("aria-hidden", "true");
  const facts = [
    `${format.count(r.active_replicas)}/${format.count(r.total_replicas)} replicas active`,
    `queue ${format.count(r.queue_size)}`,
    `delay ${format.count(r.absolute_delay_seconds)} s`,
  ];
  if (r.readonly) facts.push("read-only");
  if (r.session_expired) facts.push("Keeper session expired");
  banner.append(dot, h("strong", { class: "explorerReplicaBanner__title" }, "Replicated"), h("span", { class: "explorerReplicaBanner__facts" }, facts.join(" \u00b7 ")));
  if (r.replica_name) banner.appendChild(h("span", { class: "explorerReplicaBanner__replica" }, `this replica: ${r.replica_name}`));
  if (availableTabs(detail).includes("Operations")) {
    const open = h("button", { class: "explorerReplicaBanner__open" }, "Details");
    open.type = "button";
    open.addEventListener("click", () => actions.openTab("Operations"));
    banner.appendChild(open);
  }
  host.className = "explorerSummaryCards explorerSummaryCards--banner";
  host.hidden = false;
  host.replaceChildren(banner);
}

function renderDetailHeader() {
  const detail = model.detail;
  if (!detail) return;
  const s = detail.summary || {};
  if (dom.explorerEmptyState) dom.explorerEmptyState.hidden = true;
  if (dom.explorerDetail) dom.explorerDetail.hidden = false;
  if (dom.explorerDetailName) dom.explorerDetailName.textContent = `${s.database || ""}.${s.name || ""}`;
  if (dom.explorerDetailMeta) {
    const chips = h("span", { class: "explorerMetaChips" });
    chips.append(...headerChips(detail));
    const facts = headerFacts(detail);
    if (facts.length) {
      const line = h("span", { class: "explorerMetaFacts" });
      facts.forEach((item, index) => {
        if (index) line.appendChild(h("span", { class: "explorerMetaFacts__sep", "aria-hidden": "true" }, " \u00b7 "));
        line.appendChild(item);
      });
      chips.appendChild(line);
    }
    dom.explorerDetailMeta.replaceChildren(chips);
  }
  if (dom.explorerHealthBadge) {
    dom.explorerHealthBadge.hidden = true;
    dom.explorerHealthBadge.textContent = "";
  }
  if (dom.explorerWarnings) {
    const warnings = Array.isArray(s.warnings) ? s.warnings : [];
    dom.explorerWarnings.hidden = !warnings.length;
    dom.explorerWarnings.replaceChildren(...warnings.map((warning) => h("div", { class: "explorerWarning" }, warning)));
  }
  renderReplicationBanner(detail);
}

// Tree hook: health dot of a replicated table (catalog "replicated" / "health").
function replicaHealthDot(table) {
  if (!table?.replicated) return null;
  const state = healthState(table);
  const dot = h("i", { class: `explorerHealthDot explorerHealthDot--${state} explorerTreeHealthDot` });
  dot.title = state === "healthy" ? "Replicated: local replica healthy" : `Replicated: ${healthLabel(table).toLowerCase()} (local replica)`;
  return dot;
}

export { renderDetailHeader, replicaHealthDot };
