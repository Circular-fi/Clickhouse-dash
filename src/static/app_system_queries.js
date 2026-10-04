(() => {
  "use strict";

  // The System page's Queries section (docs/system.md "Queries"): the top
  // query shapes of a window on the selected server, modelled on Query
  // Insights. /api/system/queries reads system.query_log with the
  // RUNNER account (ClickHouse grants decide: the Query page can read the
  // same rows) in two phases: the narrow numbers grouped by
  // normalized_query_hash, then the text of the top 50 only. Sorts and kinds
  // are the server's allowlists; the System page's own reads are never listed,
  // and "Hide ChDash" (on by default) drops the system account's queries.
  // No Auto-refresh: a window is read once, cached a minute by the server.
  //
  // A row opens the shape (?q=<hash>, Back returns to the list): its
  // timeline (runs, latency, CPU) and its 20 slowest, latest or largest
  // runs, from /api/system/queries/<hash>. "Open example in Query"
  // puts the latest run's text in the Query editor; "Open history in Query"
  // a ready-made query_log SELECT of that shape. Neither runs.
  //
  // Address: from / to (the Observability range format; the default hour
  // writes neither), sort, kind, hide=0, q=<hash>, runs=<order>. Query text
  // is drawn by ui.sqlBlock (the highlighter escapes), never as markup.

  const ns = window.ChDash;
  if (!ns || !ns.systemView) return;
  const { h } = ns;
  const { $ } = ns.dom;
  const format = ns.format;
  const kit = ns.systemView.kit;
  const SEP = kit.SEP;
  const DASH = format.EMPTY;

  const SYNC_KEY = "systemQuery";
  const PLOT_HEIGHT = 150;
  // The error share of a shape's runs: neutral under 1 %, a warning to 5 %,
  // danger from there.
  const ERROR_WARN = 0.01;
  const ERROR_DANGER = 0.05;
  const MIN_ZOOM_MS = 60000;
  const HASH_RE = /^\d{1,20}$/;

  // The server's allowlists (src/system_monitor.cpp), with their labels.
  const SORTS = [
    { value: "total_time", label: "Total time", title: "Sum of the durations" },
    { value: "calls", label: "Calls", title: "Number of runs" },
    { value: "p95", label: "p95", title: "95th percentile of the duration" },
    { value: "max_memory", label: "Memory", title: "Largest memory use of a run" },
    { value: "read_bytes", label: "Read", title: "Bytes read" },
    { value: "errors", label: "Errors", title: "Failed runs" },
  ];
  const KINDS = [
    { value: "all", label: "All" },
    { value: "Select", label: "SELECT" },
    { value: "Insert", label: "INSERT" },
    { value: "other", label: "Other", title: "DDL, SYSTEM, ALTER and the other statements" },
  ];
  const ORDERS = [
    { value: "duration", label: "Slowest" },
    { value: "latest", label: "Latest" },
    { value: "memory", label: "Most memory" },
  ];
  const DEFAULTS = { sort: "total_time", kind: "all", order: "duration" };

  const settings = () => kit.features() || {};
  const maxMinutes = () => Math.max(1, Number(settings().query_log_max_lookback_hours) || 168) * 60;
  const defaultRange = () => ({ from: `now-${ns.timeRange.minutesToSpan(Math.min(maxMinutes(), Number(settings().default_lookback_minutes) || 60))}`, to: "now" });
  const sameRange = (a, b) => String(a?.from || "") === String(b?.from || "") && String(a?.to || "") === String(b?.to || "");
  const allowed = (list, value, fallback) => (list.some((item) => item.value === value) ? value : fallback);
  const oneLine = (sql) => String(sql || "").replace(/\s+/g, " ").trim();
  const ms = (value) => (Number.isFinite(Number(value)) ? format.duration.fromMs(Number(value)) : DASH);

  function errorTone(errors, calls) {
    const ratio = Number(calls) > 0 ? Number(errors) / Number(calls) : 0;
    return ratio >= ERROR_DANGER ? "error" : ratio >= ERROR_WARN ? "warn" : "neutral";
  }

  // The count and the share ("12, 4.1%") in the tone of the share; plain "0"
  // without errors.
  function errorCell(errors, calls) {
    const count = Number(errors) || 0;
    if (!count) return h("span", { class: "systemQueries__zero" }, "0");
    const tone = errorTone(count, calls);
    return ns.badge.el(`${format.count(count)}${SEP}${format.percent(count / Math.max(1, Number(calls) || 0))}`, {
      tone,
      title: `${format.count(count)} failed of ${format.count(calls)} runs (warning from 1 %, danger from 5 %)`,
      attrs: { "data-error-rate": tone },
    });
  }

  // The history of a shape as a query_log SELECT for the Query page (opened,
  // not run): the window as the picker shows it ("now() - INTERVAL 1 HOUR"
  // for "now-1h" .. "now", the instants otherwise).
  const UNITS = { m: "MINUTE", h: "HOUR", d: "DAY", w: "WEEK" };
  function historySql(hash, range, resolved) {
    if (!HASH_RE.test(String(hash))) return "";
    const relative = /^now-(\d{1,5})([mhdw])$/.exec(String(range?.from || ""));
    let from;
    let until = "";
    let note;
    if (relative && String(range?.to || "") === "now") {
      from = `now() - INTERVAL ${Number(relative[1])} ${UNITS[relative[2]]}`;
      note = `-- The last ${relative[1]}${relative[2]} on this server's clock.`;
    } else {
      const start = Math.floor(resolved.startMs / 1000);
      const end = Math.ceil(resolved.endMs / 1000);
      from = `toDateTime(${start})`;
      until = `\n  AND event_time < toDateTime(${end})`;
      note = `-- ${format.range(resolved.startMs, resolved.endMs)} (your time zone).`;
    }
    return [
      `-- The runs of query shape ${hash} (System > Queries).`,
      note,
      "SELECT",
      "    event_time,",
      "    query_id,",
      "    user,",
      "    type,",
      "    query_duration_ms,",
      "    read_rows,",
      "    formatReadableSize(read_bytes) AS read,",
      "    result_rows,",
      "    formatReadableSize(memory_usage) AS memory,",
      "    exception_code,",
      "    query",
      "FROM system.query_log",
      `WHERE event_date >= toDate(${from})`,
      `  AND event_time >= ${from}${until}`,
      `  AND normalized_query_hash = ${hash}`,
      "  AND type IN ('QueryFinish', 'ExceptionWhileProcessing', 'ExceptionBeforeStart')",
      "  AND is_initial_query",
      "ORDER BY event_time DESC",
      "LIMIT 100",
    ].join("\n");
  }

  // Why the list (or a shape) could not be read, in the runner's terms.
  function statusText(status, data) {
    const cap = format.count(Number(data?.limits?.query_log_max_rows) || 0);
    switch (status) {
      case "disabled": return "system.query_log is disabled on this server: the server configuration needs <query_log> (config.xml) and log_queries = 1.";
      case "not_granted": return "The runner account cannot read system.query_log: Queries read it with the runner account, as the Query page would.";
      case "unsupported": return "This ClickHouse version lacks a column of system.query_log (normalized_query_hash, query_kind).";
      case "window_too_large": return `Reading system.query_log for this window hit its limit (${cap} rows or the time budget, system.query_log_max_rows).`;
      case "readonly_account": return "The runner account's profile has readonly = 1, so the query limits cannot be set (use readonly = 2).";
      default: return ns.util.errorText(data?.message, "system.query_log could not be read.");
    }
  }

  function createQueries(ctx) {
    const state = {
      range: defaultRange(),
      sort: DEFAULTS.sort,
      kind: DEFAULTS.kind,
      hide: true,
      q: "",
      order: DEFAULTS.order,
      active: false,
      host: "",
      list: null,
      listKey: "",
      listError: null,
      listLoading: false,
      listSerial: 0,
      listResolved: null,
      drill: null,
      drillKey: "",
      drillError: null,
      drillLoading: false,
      drillSerial: 0,
      drillResolved: null,
      charts: new Map(),
      pending: false,
    };

    // --- Chrome: the range picker in the tab row, the filters under it -----

    const { root: pickerRoot, wrap: range } = kit.rangePicker("systemQueries");
    // No Auto-refresh: a window is read once, cached a minute by the server.
    const controls = kit.sectionBar({ id: "queries", label: "the top queries", lead: range, onRefresh: () => void refresh(true) });
    ctx.actions.appendChild(controls.bar);

    const kinds = h("div", { class: "systemQueries__kinds", id: "systemQueriesKind" });
    ns.segmented.render(kinds, KINDS, { attr: "kind", value: state.kind, size: "compact", label: "Statement kind" });
    ns.segmented.bind(kinds, { attr: "kind", onChange: (value) => { setFilter({ kind: value }); return false; } });
    const sorts = h("div", { class: "systemQueries__sorts", id: "systemQueriesSort" });
    ns.segmented.render(sorts, SORTS, { attr: "sort", value: state.sort, size: "compact", label: "Sort by" });
    ns.segmented.bind(sorts, { attr: "sort", onChange: (value) => { setFilter({ sort: value }); return false; } });
    const hideInput = h("input", { type: "checkbox", id: "systemQueriesHide", checked: true });
    hideInput.addEventListener("change", () => setFilter({ hide: !!hideInput.checked }));
    const hideOption = h("label", { class: "systemBar__option systemQueries__hide", title: "Leave out the queries of ChDash's system account (the Catalog, health checks). The System page's own reads are never listed." },
      hideInput, h("span", null, "Hide ChDash"));
    const filters = h("div", { class: "systemQueries__filters", id: "systemQueriesFilters" },
      h("div", { class: "systemQueries__filter" }, h("span", { class: "systemQueries__filterLabel" }, "Kind"), kinds),
      h("div", { class: "systemQueries__filter systemQueries__filter--sort" }, h("span", { class: "systemQueries__filterLabel" }, "Sort"), sorts),
      hideOption);

    const notes = h("div", { class: "systemQueries__notes", id: "systemQueriesNotes" });
    const listView = h("div", { class: "systemQueries__list", id: "systemQueriesList" });
    const drillView = h("section", { class: "systemQuery", id: "systemQuery", hidden: true, aria: { label: "Query shape" } });
    const body = h("div", { class: "systemQueries", id: "systemQueries" }, filters, notes, listView, drillView);
    ctx.panel.append(body);

    const picker = ns.timeRange.create(pickerRoot, {
      idPrefix: "systemQueries",
      getValue: () => state.range,
      getMaxMinutes: maxMinutes,
      settingName: "system.query_log_max_lookback_hours",
      onApply: (raw) => {
        picker.close();
        applyRange(raw);
      },
    });

    // --- Address -------------------------------------------------------------

    function query() {
      const params = new URLSearchParams();
      if (!sameRange(state.range, defaultRange())) ns.timeRange.url.write(params, state.range);
      if (state.sort !== DEFAULTS.sort) params.set("sort", state.sort);
      if (state.kind !== DEFAULTS.kind) params.set("kind", state.kind);
      if (!state.hide) params.set("hide", "0");
      if (state.q) params.set("q", state.q);
      if (state.q && state.order !== DEFAULTS.order) params.set("runs", state.order);
      return params.toString();
    }

    function readAddress(text) {
      const params = new URLSearchParams(String(text || ""));
      state.range = ns.timeRange.url.read(params) || defaultRange();
      state.sort = allowed(SORTS, params.get("sort") || "", DEFAULTS.sort);
      state.kind = allowed(KINDS, params.get("kind") || "", DEFAULTS.kind);
      state.hide = params.get("hide") !== "0";
      const q = params.get("q") || "";
      state.q = HASH_RE.test(q) ? q : "";
      state.order = allowed(ORDERS, params.get("runs") || "", DEFAULTS.order);
    }

    function applyRange(raw, { history = "push" } = {}) {
      const next = { from: String(raw.from), to: String(raw.to) };
      if (sameRange(next, state.range)) {
        void loadVisible(false);
        return;
      }
      state.range = next;
      picker.refresh();
      ctx.setQuery(query(), { history });
      void loadVisible(false);
    }

    function setFilter(change) {
      Object.assign(state, change);
      ctx.setQuery(query(), { history: "push" });
      syncFilters();
      void loadVisible(false);
    }

    function syncFilters() {
      ns.segmented.set(kinds, state.kind, "kind");
      ns.segmented.set(sorts, state.sort, "sort");
      hideInput.checked = state.hide;
      // The kind and the sort are the list's (a shape has one kind); they
      // change nothing a missing log or grant would allow.
      filters.hidden = !!state.q || ["disabled", "not_granted", "unsupported", "readonly_account"].includes(state.list?.status);
    }

    function openShape(hash) {
      if (!HASH_RE.test(String(hash))) return;
      state.q = String(hash);
      state.order = DEFAULTS.order;
      ctx.setQuery(query(), { history: "push" });
      render();
      void loadDrill(false);
    }

    function closeShape() {
      const hash = state.q;
      state.q = "";
      ctx.setQuery(query(), { history: "push" });
      render();
      void loadList(false);
      // Focus goes back to the row the shape was opened from.
      const row = hash ? $(`tr[data-hash="${hash}"]`, listView) : null;
      if (row) row.focus({ preventScroll: false });
    }

    // --- Loading -------------------------------------------------------------

    function resolveWindow() {
      const resolved = ns.timeRange.resolveRange(state.range, Date.now());
      if (!Number.isFinite(resolved.startMs) || !Number.isFinite(resolved.endMs) || resolved.endMs <= resolved.startMs) {
        return { error: Object.assign(new Error("Select a valid time range."), { code: "invalid_range" }) };
      }
      resolved.endMs = Math.min(resolved.endMs, Date.now());
      if (resolved.endMs - resolved.startMs > maxMinutes() * 60000 + 60000) {
        return { error: Object.assign(new Error(`Queries read at most ${ns.timeRange.formatMinutes(maxMinutes())} of query_log (system.query_log_max_lookback_hours).`), { code: "range_too_large" }) };
      }
      return { resolved };
    }

    function listKey(resolved) {
      return [kit.hostId(), Math.floor(resolved.startMs / 60000), Math.ceil(resolved.endMs / 60000), state.sort, state.kind, state.hide ? 1 : 0].join("|");
    }

    async function loadList(force) {
      const host = kit.hostId();
      if (!host) return;
      const { resolved, error } = resolveWindow();
      if (error) {
        state.list = null;
        state.listKey = "";
        state.listError = error;
        render();
        return;
      }
      const key = listKey(resolved);
      if (!force && key === state.listKey && (state.list || state.listLoading)) {
        return;
      }
      const serial = ++state.listSerial;
      state.listKey = key;
      state.listLoading = true;
      renderStatus();
      let data = null;
      let failure = null;
      try {
        data = await ns.api.getSystemQueries(host, { fromMs: resolved.startMs, toMs: resolved.endMs, sort: state.sort, kind: state.kind, hideChdash: state.hide }, force);
      } catch (e) {
        failure = e;
      }
      if (serial !== state.listSerial || kit.hostId() !== host) return;
      state.listLoading = false;
      state.host = host;
      state.list = data;
      state.listError = failure;
      state.listResolved = resolved;
      if (failure) state.listKey = "";
      if (!state.active) {
        state.pending = true;
        return;
      }
      render();
    }

    async function loadDrill(force) {
      const host = kit.hostId();
      const hash = state.q;
      if (!host || !hash) return;
      const { resolved, error } = resolveWindow();
      if (error) {
        state.drill = null;
        state.drillKey = "";
        state.drillError = error;
        render();
        return;
      }
      const key = [host, hash, Math.floor(resolved.startMs / 60000), Math.ceil(resolved.endMs / 60000), state.order, state.hide ? 1 : 0].join("|");
      if (!force && key === state.drillKey && (state.drill || state.drillLoading)) {
        return;
      }
      const serial = ++state.drillSerial;
      state.drillKey = key;
      state.drillLoading = true;
      if (state.drill && state.drill.hash !== hash) state.drill = null;
      render();
      let data = null;
      let failure = null;
      try {
        data = await ns.api.getSystemQuery(host, hash, { fromMs: resolved.startMs, toMs: resolved.endMs, order: state.order, hideChdash: state.hide }, force);
      } catch (e) {
        failure = e;
      }
      if (serial !== state.drillSerial || kit.hostId() !== host) return;
      state.drillLoading = false;
      state.host = host;
      state.drill = data;
      state.drillError = failure;
      state.drillResolved = resolved;
      if (failure) state.drillKey = "";
      if (!state.active) {
        state.pending = true;
        return;
      }
      render();
    }

    function loadVisible(force) {
      return state.q ? loadDrill(force) : loadList(force);
    }

    function refresh(force) {
      void loadVisible(force);
    }

    // --- Rendering -----------------------------------------------------------

    function renderStatus() {
      const loading = state.q ? state.drillLoading : state.listLoading;
      const data = state.q ? state.drill : state.list;
      ns.uiState.busy(controls.button, loading);
      ns.uiState.busy(body, loading && !data);
    }

    function render() {
      state.pending = false;
      renderStatus();
      syncFilters();
      picker.refresh();
      listView.hidden = !!state.q;
      drillView.hidden = !state.q;
      if (state.q) renderDrill();
      else renderList();
    }

    // A window over the lookback, a read past the cap: one click narrows it.
    function narrowButton(label, spanMs, id) {
      const button = h("button", { type: "button", class: "button button--small systemQueries__narrow", id }, label);
      button.addEventListener("click", () => {
        const minutes = Math.max(1, Math.floor(spanMs / 60000));
        if (ns.timeRange.isRelative(state.range) && String(state.range.to) === "now") {
          applyRange({ from: `now-${ns.timeRange.minutesToSpan(minutes)}`, to: "now" });
        } else {
          const end = ns.timeRange.resolveRange(state.range, Date.now()).endMs;
          applyRange({ from: ns.timeRange.formatDateTime(end - minutes * 60000), to: ns.timeRange.formatDateTime(end) });
        }
      });
      return button;
    }

    // The degraded states of an answer (or of a refused window), as issue
    // blocks: why, the GRANT to run, and a narrower window when one fits.
    function issueOf(data, error) {
      if (error) {
        if (error.code === "range_too_large") {
          const el = kit.issueBlock({ panel: "queries", table: "query_log", reason: "window_too_large", text: ns.util.errorText(error, "The window is too wide."), message: "" });
          el.dataset.reason = "range_too_large";
          el.appendChild(narrowButton(`Show the last ${ns.timeRange.formatMinutes(maxMinutes())}`, maxMinutes() * 60000, "systemQueriesNarrow"));
          return el;
        }
        return ns.uiState.banner(h("div"), { message: ns.util.errorText(error, "The top queries are unavailable."), retry: () => refresh(true), inset: true });
      }
      if (!data || data.status === "ok") return null;
      const el = kit.issueBlock({ panel: "queries", table: "query_log", reason: data.status, message: data.message, hint: data.hint, text: statusText(data.status, data) });
      if (data.status === "not_granted") $(".systemIssue__copy", el)?.setAttribute("aria-label", "Copy the GRANT statement");
      if (data.status === "window_too_large" && Number(data.suggested_span_ms) > 0) {
        el.appendChild(narrowButton(`Narrow to the last ${ns.timeRange.formatMinutes(Number(data.suggested_span_ms) / 60000)}`, Number(data.suggested_span_ms), "systemQueriesNarrow"));
      }
      return el;
    }

    function renderList() {
      const data = state.list;
      const children = [];
      const issue = issueOf(data, state.listError);
      if (issue) children.push(issue);
      if (data?.status === "ok" && data.phases?.text?.status && data.phases.text.status !== "ok") {
        children.push(h("p", { class: "systemCard__note", id: "systemQueriesTextNote" },
          `The query text could not be read (${statusText(data.phases.text.status, { message: data.phases.text.message, limits: data.limits })}): the shapes are named by their hash.`));
      }
      h.replace(notes, children);
      notes.hidden = !children.length;
      if (!data || data.status !== "ok" || state.listError) {
        if (!data && !state.listError) h.replace(listView, ns.uiState.block("loading", { label: "Loading the top queries\u2026", compact: true }));
        else h.replace(listView);
        return;
      }
      const queries = data.queries || [];
      if (!queries.length) {
        h.replace(listView, ns.uiState.block("empty", {
          title: "No query in this window",
          body: state.kind !== "all" ? "No query of this kind finished in the window: try All, or a wider window." : "No initial query finished in the window: pick a wider window.",
          compact: true,
          attrs: { id: "systemQueriesEmpty" },
        }));
        return;
      }
      // A refreshed list keeps the focused row (by its hash).
      const focused = document.activeElement instanceof Element && listView.contains(document.activeElement)
        ? document.activeElement.closest("tr[data-hash]")?.dataset.hash || ""
        : "";
      h.replace(listView, listTiles(data), listTable(data, queries));
      if (focused) $(`tr[data-hash="${focused}"]`, listView)?.focus({ preventScroll: true });
    }

    function listTiles(data) {
      const t = data.totals || {};
      const shown = (data.queries || []).length;
      const tone = errorTone(t.errors, t.calls);
      const tiles = [
        { label: "Queries", value: format.count(t.calls || 0), sub: "initial queries finished", attrs: { "data-tile": "calls" } },
        { label: "Shapes", value: format.count(t.shapes || 0), sub: Number(t.shapes) > shown ? `the top ${format.count(shown)} listed` : "normalized queries", attrs: { "data-tile": "shapes" } },
        { label: "Total time", value: ms(t.total_ms), sub: Number(t.calls) > 0 ? `avg ${ms(Number(t.total_ms) / Number(t.calls))}` : "", attrs: { "data-tile": "time" } },
        { label: "Errors", value: format.count(t.errors || 0), sub: Number(t.calls) > 0 ? `${format.percent(Number(t.errors || 0) / Number(t.calls))} of the queries` : "", tone: tone === "neutral" ? "" : tone, attrs: { "data-tile": "errors", "data-error-rate": tone } },
        { label: "Read", value: format.bytes(t.read_bytes || 0), sub: "by these queries", attrs: { "data-tile": "read" } },
      ];
      return h("div", { class: "statTiles statTiles--boxed systemQueries__tiles", role: "group", aria: { label: "Window" } }, tiles.map((item) => ns.ui.statTile(item)));
    }

    // Column priority: "low" columns go under 1280 px, "mid" ones under
    // 900 px; on a phone the query, its calls and total time stay, and the
    // query cell's meta line names the kind, the users and the errors.
    const COLUMNS = [
      { key: "rank", label: "#", num: true, className: "systemQueries__rank" },
      { key: "query", label: "Query", className: "systemQueries__query" },
      { key: "kind", label: "Kind", className: "is-mid" },
      { key: "calls", label: "Calls", num: true, sort: "calls", className: "systemQueries__calls" },
      { key: "errors", label: "Errors", num: true, sort: "errors", className: "is-mid" },
      { key: "total", label: "Total time", num: true, sort: "total_time", className: "systemQueries__total" },
      { key: "avg", label: "Avg", num: true, className: "is-mid" },
      { key: "p95", label: "p95", num: true, sort: "p95", className: "is-mid" },
      { key: "max", label: "Max", num: true, className: "is-low" },
      { key: "rows", label: "Read rows", num: true, className: "is-low" },
      { key: "bytes", label: "Read", num: true, sort: "read_bytes", className: "is-mid" },
      { key: "memory", label: "Memory", num: true, sort: "max_memory", className: "is-mid", title: "Largest memory use of a run" },
      { key: "users", label: "Users", className: "is-mid" },
      { key: "tables", label: "Tables", className: "is-low" },
    ];

    function listTable(data, queries) {
      const head = h("tr", null, COLUMNS.map((column) => {
        const th = h("th", { scope: "col", class: [column.num && "num", column.className], dataset: { col: column.key }, title: column.title || null }, column.label);
        if (column.sort) {
          ns.table.sortHeader(th, {
            key: column.sort,
            dir: state.sort === column.sort ? "desc" : "",
            title: `Sort by ${column.label.toLowerCase()} (the server's top 50)`,
            onSort: (key) => { if (key !== state.sort) setFilter({ sort: key }); },
          });
        }
        return th;
      }));
      const maxTotal = Math.max(0, ...queries.map((item) => Number(item.total_ms) || 0));
      const rows = queries.map((item, index) => {
        const total = h("td", { class: "num systemQueries__total" }, ms(item.total_ms));
        if (queries.length > 1) ns.table.cellBar(total, ns.table.barPercent(Number(item.total_ms) || 0, maxTotal));
        const users = (item.users || []).join(", ");
        const tables = (item.tables || []).join(", ");
        const row = h("tr", { tabindex: "-1", class: { "is-selected": item.hash === state.q }, dataset: { hash: item.hash, kind: item.kind || "" }, aria: { label: `Query shape ${index + 1}` } },
          h("td", { class: "num systemQueries__rank" }, String(index + 1)),
          h("td", { class: "systemQueries__query" }, queryCell(item, users)),
          h("td", { class: "is-mid" }, item.kind || DASH),
          h("td", { class: "num systemQueries__calls" }, format.count(item.calls)),
          h("td", { class: "num is-mid systemQueries__errors" }, errorCell(item.errors, item.calls)),
          total,
          h("td", { class: "num is-mid" }, ms(item.avg_ms)),
          h("td", { class: "num is-mid" }, ms(item.p95_ms)),
          h("td", { class: "num is-low" }, ms(item.max_ms)),
          h("td", { class: "num is-low", title: format.count(item.read_rows) }, format.compact(item.read_rows)),
          h("td", { class: "num is-mid" }, format.bytes(item.read_bytes)),
          h("td", { class: "num is-mid" }, format.bytes(item.max_memory)),
          h("td", { class: "is-mid systemQueries__names", title: users || null }, users || DASH),
          h("td", { class: "is-low systemQueries__names", title: tables || null }, tables || DASH));
        row.addEventListener("click", (event) => {
          if (event.target instanceof Element && event.target.closest("a, button:not(.sqlBlock), input")) return;
          openShape(item.hash);
        });
        return row;
      });
      const table = h("table", { class: "dataTable dataTable--compact systemTable systemQueries__table", id: "systemQueriesTable" },
        h("thead", null, head), h("tbody", null, rows));
      const wrap = h("div", { class: "systemTableWrap systemQueries__wrap" }, table);
      if (!wrap.dataset.roving) {
        wrap.dataset.roving = "1";
        ns.table.rovingRows(wrap, { onOpen: (row) => openShape(row.dataset.hash) });
      }
      return wrap;
    }

    // The normalized text, one line wrapped to two (CSS), its whole text in
    // the title; the shape's hash when the text could not be read.
    function queryCell(item, users) {
      const text = item.has_text ? oneLine(item.normalized || item.example) : "";
      const parts = [];
      if (text) {
        const block = ns.ui.sqlBlock({ sql: text, wrap: true, label: "Normalized query", className: "systemQueries__sql" });
        block.title = item.normalized || text;
        parts.push(block);
      } else {
        parts.push(h("span", { class: "mono systemQueries__hash", title: "normalized_query_hash" }, item.hash));
      }
      const meta = [item.kind || "", users].filter(Boolean).join(SEP);
      parts.push(h("div", { class: "systemQueries__meta" },
        h("span", { class: "systemQueries__metaCalls" }, format.countLabel(item.calls, "call")),
        meta ? h("span", null, meta) : null,
        Number(item.errors) > 0 ? errorCell(item.errors, item.calls) : null));
      return parts;
    }

    // --- Drill-down ------------------------------------------------------------

    function renderDrill() {
      const data = state.drill && state.drill.hash === state.q ? state.drill : null;
      const listed = (state.list?.queries || []).find((item) => item.hash === state.q) || null;
      const back = h("button", { type: "button", class: "button button--small systemQuery__back", id: "systemQueryBack" },
        ns.icon.el("chevron-left", { size: "sm" }), h("span", null, "All queries"));
      back.addEventListener("click", closeShape);
      const hashCopy = ns.ui.copyButton(null, () => state.q, { label: "Copy the query hash", className: "systemQuery__copyHash" });
      const head = h("header", { class: "systemQuery__head" },
        back,
        h("div", { class: "systemQuery__title" },
          h("h3", { class: "systemCard__title" }, "Query shape"),
          h("span", { class: "mono systemQuery__hash", title: "normalized_query_hash" }, state.q), hashCopy,
          (data?.kind || listed?.kind) ? h("span", { class: "systemQuery__kind" }, data?.kind || listed?.kind) : null),
        drillActions(data));
      const children = [head];
      const issue = issueOf(data, state.drillError);
      if (issue) children.push(issue);
      if (!data) {
        if (!state.drillError) children.push(ns.uiState.block("loading", { label: "Loading the query's history\u2026", compact: true }));
        destroyCharts();
        h.replace(drillView, children);
        return;
      }
      if (data.status !== "ok") {
        destroyCharts();
        h.replace(drillView, children);
        return;
      }
      const text = data.normalized || listed?.normalized || "";
      if (text) {
        children.push(ns.ui.sqlBlock({ sql: text, copy: true, wrap: true, maxLines: 6, label: "Normalized query", className: "systemQuery__sql" }));
      }
      if (data.example?.query_id) {
        const latest = (data.runs || []).reduce((best, run) => Math.max(best, Number(run.event_time_ms) || 0), 0);
        children.push(h("p", { class: "systemCard__note systemQuery__example" },
          `Example: the latest run, ${data.example.query_id}${latest && state.order === "latest" ? ` at ${format.time(latest)}` : ""}${data.example.truncated ? " (longer than 256K characters: cut)" : ""}.`));
      }
      if (!Number(data.summary?.calls)) {
        children.push(ns.uiState.block("empty", {
          title: "No run of this shape in the window",
          body: "Pick a wider window, or go back to the list.",
          compact: true,
          attrs: { id: "systemQueryEmpty" },
        }));
        destroyCharts();
        h.replace(drillView, children);
        return;
      }
      children.push(drillTiles(data), drillCharts(), drillRuns(data));
      h.replace(drillView, children);
      drawCharts(data);
    }

    function drillActions(data) {
      const example = data?.example?.text || "";
      const truncated = !!data?.example?.truncated;
      const openExample = h("button", { type: "button", class: "button button--small", id: "systemQueryOpenExample", disabled: !example || truncated,
        title: truncated ? "The latest run's text is longer than 256K characters" : "The latest run's text, formatted, in the Query editor (not run)" }, "Open example in Query");
      openExample.addEventListener("click", async () => {
        if (openExample.disabled) return;
        openExample.disabled = true;
        try {
          await ctx.openSql(example, { formatted: true });
        } catch {
          // The formatter could not parse it (an INSERT with its data): as is.
          try { await ctx.openSql(example, { formatted: false }); } catch (error) { state.drillError = error; render(); }
        }
        openExample.disabled = false;
      });
      const openHistory = h("button", { type: "button", class: "button button--small", id: "systemQueryOpenHistory",
        title: "A query_log SELECT of this shape's runs, in the Query editor (not run)" }, "Open history in Query");
      openHistory.addEventListener("click", async () => {
        const resolved = state.drillResolved || resolveWindow().resolved;
        if (!resolved) return;
        try { await ctx.openSql(historySql(state.q, state.range, resolved), { formatted: false }); } catch (error) { state.drillError = error; render(); }
      });
      return h("div", { class: "systemQuery__actions" }, openExample, openHistory);
    }

    function drillTiles(data) {
      const s = data.summary || {};
      const tone = errorTone(s.errors, s.calls);
      const tiles = [
        { label: "Calls", value: format.count(s.calls || 0), attrs: { "data-tile": "calls" } },
        { label: "Errors", value: format.count(s.errors || 0), sub: Number(s.calls) > 0 ? format.percent(Number(s.errors || 0) / Number(s.calls)) : "", tone: tone === "neutral" ? "" : tone, attrs: { "data-tile": "errors", "data-error-rate": tone } },
        { label: "Total time", value: ms(s.total_ms), sub: `avg ${ms(s.avg_ms)}`, attrs: { "data-tile": "time" } },
        { label: "p95", value: ms(s.p95_ms), sub: `max ${ms(s.max_ms)}`, attrs: { "data-tile": "p95" } },
        { label: "Read", value: format.bytes(s.read_bytes || 0), sub: format.countLabel(s.read_rows || 0, "row"), attrs: { "data-tile": "read" } },
        { label: "Memory", value: format.bytes(s.max_memory || 0), sub: "largest run", attrs: { "data-tile": "memory" } },
        { label: "CPU", value: `${format.number(Number(s.cpu_seconds) || 0)} s`, sub: "CPU time of every run", attrs: { "data-tile": "cpu" } },
      ];
      return h("div", { class: "statTiles statTiles--boxed systemQuery__tiles", role: "group", aria: { label: "This shape in the window" } }, tiles.map((item) => ns.ui.statTile(item)));
    }

    const CHARTS = [
      { id: "calls", title: "Runs", help: "Runs of this shape per bucket: finished and failed." },
      { id: "latency", title: "Duration", help: "Duration of the runs in each bucket: 50th and 95th percentiles." },
      { id: "cpu", title: "CPU", help: "CPU time of the runs per bucket (ProfileEvents OSCPUVirtualTimeMicroseconds); the tooltip adds the rows read and the largest memory use." },
    ];

    function destroyCharts() {
      for (const entry of state.charts.values()) entry.chart?.destroy?.();
      state.charts.clear();
    }

    function drillCharts() {
      destroyCharts();
      const grid = h("div", { class: "systemQuery__charts", id: "systemQueryCharts" });
      for (const spec of CHARTS) {
        const card = h.html(ns.ui.chartCardHtml({
          title: spec.title,
          className: "systemChart",
          id: `systemQueryChart-${spec.id}`,
          bodyClass: "systemChart__body",
          attrs: { "data-chart": spec.id },
        })).firstElementChild;
        $(".chartCard__title", card).title = spec.help;
        const plot = h("div", { class: "systemChart__plot" });
        $(".chartCard__body", card).appendChild(plot);
        grid.appendChild(card);
        state.charts.set(spec.id, { spec, card, plot, meta: $(".chartCard__meta", card), chart: null });
      }
      return grid;
    }

    function column(data, name) {
      const values = data.series?.[name] || [];
      const out = new Float64Array(values.length);
      for (let i = 0; i < values.length; i++) out[i] = values[i] == null ? NaN : Number(values[i]);
      return out;
    }

    // A drag over a chart narrows the section's window, as on Performance.
    function onZoom(windowMs, fromUser) {
      if (!fromUser || !windowMs) return;
      let startMs = Math.floor(windowMs[0] / 1000) * 1000;
      let endMs = Math.ceil(windowMs[1] / 1000) * 1000;
      if (endMs - startMs < MIN_ZOOM_MS) {
        const centre = (startMs + endMs) / 2;
        startMs = Math.floor((centre - MIN_ZOOM_MS / 2) / 1000) * 1000;
        endMs = startMs + MIN_ZOOM_MS;
      }
      applyRange({ from: ns.timeRange.formatDateTime(startMs), to: ns.timeRange.formatDateTime(endMs) });
    }

    function drawCharts(data) {
      const xs = Float64Array.from(data.timestamps || [], Number);
      const step = Number(data.step_seconds || 0) * 1000;
      const calls = column(data, "calls");
      const errors = column(data, "errors");
      const ok = new Float64Array(calls.length);
      for (let i = 0; i < calls.length; i++) ok[i] = calls[i] !== calls[i] ? NaN : Math.max(0, calls[i] - (errors[i] || 0));
      const rows = column(data, "read_rows");
      const memory = column(data, "max_memory");
      const specs = {
        calls: {
          type: "bar",
          stack: true,
          series: [
            { id: "ok", label: "Finished", color: "var(--qchart-1)", values: ok, nulls: null },
            { id: "errors", label: "Failed", color: "var(--danger)", values: errors, nulls: null },
          ],
          value: (v) => format.count(v),
          axis: (max) => { const unit = ns.chartCore.compactUnitFor(max); return { factor: unit.factor, suffix: unit.suffix }; },
          meta: `${format.countLabel(data.summary?.calls || 0, "run")}`,
        },
        latency: {
          type: "line",
          series: [
            { id: "p50", label: "p50", color: "var(--pct-p50)", values: column(data, "p50_ms"), nulls: null },
            { id: "p95", label: "p95", color: "var(--pct-p95)", values: column(data, "p95_ms"), nulls: null },
          ],
          value: (v) => format.duration.fromMs(v),
          axis: (max) => (max >= 1000 ? { factor: 1000, suffix: " s" } : { factor: 1, suffix: " ms" }),
          meta: `p95 ${ms(data.summary?.p95_ms)}`,
        },
        cpu: {
          type: "line",
          series: [{ id: "cpu", label: "CPU time", color: "var(--qchart-2)", values: column(data, "cpu_seconds"), nulls: null }],
          value: (v) => `${format.number(v)} s`,
          axis: () => ({ factor: 1, suffix: " s" }),
          meta: `${format.number(Number(data.summary?.cpu_seconds) || 0)} s in all`,
          footer: (i) => [rows[i] === rows[i] ? `Read ${format.countLabel(rows[i], "row")}` : "", memory[i] === memory[i] ? `memory ${format.bytes(memory[i])}` : ""].filter(Boolean).join(SEP),
        },
      };
      for (const [id, entry] of state.charts) {
        const spec = specs[id];
        ns.util.setMetaLine(entry.meta, spec.meta || "");
        const options = {
          xs,
          xDomain: xs.length > 1 ? [xs[0], xs[xs.length - 1]] : undefined,
          series: spec.series,
          type: spec.type,
          stack: !!spec.stack,
          legend: "always",
          yInclude: [0],
          yUnit: (maxAbs) => spec.axis(maxAbs),
          formatValue: spec.value,
          formatY: spec.value,
          bucketMs: step || undefined,
          tooltipFooter: (i) => [typeof spec.footer === "function" ? spec.footer(i) : "", step ? `${format.duration.fromMs(step)} bucket` : ""].filter(Boolean).join(SEP),
        };
        if (!entry.chart) {
          entry.chart = ns.chartCore.create(entry.plot, { ...options, xKind: "time", height: PLOT_HEIGHT, xFractionDigits: 0, syncKey: SYNC_KEY, legendClick: "toggle", tooltipNulls: false, onZoom });
          entry.chart.root.setAttribute("role", "group");
          entry.chart.root.setAttribute("aria-label", `${entry.spec.title} chart`);
        } else {
          entry.chart.setData({ ...options, zoom: null });
        }
      }
    }

    function drillRuns(data) {
      const order = h("div", { class: "systemQuery__order", id: "systemQueryRunsOrder" });
      ns.segmented.render(order, ORDERS, { attr: "order", value: state.order, size: "compact", label: "Runs order" });
      ns.segmented.bind(order, {
        attr: "order",
        onChange: (value) => {
          state.order = allowed(ORDERS, value, DEFAULTS.order);
          ctx.setQuery(query(), { history: "replace" });
          void loadDrill(false);
          return false;
        },
      });
      const label = ORDERS.find((item) => item.value === state.order)?.label.toLowerCase() || "";
      const runs = data.runs || [];
      const section = h("section", { class: "systemCard systemQuery__runs", dataset: { card: "runs" } },
        h("div", { class: "systemCard__head" },
          h("h3", { class: "systemCard__title" }, "Runs"),
          h("span", { class: "systemCard__count" }, runs.length ? `the ${format.count(runs.length)} ${label}` : ""),
          order));
      if (data.reads?.runs?.status && data.reads.runs.status !== "ok") {
        section.appendChild(h("p", { class: "systemCard__note" }, statusText(data.reads.runs.status, { message: data.reads.runs.message, limits: data.limits })));
        return section;
      }
      const headers = [
        { label: "Time" }, { label: "Duration", num: true }, { label: "Status" },
        { label: "Read rows", num: true, className: "is-mid" }, { label: "Read", num: true, className: "is-mid" },
        { label: "Result rows", num: true, className: "is-low" }, { label: "Memory", num: true, className: "is-mid" },
        { label: "CPU", num: true, className: "is-low" }, { label: "User", className: "is-mid" }, { label: "Query ID", className: "is-low" },
      ];
      const rows = runs.map((run) => {
        const failed = run.type !== "QueryFinish";
        const status = failed
          ? h("td", { class: "systemQuery__status" },
            ns.badge.el(Number(run.exception_code) ? `Error ${run.exception_code}` : "Error", { tone: "error", title: run.type }),
            run.exception ? h("span", { class: "systemQuery__exception", title: run.exception }, run.exception) : null)
          : h("td", { class: "systemQuery__status" }, h("span", { class: "systemQueries__zero" }, "OK"));
        const id = h("td", { class: "is-low mono systemQuery__id", title: run.query_id }, run.query_id);
        return h("tr", { dataset: { queryId: run.query_id, type: run.type } },
          h("td", { class: "systemQuery__time" }, format.time(Number(run.event_time_ms))),
          h("td", { class: "num" }, ms(run.duration_ms)),
          status,
          h("td", { class: "num is-mid", title: format.count(run.read_rows) }, format.compact(run.read_rows)),
          h("td", { class: "num is-mid" }, format.bytes(run.read_bytes)),
          h("td", { class: "num is-low" }, format.count(run.result_rows)),
          h("td", { class: "num is-mid" }, format.bytes(run.memory_usage)),
          h("td", { class: "num is-low" }, format.duration.fromMs(Number(run.cpu_us) / 1000)),
          h("td", { class: "is-mid" }, run.user || DASH),
          id);
      });
      const head = h("tr", null, headers.map((header) => h("th", { scope: "col", class: [header.num && "num", header.className] }, header.label)));
      section.appendChild(h("div", { class: "systemTableWrap" },
        h("table", { class: "dataTable dataTable--compact systemTable systemQuery__table", id: "systemQueryRuns" }, h("thead", null, head), h("tbody", null, rows))));
      return section;
    }

    function resetForHost() {
      state.list = null;
      state.listKey = "";
      state.listError = null;
      state.listLoading = false;
      state.listSerial += 1;
      state.drill = null;
      state.drillKey = "";
      state.drillError = null;
      state.drillLoading = false;
      state.drillSerial += 1;
      destroyCharts();
    }

    return {
      // query: the address's parameters when the address opened the section.
      show(addressQuery) {
        state.active = true;
        if (addressQuery !== undefined) readAddress(addressQuery);
        if (state.host && state.host !== kit.hostId()) resetForHost();
        render();
        void loadVisible(false);
      },
      hide() {
        state.active = false;
        if (picker.isOpen()) picker.close();
      },
      refresh(force = true) {
        if (state.host !== kit.hostId()) resetForHost();
        void loadVisible(force);
      },
      query,
    };
  }

  ns.systemView.register({
    id: "queries",
    label: "Queries",
    order: 30,
    available: (f) => !!f?.enabled && !!f?.top_queries && !!ns.timeRange && !!ns.chartCore,
    create: createQueries,
  });
})();
