const THEME_STORAGE_KEY = "chdash.theme";
const HOST_STORAGE_KEY = "chdash.selectedHost";
const HISTORY_STORAGE_KEY = "chdash.queryHistory.v1";
const RUN_OPTIONS_STORAGE_KEY = "chdash.runOptions.v1";
const EDITOR_STORAGE_KEY = "chdash.editorSql.v1";
// The last page availability that /api/version reported. Each page's head script reads it.
// The script settles the Query / Explorer / Traces switcher at first paint.
const PAGE_NAV_STORAGE_KEY = "chdash.pageNav.v1";
// What the header last showed: the version, and the name, version and health of the selected host.
// Each page's head script reads it. A reload paints these values at first paint.
// Without this key, the header shows "--" and "Host" until /api/version and the hosts stream answer.
const HEADER_STORAGE_KEY = "chdash.header.v1";
const EDITOR_HEIGHT_PREFIX = "chdash.editorHeight.v1";
const META_PREFIX = "chdash.meta.v1.";
const META_HOSTS_KEY = `${META_PREFIX}hosts`;
const META_MAX_HOSTS = 2;

// Every chdash.* key of the browser storage (localStorage unless marked
// session), by name: the one list, and the strings never change (a renamed
// key drops what users stored). The page shells' head scripts read a few
// of them before any module runs (theme, pageNav, editor sizes, facets,
// trace analytics).
const KEYS = Object.freeze({
  theme: THEME_STORAGE_KEY,
  selectedHost: HOST_STORAGE_KEY,
  // The older query History (localStorage). app_history.js moves it into IndexedDB once, then removes the key.
  queryHistory: HISTORY_STORAGE_KEY,
  runOptions: RUN_OPTIONS_STORAGE_KEY,
  editorSql: EDITOR_STORAGE_KEY,
  pageNav: PAGE_NAV_STORAGE_KEY,
  header: HEADER_STORAGE_KEY,
  editorHeight: EDITOR_HEIGHT_PREFIX,
  metaPrefix: META_PREFIX,
  // Session: the SQL that the Explorer gives to the Query editor ("Open in Query").
  editorDraft: "chdash.editor.draft.v2",
  // Editor switches ("true" / "false") and their older names.
  autocomplete: "chdash.autocomplete.enabled",
  autocompletePartial: "chdash.autocomplete.partial_match.enabled",
  autocompletePartialLegacy: ["chdash.autocomplete.fuzzy_matching.enabled", "chdash.autocomplete.contains_matches.enabled"],
  editorCopyButton: "chdash.editor.copy_button.enabled",
  editorLineNumbers: "chdash.editor.line_numbers.enabled",
  editorWarnings: "chdash.editor.warnings.enabled",
  editorWarningsLegacy: ["chdash.editor.reference_diagnostics.enabled"],
  editorWarningTables: "chdash.editor.warnings.tables.enabled",
  editorWarningFunctions: "chdash.editor.warnings.functions.enabled",
  editorWarningColumns: "chdash.editor.warnings.columns.enabled",
  queryLibrary: "chdash.queryLibrary.v2",
  queryLibraryUi: "chdash.queryLibrary.ui.v1",
  queryLibraryMenu: "chdash.queryLibraryMenu.v1",
  resultsView: "chdash.results.view",
  chartLegend: "chdash.chart.legendMode",
  chartDetails: "chdash.chart.details",
  graphLegend: "chdash.graphLegend",
  explorerIncludeSystem: "chdash.explorer.includeSystem",
  explorerIncludeNonStoring: "chdash.explorer.includeNonStoring",
  explorerTypeFilters: "chdash.explorer.typeFilters.v1",
  explorerPreviewLimit: "chdash.explorer.previewLimit",
  // Session: the data that the Observability pages of this tab share (Traces, Logs, Metrics).
  // They leave it for the page of a trace (storage.observabilityContext).
  observabilityContext: "chdash.observability.context.v1",
  // Session: the service colour slots (ns.palette), shared by Traces, Logs and Metrics.
  serviceColors: "chdash.traces.serviceColors",
  traceTimeRanges: "chdash.traceTimeRanges.v1",
  traceAnalytics: "chdash.traceAnalytics.v1",
  traceResultsView: "chdash.traceResultsView.v1",
  traceStartDisplay: "chdash.traceStartDisplay.v1",
  traceView: "chdash.traceView",
  traceDurationView: "chdash.traceDurationView.v1",
  traceSpanColumns: "chdash.traceSpanColumns.v1",
  traceLogsPanelOpen: "chdash.traceLogs.panelOpen",
  traceFacetPins: "chdash.traceFacetPins.v1",
  traceFacetsCollapsed: "chdash.traceFacetsCollapsed.v1",
  logsFacetPins: "chdash.logsFacetPins.v1",
  logsFacetsCollapsed: "chdash.logsFacetsCollapsed.v1",
  // Side panels that are folded to their rail (ns.sidePanel).
  metricsCatalogCollapsed: "chdash.metricsCatalogCollapsed.v1",
  metricsCatalogBy: "chdash.metricsCatalogBy.v1",
});

