(() => {
  "use strict";

  // Explorer Monitoring view (docs/explorer.md "Monitoring"): the selected
  // server, not the tree selection. Underlined section tabs (tier 2) under
  // the Explorer's view tabs:
  //   Overview  server tiles, cluster topology, Keeper and the replication
  //             summary (/api/explorer/monitor/overview, plus
  //             /api/explorer/ops/keeper for the session);
  //   Activity  the Server operations view (app_explorer_ops.js), mounted
  //             unchanged.
  // Performance, Queries and Disks register as sections of their own
  // (register() below) when their modules ship; until then their tabs do
  // not exist and their addresses fall back to Overview.
  //
  // ns.explorerMonitor.show(container, { section, onSection, onOpenTable })
  // mounts the view on `section`; onSection(section, { history }) tells the
  // Explorer which section shows (history "push" for a tab, "replace" for a
  // fallback). hide() stops the timers; refresh(force) reloads the section
  // on screen (a host change).
  //
  // Every figure is this server's own: system tables are local to each
  // node, so a replica is a host of its own in the host picker.

  const ns = window.ChDash;
  if (!ns) return;
  const { h } = ns;
  const { $ } = ns.dom;
  const format = ns.format;
  const DASH = format.EMPTY;
  const SEP = " · ";

  const AUTO_REFRESH_MS = 5000;
  // One Auto-refresh choice for every live section, Activity included.
  const autoRefreshPref = () => ns.storage.pref(ns.storage.KEYS.explorerOpsAutoRefresh, false);

  // Altinity's thresholds and ClickHouse's own defaults: parts_to_delay_insert
  // (1000) slows inserts down, 300 parts in one partition is the usual alert.
  const PARTS_WARN = 300;
  const PARTS_ERROR = 1000;

  const hostId = () => String(ns.state?.selectedHostId || "");
  const features = () => ns.features.get("explorer");
  const keeperEnabled = () => !!ns.features.get("explorer.operations.keeper");
  const number = (value) => (value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value));

  // ---------------------------------------------------------------------------
  // Sections

  const sections = [];

  // A section: { id, label, order, available(features), create(ctx) }.
  // create returns { el, show(), hide(), refresh(force) }; ctx holds
  // openSection(id) and openTable(database, table).
  function register(section) {
    if (!section?.id || sections.some((item) => item.id === section.id)) return;
    sections.push(section);
    sections.sort((a, b) => (a.order || 0) - (b.order || 0));
    if (view) renderTabs();
  }

  function availableSections() {
    const f = features();
    return sections.filter((section) => section.available(f));
  }

  let view = null;

  function renderTabs() {
    const items = availableSections().map((section) => ({
      value: section.id,
      label: section.label,
      id: `explorerMonitorTab-${section.id}`,
      controls: `explorerMonitorPanel-${section.id}`,
    }));
    ns.tabs.render(view.tabs, items, { attr: "section", tier: "content", selected: view.section });
  }

  function controllerOf(section) {
    let controller = view.controllers.get(section.id);
    if (!controller) {
      const panel = h("div", {
        class: "explorerMonitor__panel",
        id: `explorerMonitorPanel-${section.id}`,
        role: "tabpanel",
        dataset: { section: section.id },
        aria: { labelledby: `explorerMonitorTab-${section.id}` },
        hidden: true,
      });
      view.root.appendChild(panel);
      controller = section.create({
        panel,
        openSection: (id) => select(id, { history: "push" }),
        openTable: (database, table) => {
          if (typeof view?.options?.onOpenTable === "function") view.options.onOpenTable(database, table);
        },
      });
      controller.panel = panel;
      view.controllers.set(section.id, controller);
    }
    return controller;
  }

  // Shows `id` (or the first available section); history says how the
  // Explorer writes the address when the section differs from the asked one.
  function select(id, { history = "push" } = {}) {
    if (!view) return;
    const available = availableSections();
    if (!available.length) return;
    const section = available.find((item) => item.id === id) || available[0];
    const changed = section.id !== view.section;
    if (changed && view.section) view.controllers.get(view.section)?.hide();
    view.section = section.id;
    renderTabs();
    for (const [key, controller] of view.controllers) controller.panel.hidden = key !== section.id;
    const controller = controllerOf(section);
    controller.panel.hidden = false;
    controller.show();
    if (section.id !== id || (changed && history === "push")) {
      view.options.onSection?.(section.id, { history: section.id !== id && history !== "push" ? "replace" : history });
    }
  }

  function mount(container) {
    const tabs = h("div", { class: "contentTabs explorerMonitor__tabs", aria: { label: "Monitoring sections" } });
    const root = h("section", { class: "explorerMonitor" }, tabs);
    container.replaceChildren(root);
    view = { container, root, tabs, section: "", controllers: new Map(), options: {} };
    ns.tabs.bind(tabs, { attr: "section", onSelect: (id) => select(String(id || ""), { history: "push" }) });
  }

  function show(container, options = {}) {
    if (!container) return;
    if (!view || view.container !== container || !view.root.isConnected) mount(container);
    view.options = { ...options };
    view.active = true;
    select(String(options.section || ""), { history: "replace" });
  }

  function hide() {
    if (!view) return;
    view.active = false;
    view.controllers.get(view.section)?.hide();
  }

  function refresh(force = true) {
    if (!view?.active) return;
    view.controllers.get(view.section)?.refresh(force);
  }

  // ---------------------------------------------------------------------------
  // Shared pieces

  // The section bar: what the figures are (this server, when) on the left,
  // Auto-refresh and refresh on the right (the Activity header's layout).
  function sectionBar({ id, label, onRefresh, onAutoRefresh }) {
    const meta = h("div", { class: "explorerMonitorBar__meta" });
    const input = h("input", { type: "checkbox", id: `explorerMonitorAutoRefresh-${id}` });
    input.addEventListener("change", () => onAutoRefresh(!!input.checked));
    const option = h("label", { class: "explorerMonitorBar__option" }, input, h("span", null, `Auto-refresh (${AUTO_REFRESH_MS / 1000} s)`));
    const button = h("button", {
      type: "button",
      class: "button button--small explorerRefreshButton",
      id: `explorerMonitorRefresh-${id}`,
      title: `Refresh ${label}`,
      aria: { label: `Refresh ${label}` },
    }, ns.icon.el("refresh", { size: "sm", className: "refreshGlyph" }));
    button.addEventListener("click", onRefresh);
    const bar = h("header", { class: "explorerMonitorBar" }, meta, h("div", { class: "explorerMonitorBar__actions" }, option, button));
    return { bar, meta, input, button };
  }

  const REASONS = {
    disabled: "Disabled",
    not_granted: "Not granted",
    unsupported: "Not supported",
    window_too_large: "Too large",
    readonly_account: "Read-only account",
    failed: "Unavailable",
  };

  function issueText(issue) {
    const table = issue.table || "tables";
    switch (issue.reason) {
      case "disabled": return `system.${table} is disabled on this server (server configuration).`;
      case "not_granted": return `The system account cannot read system.${table}.`;
      case "unsupported": return `This ClickHouse version lacks a column of system.${table}.`;
      case "window_too_large": return "The read hit its time or row limit.";
      case "readonly_account": return "The system account's profile has readonly = 1, so the query limits cannot be set (use readonly = 2).";
      default: return ns.util.errorText(issue.message, `system.${table} could not be read.`);
    }
  }

  // A panel that could not be read: why, and the GRANT to run when a grant
  // is missing. One element per issue, in place of the panel's content.
  function issueBlock(issue) {
    const el = h("div", { class: "explorerMonitorIssue", dataset: { reason: issue.reason || "failed", panel: issue.panel || "" } },
      h("div", { class: "explorerMonitorIssue__head" },
        ns.badge.el(REASONS[issue.reason] || REASONS.failed, { tone: issue.reason === "disabled" ? "neutral" : "warn" }),
        h("span", { class: "explorerMonitorIssue__text" }, issueText(issue))));
    if (issue.hint) {
      const copy = ns.ui.copyButton(null, () => issue.hint, { label: "Copy the GRANT statement", className: "explorerMonitorIssue__copy" });
      el.appendChild(h("div", { class: "explorerMonitorIssue__hint" }, h("code", { class: "explorerMonitorIssue__code" }, issue.hint), copy));
    }
    if (issue.message && issue.reason !== "failed") el.title = issue.message;
    return el;
  }

  function sectionHead(title, count = "", extra = null) {
    return h("div", { class: "explorerSectionHead explorerMonitorCard__head" },
      h("h3", { class: "explorerSectionTitle" }, title),
      count ? h("span", { class: "explorerSectionCount" }, count) : null,
      extra);
  }

  function card(key, title, count, extra) {
    return h("section", { class: "explorerMonitorCard", dataset: { card: key } }, sectionHead(title, count, extra));
  }

  // A delay in whole seconds: "0 s" rather than "0 ns".
  const seconds = (value) => (Number(value) > 0 ? format.duration.fromSeconds(value) : "0 s");

  function dataTable(id, headers, rows) {
    const head = h("tr", null, headers.map((header) => h("th", { scope: "col", class: [header.num && "num", header.className], title: header.title || null }, header.label)));
    return h("div", { class: "explorerMonitorTableWrap" },
      h("table", { class: "dataTable dataTable--compact explorerMonitorTable", id }, h("thead", null, head), h("tbody", null, rows)));
  }

  // ---------------------------------------------------------------------------
  // Overview

  function createOverview(ctx) {
    const state = { data: null, keeper: null, error: null, keeperError: null, loading: false, timer: 0, active: false, host: "", serial: 0 };
    const controls = sectionBar({
      id: "overview",
      label: "the overview",
      onRefresh: () => void load(true),
      onAutoRefresh: (on) => {
        autoRefreshPref().set(on);
        schedule();
        if (on) void load(false);
      },
    });
    const body = h("div", { class: "explorerMonitorOverview", id: "explorerMonitorOverview" });
    ctx.panel.append(controls.bar, body);

    const autoRefresh = () => !!autoRefreshPref().get();
    const visible = () => state.active && ctx.panel.isConnected && !ctx.panel.hidden && ctx.panel.offsetParent !== null && !document.hidden;
    // Back on the browser tab: catch up at once rather than at the next tick.
    document.addEventListener("visibilitychange", () => {
      if (autoRefresh() && visible()) void load(false);
    });

    function schedule() {
      clearTimeout(state.timer);
      if (!state.active || !autoRefresh()) return;
      state.timer = setTimeout(async () => {
        if (visible()) await load(false);
        schedule();
      }, AUTO_REFRESH_MS);
    }

    async function load(force = false) {
      const host = hostId();
      if (!host || state.loading) return;
      state.loading = true;
      const serial = ++state.serial;
      renderStatus();
      const [overview, keeper] = await Promise.allSettled([
        ns.api.getExplorerMonitorOverview(host, force),
        keeperEnabled() ? ns.api.getExplorerOpsKeeper(host, force) : Promise.resolve(null),
      ]);
      state.loading = false;
      if (serial !== state.serial || hostId() !== host) { renderStatus(); return; }
      state.host = host;
      if (overview.status === "fulfilled") { state.data = overview.value; state.error = null; } else state.error = overview.reason;
      if (keeper.status === "fulfilled") { state.keeper = keeper.value; state.keeperError = null; } else state.keeperError = keeper.reason;
      render();
    }

    function renderStatus() {
      ns.uiState.busy(controls.button, state.loading);
      ns.uiState.busy(body, state.loading);
      const data = state.data;
      const parts = [];
      if (data?.server?.hostname) parts.push(`This server: ${data.server.hostname}`);
      else parts.push("This server");
      if (data?.server?.version) parts.push(`ClickHouse ${data.server.version}`);
      if (state.loading && !data) parts.push("Loading\u2026");
      else if (data?.generated_at_ms) parts.push(`Updated ${format.time(Number(data.generated_at_ms), { date: "never" })}${data.stale ? " (stale)" : ""}`);
      ns.util.setMetaLine(controls.meta, parts.join(SEP));
      controls.meta.title = "System tables are local to each node: every figure here is this server's own. Add each replica as a host to see it.";
      controls.input.checked = autoRefresh();
    }

    function issuesOf(panel) {
      return (state.data?.unavailable_panels || []).filter((issue) => issue.panel === panel);
    }

    function render() {
      renderStatus();
      const data = state.data;
      const children = [];
      if (state.error) {
        children.push(ns.uiState.banner(h("div"), { message: ns.util.errorText(state.error, "The server overview is unavailable."), retry: () => void load(true), inset: true }));
      }
      if (!data) {
        if (!state.error) children.push(ns.uiState.block("loading", { label: "Loading the server overview\u2026", compact: true }));
        h.replace(body, children);
        return;
      }
      children.push(renderTiles(data));
      const side = [renderKeeper(data), renderReplication(data)].filter(Boolean);
      children.push(h("div", { class: "explorerMonitorGrid" }, renderTopology(data), side.length ? h("div", { class: "explorerMonitorGrid__side" }, side) : null));
      h.replace(body, children);
    }

    // Server tiles: current values (system.asynchronous_metrics, refreshed
    // by the server every second, and system.metrics).
    function renderTiles(data) {
      const m = data.metrics || {};
      const value = (name) => number(m[name]);
      const tiles = [];
      const tile = (key, label, text, sub = "", tone = "", title = "") => tiles.push({ label, value: text, sub, tone, title, attrs: { "data-tile": key } });
      const uptime = number(data.server?.uptime_seconds) ?? value("Uptime");
      tile("uptime", "Uptime", uptime == null ? DASH : format.duration.fromSeconds(Math.floor(uptime)),
        uptime == null ? "" : `since ${format.time(Number(data.generated_at_ms || Date.now()) - uptime * 1000)}`);
      const user = value("OSUserTimeNormalized");
      const system = value("OSSystemTimeNormalized");
      tile("cpu", "CPU", user == null && system == null ? DASH : format.percent((user || 0) + (system || 0)),
        user == null ? "" : `user ${format.percent(user)}${SEP}system ${format.percent(system || 0)}`, "",
        "Share of all CPU cores busy in user and kernel mode, the last second (OSUserTimeNormalized + OSSystemTimeNormalized)");
      const resident = value("MemoryResident");
      const total = value("CGroupMemoryTotal") > 0 ? value("CGroupMemoryTotal") : value("OSMemoryTotal");
      tile("memory", "Memory", resident == null ? DASH : format.bytes(resident),
        resident != null && total > 0 ? `of ${format.bytes(total)} (${format.percent(resident / total)})` : "",
        resident != null && total > 0 && resident / total >= 0.9 ? "warn" : "", "Resident memory of the server process");
      tile("load", "Load", value("LoadAverage1") == null ? DASH : format.number(value("LoadAverage1")),
        value("LoadAverage15") == null ? "" : `15 min ${format.number(value("LoadAverage15"))}`, "", "Load average over 1 and 15 minutes");
      tile("queries", "Queries", value("Query") == null ? DASH : format.count(value("Query")),
        [value("Merge") != null ? format.countLabel(value("Merge"), "merge") : "", value("PartMutation") != null ? format.countLabel(value("PartMutation"), "mutation") : ""].filter(Boolean).join(SEP),
        "", "Queries, merges and part mutations running now");
      const connections = ["TCPConnection", "HTTPConnection", "MySQLConnection", "PostgreSQLConnection"].map(value);
      const anyConnection = connections.some((item) => item != null);
      tile("connections", "Connections", anyConnection ? format.count(connections.reduce((sum, item) => sum + (item || 0), 0)) : DASH,
        anyConnection ? `TCP ${format.count(value("TCPConnection") || 0)}${SEP}HTTP ${format.count(value("HTTPConnection") || 0)}` : "",
        "", "Client connections (native, HTTP, MySQL and PostgreSQL protocols)");
      const maxParts = value("MaxPartCountForPartition");
      const bytes = value("TotalBytesOfMergeTreeTables");
      tile("parts", "Parts", value("TotalPartsOfMergeTreeTables") == null ? DASH : format.count(value("TotalPartsOfMergeTreeTables")),
        [bytes == null ? "" : format.bytes(bytes), maxParts == null ? "" : `max ${format.count(maxParts)}/partition`].filter(Boolean).join(SEP),
        maxParts >= PARTS_ERROR ? "error" : maxParts >= PARTS_WARN ? "warn" : "",
        `Active parts of MergeTree tables and their size on disk. Inserts slow down at ${format.count(PARTS_ERROR)} parts in one partition (parts_to_delay_insert).`);
      const delayed = value("DelayedInserts");
      tile("delayed", "Delayed inserts", delayed == null ? DASH : format.count(delayed), "waiting on too many parts", delayed > 0 ? "warn" : "");
      const el = h("div", { class: "statTiles statTiles--boxed explorerMonitorTiles", role: "group", aria: { label: "Server" } },
        tiles.map((item) => ui().statTile(item)));
      const issues = issuesOf("server");
      if (!issues.length) return el;
      return h("div", { class: "explorerMonitorServer" }, issues.map((issue) => issueBlock(issue)), el);
    }

    // Topology: the local system.clusters (no fan-out). A cluster of one
    // local replica (the built-in "default") is this server alone.
    function renderTopology(data) {
      const nodes = data.topology?.nodes || [];
      const clusters = new Map();
      for (const node of nodes) {
        if (!clusters.has(node.cluster)) clusters.set(node.cluster, []);
        clusters.get(node.cluster).push(node);
      }
      const multi = [...clusters].filter(([, list]) => !(list.length === 1 && list[0].is_local));
      const single = [...clusters].filter(([, list]) => list.length === 1 && list[0].is_local).map(([name]) => name);
      const count = multi.length ? `${format.countLabel(multi.length, "cluster")}${SEP}${format.countLabel(multi.reduce((sum, [, list]) => sum + list.length, 0), "node")}` : "";
      const el = card("topology", "Topology", count);
      el.id = "explorerMonitorTopology";
      const issues = issuesOf("topology");
      if (issues.length) {
        for (const issue of issues) el.appendChild(issueBlock(issue));
        return el;
      }
      if (!multi.length) {
        el.appendChild(ns.uiState.block("empty", {
          title: "Single server, no multi-replica cluster",
          body: single.length ? `system.clusters lists ${single.map((name) => `"${name}"`).join(", ")}: this server only.` : "system.clusters lists no cluster.",
          compact: true,
        }));
        return el;
      }
      for (const [name, list] of multi) {
        const shards = new Set(list.map((node) => node.shard_num)).size;
        const replicas = Math.max(...[...new Set(list.map((node) => node.shard_num))].map((shard) => list.filter((node) => node.shard_num === shard).length));
        const rows = list.map((node) => {
          const errors = number(node.errors_count);
          const recovery = number(node.estimated_recovery_time);
          const host = h("td", { class: "explorerMonitorTable__host", title: `${node.host_name} (${node.host_address}:${node.port})` },
            h("span", { class: "mono" }, node.host_name),
            node.is_local ? ns.badge.el("this server", { tone: "accent", className: "explorerMonitorTable__local" }) : null);
          return h("tr", { class: { "is-local": !!node.is_local }, dataset: { host: node.host_name } },
            h("td", { class: "num" }, format.count(node.shard_num)),
            h("td", { class: "num" }, format.count(node.replica_num)),
            host,
            h("td", { class: "mono explorerMonitorTable__address" }, `${node.host_address}:${node.port}`),
            h("td", { class: ["num", errors > 0 && "is-warning"], title: "Connection errors to this replica (decays over time)" }, errors == null ? DASH : format.count(errors)),
            h("td", { class: "num explorerMonitorTable__slow" }, number(node.slowdowns_count) == null ? DASH : format.count(node.slowdowns_count)),
            h("td", { class: ["num", "explorerMonitorTable__recovery", recovery > 0 && "is-warning"] }, recovery == null ? DASH : seconds(recovery)));
        });
        el.appendChild(h("div", { class: "explorerMonitorCluster", dataset: { cluster: name } },
          h("div", { class: "explorerMonitorCluster__head" },
            h("span", { class: "explorerMonitorCluster__name mono" }, name),
            h("span", { class: "explorerMonitorCluster__shape" }, `${format.countLabel(shards, "shard")} × ${format.countLabel(replicas, "replica")}`)),
          dataTable(`explorerMonitorCluster-${name.replace(/[^A-Za-z0-9_-]/g, "_")}`, [
            { label: "Shard", num: true }, { label: "Replica", num: true }, { label: "Host" },
            { label: "Address", className: "explorerMonitorTable__address" },
            { label: "Errors", num: true, title: "errors_count: connection errors to this replica" },
            { label: "Slowdowns", num: true, className: "explorerMonitorTable__slow", title: "slowdowns_count: slow connections (hedged requests)" },
            { label: "Recovery", num: true, className: "explorerMonitorTable__recovery", title: "estimated_recovery_time: until the error count resets" },
          ], rows)));
      }
      const notes = [];
      if (single.length) notes.push(`${single.map((name) => `"${name}"`).join(", ")}: this server only`);
      if (data.topology?.truncated) notes.push(`first ${format.count(data.topology.row_limit)} nodes shown`);
      if (notes.length) el.appendChild(h("p", { class: "explorerMonitorCard__note" }, `${notes.join(SEP)}.`));
      return el;
    }

    // Keeper: the session (/api/explorer/ops/keeper) and, for a Keeper
    // embedded in this server, its role, znodes and followers.
    function renderKeeper(data) {
      if (!keeperEnabled()) return null;
      const m = data.metrics || {};
      const keeper = state.keeper;
      const connections = keeper?.connections || [];
      const session = number(m.ZooKeeperSession) ?? number(keeper?.metrics?.ZooKeeperSession);
      const configured = keeper ? !!keeper.configured : session > 0;
      const roles = [["KeeperIsLeader", "Leader"], ["KeeperIsFollower", "Follower"], ["KeeperIsObserver", "Observer"], ["KeeperIsStandalone", "Standalone"]]
        .filter(([name]) => number(m[name]) > 0).map(([, label]) => label);
      const embedded = roles.length > 0;
      const expired = connections.some((item) => item.is_expired) || number(keeper?.metrics?.ZooKeeperSessionExpired) > 0;
      const status = !configured && !embedded ? null : expired ? ns.badge.el("Session expired", { tone: "error" }) : configured ? ns.badge.el("Connected", { tone: "ok" }) : null;
      const el = card("keeper", "Keeper", "", status);
      el.id = "explorerMonitorKeeper";
      if (state.keeperError && !keeper) {
        el.appendChild(h("p", { class: "explorerMonitorCard__note" }, ns.util.errorText(state.keeperError, "Keeper status is unavailable.")));
        return el;
      }
      if (!configured && !embedded) {
        el.appendChild(ns.uiState.block("empty", {
          title: "No Keeper configured",
          body: "No ZooKeeper / Keeper connection: no replicated tables or distributed DDL.",
          compact: true,
          attrs: { id: "explorerMonitorNoKeeper" },
        }));
        return el;
      }
      const rows = [];
      const row = (key, label, value, extra = {}) => rows.push({ key, label, value, text: true, ...extra });
      const connection = connections[0];
      if (connection) {
        row("host", "Connection", `${connection.host}:${connection.port}`, { mono: true });
        row("session", "Session", connection.is_expired ? "Expired" : `up ${format.duration.fromSeconds(connection.session_uptime_seconds)}`);
      }
      if (keeper?.average_wait_ms != null) row("wait", "Request latency", `${format.duration.fromMs(keeper.average_wait_ms)} average since start`);
      if (embedded) {
        row("role", "This server's Keeper", roles.join(", "));
        if (number(m.KeeperZnodeCount) != null) row("znodes", "Znodes", format.count(m.KeeperZnodeCount));
        if (number(m.KeeperAvgLatency) != null) row("latency", "Keeper latency", `${format.duration.fromMs(m.KeeperAvgLatency)} average${number(m.KeeperMaxLatency) != null ? `${SEP}${format.duration.fromMs(m.KeeperMaxLatency)} max` : ""}`);
        if (number(m.KeeperFollowers) > 0) row("followers", "Followers", `${format.count(m.KeeperSyncedFollowers || 0)} of ${format.count(m.KeeperFollowers)} in sync`);
      }
      el.appendChild(ui().kvList(rows, { className: "explorerMonitorKv", label: "Keeper" }));
      return el;
    }

    // Replication: the replicated tables the runner can see, with Altinity's
    // alert thresholds. Hidden when there are none; the tables are in Activity.
    function renderReplication(data) {
      const issues = issuesOf("replication");
      const r = data.replication;
      if (!issues.length && (!r || !Number(r.tables))) return null;
      const openActivity = features().operations?.enabled
        ? h("button", { type: "button", class: "button button--small explorerMonitorCard__link", id: "explorerMonitorOpenActivity" }, "Open Activity")
        : null;
      openActivity?.addEventListener("click", () => ctx.openSection("activity"));
      const el = card("replication", "Replication", r ? format.countLabel(r.tables, "replicated table") : "", openActivity);
      el.id = "explorerMonitorReplication";
      if (issues.length) {
        for (const issue of issues) el.appendChild(issueBlock(issue));
        return el;
      }
      const problems = Number(r.readonly) + Number(r.session_expired);
      const lagging = Number(r.queue_over) + Number(r.inserts_over) + Number(r.future_parts_over) + Number(r.parts_to_check_over) + (Number(r.max_delay_seconds) > 300 ? 1 : 0);
      const tone = problems ? "error" : lagging ? "warn" : "ok";
      const summary = problems ? `${format.count(problems)} need attention` : lagging ? "Behind" : "Healthy";
      const tiles = [
        { label: "Status", value: summary, tone, attrs: { "data-tile": "status" } },
        { label: "Read-only", value: format.count(r.readonly), tone: r.readonly > 0 ? "error" : "", sub: r.session_expired > 0 ? `${format.count(r.session_expired)} session expired` : "", attrs: { "data-tile": "readonly" } },
        { label: "Max delay", value: seconds(r.max_delay_seconds), tone: r.max_delay_seconds > 300 ? "warn" : "", attrs: { "data-tile": "delay" } },
        { label: "Queue", value: format.count(r.queue_size), sub: `${format.countLabel(r.inserts_in_queue, "insert")}${SEP}${format.countLabel(r.merges_in_queue, "merge")}`, tone: r.queue_over > 0 || r.inserts_over > 0 ? "warn" : "", attrs: { "data-tile": "queue" } },
      ];
      el.appendChild(h("div", { class: "statTiles statTiles--boxed explorerMonitorTiles--small" }, tiles.map((item) => ui().statTile(item))));
      const alerts = [];
      if (r.future_parts_over > 0) alerts.push(`${format.countLabel(r.future_parts_over, "table")} with more than 20 parts to fetch or merge`);
      if (r.parts_to_check_over > 0) alerts.push(`${format.countLabel(r.parts_to_check_over, "table")} with more than 10 parts to check`);
      if (r.queue_over > 0) alerts.push(`${format.countLabel(r.queue_over, "table")} with a queue over 20`);
      if (r.inserts_over > 0) alerts.push(`${format.countLabel(r.inserts_over, "table")} with more than 10 inserts queued`);
      if (r.truncated) alerts.push("the first 10,000 replicated tables only");
      if (alerts.length) el.appendChild(h("p", { class: "explorerMonitorCard__note" }, `${alerts.join(SEP)}.`));
      return el;
    }

    return {
      show() {
        state.active = true;
        if (state.host && state.host !== hostId()) { state.data = null; state.keeper = null; }
        render();
        void load(false);
        schedule();
      },
      hide() {
        state.active = false;
        clearTimeout(state.timer);
      },
      refresh(force = true) {
        if (state.host !== hostId()) {
          state.data = null;
          state.keeper = null;
          state.error = null;
          state.keeperError = null;
          state.serial += 1;
          state.loading = false;
          render();
        }
        void load(force);
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Activity: app_explorer_ops.js, as it is. Its own header holds the
  // Auto-refresh choice, which is the Overview's too (one stored preference).

  function createActivity(ctx) {
    const container = h("div", { class: "explorerMonitorActivity" });
    ctx.panel.appendChild(container);
    return {
      show() {
        ns.explorerOps.show(container, { onOpenTable: ctx.openTable });
        // The choice may have changed in another section since the view
        // was mounted: its own checkbox applies it.
        const input = $("#explorerOpsAutoRefresh", container);
        const on = !!autoRefreshPref().get();
        if (input && input.checked !== on) {
          input.checked = on;
          input.dispatchEvent(new Event("change"));
        }
      },
      hide() {
        ns.explorerOps.hide();
      },
      refresh(force = true) {
        void ns.explorerOps.refresh(force);
      },
    };
  }

  const ui = () => ns.ui;

  register({ id: "overview", label: "Overview", order: 10, available: (f) => !!f.monitoring?.enabled, create: createOverview });
  register({ id: "activity", label: "Activity", order: 50, available: (f) => !!f.operations?.enabled && !!ns.explorerOps, create: createActivity });

  ns.explorerMonitor = { show, hide, refresh, register, sections: () => availableSections().map((section) => section.id) };
})();
