const THEME_STORAGE_KEY = "chdash.theme";
const HOST_STORAGE_KEY = "chdash.selectedHost";
const HISTORY_STORAGE_KEY = "chdash.queryHistory.v1";
const RUN_OPTIONS_STORAGE_KEY = "chdash.runOptions.v1";
const EDITOR_STORAGE_KEY = "chdash.editorSql.v1";
// Last page availability reported by /api/version, read by each page's head
// script so the Query / Explorer / Traces switcher is settled at first paint.
const PAGE_NAV_STORAGE_KEY = "chdash.pageNav.v1";
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
  // The older query History (localStorage): app_history.js moves it into IndexedDB once and removes the key.
  queryHistory: HISTORY_STORAGE_KEY,
  runOptions: RUN_OPTIONS_STORAGE_KEY,
  editorSql: EDITOR_STORAGE_KEY,
  pageNav: PAGE_NAV_STORAGE_KEY,
  editorHeight: EDITOR_HEIGHT_PREFIX,
  metaPrefix: META_PREFIX,
  // Session: the SQL the Explorer hands to the Query editor ("Open in Query").
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
  graphLegend: "chdash.graphLegend",
  explorerIncludeSystem: "chdash.explorer.includeSystem",
  explorerIncludeNonStoring: "chdash.explorer.includeNonStoring",
  explorerTypeFilters: "chdash.explorer.typeFilters.v1",
  explorerPreviewLimit: "chdash.explorer.previewLimit",
  // Session: what this tab's Observability pages (Traces, Logs, Metrics) share and leave for a
  // trace's page (storage.observabilityContext).
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
  // Side panels folded to their rail (ns.sidePanel).
  metricsCatalogCollapsed: "chdash.metricsCatalogCollapsed.v1",
  metricsCatalogBy: "chdash.metricsCatalogBy.v1",
});

// Keys no feature reads any more, removed from the browser storage once a
// page loads: the Explorer's side panels have no rail (2026-10), System and
// Logs no live refresh, the query library no import offer (both of its
// roots are browsable at once).
const RETIRED_KEYS = Object.freeze([
  "chdash.explorerTreeCollapsed.v1",
  "chdash.explorerFunctionsCollapsed.v1",
  "chdash.system.autoRefresh",
  "chdash.queryLibrary.importOffer.v1",
]);
for (const key of RETIRED_KEYS) {
  try { localStorage.removeItem(key); } catch { /* blocked storage: nothing to clean */ }
}

// A stored preference: storage.pref(key, fallback, options) -> { get(), set(value), remove() }.
// Reading and writing never throw (private mode, blocked storage, quota):
// get() returns `fallback`, set() does nothing. The fallback's type picks
// how the value is stored, as it always has been for that key:
//   boolean  "1" / "0" ("true" / "false" with text: true; both read)
//   number   its text; get() falls back on a non-number
//   string   as is; `allowed` lists the valid values
//   object   JSON (arrays included); `json: true` for a null fallback
// options: session (sessionStorage), allowed, text, json, legacy (older
// keys read once and moved to `key`), valid(value) (a parsed value check).
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

// The preferences of the application, each one `pref` (above): a read or a write never throws, whatever the storage does.
const themePref = pref(KEYS.theme, "system", { allowed: ["light", "dark", "system"] });
const hostPref = pref(KEYS.selectedHost, "");
const pageNavPref = pref(KEYS.pageNav, null, { json: true });
const runOptionsPref = pref(KEYS.runOptions, null, { json: true });
const editorSqlPref = pref(KEYS.editorSql, "");
// The editor / results split is remembered across sessions; older builds kept it per tab (sessionStorage), still read as a fallback.
const editorHeightPref = pref(KEYS.editorHeight, 0, { valid: (value) => value > 0 });
const editorHeightTabPref = pref(KEYS.editorHeight, 0, { session: true, valid: (value) => value > 0 });
const metaHostsPref = pref(META_HOSTS_KEY, [], { json: true });
// The catalogue of one type of one host: { updated_at_ms, items }.
const metaPref = (hostId, type) => pref(`${META_PREFIX}${String(hostId || "")}.${String(type || "")}`, null, { json: true });