// No feature reads these keys any more. The page removes them from the browser storage when it loads.
// The Explorer's side panels have no rail (2026-10). System and Logs have no live refresh.
// The query library has no import offer, because both of its roots are browsable at once.
const RETIRED_KEYS = Object.freeze([
  "chdash.explorerTreeCollapsed.v1",
  "chdash.explorerFunctionsCollapsed.v1",
  "chdash.system.autoRefresh",
  "chdash.queryLibrary.importOffer.v1",
]);
for (const key of RETIRED_KEYS) {
  try { localStorage.removeItem(key); } catch { /* blocked storage: nothing to clean */ }
}

// A stored preference: storage.pref(key, fallback, options) returns { get(), set(value), remove() }.
// A read or a write never throws. This is true in private mode, with blocked storage and when the quota is full.
// When the storage fails, get() returns `fallback` and set() does nothing.
// The type of the fallback picks how the value is stored. This is the same rule as before, for each key:
//   boolean  "1" / "0" ("true" / "false" with text: true; both are read)
//   number   its text; get() falls back on a non-number
//   string   as it is; `allowed` lists the valid values
//   object   JSON (arrays included); `json: true` for a null fallback
// options: session (sessionStorage), allowed, text, json, legacy (older
// keys: each is read once and moved to `key`), valid(value) (a check of the parsed value).
function pref(key, fallback, options = {}) {
  const store = () => (options.session ? window.sessionStorage : window.localStorage);
  const kind = options.json ? "json" : typeof fallback === "boolean" ? "bool" : typeof fallback === "number" ? "number" : fallback !== null && typeof fallback === "object" ? "json" : "string";
  const encode = (value) => {
    if (kind === "bool") return options.text ? (value ? "true" : "false") : (value ? "1" : "0");
    if (kind === "json") return JSON.stringify(value);
    return String(value);
  };
  const decode = (raw) => {
    if (raw == null) return undefined;
    if (kind === "bool") return raw === "1" || raw === "true" ? true : raw === "0" || raw === "false" ? false : undefined;
    if (kind === "number") return raw.trim() !== "" && Number.isFinite(Number(raw)) ? Number(raw) : undefined;
    if (kind === "json") {
      try { return JSON.parse(raw); } catch { return undefined; }
    }
    return Array.isArray(options.allowed) && !options.allowed.includes(raw) ? undefined : raw;
  };
  const valid = (value) => value !== undefined && (typeof options.valid !== "function" || options.valid(value));
  const read = (name) => {
    try { return store().getItem(name); } catch { return null; }
  };
  const handle = {
    key,
    get() {
      let value = decode(read(key));
      if (value === undefined && Array.isArray(options.legacy)) {
        for (const older of options.legacy) {
          const legacy = decode(read(older));
          if (legacy !== undefined) { handle.set(legacy); value = legacy; break; }
        }
      }
      return valid(value) ? value : fallback;
    },
    // true once stored; false when the browser refused (the page keeps its state).
    set(value) {
      try { store().setItem(key, encode(value)); return true; } catch { return false; }
    },
    remove() {
      try { store().removeItem(key); } catch { /* nothing to remove */ }
    },
  };
  return handle;
}

