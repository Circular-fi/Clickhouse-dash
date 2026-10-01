(() => {
  "use strict";

  // Explorer Server operations view: what the selected server is doing in the
  // background. Merges, pending mutations (with their failure reason),
  // replication queues (one row per table), replica health, Distributed send
  // queues and the Keeper/ZooKeeper session. Data comes from
  // /api/explorer/ops/activity and /api/explorer/ops/keeper: fixed, bounded,
  // read-only system-table reads restricted to objects the runner can see.
  //
  // ns.explorerOps.show(container, { onOpenTable }) mounts the view;
  // hide() stops the auto-refresh timer (it also pauses by itself while the
  // container or the tab is hidden).

  const ns = window.ChDash;
  if (!ns) return;

  const AUTO_REFRESH_MS = 5000;
  const AUTO_REFRESH_KEY = "chdash.explorer.opsAutoRefresh";
  const DASH = "\u2014";

  let view = null;

  function node(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = String(text);
    return el;
  }

  function hostId() {
    return String(ns.state?.selectedHostId || "");
  }

  function keeperEnabled() {
    const operations = ns.state?.features?.explorer?.operations;
    return !operations || (operations.enabled !== false && operations.keeper !== false);
  }

  function fmtInt(value) {
    const n = Number(value);
    return value == null || !Number.isFinite(n) ? DASH : ns.util.formatInt(n);
  }

  function fmtBytes(value) {
    const n = Number(value);
    return value == null || !Number.isFinite(n) ? DASH : ns.util.formatBytes(n);
  }

  function fmtDuration(seconds) {
    const n = Number(seconds);
    if (!Number.isFinite(n)) return DASH;
    if (n < 1) return `${Math.round(n * 1000)} ms`;
    if (n < 60) return `${n.toFixed(n < 10 ? 1 : 0)} s`;
    const minutes = Math.floor(n / 60);
    if (minutes < 60) return `${minutes} min ${Math.round(n % 60)} s`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours} h ${minutes % 60} min`;
    return `${Math.floor(hours / 24)} d ${hours % 24} h`;
  }

  function fmtMs(value) {
    const n = Number(value);
    if (value == null || !Number.isFinite(n)) return DASH;
    return n < 10 ? `${n.toFixed(2)} ms` : `${n.toFixed(n < 100 ? 1 : 0)} ms`;
  }

  // ClickHouse reports "1970-01-01 00:00:00" for unset times.
  function validTime(value) {
    const text = String(value || "").trim();
    return text && !text.startsWith("1970-01-01") ? text : "";
  }

  function readAutoRefresh() {
    try { return localStorage.getItem(AUTO_REFRESH_KEY) === "1"; } catch { return false; }
  }

  function writeAutoRefresh(value) {
    try { localStorage.setItem(AUTO_REFRESH_KEY, value ? "1" : "0"); } catch {}
  }

  // ---------------------------------------------------------------------------
  // Data

  async function load(force = false) {
    if (!view) return;
    const host = hostId();
    if (!host) return;
    if (view.loading) return;
    view.loading = true;
    renderStatus();
    const keeper = keeperEnabled();
    const [activity, keeperStatus] = await Promise.allSettled([
      ns.api.getExplorerOpsActivity(host, force),
      keeper ? ns.api.getExplorerOpsKeeper(host, force) : Promise.resolve(null),
    ]);
    if (!view) return;
    view.loading = false;
    if (hostId() !== host) { renderStatus(); return; }
    view.host = host;
    if (activity.status === "fulfilled") {
      view.activity = activity.value;
      view.activityError = null;
    } else {
      view.activityError = activity.reason;
    }
    if (keeperStatus.status === "fulfilled") {
      const next = keeperStatus.value;
      if (next && view.keeper && Number(next.generated_at_ms) > Number(view.keeper.generated_at_ms)) {
        const tx = Number(next.events?.ZooKeeperTransactions || 0) - Number(view.keeper.events?.ZooKeeperTransactions || 0);
        const wait = Number(next.events?.ZooKeeperWaitMicroseconds || 0) - Number(view.keeper.events?.ZooKeeperWaitMicroseconds || 0);
        const seconds = (Number(next.generated_at_ms) - Number(view.keeper.generated_at_ms)) / 1000;
        view.keeperRecent = tx > 0 && seconds > 0 ? { latencyMs: wait / 1000 / tx, rate: tx / seconds, seconds } : (seconds > 0 ? { latencyMs: null, rate: 0, seconds } : view.keeperRecent);
      }
      view.keeper = next;
      view.keeperError = null;
    } else {
      view.keeperError = keeperStatus.reason;
    }
    render();
  }

  function visible() {
    return !!view && view.root.isConnected && !view.container.hidden && view.container.offsetParent !== null && !document.hidden;
  }

  function schedule() {
    clearTimeout(view?.timer);
    if (!view || !view.autoRefresh || !view.active) return;
    view.timer = setTimeout(async () => {
      if (!view) return;
      if (visible()) await load(false);
      schedule();
    }, AUTO_REFRESH_MS);
  }

  // ---------------------------------------------------------------------------
  // Rendering helpers

  function openTable(database, table) {
    if (typeof view?.options?.onOpenTable === "function") {
      view.options.onOpenTable(database, table);
      return;
    }
    const base = String(window.__CHDASH_BASE_PATH__ || "/").replace(/\/+$/, "");
    window.location.assign(`${base}/explorer/${encodeURIComponent(database)}/${encodeURIComponent(table)}/overview`);
  }

  function objectCell(item) {
    const td = node("td", "explorerOpsTable__object");
    const button = node("button", "explorerOpsTable__link", item.table);
    button.type = "button";
    button.title = `Open ${item.database}.${item.table}`;
    button.addEventListener("click", () => openTable(item.database, item.table));
    td.append(button, node("span", "explorerOpsTable__database", item.database));
    return td;
  }

  function textCell(text, className = "", title = "") {
    const td = node("td", className, text == null || text === "" ? DASH : text);
    if (title) td.title = title;
    return td;
  }

  function numCell(text, title = "") {
    return textCell(text, "explorerOpsTable__num", title);
  }

  function statusCell(level, text, title = "") {
    const td = node("td", "explorerOpsTable__status");
    const badge = node("span", `explorerOpsStatus is-${level}`);
    badge.appendChild(node("span", "explorerOpsStatus__dot"));
    badge.appendChild(node("span", "", text));
    if (title) badge.title = title;
    td.appendChild(badge);
    return td;
  }

  function messageCell(text) {
    const value = String(text || "").trim();
    const td = node("td", "explorerOpsTable__message");
    if (!value) { td.textContent = DASH; return td; }
    const first = value.split("\n")[0];
    td.appendChild(node("span", "explorerOpsTable__messageText", first.length > 220 ? `${first.slice(0, 220)}\u2026` : first));
    td.title = value.length > 2000 ? `${value.slice(0, 2000)}\u2026` : value;
    return td;
  }

  function progressCell(progress) {
    const td = node("td", "explorerOpsTable__progress");
    const pct = Math.max(0, Math.min(100, Number(progress || 0) * 100));
    const bar = node("span", "explorerOpsProgress");
    const fill = node("span", "explorerOpsProgress__fill");
    fill.style.width = `${pct.toFixed(1)}%`;
    bar.appendChild(fill);
    td.append(bar, node("span", "explorerOpsProgress__text", `${pct.toFixed(pct < 10 ? 1 : 0)}%`));
    return td;
  }

  function opsTable(id, headers, rows) {
    const table = node("table", "explorerOpsTable");
    table.id = id;
    const thead = node("thead");
    const tr = node("tr");
    for (const header of headers) {
      const th = node("th", header.num ? "explorerOpsTable__num" : "", header.label);
      th.scope = "col";
      if (header.title) th.title = header.title;
      tr.appendChild(th);
    }
    thead.appendChild(tr);
    const tbody = node("tbody");
    rows.forEach((row) => tbody.appendChild(row));
    table.append(thead, tbody);
    const wrap = node("div", "explorerOpsTableWrap");
    wrap.appendChild(table);
    return wrap;
  }

  function section(key, title, count, { warn = 0, note = "" } = {}) {
    const el = node("section", "explorerOpsSection");
    el.dataset.section = key;
    const head = node("div", "explorerOpsSection__head");
    head.appendChild(node("h3", "explorerOpsSection__title", title));
    head.appendChild(node("span", `explorerOpsSection__count${warn > 0 ? " is-warning" : ""}`, count));
    if (note) head.appendChild(node("span", "explorerOpsSection__note", note));
    el.appendChild(head);
    return el;
  }

  function truncatedNote(name) {
    const activity = view.activity || {};
    return (activity.truncated_sections || []).includes(name) ? `first ${fmtInt(activity.row_limit)} shown` : "";
  }

  // ---------------------------------------------------------------------------
  // Sections

  function replicaLevel(item) {
    if (item.is_readonly || item.is_session_expired) return "error";
    const inactive = item.total_replicas != null && item.active_replicas != null && Number(item.active_replicas) < Number(item.total_replicas);
    if (Number(item.absolute_delay_seconds) > 60 || Number(item.queue_size) > 1000 || inactive) return "warning";
    return "ok";
  }

  function renderKeeper() {
    if (!keeperEnabled()) return null;
    const keeper = view.keeper;
    if (!keeper) {
      if (!view.keeperError) return null;
      const el = section("keeper", "Keeper", "unavailable", { warn: 1 });
      el.appendChild(node("div", "explorerOpsSection__empty", String(view.keeperError.message || "Keeper status is unavailable.")));
      return el;
    }
    if (!keeper.configured) {
      const el = section("keeper", "Keeper", "not configured");
      el.appendChild(node("div", "explorerOpsSection__empty", "This server has no Keeper / ZooKeeper connection (no replicated tables or distributed DDL)."));
      return el;
    }
    const connections = keeper.connections || [];
    const expired = connections.some((item) => item.is_expired) || Number(keeper.metrics?.ZooKeeperSessionExpired || 0) > 0;
    const el = section("keeper", "Keeper", expired ? "session expired" : `${connections.length || Number(keeper.metrics?.ZooKeeperSession || 0)} connected`, { warn: expired ? 1 : 0 });
    const tiles = node("div", "explorerOpsTiles");
    const tile = (label, value, sub = "", level = "") => {
      const item = node("div", `explorerOpsTile${level ? ` is-${level}` : ""}`);
      item.append(node("span", "explorerOpsTile__label", label), node("span", "explorerOpsTile__value", value));
      if (sub) item.appendChild(node("span", "explorerOpsTile__sub", sub));
      tiles.appendChild(item);
    };
    const recent = view.keeperRecent;
    tile("Latency", recent?.latencyMs != null ? fmtMs(recent.latencyMs) : fmtMs(keeper.average_wait_ms),
      recent?.latencyMs != null ? `average over the last ${Math.round(recent.seconds)} s` : "average since server start");
    tile("Requests in flight", fmtInt(keeper.metrics?.ZooKeeperRequest ?? null),
      recent ? `${recent.rate.toFixed(recent.rate < 10 ? 1 : 0)} transactions/s` : `${fmtInt(keeper.events?.ZooKeeperTransactions ?? null)} transactions since start`);
    tile("Watches", fmtInt(keeper.metrics?.ZooKeeperWatch ?? null));
    const exceptions = ["ZooKeeperHardwareExceptions", "ZooKeeperUserExceptions", "ZooKeeperOtherExceptions"]
      .reduce((sum, name) => sum + Number(keeper.events?.[name] || 0), 0);
    tile("Exceptions", fmtInt(exceptions), "since server start");
    el.appendChild(tiles);
    if (connections.length) {
      const rows = connections.map((item) => {
        const tr = node("tr");
        tr.append(
          textCell(item.name || "default"),
          textCell(`${item.host}:${item.port}`, "explorerOpsTable__mono"),
          statusCell(item.is_expired ? "error" : "ok", item.is_expired ? "Expired" : "Connected"),
          numCell(fmtDuration(item.session_uptime_seconds)),
          numCell(item.session_timeout_ms == null ? DASH : fmtDuration(Number(item.session_timeout_ms) / 1000)),
          numCell(fmtInt(item.keeper_api_version)),
          textCell(validTime(item.connected_time)),
        );
        return tr;
      });
      el.appendChild(opsTable("explorerOpsKeeper", [
        { label: "Name" }, { label: "Host" }, { label: "Session" }, { label: "Uptime", num: true },
        { label: "Timeout", num: true }, { label: "API", num: true, title: "Keeper API version" }, { label: "Connected since" },
      ], rows));
    }
    return el;
  }

  function renderMerges(items) {
    const el = section("merges", "Merges", `${fmtInt(items.length)} running`, { note: truncatedNote("merges") });
    const rows = items.map((item) => {
      const tr = node("tr");
      tr.append(
        objectCell(item),
        textCell(item.is_mutation ? "Mutation" : (item.merge_type || "Merge")),
        textCell(item.partition_id || DASH, "explorerOpsTable__mono", item.result_part_name ? `Result part ${item.result_part_name}` : ""),
        progressCell(item.progress),
        numCell(fmtDuration(item.elapsed_seconds)),
        numCell(fmtBytes(item.total_bytes_compressed)),
        numCell(fmtInt(item.num_parts)),
        numCell(fmtBytes(item.memory_usage)),
      );
      return tr;
    });
    el.appendChild(opsTable("explorerOpsMerges", [
      { label: "Table" }, { label: "Type" }, { label: "Partition" }, { label: "Progress" },
      { label: "Elapsed", num: true }, { label: "Size", num: true, title: "Compressed size of the source parts" },
      { label: "Parts", num: true }, { label: "Memory", num: true },
    ], rows));
    return el;
  }

  function renderMutations(items) {
    const failing = items.filter((item) => String(item.latest_fail_reason || "").trim()).length;
    const el = section("mutations", "Mutations", failing ? `${fmtInt(items.length)} pending · ${fmtInt(failing)} failing` : `${fmtInt(items.length)} pending`, { warn: failing, note: truncatedNote("mutations") });
    const rows = items.map((item) => {
      const tr = node("tr");
      const failed = String(item.latest_fail_reason || "").trim();
      const command = node("td", "explorerOpsTable__command");
      command.appendChild(node("code", "", item.command));
      command.title = item.command;
      tr.append(
        objectCell(item),
        textCell(item.mutation_id, "explorerOpsTable__mono"),
        command,
        statusCell(failed ? "error" : (item.is_killed ? "warning" : "pending"), failed ? (item.latest_fail_error_code_name || "Failing") : (item.is_killed ? "Killed" : "Pending")),
        numCell(fmtInt(item.parts_to_do)),
        textCell(validTime(item.create_time)),
        messageCell(failed ? `${item.latest_failed_part ? `Part ${item.latest_failed_part}: ` : ""}${failed}` : ""),
      );
      return tr;
    });
    el.appendChild(opsTable("explorerOpsMutations", [
      { label: "Table" }, { label: "Mutation" }, { label: "Command" }, { label: "Status" },
      { label: "Parts to do", num: true }, { label: "Created" }, { label: "Latest failure" },
    ], rows));
    return el;
  }

  function renderQueue(items) {
    const entries = items.reduce((sum, item) => sum + Number(item.entries || 0), 0);
    const postponed = items.reduce((sum, item) => sum + Number(item.postponed || 0), 0);
    const el = section("replication_queue", "Replication queue", `${fmtInt(entries)} entries in ${fmtInt(items.length)} tables`, { warn: postponed, note: truncatedNote("replication_queue") });
    const rows = items.map((item) => {
      const tr = node("tr");
      tr.append(
        objectCell(item),
        numCell(fmtInt(item.entries)),
        numCell(fmtInt(item.executing)),
        numCell(fmtInt(item.postponed)),
        numCell(fmtInt(item.max_tries)),
        textCell(validTime(item.oldest_create_time)),
        textCell((item.types || []).join(", ")),
        messageCell(item.last_exception || item.postpone_reason),
      );
      return tr;
    });
    el.appendChild(opsTable("explorerOpsReplicationQueue", [
      { label: "Table" }, { label: "Entries", num: true }, { label: "Executing", num: true },
      { label: "Postponed", num: true }, { label: "Max tries", num: true }, { label: "Oldest entry" },
      { label: "Types" }, { label: "Last exception / postpone reason" },
    ], rows));
    return el;
  }

  function renderReplicas(items) {
    const problems = items.filter((item) => replicaLevel(item) !== "ok").length;
    const el = section("replicas", "Replicas", problems ? `${fmtInt(items.length)} tables · ${fmtInt(problems)} need attention` : `${fmtInt(items.length)} tables healthy`, { warn: problems, note: truncatedNote("replicas") });
    const rows = items.map((item) => {
      const level = replicaLevel(item);
      const status = item.is_session_expired ? "Session expired" : item.is_readonly ? "Read-only" : level === "warning" ? "Lagging" : "Healthy";
      const tr = node("tr");
      tr.append(
        objectCell(item),
        textCell(item.replica_name, "explorerOpsTable__mono", item.is_leader ? "Leader" : ""),
        statusCell(level, status),
        numCell(item.total_replicas == null ? DASH : `${fmtInt(item.active_replicas)} / ${fmtInt(item.total_replicas)}`, "Active / total replicas (refreshed at most every 60 s)"),
        numCell(Number(item.absolute_delay_seconds) < 60 ? `${fmtInt(item.absolute_delay_seconds)} s` : fmtDuration(item.absolute_delay_seconds)),
        numCell(fmtInt(item.queue_size), `${fmtInt(item.inserts_in_queue)} inserts · ${fmtInt(item.merges_in_queue)} merges`),
        textCell(validTime(item.last_queue_update)),
        messageCell(item.last_queue_update_exception),
      );
      return tr;
    });
    el.appendChild(opsTable("explorerOpsReplicas", [
      { label: "Table" }, { label: "Replica" }, { label: "Health" }, { label: "Active", num: true },
      { label: "Delay", num: true }, { label: "Queue", num: true }, { label: "Last queue update" }, { label: "Last exception" },
    ], rows));
    return el;
  }

  function renderDistribution(items) {
    const files = items.reduce((sum, item) => sum + Number(item.data_files || 0), 0);
    const errors = items.filter((item) => Number(item.error_count || 0) > 0 || item.is_blocked || Number(item.broken_data_files || 0) > 0).length;
    const el = section("distribution_queue", "Distributed send queues", `${fmtInt(files)} files pending`, { warn: errors, note: truncatedNote("distribution_queue") });
    const rows = items.map((item) => {
      const tr = node("tr");
      const level = item.is_blocked || Number(item.broken_data_files || 0) > 0 ? "error" : Number(item.error_count || 0) > 0 ? "warning" : "ok";
      tr.append(
        objectCell(item),
        textCell(item.data_path, "explorerOpsTable__mono"),
        statusCell(level, item.is_blocked ? "Blocked" : level === "error" ? "Broken files" : level === "warning" ? "Retrying" : "Sending"),
        numCell(fmtInt(item.data_files)),
        numCell(fmtBytes(item.data_compressed_bytes)),
        numCell(fmtInt(item.error_count)),
        numCell(Number(item.broken_data_files || 0) > 0 ? `${fmtInt(item.broken_data_files)} (${fmtBytes(item.broken_data_compressed_bytes)})` : "0"),
        messageCell(item.last_exception),
      );
      return tr;
    });
    el.appendChild(opsTable("explorerOpsDistribution", [
      { label: "Table" }, { label: "Path" }, { label: "State" }, { label: "Files", num: true },
      { label: "Bytes", num: true }, { label: "Errors", num: true }, { label: "Broken", num: true }, { label: "Last exception" },
    ], rows));
    return el;
  }

  // ---------------------------------------------------------------------------
  // View

  function renderStatus() {
    if (!view) return;
    view.refresh.disabled = !!view.loading;
    const bits = [];
    if (view.loading && !view.activity) bits.push("Loading\u2026");
    else if (view.activity?.generated_at_ms) {
      bits.push(`Updated ${new Date(Number(view.activity.generated_at_ms)).toLocaleTimeString("en-GB")}`);
      if (view.activity.stale) bits.push("stale");
    }
    view.meta.textContent = bits.join(" · ");
  }

  function render() {
    if (!view) return;
    renderStatus();
    view.autoRefreshInput.checked = view.autoRefresh;
    const body = view.body;
    body.replaceChildren();
    if (view.activityError) {
      body.appendChild(node("div", "explorerOpsView__error", String(view.activityError.message || "Server operations are unavailable.")));
    }
    const activity = view.activity;
    if (!activity) {
      const keeper = renderKeeper();
      if (keeper) body.appendChild(keeper);
      if (!view.activityError) body.appendChild(node("div", "explorerOpsSection__empty", view.loading ? "Loading server operations\u2026" : ""));
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
    const keeper = renderKeeper();
    const keeperProblem = keeper && keeper.querySelector(".explorerOpsSection__count.is-warning");
    if (keeper && keeperProblem) body.appendChild(keeper);
    for (const item of withData) body.appendChild(item.render(item.items));
    if (keeper && !keeperProblem) body.appendChild(keeper);
    const empty = sections.filter((item) => !item.items.length && !unavailable.has(item.key)).map((item) => `No ${item.label}`);
    const missing = sections.filter((item) => unavailable.has(item.key)).map((item) => item.key.replace(/_/g, " "));
    if (empty.length || missing.length) {
      const line = node("div", "explorerOpsView__quiet");
      line.id = "explorerOpsQuiet";
      if (empty.length) line.appendChild(node("span", "", `${empty.join(" · ")}.`));
      if (missing.length) line.appendChild(node("span", "explorerOpsView__missing", `Not readable on this server: ${missing.join(", ")}.`));
      body.appendChild(line);
    }
  }

  function mount(container) {
    clearTimeout(view?.timer);
    const root = node("section", "explorerOpsView");
    const header = node("header", "explorerOpsView__header");
    const heading = node("div", "explorerOpsView__heading");
    heading.append(node("h2", "explorerOpsView__title", "Server operations"), node("div", "explorerOpsView__meta"));
    const actions = node("div", "explorerOpsView__actions");
    const option = node("label", "explorerOpsView__option");
    const autoRefreshInput = node("input");
    autoRefreshInput.type = "checkbox";
    autoRefreshInput.id = "explorerOpsAutoRefresh";
    option.append(autoRefreshInput, node("span", "", `Auto-refresh (${AUTO_REFRESH_MS / 1000} s)`));
    const refresh = node("button", "button button--small explorerRefreshButton");
    refresh.type = "button";
    refresh.id = "explorerOpsRefreshButton";
    refresh.title = "Refresh server operations";
    refresh.setAttribute("aria-label", "Refresh server operations");
    refresh.innerHTML = '<svg class="refreshGlyph" viewBox="0 0 16 16" aria-hidden="true"><path d="M13 5.25A5.25 5.25 0 1 0 13.1 10.5"/><path d="M13 2.75v3.1h-3.1"/></svg>';
    actions.append(option, refresh);
    header.append(heading, actions);
    const body = node("div", "explorerOpsView__body");
    body.setAttribute("aria-live", "polite");
    root.append(header, body);
    container.replaceChildren(root);
    view = {
      container,
      root,
      meta: heading.querySelector(".explorerOpsView__meta"),
      body,
      refresh,
      autoRefreshInput,
      autoRefresh: readAutoRefresh(),
      options: {},
      activity: null,
      keeper: null,
      keeperRecent: null,
      activityError: null,
      keeperError: null,
      loading: false,
      timer: 0,
      active: false,
      host: "",
    };
    autoRefreshInput.addEventListener("change", () => {
      view.autoRefresh = !!autoRefreshInput.checked;
      writeAutoRefresh(view.autoRefresh);
      schedule();
      if (view.autoRefresh) void load(false);
    });
    refresh.addEventListener("click", () => void load(true));
  }

  function show(container, options = {}) {
    if (!container) return;
    if (!view || view.container !== container || !view.root.isConnected) mount(container);
    view.options = { ...options };
    view.active = true;
    if (view.host && view.host !== hostId()) {
      view.activity = null;
      view.keeper = null;
      view.keeperRecent = null;
    }
    render();
    void load(false);
    schedule();
  }

  function hide() {
    if (!view) return;
    view.active = false;
    clearTimeout(view.timer);
  }

  window.addEventListener("chdash:host-changed", () => {
    if (!view) return;
    view.activity = null;
    view.keeper = null;
    view.keeperRecent = null;
    view.activityError = null;
    view.keeperError = null;
    if (visible()) { render(); void load(false); }
  });
  document.addEventListener("visibilitychange", () => {
    if (view?.autoRefresh && visible()) void load(false);
  });

  ns.explorerOps = { show, hide, refresh: (force = true) => load(force) };
})();