// What the Observability pages (Traces, Logs, Metrics: each a page of its own) share and leave
// for the page of one trace (app_page_trace.js). Each page writes it when it is left
// (app_obs_page.js): the shared time range and service, with a revision each, the revisions
// each view last showed (seen) and each view's last query string (urls), so the next page
// adopts what changed and a view reached from the row restores its filters. A trace's address
// that carries no time range of its own reads range, for its back arrow and its wider search.
// One tab's (sessionStorage), gone with it.
const observabilityContext = pref(KEYS.observabilityContext, { range: null, service: null, rangeRev: 0, serviceRev: 0, seen: {}, urls: {} }, {
  session: true,
  // Only the range is required: a tab that holds { range } alone (written before the pages shared
  // more) is still read, the rest taking its defaults in app_obs_page.js.
  valid: (value) => !!value
    && (value.range === null || (typeof value.range?.from === "string" && typeof value.range?.to === "string"))
    && (value.service == null || typeof value.service === "string")
    && (value.rangeRev == null || Number.isFinite(value.rangeRev)) && (value.serviceRev == null || Number.isFinite(value.serviceRev))
    && (value.seen == null || typeof value.seen === "object") && (value.urls == null || typeof value.urls === "object"),
});

// The host this page touched last: one scan of the storage per host and page, not one per write.
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
      // Execution lookup is intentionally opt-in. It adds a post-run
      // /api/query/execution request and is not needed for normal results.
      executionStats: obj.executionStats === true,
      // Tuple flattening is a presentation preference and is enabled by default.
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

  // The split is one for every host: its height in px, or null.
  loadEditorHeight() {
    return editorHeightPref.get() || editorHeightTabPref.get() || null;
  },

  saveEditorHeight(heightPx) {
    const v = Number(heightPx);
    if (Number.isFinite(v) && v > 0) editorHeightPref.set(Math.round(v));
  },

  // The metadata catalogue of a host (functions, settings, tables...) is a cache: at most META_MAX_HOSTS hosts keep
  // one in localStorage, the least recently used go (their keys are removed), so the cache never takes the room of
  // what the user keeps (the browser library) for a host that was visited once. `chdash.meta.v1.hosts` lists the
  // hosts, the most recent last. Returns the hosts that were evicted.
  touchMetaHost(hostId) {
    const host = String(hostId || "");
    if (!host || host === lastTouchedMetaHost) return [];
    lastTouchedMetaHost = host;
    const known = metaHostsInStorage();
    const order = metaHostsPref.get();
    // Hosts with keys but no place in the list (a page of an older build wrote them) come first, so they go first.
    const listed = (Array.isArray(order) ? order.map(String) : []).filter((id) => known.has(id));
    const unlisted = [...known].filter((id) => !listed.includes(id));
    const next = [...unlisted, ...listed].filter((id) => id !== host).concat(host);
    const evicted = next.slice(0, Math.max(0, next.length - META_MAX_HOSTS));
    for (const id of evicted) storage.removeMetaHost(id);
    metaHostsPref.set(next.slice(evicted.length));
    return evicted;
  },

  // Every metadata key of a host.
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

  // The room of last resort: a write of user data (the library) that the browser refused drops the whole cache first.
  freeMetaSpace() {
    lastTouchedMetaHost = "";
    for (const id of metaHostsInStorage()) storage.removeMetaHost(id);
    metaHostsPref.remove();
  },

  // The cached catalogue of a type of a host, or null.
  readMeta(hostId, type) {
    const obj = metaPref(hostId, type).get();
    if (!obj || typeof obj !== "object") return null;
    if (typeof obj.updated_at_ms !== "number" || !Array.isArray(obj.items)) return null;
    return { updated_at_ms: obj.updated_at_ms, items: obj.items };
  },

  // A cache: a write the browser refuses is dropped after one try with the other hosts' catalogues removed.
  // Returns whether it was stored.
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