// The preferences of the application. Each one is made by `pref` (above). A read or a write never throws, whatever the storage does.
const themePref = pref(KEYS.theme, "system", { allowed: ["light", "dark", "system"] });
const hostPref = pref(KEYS.selectedHost, "");
const pageNavPref = pref(KEYS.pageNav, null, { json: true });
const headerPref = pref(KEYS.header, null, { json: true });
const runOptionsPref = pref(KEYS.runOptions, null, { json: true });
const editorSqlPref = pref(KEYS.editorSql, "");
// The split between the editor and the results is kept across sessions. Older builds kept it per tab (sessionStorage).
// The app still reads that value as a fallback.
const editorHeightPref = pref(KEYS.editorHeight, 0, { valid: (value) => value > 0 });
const editorHeightTabPref = pref(KEYS.editorHeight, 0, { session: true, valid: (value) => value > 0 });
const metaHostsPref = pref(META_HOSTS_KEY, [], { json: true });
// The catalogue of one type of one host: { updated_at_ms, items }.
const metaPref = (hostId, type) => pref(`${META_PREFIX}${String(hostId || "")}.${String(type || "")}`, null, { json: true });

// The state that the Observability pages share (Traces, Logs and Metrics). Each page is a page of its own.
// The state is for the page of one trace (app_page_trace.js). A page writes the state when the user leaves it (app_obs_page.js).
// The state holds the shared time range and service, with a revision for each one.
// It also holds the revisions that each view last showed (seen), and the last query string of each view (urls).
// So the next page takes what changed. A view that the row opens restores its filters.
// The address of a trace that has no time range of its own reads range. The back arrow and the wider search use it.
// The state is kept in sessionStorage. It lasts for one tab only.
const observabilityContext = pref(KEYS.observabilityContext, { range: null, service: null, rangeRev: 0, serviceRev: 0, seen: {}, urls: {} }, {
  session: true,
  // Only the range is required. A tab that holds { range } alone is still read. This is true for a tab that an older build wrote,
  // before the pages shared more. The other values take their defaults in app_obs_page.js.
  valid: (value) => !!value
    && (value.range === null || (typeof value.range?.from === "string" && typeof value.range?.to === "string"))
    && (value.service == null || typeof value.service === "string")
    && (value.rangeRev == null || Number.isFinite(value.rangeRev)) && (value.serviceRev == null || Number.isFinite(value.serviceRev))
    && (value.seen == null || typeof value.seen === "object") && (value.urls == null || typeof value.urls === "object"),
});

// The host that this page touched last. The page scans the storage once for each host and page, not once for each write.
let lastTouchedMetaHost = "";

// The hosts that have metadata keys in localStorage (`chdash.meta.v1.<host>.<type>`).
function metaHostsInStorage() {
  const hosts = new Set();
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key || !key.startsWith(META_PREFIX) || key === META_HOSTS_KEY) continue;
      const rest = key.slice(META_PREFIX.length);
      const dot = rest.lastIndexOf(".");
      if (dot > 0) hosts.add(rest.slice(0, dot));
    }
  } catch {
    return hosts;
  }
  return hosts;
}

