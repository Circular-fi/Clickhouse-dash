// The Operations tab of the table card: replication, its queue, merges, mutations, ingestion, the distribution queue and the cluster. The
// sections and whether they have anything to show are the model's (operationSectionList); this module draws them.

import { h } from "./app_dom.js";
import { exprEl, gaugeCell, numericCell, renderSections, staticTable, timeCell } from "./app_explorer_detail_cells.js";
import { DASH, operationSectionList, optionalNumber } from "./app_explorer_detail_model.js";
import { format } from "./app_format.js";
import { header } from "./app_header.js";
import { badge as badgeMod } from "./app_ui_badge.js";

function renderIngestion(body, detail) {
  const s = detail.summary || {};
  const windows = [["1 min", "1m"], ["5 min", "5m"], ["1 h", "1h"]];
  const sources = [
    ["Client", s.client_ingress || {}, "Finished INSERT queries (system.query_log)"],
    ["Persisted", s.physical_ingress || {}, "New parts written (system.part_log); Buffer forwarding and MV output are not folded in"],
  ];
  const table = h("table", { class: "explorerIngestionTable dataTable dataTable--compact" });
  const head = h("tr");
  head.appendChild(h("th", null, ""));
  for (const [label] of windows) head.appendChild(h("th", { class: "num" }, label));
  const thead = h("thead");
  thead.appendChild(head);
  const tbody = h("tbody");
  for (const [label, rate, title] of sources) {
    const tr = h("tr");
    const th = h("th", null, label);
    th.scope = "row";
    th.title = title;
    tr.appendChild(th);
    for (const [, suffix] of windows) {
      const td = h("td", { class: "num" });
      td.append(
        h("div", { class: "explorerIngestionTable__rows" }, format.rate(rate[`rows_per_second_${suffix}`], "rows")),
        h("div", { class: "explorerIngestionTable__bytes" }, format.bytesRate(rate[`bytes_per_second_${suffix}`])),
      );
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.append(thead, tbody);
  body.appendChild(table);
  const client = s.client_ingress || {};
  const physical = s.physical_ingress || {};
  const facts = [
    client.rows_total_1h != null ? `1 h client total ${format.count(client.rows_total_1h)} rows \u00b7 ${format.bytes(client.bytes_total_1h)}` : "",
    physical.rows_total_1h != null ? `1 h persisted total ${format.count(physical.rows_total_1h)} rows \u00b7 ${format.bytes(physical.bytes_total_1h)}` : "",
    physical.new_parts_per_minute != null ? `${format.count(physical.new_parts_per_minute)} new parts in the last minute` : "",
    client.last_event_time ? `last client write ${header.serverTime(client.last_event_time).text}` : "",
    physical.last_event_time ? `last persisted write ${header.serverTime(physical.last_event_time).text}` : "",
  ].filter(Boolean);
  if (facts.length) body.appendChild(h("div", { class: "explorerSection__facts" }, facts.join(" \u00b7 ")));
}

function keyValueGrid(items) {
  const grid = h("dl", { class: "explorerKeyValues" });
  for (const [label, value, { code = false, title = "" } = {}] of items) {
    if (value == null || value === "") continue;
    const dt = h("dt", null, label);
    const dd = h("dd", { class: code ? "is-code" : "" }, value);
    if (title || String(value).length > 32) dd.title = title || String(value);
    grid.append(dt, dd);
  }
  return grid;
}

function renderReplication(body, detail) {
  const r = detail.summary?.replication || {};
  body.appendChild(keyValueGrid([
    ["This replica", r.replica_name || DASH, { code: true }],
    ["Active replicas", `${format.count(r.active_replicas)}/${format.count(r.total_replicas)}`],
    ["Queue", `${format.count(r.queue_size)} (${format.count(r.inserts_in_queue)} inserts \u00b7 ${format.count(r.merges_in_queue)} merges)`],
    ["Absolute delay", `${format.count(r.absolute_delay_seconds)} s`],
    ["Log entries to fetch", r.log_lag == null ? null : format.count(r.log_lag)],
    ["Leader", r.is_leader == null ? null : (r.is_leader ? "yes" : "no")],
    ["Read-only", r.readonly ? "yes" : "no"],
    ["Keeper session", r.session_expired ? "expired" : "ok"],
    ["Last queue update", r.last_queue_update || null],
    ["Keeper path", r.zookeeper_path || DASH, { code: true }],
  ]));
  if ((r.replicas || []).length) {
    const list = h("div", { class: "explorerAboutTile__replicas explorerReplicaList" });
    for (const replica of r.replicas) {
      const chip = h("span", { class: "explorerReplicaChip" });
      const dot = h("i", { class: `explorerHealthDot explorerHealthDot--${replica.active ? "healthy" : "error"}` });
      dot.setAttribute("aria-hidden", "true");
      chip.append(dot, h("span", null, `${replica.name}${replica.name === r.replica_name ? " (this)" : ""} \u00b7 ${replica.active ? "active" : "inactive"}`));
      list.appendChild(chip);
    }
    body.appendChild(list);
  }
}

function renderReplicationQueue(body, detail) {
  body.appendChild(staticTable({
    className: "explorerTable--replicationQueue",
    items: detail.replication_queue || [],
    specs: [
      { label: "Type", value: (q) => q.type },
      { label: "Created", value: (q) => q.create_time, render: (td, q) => timeCell(td, q.create_time) },
      { label: "Source replica", value: (q) => q.source_replica || "", cellClass: "explorerCell--code" },
      { label: "Part", value: (q) => q.new_part_name || "", cellClass: "explorerCell--code" },
      { label: "Tries", type: "UInt64", numeric: true, value: (q) => optionalNumber(q.num_tries) },
      { label: "Last attempt", value: (q) => q.last_attempt_time || "", render: (td, q) => timeCell(td, q.last_attempt_time) },
      { label: "Last exception", value: (q) => q.last_exception || "", cellClass: "explorerCell--message" },
    ],
  }));
}

function renderMerges(body, detail) {
  body.appendChild(staticTable({
    className: "explorerStorageResultTable--merges",
    items: detail.merges || [],
    specs: [
      { label: "Result part", value: (m) => m.result_part_name || m.partition || "merge", cellClass: "explorerCell--code" },
      { label: "Partition", value: (m) => m.partition || "", cellClass: "explorerCell--code" },
      {
        label: "Elapsed", type: "Float64", numeric: true, value: (m) => Number(m.elapsed_seconds || 0),
        render: (td, m) => numericCell(td, format.duration.fromSeconds(Number(m.elapsed_seconds || 0))),
      },
      {
        label: "Progress", type: "Float64", numeric: true, value: (m) => Math.max(0, Math.min(100, Number(m.progress || 0) * 100)),
        render: (td, m, value) => gaugeCell(td, value, 100, format.percent(Number(value || 0) / 100)),
      },
      { label: "Parts", type: "UInt64", numeric: true, value: (m) => optionalNumber(m.num_parts) },
      { label: "Rows read", type: "UInt64", numeric: true, value: (m) => optionalNumber(m.rows_read) },
      { label: "Bytes read", type: "UInt64", numeric: true, value: (m) => optionalNumber(m.bytes_read), render: (td, m) => numericCell(td, format.bytes(m.bytes_read)) },
      { label: "Memory", type: "UInt64", numeric: true, value: (m) => optionalNumber(m.memory_usage), render: (td, m) => numericCell(td, format.bytes(m.memory_usage)) },
    ],
  }));
}

function renderMutations(body, detail) {
  const mutations = (detail.mutations || []).slice().sort((a, b) => Number(!!a.done) - Number(!!b.done));
  body.appendChild(staticTable({
    className: "explorerTable--mutations",
    items: mutations,
    specs: [
      { label: "Mutation", value: (m) => m.mutation_id, cellClass: "explorerCell--code" },
      { label: "Created", value: (m) => m.create_time, render: (td, m) => timeCell(td, m.create_time) },
      {
        label: "State", value: (m) => (m.done ? "done" : "pending"),
        render: (td, m) => td.appendChild(badgeMod.el(m.done ? "done" : "pending", { tone: m.done ? "neutral" : "warn", className: `explorerBadge explorerBadge--${m.done ? "inactive" : "pending"}` })),
      },
      { label: "Parts to do", type: "UInt64", numeric: true, value: (m) => optionalNumber(m.parts_to_do) },
      {
        label: "Command", value: (m) => m.command,
        render: (td, m) => {
          td.classList.add("explorerCell--code", "explorerCell--expr");
          td.appendChild(exprEl(m.command || ""));
          td.title = String(m.command || "");
        },
      },
      { label: "Last failure", value: (m) => m.latest_fail_reason || "", cellClass: "explorerCell--message" },
    ],
  }));
}

function renderDistributionQueue(body, detail) {
  body.appendChild(staticTable({
    className: "explorerTable--distributionQueue",
    items: detail.distribution_queue || [],
    specs: [
      { label: "Data path", value: (q) => q.data_path || "", cellClass: "explorerCell--code explorerCell--path" },
      { label: "Blocked", value: (q) => (q.blocked ? "yes" : "no") },
      { label: "Errors", type: "UInt64", numeric: true, value: (q) => optionalNumber(q.error_count) },
      { label: "Files", type: "UInt64", numeric: true, value: (q) => optionalNumber(q.data_files) },
      { label: "Compressed", type: "UInt64", numeric: true, value: (q) => optionalNumber(q.data_compressed_bytes), render: (td, q) => numericCell(td, format.bytes(q.data_compressed_bytes)) },
      { label: "Broken files", type: "UInt64", numeric: true, value: (q) => optionalNumber(q.broken_data_files) },
      { label: "Last error", value: (q) => q.last_exception || "", cellClass: "explorerCell--message" },
    ],
  }));
}

function renderCluster(body, detail) {
  body.appendChild(staticTable({
    className: "explorerTable--cluster",
    items: detail.topology || [],
    specs: [
      { label: "Shard", type: "UInt64", numeric: true, value: (n) => optionalNumber(n.shard_num) },
      { label: "Replica", type: "UInt64", numeric: true, value: (n) => optionalNumber(n.replica_num) },
      { label: "Host", value: (n) => n.host_name || "", cellClass: "explorerCell--code" },
      { label: "Address", value: (n) => n.host_address ? `${n.host_address}:${n.port}` : "", cellClass: "explorerCell--code" },
      { label: "Local", value: (n) => (n.is_local ? "yes" : "no") },
      { label: "Errors", type: "UInt64", numeric: true, value: (n) => optionalNumber(n.errors_count) },
      { label: "Slowdowns", type: "UInt64", numeric: true, value: (n) => optionalNumber(n.slowdowns_count) },
    ],
  }));
}

const RENDERERS = {
  replication: renderReplication,
  replication_queue: renderReplicationQueue,
  merges: renderMerges,
  mutations: renderMutations,
  ingestion: renderIngestion,
  distribution_queue: renderDistributionQueue,
  cluster: renderCluster,
};

function operationSections(detail) {
  return operationSectionList(detail).map((item) => ({ ...item, render: (body) => RENDERERS[item.id](body, detail) }));
}

function renderOperationsTab(container, detail) {
  renderSections(container, operationSections(detail));
}

export { renderOperationsTab };