// Older builds persisted the complete system.columns payload for every host.
// Removing those entries without parsing them avoids a large startup heap
// spike and migrates users to the table-scoped metadata cache.
storage.removeLegacyColumnMetadata();

const runOpts = storage.loadRunOptions();

// --- Feature flags (features of /api/version) ------------------------------
// The one defaults table: the server's own defaults (server.hpp), used for
// a flag the server did not send (an older server) and until /api/version
// has answered. The Explorer and its views are on, the OpenTelemetry views
// and the server query library off.
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
  query_library: { enabled: false, writable: false },
  // The MCP endpoint (docs/mcp.md): its page is in the page switcher only when it is on.
  mcp: { enabled: false },
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

// /api/version features -> the effective flags (each missing one from the
// defaults table; derived flags as the server computes them).
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
  const libraryEnabled = bool(library.enabled, d.query_library.enabled);
  return {
    explorer: {
      enabled: bool(explorer.enabled, d.explorer.enabled),
      browse: bool(explorer.browse, d.explorer.browse),
      graph: { enabled: bool(graph.enabled, d.explorer.graph.enabled) && (lineage || storageTopology), lineage, storage_topology: storageTopology },
    },
    system: {
      enabled: systemEnabled,
      activity: systemEnabled && bool(system.activity, ds.activity),
      keeper: systemEnabled && bool(system.keeper, ds.keeper),
      top_queries: systemEnabled && bool(system.top_queries, ds.top_queries),
      cluster_fanout: systemEnabled && bool(system.cluster_fanout, ds.cluster_fanout),
      default_lookback_minutes: positive(system.default_lookback_minutes, ds.default_lookback_minutes),
      max_lookback_days: positive(system.max_lookback_days, ds.max_lookback_days),
      query_log_max_lookback_hours: positive(system.query_log_max_lookback_hours, ds.query_log_max_lookback_hours),
      disk_growth_days: positive(system.disk_growth_days, ds.disk_growth_days),
    },
    traces: { enabled: bool(src.traces?.enabled, d.traces.enabled) },
    logs: { enabled: bool(src.logs?.enabled, d.logs.enabled), body_search: String(src.logs?.body_search || d.logs.body_search) },
    metrics: { enabled: bool(src.metrics?.enabled, d.metrics.enabled) },
    query_library: {
      enabled: libraryEnabled,
      writable: libraryEnabled && library.writable === true,
    },
    mcp: { enabled: bool(src.mcp?.enabled, d.mcp.enabled) },
  };
}

let resolveReady = null;
let answered = false;
const ready = new Promise((resolve) => { resolveReady = resolve; });

// ns.features: every read of a feature flag.
//   get(path, fallback)  the flag at "explorer.graph.lineage"; before
//                        /api/version answers, `fallback` when given (a
//                        caller that tries and lets the endpoint say no),
//                        else the defaults table
//   known()              /api/version has answered with its flags
//   ready                Promise, resolved once it has answered or failed
//   on(fn)               fn(features) after every change; returns off()
//   set(raw)             app_ui.js: the features of /api/version
//   DEFAULTS             the defaults table
const features = {
  DEFAULTS: FEATURE_DEFAULTS,
  ready,
  known: () => answered,
  // A copy: a caller that changes what it got changes nothing of the flags.
  get(path, fallback) {
    if (!answered && fallback !== undefined) return fallback;
    const value = lookup(state.features, path);
    if (value !== undefined) return value !== null && typeof value === "object" ? clone(value) : value;
    const preset = lookup(FEATURE_DEFAULTS, path);
    return preset !== undefined ? clone(preset) : fallback;
  },
  // The flags changed: every on(fn) hears it, with the new flags.
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
  // The effective flags (ns.features reads them): the defaults until /api/version answers.
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