const storage = {
  KEYS,
  pref,
  observabilityContext,
  THEME_STORAGE_KEY,
  HOST_STORAGE_KEY,
  HISTORY_STORAGE_KEY,
  RUN_OPTIONS_STORAGE_KEY,
  EDITOR_STORAGE_KEY,
  PAGE_NAV_STORAGE_KEY,
  EDITOR_HEIGHT_PREFIX,
  META_PREFIX,

  getSavedThemeMode() {
    return themePref.get();
  },

  setSavedThemeMode(mode) {
    themePref.set(String(mode));
  },

  loadPageNav() {
    const obj = pageNavPref.get();
    if (!obj || typeof obj !== "object") return null;
    return { explorer: obj.explorer !== false, system: obj.system !== false, traces: obj.traces === true, logs: obj.logs === true, metrics: obj.metrics === true, mcp: obj.mcp === true };
  },

  savePageNav(nav) {
    pageNavPref.set({ explorer: nav?.explorer !== false, system: nav?.system !== false, traces: nav?.traces === true, logs: nav?.logs === true, metrics: nav?.metrics === true, mcp: nav?.mcp === true });
  },

  loadHeader() {
    const obj = headerPref.get();
    return obj && typeof obj === "object" ? obj : null;
  },

  saveHeader(value) {
    headerPref.set(value);
  },

  getStoredHostId() {
    return hostPref.get() || null;
  },

  setStoredHostId(hostId) {
    hostPref.set(String(hostId || ""));
  },

  loadRunOptions() {
    const obj = runOptionsPref.get();
    if (!obj || typeof obj !== "object") {
      return { autoFormat: true, multiQuery: false, executionStats: false, flattenTuple: true };
    }
    return {
      autoFormat: !!obj.autoFormat,
      multiQuery: !!obj.multiQuery,
      // The execution lookup is opt-in. It adds a request to /api/query/execution after a run.
      // Normal results do not need it.
      executionStats: obj.executionStats === true,
      // Tuple flattening is a display preference. It is on by default.
      flattenTuple: obj.flattenTuple !== false,
    };
  },

  saveRunOptions({ autoFormat, multiQuery, executionStats, flattenTuple }) {
    runOptionsPref.set({
      autoFormat: !!autoFormat,
      multiQuery: !!multiQuery,
      executionStats: !!executionStats,
      flattenTuple: flattenTuple !== false,
    });
  },

  loadEditorSql() {
    return editorSqlPref.get();
  },

  saveEditorSql(sqlText) {
    editorSqlPref.set(String(sqlText ?? ""));
  },

  // There is one split for every host. Its height is in px, or null.
  loadEditorHeight() {
    return editorHeightPref.get() || editorHeightTabPref.get() || null;
  },

  saveEditorHeight(heightPx) {
    const v = Number(heightPx);
    if (Number.isFinite(v) && v > 0) editorHeightPref.set(Math.round(v));
  },

  // The metadata catalogue of a host (functions, settings, tables...) is a cache. At most META_MAX_HOSTS hosts keep
  // one in localStorage. The least recently used hosts go first, and their keys are removed.
  // The cache never takes the room that the browser library needs. This is true even for a host that was visited once.
  // `chdash.meta.v1.hosts` lists the hosts, the most recent last. The function returns the hosts that were evicted.
  touchMetaHost(hostId) {
    const host = String(hostId || "");
    if (!host || host === lastTouchedMetaHost) return [];
    lastTouchedMetaHost = host;
    const known = metaHostsInStorage();
    const order = metaHostsPref.get();
    // Hosts that have keys but no place in the list come first. An older build wrote their keys. So these hosts go first.
    const listed = (Array.isArray(order) ? order.map(String) : []).filter((id) => known.has(id));
    const unlisted = [...known].filter((id) => !listed.includes(id));
    const next = [...unlisted, ...listed].filter((id) => id !== host).concat(host);
    const evicted = next.slice(0, Math.max(0, next.length - META_MAX_HOSTS));
    for (const id of evicted) storage.removeMetaHost(id);
    metaHostsPref.set(next.slice(evicted.length));
    return evicted;
  },

  // Remove every metadata key of a host.
  removeMetaHost(hostId) {
    const prefix = `${META_PREFIX}${String(hostId || "")}.`;
    try {
      const keys = [];
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (key && key.startsWith(prefix) && !key.slice(prefix.length).includes(".")) keys.push(key);
      }
      for (const key of keys) localStorage.removeItem(key);
    } catch {
      return;
    }
  },

  // The last resort for room. When the browser refuses a write of user data (the library), this drops the whole cache first.
  freeMetaSpace() {
    lastTouchedMetaHost = "";
    for (const id of metaHostsInStorage()) storage.removeMetaHost(id);
    metaHostsPref.remove();
  },

  // The cached catalogue of a type of a host. It returns null when no catalogue is cached.
  readMeta(hostId, type) {
    const obj = metaPref(hostId, type).get();
    if (!obj || typeof obj !== "object") return null;
    if (typeof obj.updated_at_ms !== "number" || !Array.isArray(obj.items)) return null;
    return { updated_at_ms: obj.updated_at_ms, items: obj.items };
  },

  // This is a cache. When the browser refuses a write, the function removes the catalogues of the other hosts and tries once more.
  // It returns whether the value was stored.
  writeMeta(hostId, type, updatedAtMs, items) {
    const entry = metaPref(hostId, type);
    const payload = { updated_at_ms: Number(updatedAtMs) || 0, items: Array.isArray(items) ? items : [] };
    storage.touchMetaHost(hostId);
    if (entry.set(payload)) return true;
    for (const id of metaHostsInStorage()) if (id !== String(hostId)) storage.removeMetaHost(id);
    return entry.set(payload);
  },

  removeMeta(hostId, type) {
    metaPref(hostId, type).remove();
  },

  removeLegacyColumnMetadata() {
    try {
      const keys = [];
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (key && key.startsWith(META_PREFIX) && key.endsWith(".columns")) keys.push(key);
      }
      for (const key of keys) localStorage.removeItem(key);
    } catch {
      return;
    }
  },
};

