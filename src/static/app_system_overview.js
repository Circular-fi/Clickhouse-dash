(() => {
  "use strict";

  // The System Overview (docs/system.md "Overview"): the selected server on
  // one page, top to bottom:
  //   the server tiles   /api/system/overview (system.asynchronous_metrics
  //                      and system.metrics, refreshed by the server every
  //                      second);
  //   Databases          a treemap of the databases the runner can see, by
  //                      bytes on disk (the disks answer's usage,
  //                      /api/system/disks); a database opens its Explorer
  //                      card;
  //   Cluster            the topology (system.clusters), Keeper (the
  //                      overview's Keeper metrics and /api/system/keeper)
  //                      and the replication summary;
  //   Performance        the history charts and their time range
  //                      (app_system_perf.js);
  //   Activity           replicas, mutations, replication queues, merges and
  //                      Distributed send queues (app_system_activity.js).
  // Each part degrades on its own: an answer or a panel that fails says why
  // in place of that part only.
  //
  // One Auto-refresh choice (remembered per browser, off by default): the
  // tiles, the cluster cards and the activity every 5 s, the charts every
  // 30 s and only for relative ranges of 6 h or less; nothing while the
  // section or the browser tab is hidden (back on the tab, it catches up at
  // once). The databases follow the refresh button and a new host.
  //
  // Address: the time range of the charts (from / to, absent for the
  // default); #performance and #activity (the former Monitoring sections and
  // /explorer/_operations) scroll to their part once.

  const ns = window.ChDash;
  if (!ns || !ns.systemView) return;
  const { h } = ns;
  const format = ns.format;
  const kit = ns.systemView.kit;
  const { SEP, number, seconds } = kit;
  const DASH = format.EMPTY;

  const LIVE_REFRESH_MS = 5000;
  // The databases (bytes on disk) read again on show after this long.
  const DATABASES_TTL_MS = 60000;
  // Altinity's thresholds and ClickHouse's own defaults: parts_to_delay_insert
  // (1000) slows inserts down, 300 parts in one partition is the usual alert.
  const PARTS_WARN = 300;
  const PARTS_ERROR = 1000;
  const TREEMAP_LABEL = "Databases by bytes on disk";

  const keeperEnabled = () => !!kit.features()?.keeper;
  const activityEnabled = () => !!kit.features()?.activity && !!ns.systemActivity;
  const explorerEnabled = () => !!ns.features.get("explorer.enabled");

  // Server tiles: the current values of an overview answer.
  function serverTiles(data) {
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
    return h("div", { class: "statTiles statTiles--boxed systemTiles", role: "group", aria: { label: "Server" } },
      tiles.map((item) => ns.ui.statTile(item)));
  }

  function createOverview(ctx) {
    const state = {
      data: null,
      keeper: null,
      keeperRecent: null,
      error: null,
      keeperError: null,
      loading: false,
      serial: 0,
      databases: null,
      databasesError: null,
      databasesLoading: false,
      databasesSerial: 0,
      databasesAt: 0,
      treemap: null,
      active: false,
      host: "",
      liveTimer: 0,
      perfTimer: 0,
      scrolled: false,
    };

    const controls = kit.sectionBar({
      id: "overview",
      label: "the overview",
      autoRefreshTitle: "The tiles, the cluster cards and the activity every 5 s; the charts every 30 s, for relative ranges of 6 hours or less",
      onRefresh: () => refreshAll(true),
      onAutoRefresh: (on) => {
        kit.autoRefreshPref().set(on);
        schedule();
        if (on) {
          void loadLive(false);
          if (perf?.canAutoRefresh()) void perf.load(false);
        }
      },
    });
    ctx.actions.appendChild(controls.bar);

    // The parts, top to bottom.
    const tilesHost = h("div", { class: "systemOverview__server", id: "systemServer" });
    const databases = kit.part("databases", "Databases");
    const databasesCount = h("span", { class: "systemPart__count", id: "systemDatabasesCount" });
    databases.head.appendChild(databasesCount);
    const treemapHost = h("div", { class: "systemDatabases__map", id: "systemDatabaseMap" });
    const databasesNotes = h("div", { class: "systemDatabases__notes", id: "systemDatabasesNotes" });
    const databasesFoot = h("p", { class: "systemCard__note systemDatabases__foot", id: "systemDatabasesFoot" });
    databases.body.append(databasesNotes, treemapHost, databasesFoot);
    const cluster = kit.part("cluster", "Cluster");
    const perf = ns.systemPerf?.create({
      setQuery: (query, options) => ctx.setQuery(query, options),
      onRangeChange: () => schedulePerf(),
    }) || null;
    const activity = activityEnabled() ? ns.systemActivity.create({ openTable: ctx.openTable }) : null;
    const activityPart = activity ? kit.part("activity", "Activity") : null;
    if (activityPart) activityPart.body.appendChild(activity.el);
    const body = h("div", { class: "systemOverview", id: "systemOverview" },
      tilesHost, databases.el, cluster.el, perf?.el || null, activityPart?.el || null);
    ctx.panel.appendChild(body);

    const autoRefresh = () => !!kit.autoRefreshPref().get();
    const visible = () => state.active && ctx.panel.isConnected && !ctx.panel.hidden && !document.hidden;

    // Back on the browser tab: catch up at once rather than at the next tick.
    document.addEventListener("visibilitychange", () => {
      if (!autoRefresh() || !visible()) return;
      void loadLive(false);
      if (perf?.canAutoRefresh() && perf.stale()) void perf.load(false);
    });

    // Two clocks: the live parts every 5 s, the charts every 30 s (each
    // keeps its own period; a live tick never restarts the charts' one).
    function scheduleLive() {
      clearTimeout(state.liveTimer);
      if (!state.active || !autoRefresh()) return;
      state.liveTimer = setTimeout(async () => {
        if (visible()) await loadLive(false);
        scheduleLive();
      }, LIVE_REFRESH_MS);
    }

    function schedulePerf() {
      clearTimeout(state.perfTimer);
      if (!state.active || !autoRefresh() || !perf?.canAutoRefresh()) return;
      state.perfTimer = setTimeout(async () => {
        if (visible()) await perf.load(false);
        schedulePerf();
      }, perf.AUTO_REFRESH_MS);
    }

    function schedule() {
      controls.input.checked = autoRefresh();
      scheduleLive();
      schedulePerf();
    }

    // --- Loading -------------------------------------------------------------

    // The tiles, the cluster cards and the activity: one round.
    async function loadLive(force = false) {
      const host = kit.hostId();
      if (!host) return;
      const work = [];
      if (activity && !activity.loading()) work.push(activity.load(force));
      if (!state.loading) {
        state.loading = true;
        const serial = ++state.serial;
        renderBusy();
        work.push(Promise.allSettled([
          ns.api.getSystemOverview(host, force),
          keeperEnabled() ? ns.api.getSystemKeeper(host, force) : Promise.resolve(null),
        ]).then(([overview, keeper]) => {
          state.loading = false;
          renderBusy();
          if (serial !== state.serial || kit.hostId() !== host) return;
          state.host = host;
          if (overview.status === "fulfilled") { state.data = overview.value; state.error = null; } else state.error = overview.reason;
          if (keeper.status === "fulfilled") {
            const next = keeper.value;
            const prev = state.keeper;
            if (next && prev && Number(next.generated_at_ms) > Number(prev.generated_at_ms)) {
              const tx = Number(next.events?.ZooKeeperTransactions || 0) - Number(prev.events?.ZooKeeperTransactions || 0);
              const wait = Number(next.events?.ZooKeeperWaitMicroseconds || 0) - Number(prev.events?.ZooKeeperWaitMicroseconds || 0);
              const span = (Number(next.generated_at_ms) - Number(prev.generated_at_ms)) / 1000;
              state.keeperRecent = tx > 0 && span > 0 ? { latencyMs: wait / 1000 / tx, rate: tx / span, seconds: span } : (span > 0 ? { latencyMs: null, rate: 0, seconds: span } : state.keeperRecent);
            }
            state.keeper = next;
            state.keeperError = null;
          } else {
            state.keeperError = keeper.reason;
          }
          renderLive();
        }));
      }
      await Promise.all(work);
    }

    async function loadDatabases(force = false) {
      const host = kit.hostId();
      if (!host || state.databasesLoading) return;
      state.databasesLoading = true;
      const serial = ++state.databasesSerial;
      ns.uiState.busy(databases.body, !state.databases);
      let data = null;
      let error = null;
      try {
        data = await ns.api.getSystemDisks(host, force);
      } catch (e) {
        error = e;
      }
      state.databasesLoading = false;
      ns.uiState.busy(databases.body, false);
      if (serial !== state.databasesSerial || kit.hostId() !== host) return;
      state.databasesAt = Date.now();
      if (data) { state.databases = data; state.databasesError = null; } else state.databasesError = error;
      renderDatabases();
    }

    function refreshAll(force) {
      void loadLive(force);
      void loadDatabases(force);
      if (perf) void perf.load(force);
    }

    // --- Rendering -------------------------------------------------------------

    function renderBusy() {
      ns.uiState.busy(controls.button, state.loading);
      ns.uiState.busy(tilesHost, state.loading && !state.data);
    }

    function issuesOf(panel) {
      return (state.data?.unavailable_panels || []).filter((issue) => issue.panel === panel);
    }

    // The tiles and the cluster cards (the overview answer and Keeper).
    function renderLive() {
      renderBusy();
      const data = state.data;
      const banner = state.error
        ? ns.uiState.banner(h("div"), { message: ns.util.errorText(state.error, "The server overview is unavailable."), retry: () => void loadLive(true), inset: true })
        : null;
      if (!data) {
        h.replace(tilesHost, banner || ns.uiState.block("loading", { label: "Loading the server overview\u2026", compact: true }));
        h.replace(cluster.body);
        cluster.el.hidden = true;
        return;
      }
      const issues = issuesOf("server").map((issue) => kit.issueBlock(issue));
      h.replace(tilesHost, banner, issues, serverTiles(data));
      cluster.el.hidden = false;
      const side = [renderKeeper(data), renderReplication(data)].filter(Boolean);
      h.replace(cluster.body, h("div", { class: "systemGrid" }, renderTopology(data), side.length ? h("div", { class: "systemGrid__side" }, side) : null));
      scrollToHash();
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
      const el = kit.card("topology", "Topology", count);
      el.id = "systemTopology";
      const issues = issuesOf("topology");
      if (issues.length) {
        for (const issue of issues) el.appendChild(kit.issueBlock(issue));
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
          const host = h("td", { class: "systemTable__host", title: `${node.host_name} (${node.host_address}:${node.port})` },
            h("span", { class: "mono" }, node.host_name),
            node.is_local ? ns.badge.el("this server", { tone: "accent", className: "systemTable__local" }) : null);
          return h("tr", { class: { "is-local": !!node.is_local }, dataset: { host: node.host_name } },
            h("td", { class: "num" }, format.count(node.shard_num)),
            h("td", { class: "num" }, format.count(node.replica_num)),
            host,
            h("td", { class: "mono systemTable__address" }, `${node.host_address}:${node.port}`),
            h("td", { class: ["num", errors > 0 && "is-warning"], title: "Connection errors to this replica (decays over time)" }, errors == null ? DASH : format.count(errors)),
            h("td", { class: "num systemTable__slow" }, number(node.slowdowns_count) == null ? DASH : format.count(node.slowdowns_count)),
            h("td", { class: ["num", "systemTable__recovery", recovery > 0 && "is-warning"] }, recovery == null ? DASH : seconds(recovery)));
        });
        el.appendChild(h("div", { class: "systemCluster", dataset: { cluster: name } },
          h("div", { class: "systemCluster__head" },
            h("span", { class: "systemCluster__name mono" }, name),
            h("span", { class: "systemCluster__shape" }, `${format.countLabel(shards, "shard")} \u00d7 ${format.countLabel(replicas, "replica")}`)),
          kit.dataTable(`systemCluster-${name.replace(/[^A-Za-z0-9_-]/g, "_")}`, [
            { label: "Shard", num: true }, { label: "Replica", num: true }, { label: "Host" },
            { label: "Address", className: "systemTable__address" },
            { label: "Errors", num: true, title: "errors_count: connection errors to this replica" },
            { label: "Slowdowns", num: true, className: "systemTable__slow", title: "slowdowns_count: slow connections (hedged requests)" },
            { label: "Recovery", num: true, className: "systemTable__recovery", title: "estimated_recovery_time: until the error count resets" },
          ], rows)));
      }
      const notes = [];
      if (single.length) notes.push(`${single.map((name) => `"${name}"`).join(", ")}: this server only`);
      if (data.topology?.truncated) notes.push(`first ${format.count(data.topology.row_limit)} nodes shown`);
      if (notes.length) el.appendChild(h("p", { class: "systemCard__note" }, `${notes.join(SEP)}.`));
      return el;
    }

    // Keeper: the session (/api/system/keeper: connection, latency, requests,
    // watches, exceptions) and, for a Keeper embedded in this server, its
    // role, znodes and followers (the overview's Keeper* metrics).
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
      const el = kit.card("keeper", "Keeper", "", status);
      el.id = "systemKeeper";
      if (state.keeperError && !keeper) {
        el.appendChild(h("p", { class: "systemCard__note" }, ns.util.errorText(state.keeperError, "Keeper status is unavailable.")));
        return el;
      }
      if (!configured && !embedded) {
        el.appendChild(ns.uiState.block("empty", {
          title: "No Keeper configured",
          body: "No ZooKeeper / Keeper connection: no replicated tables or distributed DDL.",
          compact: true,
          attrs: { id: "systemNoKeeper" },
        }));
        return el;
      }
      const rows = [];
      const row = (key, label, value, extra = {}) => rows.push({ key, label, value, text: true, attrs: { "data-row": key }, ...extra });
      connections.forEach((connection, index) => {
        const name = connection.name && connection.name !== "default" ? ` (${connection.name})` : "";
        const since = ns.ui.serverTime(connection.connected_time);
        row(index ? `host${index}` : "host", `Connection${name}`, `${connection.host}:${connection.port}`, { mono: true, keyTitle: since.text && since.text !== DASH ? `Connected since ${since.text}` : "" });
        const timeout = number(connection.session_timeout_ms);
        row(index ? `session${index}` : "session", "Session", connection.is_expired
          ? "Expired"
          : `up ${format.duration.fromSeconds(connection.session_uptime_seconds)}${timeout ? `${SEP}timeout ${format.duration.fromMs(timeout)}` : ""}`);
      });
      if (keeper && configured) {
        const recent = state.keeperRecent;
        const latency = recent?.latencyMs != null ? recent.latencyMs : keeper.average_wait_ms;
        if (latency != null) row("latency", "Latency", `${format.duration.fromMs(latency)} ${recent?.latencyMs != null ? `average over the last ${Math.round(recent.seconds)} s` : "average since start"}`);
        const inFlight = number(keeper.metrics?.ZooKeeperRequest);
        const rate = recent ? format.rate(recent.rate, "transactions") : `${format.count(keeper.events?.ZooKeeperTransactions ?? null)} transactions since start`;
        row("requests", "Requests", `${inFlight == null ? DASH : format.count(inFlight)} in flight${SEP}${rate}`);
        if (number(keeper.metrics?.ZooKeeperWatch) != null) row("watches", "Watches", format.count(keeper.metrics.ZooKeeperWatch));
        const exceptions = ["ZooKeeperHardwareExceptions", "ZooKeeperUserExceptions", "ZooKeeperOtherExceptions"]
          .reduce((sum, name) => sum + Number(keeper.events?.[name] || 0), 0);
        row("exceptions", "Exceptions", `${format.count(exceptions)} since start`);
      }
      if (embedded) {
        row("role", "This server's Keeper", roles.join(", "));
        if (number(m.KeeperZnodeCount) != null) row("znodes", "Znodes", format.count(m.KeeperZnodeCount));
        if (number(m.KeeperAvgLatency) != null) row("keeper_latency", "Keeper latency", `${format.duration.fromMs(m.KeeperAvgLatency)} average${number(m.KeeperMaxLatency) != null ? `${SEP}${format.duration.fromMs(m.KeeperMaxLatency)} max` : ""}`);
        if (number(m.KeeperFollowers) > 0) row("followers", "Followers", `${format.count(m.KeeperSyncedFollowers || 0)} of ${format.count(m.KeeperFollowers)} in sync`);
      }
      el.appendChild(ns.ui.kvList(rows, { className: "systemKv", label: "Keeper" }));
      return el;
    }

    // Replication: the replicated tables the runner can see, with Altinity's
    // alert thresholds. Hidden when there are none; their tables are the
    // Activity's Replicas, further down.
    function renderReplication(data) {
      const issues = issuesOf("replication");
      const r = data.replication;
      if (!issues.length && (!r || !Number(r.tables))) return null;
      const replicas = activity
        ? h("button", { type: "button", class: "button button--small systemCard__link", id: "systemReplicationTables", title: "The Activity's Replicas table, further down" }, "Show the tables")
        : null;
      replicas?.addEventListener("click", () => {
        const target = ns.dom.$('[data-section="replicas"]', activityPart.el) || activityPart.el;
        target.scrollIntoView({ block: "start", behavior: "smooth" });
      });
      const el = kit.card("replication", "Replication", r ? format.countLabel(r.tables, "replicated table") : "", replicas);
      el.id = "systemReplication";
      if (issues.length) {
        for (const issue of issues) el.appendChild(kit.issueBlock(issue));
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
      el.appendChild(h("div", { class: "statTiles statTiles--boxed systemTiles--small" }, tiles.map((item) => ns.ui.statTile(item))));
      const alerts = [];
      if (r.future_parts_over > 0) alerts.push(`${format.countLabel(r.future_parts_over, "table")} with more than 20 parts to fetch or merge`);
      if (r.parts_to_check_over > 0) alerts.push(`${format.countLabel(r.parts_to_check_over, "table")} with more than 10 parts to check`);
      if (r.queue_over > 0) alerts.push(`${format.countLabel(r.queue_over, "table")} with a queue over 20`);
      if (r.inserts_over > 0) alerts.push(`${format.countLabel(r.inserts_over, "table")} with more than 10 inserts queued`);
      if (r.truncated) alerts.push("the first 10,000 replicated tables only");
      if (alerts.length) el.appendChild(h("p", { class: "systemCard__note" }, `${alerts.join(SEP)}.`));
      return el;
    }

    // Databases: the usage rows of the disks answer (bytes of active parts by
    // disk and database, the runner-visible databases only), summed by
    // database. The map's tooltip names the size and the share.
    function databaseTree(data) {
      const byName = new Map();
      for (const row of data.usage?.rows || []) {
        const entry = byName.get(row.database) || { bytes: 0, parts: 0, disks: [] };
        entry.bytes += Number(row.bytes) || 0;
        entry.parts += Number(row.parts) || 0;
        if (row.disk) entry.disks.push(row.disk);
        byName.set(row.database, entry);
      }
      const children = [...byName].map(([name, entry]) => ({
        kind: "database",
        name,
        path: name,
        database: name,
        bytes: entry.bytes,
        // Parts, not tables: the map names them (countLabel) and counts no
        // tables for a group of small databases.
        count: 0,
        parts: entry.parts,
        countLabel: format.countLabel(entry.parts, "part"),
      }));
      const total = children.reduce((sum, item) => sum + item.bytes, 0);
      return { tree: { kind: "server", name: "", bytes: total, children }, count: children.length, total };
    }

    function renderDatabases() {
      const data = state.databases;
      const notes = [];
      if (state.databasesError) {
        notes.push(ns.uiState.banner(h("div"), { message: ns.util.errorText(state.databasesError, "The databases are unavailable."), retry: () => void loadDatabases(true), inset: true }));
      }
      const issues = (data?.unavailable_panels || []).filter((issue) => issue.panel === "usage");
      for (const issue of issues) notes.push(kit.issueBlock(issue));
      if (!data) {
        if (!state.databasesError) notes.push(ns.uiState.block("loading", { label: "Loading the databases\u2026", compact: true }));
        h.replace(databasesNotes, notes);
        databasesNotes.hidden = !notes.length;
        treemapHost.hidden = true;
        databasesFoot.hidden = true;
        databasesCount.textContent = "";
        return;
      }
      const { tree, count, total } = databaseTree(data);
      databasesCount.textContent = count ? `${format.countLabel(count, "database")}${SEP}${format.bytes(total)} on disk` : "";
      if (!issues.length && !(total > 0)) {
        notes.push(ns.uiState.block("empty", { title: "No data on disk", body: "No database the runner can see has active parts.", compact: true, attrs: { id: "systemDatabasesEmpty" } }));
      }
      h.replace(databasesNotes, notes);
      databasesNotes.hidden = !notes.length;
      const show = !issues.length && total > 0 && !!ns.explorerTreemap;
      treemapHost.hidden = !show;
      databasesFoot.hidden = !show;
      if (!show) return;
      if (!state.treemap) {
        state.treemap = ns.explorerTreemap.mount(treemapHost, {
          ariaLabel: TREEMAP_LABEL,
          formatBytes: (value) => format.bytes(value),
          emptyText: "No data on disk.",
          onOpen: (target) => {
            if (target.kind === "database" && target.database && explorerEnabled()) ctx.openDatabase(target.database);
          },
        });
      }
      const built = ns.explorerTreemap.buildTreemap(tree);
      state.treemap?.setTree(built.tree, { name: "the databases" });
      treemapHost.classList.toggle("is-static", !explorerEnabled());
      const grouped = built.threshold > 0 ? ` Databases under 1% of the total (< ${format.bytes(built.threshold)}) are grouped into Others.` : "";
      databasesFoot.textContent = `Bytes on disk of the active parts of the databases the runner can see, every disk.${grouped}${explorerEnabled() ? " A database opens its card in the Explorer." : ""}${data.usage?.truncated ? ` The first ${format.count(data.limits?.usage_row_limit || 1000)} rows.` : ""}`;
    }

    // #performance / #activity (the former Monitoring sections): their part,
    // once, when the page opened on it.
    function scrollToHash() {
      if (state.scrolled) return;
      state.scrolled = true;
      const hash = String(window.location.hash || "").slice(1);
      const target = hash === "performance" ? perf?.el : hash === "activity" ? activityPart?.el : null;
      if (target) requestAnimationFrame(() => target.scrollIntoView({ block: "start" }));
    }

    function resetForHost() {
      state.data = null;
      state.keeper = null;
      state.keeperRecent = null;
      state.error = null;
      state.keeperError = null;
      state.serial += 1;
      state.loading = false;
      state.databases = null;
      state.databasesError = null;
      state.databasesSerial += 1;
      state.databasesLoading = false;
      state.databasesAt = 0;
      activity?.reset();
      perf?.reset();
      renderLive();
      renderDatabases();
    }

    renderLive();
    renderDatabases();

    return {
      show(addressQuery) {
        state.active = true;
        if (state.host && state.host !== kit.hostId()) resetForHost();
        controls.input.checked = autoRefresh();
        void loadLive(false);
        if (!state.databases || Date.now() - state.databasesAt >= DATABASES_TTL_MS) void loadDatabases(false);
        perf?.show(addressQuery);
        schedule();
      },
      hide() {
        state.active = false;
        clearTimeout(state.liveTimer);
        clearTimeout(state.perfTimer);
        perf?.hide();
      },
      refresh(force = true) {
        if (state.host !== kit.hostId()) resetForHost();
        refreshAll(force);
      },
      query: () => perf?.query() || "",
    };
  }

  ns.systemView.register({ id: "overview", label: "Overview", order: 10, available: (f) => !!f?.enabled, create: createOverview });
})();
