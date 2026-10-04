(() => {
  "use strict";

  // The Activity part of the System Overview (docs/system.md "Activity"):
  // what the selected server is doing in the background. Replicas, pending
  // mutations (with their failure reason), replication queues (one row per
  // table), merges and Distributed send queues, from /api/system/activity:
  // fixed, bounded, read-only system-table reads restricted to the objects
  // the runner can see. The Keeper session is the Overview's Keeper card.
  //
  // ns.systemActivity.create({ openTable }) -> { el, load(force), reset(),
  //   loading() }: the Overview mounts el, loads it with its tiles (on show and
  // with the refresh button, never on a timer) and resets it on a host change.

  const ns = window.ChDash;
  if (!ns || !ns.systemView) return;
  const { h } = ns;
  const format = ns.format;
  const kit = ns.systemView.kit;
  const SEP = kit.SEP;
  const DASH = format.EMPTY;

  // A DateTime text of the server's system tables: browser-local text, the
  // server value (and ISO) in the tooltip; an unset (epoch 0) time is EMPTY.
  function timeCell(value) {
    const time = ns.ui.serverTime(value);
    return textCell(time.text, "", time.title);
  }

  function textCell(text, className = "", title = "") {
    const td = h("td", { class: className }, text == null || text === "" ? DASH : text);
    if (title) td.title = title;
    return td;
  }

  function numCell(text, title = "") {
    return textCell(text, "num", title);
  }

  const STATUS_TONES = { ok: "ok", warning: "warn", pending: "neutral", error: "error" };

  function statusCell(level, text, title = "") {
    return h("td", { class: "systemActivityTable__status" },
      ns.badge.el(text, { tone: STATUS_TONES[level] || "neutral", title, attrs: { "data-level": level } }));
  }

  function messageCell(text) {
    const value = String(text || "").trim();
    const td = h("td", { class: "systemActivityTable__message" });
    if (!value) { td.textContent = DASH; return td; }
    const first = value.split("\n")[0];
    td.appendChild(h("span", { class: "systemActivityTable__messageText" }, first.length > 220 ? `${first.slice(0, 220)}\u2026` : first));
    td.title = value.length > 2000 ? `${value.slice(0, 2000)}\u2026` : value;
    return td;
  }

  function progressCell(progress) {
    const pct = Math.max(0, Math.min(100, Number(progress || 0) * 100));
    const td = h("td", { class: "num systemActivityTable__progress" }, format.percent(pct / 100));
    ns.table.cellBar(td, pct);
    return td;
  }

  function activityTable(id, headers, rows) {
    const head = h("tr", null, headers.map((header) => h("th", { scope: "col", class: header.num ? "num" : "", title: header.title || null }, header.label)));
    return h("div", { class: "systemTableWrap" },
      h("table", { class: "systemActivityTable dataTable dataTable--compact", id }, h("thead", null, head), h("tbody", null, rows)));
  }

  function replicaLevel(item) {
    if (item.is_readonly || item.is_session_expired) return "error";
    const inactive = item.total_replicas != null && item.active_replicas != null && Number(item.active_replicas) < Number(item.total_replicas);
    if (Number(item.absolute_delay_seconds) > 60 || Number(item.queue_size) > 1000 || inactive) return "warning";
    return "ok";
  }

  function create({ openTable = null } = {}) {
    const state = { activity: null, error: null, loading: false, serial: 0 };
    // Not a live region: a refresh would read the tables out again every time.
    const body = h("div", { class: "systemActivity", id: "systemActivity" });

    function objectCell(item) {
      const button = h("button", { type: "button", class: "systemActivityTable__link", title: `Open ${item.database}.${item.table} in the Explorer` }, item.table);
      button.addEventListener("click", () => openTable?.(item.database, item.table));
      return h("td", { class: "systemActivityTable__object" }, button, h("span", { class: "systemActivityTable__database" }, item.database));
    }

    function section(key, title, count, { warn = 0, note = "" } = {}) {
      return h("section", { class: "systemActivitySection", dataset: { section: key } },
        h("div", { class: "systemActivitySection__head" },
          h("h3", { class: "systemActivitySection__title" }, title),
          h("span", { class: ["systemActivitySection__count", warn > 0 && "is-warning"] }, count),
          note ? h("span", { class: "systemActivitySection__note" }, note) : null));
    }

    function truncatedNote(name) {
      const activity = state.activity || {};
      return (activity.truncated_sections || []).includes(name) ? `first ${format.count(activity.row_limit)} shown` : "";
    }

    function renderMerges(items) {
      const el = section("merges", "Merges", `${format.count(items.length)} running`, { note: truncatedNote("merges") });
      const rows = items.map((item) => h("tr", null,
        objectCell(item),
        textCell(item.is_mutation ? "Mutation" : (item.merge_type || "Merge")),
        textCell(item.partition_id || DASH, "mono", item.result_part_name ? `Result part ${item.result_part_name}` : ""),
        progressCell(item.progress),
        numCell(format.duration.fromSeconds(item.elapsed_seconds)),
        numCell(format.bytes(item.total_bytes_compressed)),
        numCell(format.count(item.num_parts)),
        numCell(format.bytes(item.memory_usage))));
      el.appendChild(activityTable("systemActivityMerges", [
        { label: "Table" }, { label: "Type" }, { label: "Partition" }, { label: "Progress" },
        { label: "Elapsed", num: true }, { label: "Size", num: true, title: "Compressed size of the source parts" },
        { label: "Parts", num: true }, { label: "Memory", num: true },
      ], rows));
      return el;
    }

    function renderMutations(items) {
      const failing = items.filter((item) => String(item.latest_fail_reason || "").trim()).length;
      const el = section("mutations", "Mutations", failing ? `${format.count(items.length)} pending${SEP}${format.count(failing)} failing` : `${format.count(items.length)} pending`, { warn: failing, note: truncatedNote("mutations") });
      const rows = items.map((item) => {
        const failed = String(item.latest_fail_reason || "").trim();
        const command = h("td", { class: "systemActivityTable__command", title: item.command },
          ns.ui.sqlBlock({ sql: item.command, inline: true, label: "Mutation command" }));
        return h("tr", null,
          objectCell(item),
          textCell(item.mutation_id, "mono"),
          command,
          statusCell(failed ? "error" : (item.is_killed ? "warning" : "pending"), failed ? (item.latest_fail_error_code_name || "Failing") : (item.is_killed ? "Killed" : "Pending")),
          numCell(format.count(item.parts_to_do)),
          timeCell(item.create_time),
          messageCell(failed ? `${item.latest_failed_part ? `Part ${item.latest_failed_part}: ` : ""}${failed}` : ""));
      });
      el.appendChild(activityTable("systemActivityMutations", [
        { label: "Table" }, { label: "Mutation" }, { label: "Command" }, { label: "Status" },
        { label: "Parts to do", num: true }, { label: "Created" }, { label: "Latest failure" },
      ], rows));
      return el;
    }

    function renderQueue(items) {
      const entries = items.reduce((sum, item) => sum + Number(item.entries || 0), 0);
      const postponed = items.reduce((sum, item) => sum + Number(item.postponed || 0), 0);
      const el = section("replication_queue", "Replication queue", `${format.count(entries)} entries in ${format.count(items.length)} tables`, { warn: postponed, note: truncatedNote("replication_queue") });
      const rows = items.map((item) => h("tr", null,
        objectCell(item),
        numCell(format.count(item.entries)),
        numCell(format.count(item.executing)),
        numCell(format.count(item.postponed)),
        numCell(format.count(item.max_tries)),
        timeCell(item.oldest_create_time),
        textCell((item.types || []).join(", ")),
        messageCell(item.last_exception || item.postpone_reason)));
      el.appendChild(activityTable("systemActivityReplicationQueue", [
        { label: "Table" }, { label: "Entries", num: true }, { label: "Executing", num: true },
        { label: "Postponed", num: true }, { label: "Max tries", num: true }, { label: "Oldest entry" },
        { label: "Types" }, { label: "Last exception / postpone reason" },
      ], rows));
      return el;
    }

    function renderReplicas(items) {
      const problems = items.filter((item) => replicaLevel(item) !== "ok").length;
      const el = section("replicas", "Replicas", problems ? `${format.count(items.length)} tables${SEP}${format.count(problems)} need attention` : `${format.count(items.length)} tables healthy`, { warn: problems, note: truncatedNote("replicas") });
      const rows = items.map((item) => {
        const level = replicaLevel(item);
        const status = item.is_session_expired ? "Session expired" : item.is_readonly ? "Read-only" : level === "warning" ? "Lagging" : "Healthy";
        return h("tr", null,
          objectCell(item),
          textCell(item.replica_name, "mono", item.is_leader ? "Leader" : ""),
          statusCell(level, status),
          numCell(item.total_replicas == null ? DASH : `${format.count(item.active_replicas)} / ${format.count(item.total_replicas)}`, "Active / total replicas (refreshed at most every 60 s)"),
          numCell(kit.seconds(item.absolute_delay_seconds)),
          numCell(format.count(item.queue_size), `${format.count(item.inserts_in_queue)} inserts${SEP}${format.count(item.merges_in_queue)} merges`),
          timeCell(item.last_queue_update),
          messageCell(item.last_queue_update_exception));
      });
      el.appendChild(activityTable("systemActivityReplicas", [
        { label: "Table" }, { label: "Replica" }, { label: "Health" }, { label: "Active", num: true },
        { label: "Delay", num: true }, { label: "Queue", num: true }, { label: "Last queue update" }, { label: "Last exception" },
      ], rows));
      return el;
    }

    function renderDistribution(items) {
      const files = items.reduce((sum, item) => sum + Number(item.data_files || 0), 0);
      const errors = items.filter((item) => Number(item.error_count || 0) > 0 || item.is_blocked || Number(item.broken_data_files || 0) > 0).length;
      const el = section("distribution_queue", "Distributed send queues", `${format.count(files)} files pending`, { warn: errors, note: truncatedNote("distribution_queue") });
      const rows = items.map((item) => {
        const level = item.is_blocked || Number(item.broken_data_files || 0) > 0 ? "error" : Number(item.error_count || 0) > 0 ? "warning" : "ok";
        return h("tr", null,
          objectCell(item),
          textCell(item.data_path, "mono"),
          statusCell(level, item.is_blocked ? "Blocked" : level === "error" ? "Broken files" : level === "warning" ? "Retrying" : "Sending"),
          numCell(format.count(item.data_files)),
          numCell(format.bytes(item.data_compressed_bytes)),
          numCell(format.count(item.error_count)),
          numCell(Number(item.broken_data_files || 0) > 0 ? `${format.count(item.broken_data_files)} (${format.bytes(item.broken_data_compressed_bytes)})` : "0"),
          messageCell(item.last_exception));
      });
      el.appendChild(activityTable("systemActivityDistribution", [
        { label: "Table" }, { label: "Path" }, { label: "State" }, { label: "Files", num: true },
        { label: "Bytes", num: true }, { label: "Errors", num: true }, { label: "Broken", num: true }, { label: "Last exception" },
      ], rows));
      return el;
    }

    function render() {
      const children = [];
      if (state.error) {
        children.push(ns.uiState.banner(h("div"), { message: ns.util.errorText(state.error, "The server activity is unavailable."), retry: () => void load(true), inset: true }));
      }
      const activity = state.activity;
      if (!activity) {
        if (!state.error) children.push(ns.uiState.block("loading", { label: "Loading the server activity\u2026", compact: true }));
        h.replace(body, children);
        return;
      }
      const unavailable = new Set(activity.unavailable_sections || []);
      const sections = [
        { key: "replicas", label: "replicated tables", items: activity.replicas || [], render: renderReplicas, warn: (items) => items.some((item) => replicaLevel(item) !== "ok") },
        { key: "mutations", label: "pending mutations", items: activity.mutations || [], render: renderMutations, warn: (items) => items.some((item) => String(item.latest_fail_reason || "").trim()) },
        { key: "replication_queue", label: "replication queue entries", items: activity.replication_queue || [], render: renderQueue, warn: (items) => items.some((item) => Number(item.postponed || 0) > 0 || String(item.last_exception || "").trim()) },
        { key: "merges", label: "merges running", items: activity.merges || [], render: renderMerges, warn: () => false },
        { key: "distribution_queue", label: "Distributed send queue", items: activity.distribution_queue || [], render: renderDistribution, warn: (items) => items.some((item) => Number(item.error_count || 0) > 0 || item.is_blocked) },
      ];
      // Problems first, then sections with data; empty sections collapse into
      // one summary line instead of empty tables.
      const withData = sections.filter((item) => item.items.length && !unavailable.has(item.key));
      withData.sort((a, b) => Number(b.warn(b.items)) - Number(a.warn(a.items)));
      for (const item of withData) children.push(item.render(item.items));
      // One sentence ("No pending mutations, merges running or ..."): a list,
      // not a line of separators.
      const quiet = sections.filter((item) => !item.items.length && !unavailable.has(item.key)).map((item) => item.label);
      const empty = quiet.length ? [`No ${quiet.length > 1 ? `${quiet.slice(0, -1).join(", ")} or ${quiet[quiet.length - 1]}` : quiet[0]}`] : [];
      const missing = sections.filter((item) => unavailable.has(item.key)).map((item) => item.key.replace(/_/g, " "));
      if (empty.length || missing.length) {
        children.push(h("div", { class: "systemActivity__quiet", id: "systemActivityQuiet" },
          empty.length ? h("span", null, `${empty.join(SEP)}.`) : null,
          missing.length ? h("span", { class: "systemActivity__missing" }, `Not readable on this server: ${missing.join(", ")}.`) : null));
      }
      h.replace(body, children);
    }

    async function load(force = false) {
      const host = kit.hostId();
      if (!host || state.loading) return;
      state.loading = true;
      const serial = ++state.serial;
      ns.uiState.busy(body, true);
      let data = null;
      let error = null;
      try {
        data = await ns.api.getSystemActivity(host, force);
      } catch (e) {
        error = e;
      }
      state.loading = false;
      ns.uiState.busy(body, false);
      if (serial !== state.serial || kit.hostId() !== host) return;
      if (data) { state.activity = data; state.error = null; } else state.error = error;
      render();
    }

    function reset() {
      state.activity = null;
      state.error = null;
      state.loading = false;
      state.serial += 1;
      render();
    }

    render();
    return { el: body, load, reset, render, loading: () => state.loading };
  }

  ns.systemActivity = { create, replicaLevel };
})();