// Older builds saved the complete system.columns payload for every host.
// The app removes these entries without parsing them. This avoids a large spike of the heap at start.
// The users then move to the metadata cache that is scoped to each table.
storage.removeLegacyColumnMetadata();

const runOpts = storage.loadRunOptions();

// --- Feature flags (features of /api/version) ------------------------------
// This is the one table of defaults. It holds the defaults of the server (server.hpp).
// The app uses them for a flag that the server did not send, for example from an older server.
// The app also uses them until /api/version answers. The Explorer and its views are on.
// The OpenTelemetry views and the server query library are off.
const FEATURE_DEFAULTS = Object.freeze({
  explorer: {
    enabled: true,
    browse: true,
    graph: { enabled: true, lineage: true, storage_topology: true },
  },
  system: {
    enabled: true, activity: true, keeper: true, top_queries: true, cluster_fanout: false,
    default_lookback_minutes: 60, max_lookback_days: 30, query_log_max_lookback_hours: 168, disk_growth_days: 7,
  },
  traces: { enabled: false },
  logs: { enabled: false, body_search: "token" },
  metrics: { enabled: false },
  query_library: { enabled: false, writable: false, libraries: [] },
  // The MCP endpoint (docs/mcp.md). Its page appears in the page switcher only when it is on.
  mcp: { enabled: false },
  // The access of humans (docs/access.md). In the authzen mode, this holds the decisions of the PDP for the user, by action, and the
  // decisions on each host that the user can see (hosts: { "<host>": { "<action>": true|false } }, null when the server sends none).
  // The flags above already mean "on and allowed". The allows(name) function reads one decision.
  access: { mode: "open", subject: "", actions: {}, hosts: null },
});

const clone = (value) => JSON.parse(JSON.stringify(value));

function lookup(root, path) {
  let value = root;
  for (const part of String(path || "").split(".").filter(Boolean)) {
    if (value == null || typeof value !== "object") return undefined;
    value = value[part];
  }
  return value;
}

const bool = (value, fallback) => (typeof value === "boolean" ? value : fallback);

// Convert the features of /api/version to the effective flags. A flag that is missing takes its value from the
// defaults table. Derived flags are computed as the server computes them.
function normalizeFeatures(raw) {
  const d = FEATURE_DEFAULTS;
  const src = raw && typeof raw === "object" ? raw : {};
  const explorer = src.explorer || {};
  const graph = explorer.graph || {};
  const lineage = bool(graph.lineage, d.explorer.graph.lineage);
  const storageTopology = bool(graph.storage_topology, d.explorer.graph.storage_topology);
  const system = src.system || {};
  const ds = d.system;
  const systemEnabled = bool(system.enabled, ds.enabled);
  const positive = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback);
  const library = src.query_library || {};
  const access = normalizeAccess(src.access);
  const allowed = (name) => allowsAction(access, name);
  const libraryEnabled = bool(library.enabled, d.query_library.enabled) && allowed("library.read");
  const libraryWritable = allowed("library.write");
  const observabilityAllowed = allowed("observability.read");
  const mcpAllowed = allowed("mcp.keys.read") || allowed("mcp.usage.read");
  return {
    explorer: {
      enabled: bool(explorer.enabled, d.explorer.enabled),
      browse: bool(explorer.browse, d.explorer.browse),
      graph: { enabled: bool(graph.enabled, d.explorer.graph.enabled) && (lineage || storageTopology), lineage, storage_topology: storageTopology },
    },
    system: {
      enabled: systemEnabled && allowed("system.read"),
      activity: systemEnabled && allowed("system.read") && bool(system.activity, ds.activity),
      keeper: systemEnabled && allowed("system.read") && bool(system.keeper, ds.keeper),
      top_queries: systemEnabled && allowed("system.read") && bool(system.top_queries, ds.top_queries),
      cluster_fanout: systemEnabled && allowed("system.read") && bool(system.cluster_fanout, ds.cluster_fanout),
      default_lookback_minutes: positive(system.default_lookback_minutes, ds.default_lookback_minutes),
      max_lookback_days: positive(system.max_lookback_days, ds.max_lookback_days),
      query_log_max_lookback_hours: positive(system.query_log_max_lookback_hours, ds.query_log_max_lookback_hours),
      disk_growth_days: positive(system.disk_growth_days, ds.disk_growth_days),
    },
    traces: { enabled: bool(src.traces?.enabled, d.traces.enabled) && observabilityAllowed },
    logs: { enabled: bool(src.logs?.enabled, d.logs.enabled) && observabilityAllowed, body_search: String(src.logs?.body_search || d.logs.body_search) },
    metrics: { enabled: bool(src.metrics?.enabled, d.metrics.enabled) && observabilityAllowed },
    // libraries: every library of the server. The first one is the default library. Each one is { name, writable }.
    query_library: {
      enabled: libraryEnabled,
      writable: libraryEnabled && libraryWritable && library.writable === true,
      libraries: libraryEnabled && Array.isArray(library.libraries)
        ? library.libraries.filter((item) => item && typeof item.name === "string" && item.name).map((item) => ({ name: item.name, writable: libraryWritable && item.writable === true }))
        : [],
    },
    mcp: { enabled: bool(src.mcp?.enabled, d.mcp.enabled) && mcpAllowed },
    access,
  };
}

