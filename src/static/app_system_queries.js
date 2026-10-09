(() => {
  "use strict";

  // The System page's Queries section (docs/system.md "Queries"): the top
  // query shapes of a window on the selected server, modelled on Query
  // Insights. /api/system/queries reads system.query_log with the
  // RUNNER account (ClickHouse grants decide: the Query page can read the
  // same rows) in two phases: the narrow numbers grouped by
  // normalized_query_hash, then the text of the top 50 only. The filters
  // (kind, errors, user, database, table) and the order are the server's
  // allowlists (the user, the database and the table bound query
  // parameters; a shape is kept whole when one of its runs involved the
  // database or the table); the System page's own reads are never listed,
  // and "Hide ChDash" (on by default) drops the system account's queries.
  // "Order by" and the sortable column headers are one setting: either
  // changes the other. No Auto-refresh: a window is read once, cached a
  // minute by the server.
  //
  // A row opens the shape as a page of its own (shape.html,
  // /system/queries/<hash>, app_shape_page.js; ctx.shape is its hash and the
  // section shows nothing else): its timeline (runs, latency, CPU) and its 20
  // slowest, latest or largest runs, from /api/system/queries/<hash>. "All
  // queries" returns to the list; the former /system/queries?q=<hash> opens
  // the shape's page. "Open example in Query"
  // puts the latest run's text in the Query editor; "Open history in Query"
  // a ready-made query_log SELECT of that shape. Neither runs.
  //
  // Address: from / to (the Observability range format; the default hour
  // writes neither), sort, kind, errors, user, database, table
  // ("database.table", as query_log names it), hide=0 and, on a shape's page,
  // runs=<order>; the list's parameters stay on the shape's address, so the
  // way back is the same list. Query text is drawn by ui.sqlBlock (the highlighter
  // escapes), never as markup.

  const ns = window.ChDash;
  if (!ns) return;

  // --- The shape's SQL, formatted ---------------------------------------------
  // A shape's text is normalizeQuery's: its literals are ? (a list ?..),
  // which no SQL parser accepts. The Query page's formatter (/api/format,
  // ns.api.formatSqls) gets a numeric literal in their place (a normalized
  // query has no number of its own), and they come back after; the AS
  // column the formatter aligned keeps its alignment. Quoted text and
  // comments are left alone.
  const MASK_BASE = 90900;
  const MASK_MAX = 9000;
  const MASK_TOKEN = /(?<![\w.$])9\d{4}(?![\w.])/g;

  function skipQuoted(sql, start) {
    const quote = sql[start];
    let i = start + 1;
    while (i < sql.length) {
      if (sql[i] === "\\") { i += 2; continue; }
      if (sql[i] === quote) {
        if (sql[i + 1] === quote) { i += 2; continue; }
        return i + 1;
      }
      i += 1;
    }
    return sql.length;
  }

  // { sql, marks } with marks[k] the placeholder (? or ?..) of the literal
  // MASK_BASE + k, or null when the text cannot be masked (too many
  // placeholders, or a number in the masks' range already in it).
  function maskPlaceholders(sql) {
    const text = String(sql || "");
    const marks = [];
    let out = "";
    let i = 0;
    while (i < text.length) {
      const c = text[i];
      let end = i;
      if (c === "'" || c === '"' || c === "`") end = skipQuoted(text, i);
      else if (c === "-" && text[i + 1] === "-") end = text.indexOf("\n", i) < 0 ? text.length : text.indexOf("\n", i);
      else if (c === "/" && text[i + 1] === "*") end = text.indexOf("*/", i + 2) < 0 ? text.length : text.indexOf("*/", i + 2) + 2;
      if (end > i) {
        out += text.slice(i, end);
        i = end;
        continue;
      }
      if (c === "?") {
        const list = text.startsWith("?..", i);
        if (marks.length >= MASK_MAX) return null;
        out += String(MASK_BASE + marks.length);
        marks.push(list ? "?.." : "?");
        i += list ? 3 : 1;
        continue;
      }
      out += c;
      i += 1;
    }
    MASK_TOKEN.lastIndex = 0;
    if (MASK_TOKEN.test(text)) return null;
    return { sql: out, marks };
  }

  // The formatted text with its placeholders back, or null when the
  // formatter did not keep every one of them exactly once.
  function restorePlaceholders(formatted, marks) {
    const seen = new Array(marks.length).fill(0);
    const lines = String(formatted || "").split("\n").map((line) => {
      let removed = 0;
      const restored = line.replace(MASK_TOKEN, (token) => {
        const k = Number(token) - MASK_BASE;
        if (!(k >= 0 && k < marks.length)) return token;
        seen[k] += 1;
        removed += token.length - marks[k].length;
        return marks[k];
      });
      // The formatter padded the expressions before their AS to one column:
      // the shorter placeholder gives the width back to that padding.
      return removed > 0 ? restored.replace(/(\S)( {2,})(AS )/, (all, before, pad, as) => `${before}${pad}${" ".repeat(removed)}${as}`) : restored;
    });
    if (seen.some((count) => count !== 1)) return null;
    return lines.join("\n");
  }

  ns.systemQuerySql = Object.freeze({ maskPlaceholders, restorePlaceholders });
  if (!ns.systemView) return;
  const { h } = ns;
  const { $, $$ } = ns.dom;
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

  // The server's allowlists (src/system_monitor.cpp), with their labels:
  // "Order by" lists the sorts in this order, always the largest first.
  const SORTS = [
    { value: "calls", label: "Calls", title: "Number of runs" },
    { value: "total_time", label: "Total time", title: "Sum of the durations (query_duration_ms of ClickHouse)" },
    { value: "avg", label: "Avg", title: "Average duration" },
    { value: "p95", label: "p95", title: "95th percentile of the duration" },
    { value: "max", label: "Max", title: "Longest run" },
    { value: "errors", label: "Errors", title: "Failed runs" },
    { value: "read_rows", label: "Read rows", title: "Rows read" },
    { value: "read_bytes", label: "Read bytes", title: "Bytes read" },
    { value: "max_memory", label: "Memory", title: "Largest memory use of a run" },
  ];
  const ERRORS = [
    { value: "all", label: "All" },
    { value: "with", label: "With errors", title: "The shapes with at least one failed run" },
    { value: "without", label: "Without errors", title: "The shapes whose every run finished" },
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
  const DEFAULTS = { sort: "total_time", kind: "all", errors: "all", order: "duration" };
  // The server's bound on a user filter value (kMonitorQueryUserMaxBytes).
  const USER_MAX = 256;
  const validUser = (value) => {
    const text = String(value || "");
    return !!text && new TextEncoder().encode(text).length <= USER_MAX && !/[\u0000-\u001f\u007f]/.test(text);
  };
  // The server's bounds on a database / table filter value
  // (kMonitorQueryObjectMaxBytes); a table is "database.table" (either name
  // may hold dots).
  const OBJECT_MAX = 512;
  const validDatabase = (value) => {
    const text = String(value || "");
    return !!text && new TextEncoder().encode(text).length <= OBJECT_MAX && !/[\u0000-\u001f\u007f]/.test(text);
  };
  const validTable = (value) => {
    const text = String(value || "");
    const dot = text.indexOf(".");
    return validDatabase(text) && dot > 0 && dot < text.length - 1;
  };
  const counted = (list, valid) => (Array.isArray(list) ? list : [])
    .filter((item) => valid(item?.name)).map((item) => ({ name: String(item.name), calls: Number(item.calls) || 0 }));

  const settings = () => kit.features() || {};
  const maxMinutes = () => Math.max(1, Number(settings().query_log_max_lookback_hours) || 168) * 60;
  const defaultRange = () => ({ from: `now-${ns.timeRange.minutesToSpan(Math.min(maxMinutes(), Number(settings().default_lookback_minutes) || 60))}`, to: "now" });
  const sameRange = (a, b) => String(a?.from || "") === String(b?.from || "") && String(a?.to || "") === String(b?.to || "");
  const allowed = (list, value, fallback) => (list.some((item) => item.value === value) ? value : fallback);
  const oneLine = (sql) => String(sql || "").replace(/\s+/g, " ").trim();
  // A statement kind as SQL writes it ("SELECT", "INSERT"), the casing of the
  // kind filter: query_log's query_kind says "Select".
  const kindLabel = (kind) => String(kind || "").toUpperCase();
  // CPU time in seconds, in the one duration format ("107 ms", "1.2 s").
  const cpuText = (value) => (Number(value) > 0 ? format.duration.fromSeconds(Number(value)) : "0 s");
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
    // One shape's page (shape.html): the section shows the shape ctx.shape.
    const shapeMode = !!ctx.shape;
    const state = {
      range: defaultRange(),
      sort: DEFAULTS.sort,
      kind: DEFAULTS.kind,
      errors: DEFAULTS.errors,
      user: "",
      // The user filter's choices: the users of the last list read for
      // every user (a list filtered by one user names only that one).
      users: [],
      // One database and / or one table ("database.table") the shapes
      // involve; their choices, from the last list read without that filter.
      database: "",
      table: "",
      databases: [],
      tables: [],
      hide: true,
      q: shapeMode ? ctx.shape : "",
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
      // host|hash|text -> "pending" | { text } (formatted, "" when the
      // formatter could not parse it).
      formatted: new Map(),
      rawSql: false,
      pending: false,
    };

    // --- Chrome: the filter bar ----------------------------------------------
    // The time range, then Kind, Errors, User, Database, Table and Order by
    // as the bar's "Label \u00b7 Value" pickers (ns.menu.select over native
    // selects), Hide ChDash as a toggle chip, then the refresh button. A change
    // applies at once. No Auto-refresh: a window is read once, cached a
    // minute by the server.
    const option = (item) => h("option", { value: item.value, title: item.title || null }, item.label);
    const kindSelect = h("select", { id: "systemQueriesKind", aria: { label: "Statement kind" }, dataset: { fieldLabel: "Kind" } }, KINDS.map(option));
    const errorsSelect = h("select", { id: "systemQueriesErrors", aria: { label: "Errors" }, dataset: { fieldLabel: "Errors" } }, ERRORS.map(option));
    const userSelect = h("select", { id: "systemQueriesUser", aria: { label: "User" }, dataset: { fieldLabel: "User" } });
    const databaseSelect = h("select", { id: "systemQueriesDatabase", aria: { label: "Database" }, dataset: { fieldLabel: "Database" } });
    const tableSelect = h("select", { id: "systemQueriesTableFilter", aria: { label: "Table" }, dataset: { fieldLabel: "Table" } });
    const orderSelect = h("select", { id: "systemQueriesOrder", aria: { label: "Order by" }, dataset: { fieldLabel: "Order by" } }, SORTS.map(option));
    renderUserOptions();
    renderObjectOptions();
    const controls = kit.sectionBar(ctx, {
      id: "queries",
      label: "the top queries",
      range: "systemQueries",
      onRefresh: () => void refresh(true),
      fields: [
        { select: kindSelect, pickerClass: "systemQueries__kindPicker" },
        { select: errorsSelect, pickerClass: "systemQueries__errorsPicker" },
        { select: userSelect, pickerClass: "systemQueries__userPicker" },
        // The tail, so the lead keeps one row down to 761 px.
        { select: databaseSelect, pickerClass: "systemQueries__databasePicker", tail: true },
        { select: tableSelect, pickerClass: "systemQueries__tablePicker", tail: true },
        // An order, not a filter: the phone summary does not count it.
        { select: orderSelect, pickerClass: "systemQueries__orderPicker", summary: false, tail: true },
      ],
      chips: [{
        id: "systemQueriesHide",
        label: "Hide ChDash",
        title: "Leave out the queries of ChDash's system account (the Catalog, health checks). The System page's own reads are never listed.",
        pressed: true,
        onChange: (on) => setFilter({ hide: on }),
      }],
    });
    const pickerRoot = controls.rangeRoot;
    // A shape's page: the section's bar is not in the page; its time range and
    // refresh button live in the shape's head (shapeTools, systemQuery__head).
    // A bar's own classes style them (the pickers' look is the bar's), so the
    // tools are a bar of their own, bare of the bar's chrome (CSS).
    const shapeTools = shapeMode ? h("div", { class: "systemQuery__tools traceSearchBar obsFilterBar" }, pickerRoot.parentElement, controls.button) : null;
    if (shapeMode) {
      controls.button.type = "button";
      controls.button.addEventListener("click", () => void refresh(true));
    }
    const [kindMenu, errorsMenu, userMenu, databaseMenu, tableMenu, orderMenu] = controls.pickers;
    // Six pickers and a chip: the bar takes its two rows from 1279 px down.
    controls.bar.classList.add("obsFilterBar--wide");
    const [hideChip] = controls.chips;
    // A pick fires the select's change event (syncFilters sets them quietly).
    kindSelect.addEventListener("change", () => setFilter({ kind: allowed(KINDS, kindSelect.value, DEFAULTS.kind) }));
    errorsSelect.addEventListener("change", () => setFilter({ errors: allowed(ERRORS, errorsSelect.value, DEFAULTS.errors) }));
    userSelect.addEventListener("change", () => setFilter({ user: validUser(userSelect.value) ? userSelect.value : "" }));
    // A database narrows the tables: a table of another database goes.
    databaseSelect.addEventListener("change", () => {
      const database = validDatabase(databaseSelect.value) ? databaseSelect.value : "";
      setFilter({ database, table: database && state.table && !state.table.startsWith(`${database}.`) ? "" : state.table });
    });
    tableSelect.addEventListener("change", () => setFilter({ table: validTable(tableSelect.value) ? tableSelect.value : "" }));
    orderSelect.addEventListener("change", () => setFilter({ sort: allowed(SORTS, orderSelect.value, DEFAULTS.sort) }));
    // The filters of the list (not the range, not the action).
    const filterParts = () => [...controls.pickers.map((menu) => menu.field), hideChip];

    const notes = h("div", { class: "systemQueries__notes", id: "systemQueriesNotes" });
    const listView = h("div", { class: "systemQueries__list", id: "systemQueriesList" });
    const drillView = h("section", { class: "systemQuery", id: "systemQuery", hidden: true, aria: { label: "Query shape" } });
    const body = h("div", { class: ["systemQueries", shapeMode && "systemQueries--shape"], id: "systemQueries" }, notes, listView, drillView);
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
      if (state.errors !== DEFAULTS.errors) params.set("errors", state.errors);
      if (state.user) params.set("user", state.user);
      if (state.database) params.set("database", state.database);
      if (state.table) params.set("table", state.table);
      if (!state.hide) params.set("hide", "0");
      if (state.q && state.order !== DEFAULTS.order) params.set("runs", state.order);
      return params.toString();
    }

    function readAddress(text) {
      const params = new URLSearchParams(String(text || ""));
      state.range = ns.timeRange.url.read(params) || defaultRange();
      state.sort = allowed(SORTS, params.get("sort") || "", DEFAULTS.sort);
      state.kind = allowed(KINDS, params.get("kind") || "", DEFAULTS.kind);
      state.errors = allowed(ERRORS, params.get("errors") || "", DEFAULTS.errors);
      const user = params.get("user") || "";
      state.user = validUser(user) ? user : "";
      const database = params.get("database") || "";
      state.database = validDatabase(database) ? database : "";
      const table = params.get("table") || "";
      state.table = validTable(table) ? table : "";
      state.hide = params.get("hide") !== "0";
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

    // The user picker's options: every user, then the window's users (their
    // query counts in the label), the chosen one kept when the last list did
    // not name it.
    function renderUserOptions() {
      const users = state.users.slice();
      if (state.user && !users.some((item) => item.name === state.user)) users.unshift({ name: state.user, calls: null });
      h.replace(userSelect,
        h("option", { value: "" }, "All"),
        users.map((item) => h("option", { value: item.name }, item.calls == null ? item.name : `${item.name} (${format.count(item.calls)})`)));
      userSelect.value = state.user;
    }

    // The database and table pickers' options: All, then the window's
    // databases / tables ("database.table", narrowed to the chosen
    // database), most involved first, with their run counts; the chosen one
    // kept when the last list did not name it.
    function renderObjectOptions() {
      const label = (item) => (item.calls == null ? item.name : `${item.name} (${format.count(item.calls)})`);
      const databases = state.databases.slice();
      if (state.database && !databases.some((item) => item.name === state.database)) databases.unshift({ name: state.database, calls: null });
      h.replace(databaseSelect, h("option", { value: "" }, "All"), databases.map((item) => h("option", { value: item.name }, label(item))));
      databaseSelect.value = state.database;
      const tables = state.tables.filter((item) => !state.database || item.name.startsWith(`${state.database}.`));
      if (state.table && !tables.some((item) => item.name === state.table)) tables.unshift({ name: state.table, calls: null });
      h.replace(tableSelect, h("option", { value: "" }, "All"), tables.map((item) => h("option", { value: item.name }, label(item))));
      tableSelect.value = state.table;
    }

    function syncFilters() {
      kindMenu?.set?.(state.kind);
      errorsMenu?.set?.(state.errors);
      renderUserOptions();
      userMenu?.refresh?.();
      renderObjectOptions();
      databaseMenu?.refresh?.();
      tableMenu?.refresh?.();
      orderMenu?.set?.(state.sort);
      hideChip.set(state.hide);
      // The filters and the order are the list's (a shape has one kind); they
      // change nothing a missing log or grant would allow. The range and the
      // refresh button stay.
      const off = !!state.q || ["disabled", "not_granted", "unsupported", "readonly_account"].includes(state.list?.status);
      for (const part of filterParts()) if (part) part.hidden = off;
    }

    // A row opens the shape's page, with the list's parameters.
    function openShape(hash) {
      if (!HASH_RE.test(String(hash))) return;
      ctx.openShape(String(hash));
    }

    // "All queries": the list the shape was opened from.
    function closeShape() {
      ctx.back();
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
      return [kit.hostId(), Math.floor(resolved.startMs / 60000), Math.ceil(resolved.endMs / 60000), state.sort, state.kind, state.errors, state.hide ? 1 : 0, state.user, state.database, state.table].join("\u0000");
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
        data = await ns.api.getSystemQueries(host, { fromMs: resolved.startMs, toMs: resolved.endMs, sort: state.sort, kind: state.kind, errors: state.errors, user: state.user, database: state.database, table: state.table, hideChdash: state.hide }, force);
      } catch (e) {
        failure = e;
      }
      if (serial !== state.listSerial || kit.hostId() !== host) return;
      state.listLoading = false;
      state.host = host;
      state.list = data;
      state.listError = failure;
      state.listResolved = resolved;
      // A list of every user names the user filter's choices.
      if (data?.status === "ok" && !data.user && Array.isArray(data.users)) {
        state.users = data.users.filter((item) => validUser(item?.name)).map((item) => ({ name: String(item.name), calls: Number(item.calls) || 0 }));
      }
      // A list for every database names the database choices; one for every
      // table the table choices (narrowed to the chosen database on show).
      if (data?.status === "ok" && !data.database && Array.isArray(data.databases)) state.databases = counted(data.databases, validDatabase);
      if (data?.status === "ok" && !data.table && Array.isArray(data.tables)) state.tables = counted(data.tables, validTable);
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
      ensureHighlighterMeta();
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
          body: state.kind !== "all" || state.errors !== "all" || state.user || state.database || state.table
            ? "No query matches these filters in the window: try All, or a wider window."
            : "No initial query finished in the window: pick a wider window.",
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
      { key: "avg", label: "Avg", num: true, sort: "avg", className: "is-mid" },
      { key: "p95", label: "p95", num: true, sort: "p95", className: "is-mid" },
      { key: "max", label: "Max", num: true, sort: "max", className: "is-low" },
      { key: "rows", label: "Read rows", num: true, sort: "read_rows", className: "is-low" },
      { key: "bytes", label: "Read", num: true, sort: "read_bytes", className: "is-mid", title: "Bytes read" },
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
            title: `Order by ${(SORTS.find((item) => item.value === column.sort)?.label || column.label).toLowerCase()} (the server's top 50)`,
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
          h("td", { class: "is-mid" }, item.kind ? kindLabel(item.kind) : DASH),
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
      const wrap = h("div", { class: "dataTableWrap systemQueries__wrap" }, table);
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
      const meta = [kindLabel(item.kind), users].filter(Boolean).join(SEP);
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
      // The trace page's arrow (.pageBack): back to the list the shape was opened from.
      const back = h("button", { type: "button", class: "pageBack", id: "systemQueryBack", aria: { label: "Back to the list of queries" }, title: "Back to the queries" },
        ns.icon.el("arrow-left", { size: "lg" }));
      back.addEventListener("click", closeShape);
      const text = data?.normalized || listed?.normalized || "";
      // The tab names the shape (its first words) among the others of the browser.
      if (shapeMode && text) {
        const line = oneLine(text);
        document.title = `${line.length > 70 ? `${line.slice(0, 69)}\u2026` : line} \u00b7 Query shape`;
      }
      // The query is drawn right under the head: no title of its own. Its hash
      // names the shape only when its text could not be read.
      const head = h("header", { class: "systemQuery__head" },
        back,
        !text && (data || state.drillError) ? h("span", { class: "mono systemQuery__hash", title: "normalized_query_hash" }, state.q) : null,
        shapeTools,
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
      const sql = text ? shapeSql(state.q, text) : null;
      if (!Number(data.summary?.calls)) {
        if (sql) children.push(sql);
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
      // The query, its figures and its charts: on a wide screen (CSS) the figures take the right
      // side, beside the query and the charts; otherwise one under the other.
      children.push(h("div", { class: "systemQuery__top" }, sql, drillTiles(data), drillCharts()), drillRuns(data));
      h.replace(drillView, children);
      drawCharts(data);
    }

    // The shape's SQL, formatted as the Query page's Format button would
    // (the raw text until the formatter answers, and when it cannot parse
    // it). Its copy button gives the text shown.
    function shapeSqlBlock(text, formatted) {
      // Line numbers, like the Query editor's (so no wrapping: a wrapped line would shift them). A
      // long query scrolls inside its block; Raw shows the normalized text as query_log has it.
      const shown = state.rawSql ? text : formatted || text;
      const block = ns.ui.sqlBlock({ sql: shown, gutter: true, copy: true, maxLines: 14, expand: false, label: state.rawSql ? "Normalized query (raw)" : "Normalized query", className: "systemQuery__sql" });
      const isFormatted = !state.rawSql && !!formatted;
      block.dataset.formatted = isFormatted ? "1" : "0";
      return h("div", { class: "systemQuery__sqlWrap", id: "systemQuerySql", dataset: { formatted: isFormatted ? "1" : "0", raw: state.rawSql ? "1" : "0" } }, block);
    }

    function shapeSql(hash, text) {
      const key = `${kit.hostId()}|${hash}|${text}`;
      const cached = state.formatted.get(key);
      if (cached && cached !== "pending") return shapeSqlBlock(text, cached.text);
      const block = shapeSqlBlock(text, "");
      if (!cached) {
        if (state.formatted.size > 200) state.formatted.clear();
        state.formatted.set(key, "pending");
        void formatShapeSql(text).then((formatted) => {
          state.formatted.set(key, { text: formatted });
          if (state.q !== hash || !formatted || state.rawSql) return;
          const current = $("#systemQuerySql", drillView);
          if (current && current.dataset.formatted !== "1") current.replaceWith(shapeSqlBlock(text, formatted));
        });
      }
      return block;
    }

    async function formatShapeSql(text) {
      const masked = maskPlaceholders(text);
      if (!masked) return "";
      try {
        const out = await ns.api.formatSqls(kit.hostId(), [masked.sql]);
        const formatted = String(out?.[0] || "").trim();
        return formatted ? restorePlaceholders(formatted, masked.marks) || "" : "";
      } catch {
        return "";
      }
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
      // Formatted | Raw: the shared segmented control. Formatted is the default; Raw shows the
      // normalized text unchanged (its literals are ?).
      const view = h("div", { id: "systemQueryView", class: "systemQuery__view" });
      ns.segmented.render(view, [
        { value: "formatted", label: "Formatted", title: "Show the normalized query formatted, as the Query page's Format button does" },
        { value: "raw", label: "Raw", title: "Show the normalized query as query_log has it, without the formatter" },
      ], { attr: "sqlView", value: state.rawSql ? "raw" : "formatted", size: "compact", label: "Query text" });
      ns.segmented.bind(view, { attr: "sqlView", onChange: (mode) => {
        state.rawSql = mode === "raw";
        const text = data?.normalized || (state.list?.queries || []).find((item) => item.hash === state.q)?.normalized || "";
        const current = $("#systemQuerySql", drillView);
        if (current && text) current.replaceWith(shapeSql(state.q, text));
      } });
      return h("div", { class: "systemQuery__actions" }, view, openExample, openHistory);
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
        { label: "CPU", value: cpuText(s.cpu_seconds), sub: "CPU time of every run", attrs: { "data-tile": "cpu" } },
      ];
      return h("div", { class: "statTiles statTiles--boxed systemQuery__tiles", role: "group", aria: { label: "This shape in the window" } }, tiles.map((item) => ns.ui.statTile(item)));
    }

    const CHARTS = [
      { id: "calls", title: "Runs", help: "Runs of this shape per bucket: finished and failed." },
      { id: "latency", title: "Duration", help: "Duration of the runs in each bucket: 50th and 95th percentiles. A duration is the query_duration_ms of ClickHouse: it ends when ClickHouse has sent its last block, and it includes the time ClickHouse waits for a slow client." },
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
          value: (v) => cpuText(v),
          // Milliseconds under a second ("10 ms" rather than "0.010 s").
          axis: (max) => (max >= 1 ? { factor: 1, suffix: " s" } : { factor: 0.001, suffix: " ms" }),
          meta: `${cpuText(data.summary?.cpu_seconds)} in all`,
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
          // A few runs are dots: room above the largest one.
          yHeadroom: 0.15,
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
      section.appendChild(h("div", { class: "dataTableWrap" },
        h("table", { class: "dataTable dataTable--compact systemTable systemQuery__table", id: "systemQueryRuns" }, h("thead", null, head), h("tbody", null, rows))));
      return section;
    }

    // The highlighter colours function names and keywords from the host's lists
    // (ns.meta, as on the Query page): a shape's page asks for them (the cached
    // copy at once, the server's when missing) and repaints its SQL when they
    // arrive (chdash:meta-changed).
    function ensureHighlighterMeta() {
      const hostId = kit.hostId();
      if (!hostId || !ns.meta) return;
      ns.meta.hydrateFromStorage?.(hostId);
      const host = ns.state.meta?.hosts?.[hostId];
      const missing = ["functions", "keywords"].filter((type) => !host?.[type]);
      if (missing.length) void ns.meta.fetchAndStore?.(hostId, missing);
    }

    if (shapeMode) {
      window.addEventListener("chdash:meta-changed", () => {
        for (const code of $$("#systemQuerySql .sqlBlock__code", drillView)) ns.highlight?.renderInto?.(code, code.textContent || "");
      });
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
      // Another server, other users, databases and tables.
      state.users = [];
      state.databases = [];
      state.tables = [];
      destroyCharts();
    }

    return {
      // query: the address's parameters when the address opened the section.
      show(addressQuery) {
        state.active = true;
        if (addressQuery !== undefined) {
          readAddress(addressQuery);
          // The former address of a shape, /system/queries?q=<hash>: its page.
          const former = new URLSearchParams(String(addressQuery || "")).get("q") || "";
          if (!shapeMode && HASH_RE.test(former)) {
            ctx.openShape(former, { replace: true });
            return;
          }
        }
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