// The access part of /api/version (docs/access.md): { mode, subject, actions: { "<action>": true|false },
// hosts: { "<host>": { "<action>": true|false } } }. An action is true when the user may use it on the service or on one host.
function normalizeAccess(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const actions = {};
  if (src.actions && typeof src.actions === "object") {
    for (const [name, value] of Object.entries(src.actions)) actions[name] = value === true;
  }
  let hosts = null;
  if (src.hosts && typeof src.hosts === "object" && !Array.isArray(src.hosts)) {
    hosts = {};
    for (const [host, decisions] of Object.entries(src.hosts)) {
      const own = {};
      if (decisions && typeof decisions === "object") {
        for (const [name, value] of Object.entries(decisions)) own[name] = value === true;
      }
      hosts[host] = own;
    }
  }
  return { mode: src.mode === "authzen" ? "authzen" : "open", subject: typeof src.subject === "string" ? src.subject : "", actions, hosts };
}

// The actions that let a page work on a host (the name is the data-page of the body of the shell). A page that is not in the table
// is not tied to a host (the MCP pages): every host passes.
const PAGE_HOST_ACTIONS = Object.freeze({
  query: ["query.run.read", "query.run.write"],
  explorer: ["explorer.read"],
  observability: ["observability.read"],
  trace: ["observability.read"],
  system: ["system.read"],
  shape: ["system.read"],
});

// It returns whether the host picker of the page `page` shows the host `hostId`. The open mode, and a server that sends no decisions by
// host, show every host. In the authzen mode, the page needs one of its actions on that host. The server checks each route again.
function hostAllowed(access, hostId, page) {
  if (!access || access.mode !== "authzen" || !access.hosts) return true;
  const actions = PAGE_HOST_ACTIONS[String(page || "")];
  if (!actions) return true;
  const decisions = access.hosts[String(hostId)];
  return !!decisions && actions.some((name) => decisions[name] === true);
}

// It returns whether the user may do `name`. The open mode always allows it. The authzen mode allows it only when the PDP said true.
// The server checks each action again on its routes. This function only hides what the user cannot do.
function allowsAction(access, name) {
  if (!access || access.mode !== "authzen") return true;
  return access.actions[name] === true;
}

// The pages that the server let this human use when it served the page (the meta element chdash-pages, docs/access.md "Navigation").
// app_header.js gives them (features.servePages). null: the server named no list (the open mode), so every page is allowed.
let served = null;
const servedPages = () => served;

// Whether the page `name` is on and allowed: query, explorer, observability, system, mcp-keys or mcp-usage. A link or a button that
// leads to another page shows only when it gives true. The server checks each page and each route again.
function pageAllowed(features, name) {
  const served = servedPages();
  if (served && !served.has(name)) return false;
  const allowed = (action) => allowsAction(features.access, action);
  switch (name) {
    case "query": return allowed("query.run.read") || allowed("query.run.write");
    case "explorer": return features.explorer.enabled && allowed("explorer.read");
    case "observability": return features.traces.enabled || features.logs.enabled || features.metrics.enabled;
    case "system": return features.system.enabled;
    case "mcp-keys": return features.mcp.enabled && allowed("mcp.keys.read");
    case "mcp-usage": return features.mcp.enabled && allowed("mcp.usage.read");
    default: return false;
  }
}

let resolveReady = null;
let answered = false;
const ready = new Promise((resolve) => { resolveReady = resolve; });

// ns.features: every read of a feature flag. The members are:
//   get(path, fallback)  the flag at "explorer.graph.lineage". Before
//                        /api/version answers, it returns `fallback` when a
//                        fallback is given. A caller can use this to try the
//                        endpoint and let it refuse. Otherwise it returns the
//                        value from the defaults table.
//   known()              /api/version has answered with its flags
//   ready                Promise. It is resolved when the answer arrives or when the request fails.
//   on(fn)               fn(features) runs after every change. It returns off().
//   set(raw)             app_ui.js: it sets the features of /api/version.
//   allows(name)         the decision for one action of the access of humans.
//                        The open mode always allows it.
//   hostAllowed(id, page)  the host picker of the page `page` (the data-page of the body) shows the host `id`.
//   page(name)           the page (query, explorer, observability, system, mcp-keys, mcp-usage) is on and the
//                        human may use it: a link to another page shows only then.
//   servePages(text)     app_header.js: the pages that the server allowed for this render (meta chdash-pages).
//   DEFAULTS             the defaults table
const features = {
  DEFAULTS: FEATURE_DEFAULTS,
  ready,
  known: () => answered,
  // This returns a copy. If a caller changes the copy, the flags do not change.
  get(path, fallback) {
    if (!answered && fallback !== undefined) return fallback;
    const value = lookup(state.features, path);
    if (value !== undefined) return value !== null && typeof value === "object" ? clone(value) : value;
    const preset = lookup(FEATURE_DEFAULTS, path);
    return preset !== undefined ? clone(preset) : fallback;
  },
  // The decision of the PDP for one action. An action name has dots, so get() cannot read it.
  allows: (name) => allowsAction(state.features.access, name),
  hostAllowed: (hostId, page) => hostAllowed(state.features.access, hostId, page),
  page: (name) => pageAllowed(state.features, name),
  // The list of the meta element chdash-pages (space-separated page names), or null/undefined when the page has none.
  servePages(text) {
    served = typeof text === "string" ? new Set(text.split(/\s+/).filter(Boolean)) : null;
  },
  // The flags changed. Every on(fn) listener receives the new flags.
  set(raw) {
    state.features = normalizeFeatures(raw);
    answered = true;
    window.dispatchEvent(new CustomEvent("chdash:features-changed", { detail: state.features }));
    return state.features;
  },
  markLoaded() {
    if (state.featuresLoaded) return;
    state.featuresLoaded = true;
    resolveReady(state.features);
  },
  on(fn) {
    if (typeof fn !== "function") return () => {};
    const listener = (event) => fn(event?.detail || state.features);
    window.addEventListener("chdash:features-changed", listener);
    return () => window.removeEventListener("chdash:features-changed", listener);
  },
};

const state = {
  hostsSnapshot: null,
  selectedHostId: storage.getStoredHostId(),
  apiOnline: true,
  // The effective flags. ns.features reads them. The defaults apply until /api/version answers.
  features: clone(FEATURE_DEFAULTS),
  featuresLoaded: false,
  suppressResultsVisibility: false,

  runOptAutoFormat: runOpts.autoFormat,
  runOptMultiQuery: runOpts.multiQuery,
  runOptExecutionStats: runOpts.executionStats,
  runOptFlattenTuple: runOpts.flattenTuple,

  isFormatting: false,
  isRunning: false,
  isBatchRun: false,
  batchStopRequested: false,
  batchProgressLabel: "",

  activeQueryId: null,
  cancelToken: null,

  lastRunMode: "single",

  meta: { version: 1, hosts: Object.create(null) },
  highlightCtrl: null,
  editorSizeCtrl: null,
};

export { storage };
export { state };
Object.freeze(features);
export { features };
