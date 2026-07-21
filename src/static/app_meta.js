(() => {
  "use strict";

  const ns = window.ChDash;
  if (!ns) return;

  const { api, state, storage } = ns;
  const clientTtlMs = 30 * 60 * 1000;
  const refreshPollMs = 5 * 60 * 1000;

  const baseTypes = [
    "keywords",
    "functions",
    "databases",
    "tables",
    "columns",
    "table_functions",
    "formats",
    "settings",
    "data_types",
  ];

  // The complete columns catalog can dwarf every other metadata payload on a
  // busy cluster. Load it only when the editor actually needs relation-aware
  // completion; all lighter catalogs remain eager.
  const eagerTypes = baseTypes.filter((t) => t !== "columns");
  const rawTypes = new Set(baseTypes.filter((t) => t !== "keywords"));
  const inflight = new Map();

  function normalizeType(t) {
    return String(t || "").trim().toLowerCase();
  }

  function getHostMeta(hostId) {
    const h = String(hostId || "");
    if (!h) return null;
    const root = state.meta;
    if (!root.hosts[h]) root.hosts[h] = Object.create(null);
    return root.hosts[h];
  }

  function normalizeCatalogItem(raw) {
    if (raw == null) return null;
    if (typeof raw === "string") {
      const name = String(raw || "");
      return name ? { name } : null;
    }
    if (typeof raw !== "object") return null;
    const item = {
      name: String(raw.name || ""),
      database: raw.database == null ? "" : String(raw.database),
      table: raw.table == null ? "" : String(raw.table),
      type: raw.type == null ? "" : String(raw.type),
      detail: raw.detail == null ? "" : String(raw.detail),
      parent: raw.parent == null ? "" : String(raw.parent),
    };
    return item.name ? item : null;
  }

  function rebuildAutocompleteIndexes(hostMeta) {
    if (!hostMeta) return;

    const tables = Array.isArray(hostMeta.tables?.items) ? hostMeta.tables.items : [];
    const columns = Array.isArray(hostMeta.columns?.items) ? hostMeta.columns.items : [];

    const tablesByDatabase = new Map();
    for (const t of tables) {
      const db = String(t.database || "");
      const key = db.toLowerCase();
      if (!tablesByDatabase.has(key)) tablesByDatabase.set(key, []);
      tablesByDatabase.get(key).push(t);
    }

    const columnsByTable = new Map();
    for (const c of columns) {
      const db = String(c.database || "");
      const table = String(c.table || "");
      const key = `${db}.${table}`.toLowerCase();
      if (!columnsByTable.has(key)) columnsByTable.set(key, []);
      columnsByTable.get(key).push(c);
    }

    hostMeta.autocomplete = { tablesByDatabase, columnsByTable };
  }

  function notifyMetaChanged(hostId) {
    if (String(state.selectedHostId || "") !== String(hostId)) return;
    if (state.highlightCtrl && typeof state.highlightCtrl.refresh === "function") state.highlightCtrl.refresh();
    if (ns.autocomplete && typeof ns.autocomplete.refresh === "function") ns.autocomplete.refresh();
  }

  function applyKeywords(hostId, payload) {
    const data = payload && payload.data && payload.data.keywords ? payload.data.keywords : null;
    if (!data || !Array.isArray(data.items)) return;
    const updatedAt = typeof data.updated_at_ms === "number" ? data.updated_at_ms : 0;
    const items = data.items.map((x) => String(x || "")).filter((x) => x);
    storage.writeMeta(hostId, "keywords", updatedAt, items);

    const hostMeta = getHostMeta(hostId);
    hostMeta.keywords = { updated_at_ms: updatedAt, items, set: new Set(items) };
    notifyMetaChanged(hostId);
  }

  function applyFunctions(hostId, payload) {
    const data = payload && payload.data && payload.data.functions ? payload.data.functions : null;
    if (!data || !Array.isArray(data.items)) return;

    const updatedAt = typeof data.updated_at_ms === "number" ? data.updated_at_ms : 0;
    const items = data.items
      .map((x) => (x && typeof x === "object" ? x : null))
      .filter(Boolean)
      .map((x) => ({
        name: String(x.name || ""),
        is_aggregate: Boolean(x.is_aggregate),
        case_insensitive: Boolean(x.case_insensitive),
        is_user_defined: Boolean(x.is_user_defined),
        origin: x.origin == null ? "" : String(x.origin),
      }))
      .filter((x) => x.name);

    storage.writeMetaRaw(hostId, "functions", updatedAt, items);

    const hostMeta = getHostMeta(hostId);
    const ci = new Set();
    const cs = new Set();
    const meta = new Map();
    for (const it of items) {
      meta.set(it.name, it);
      if (it.case_insensitive) ci.add(it.name.toLowerCase());
      else cs.add(it.name);
    }
    hostMeta.functions = { updated_at_ms: updatedAt, items, ci, cs, meta };
    notifyMetaChanged(hostId);
  }

  function applyCatalog(hostId, type, payload) {
    const data = payload && payload.data && payload.data[type] ? payload.data[type] : null;
    if (!data || !Array.isArray(data.items)) return;
    const updatedAt = typeof data.updated_at_ms === "number" ? data.updated_at_ms : 0;
    const items = data.items.map(normalizeCatalogItem).filter(Boolean);
    storage.writeMetaRaw(hostId, type, updatedAt, items);

    const hostMeta = getHostMeta(hostId);
    hostMeta[type] = { updated_at_ms: updatedAt, items };
    rebuildAutocompleteIndexes(hostMeta);
    notifyMetaChanged(hostId);
  }

  function readClientUpdatedAt(hostId, type) {
    const t = normalizeType(type);
    const v = rawTypes.has(t) ? storage.readMetaRaw(hostId, t) : storage.readMeta(hostId, t);
    return v && typeof v.updated_at_ms === "number" ? v.updated_at_ms : 0;
  }

  function shouldRefresh(hostId, type) {
    const updatedAt = readClientUpdatedAt(hostId, type);
    if (!updatedAt) return true;
    const age = Date.now() - updatedAt;
    return age > clientTtlMs;
  }

  async function fetchAndStore(hostId, types) {
    const normalizedTypes = Array.from(new Set(types.map(normalizeType).filter(Boolean))).sort();
    const key = `${hostId}::${normalizedTypes.join(",")}`;
    if (inflight.has(key)) return inflight.get(key);

    const p = (async () => {
      const payload = await api.getMeta(hostId, normalizedTypes);
      const tset = new Set(normalizedTypes);
      if (tset.has("keywords")) applyKeywords(hostId, payload);
      if (tset.has("functions")) applyFunctions(hostId, payload);
      for (const t of baseTypes) {
        if (t !== "keywords" && t !== "functions" && tset.has(t)) applyCatalog(hostId, t, payload);
      }
      return payload;
    })()
      .catch(() => null)
      .finally(() => inflight.delete(key));

    inflight.set(key, p);
    return p;
  }

  function refreshTypes(types) {
    const hostId = state.selectedHostId;
    if (!hostId) return null;
    const need = types.filter((t) => shouldRefresh(hostId, t));
    if (!need.length) return null;
    return fetchAndStore(String(hostId), need);
  }

  function maybeRefreshOnUserAction() {
    return refreshTypes(eagerTypes);
  }

  function maybeRefreshOnLoad() {
    return refreshTypes(eagerTypes);
  }

  function ensureColumns() {
    return refreshTypes(["columns"]);
  }

  function hydrateFunctions(hostMeta, raw) {
    const ci = new Set();
    const cs = new Set();
    const meta = new Map();
    const items = [];
    for (const rawItem of raw.items) {
      if (!rawItem || typeof rawItem !== "object") continue;
      const name = String(rawItem.name || "");
      if (!name) continue;
      const it = {
        name,
        is_aggregate: Boolean(rawItem.is_aggregate),
        case_insensitive: Boolean(rawItem.case_insensitive),
        is_user_defined: Boolean(rawItem.is_user_defined),
        origin: rawItem.origin == null ? "" : String(rawItem.origin),
      };
      items.push(it);
      meta.set(name, it);
      if (it.case_insensitive) ci.add(name.toLowerCase());
      else cs.add(name);
    }
    hostMeta.functions = { updated_at_ms: raw.updated_at_ms, items, ci, cs, meta };
  }

  function hydrateFromStorage(hostId) {
    const h = String(hostId || "");
    if (!h) return;
    const hostMeta = getHostMeta(h);

    const kw = storage.readMeta(h, "keywords");
    if (kw && Array.isArray(kw.items) && kw.items.length) {
      const items = kw.items.map((x) => String(x || "")).filter((x) => x);
      hostMeta.keywords = { updated_at_ms: kw.updated_at_ms, items, set: new Set(items) };
    }

    const fn = storage.readMetaRaw(h, "functions");
    if (fn && Array.isArray(fn.items) && fn.items.length) hydrateFunctions(hostMeta, fn);

    for (const t of baseTypes) {
      if (t === "keywords" || t === "functions") continue;
      const raw = storage.readMetaRaw(h, t);
      if (!raw || !Array.isArray(raw.items) || !raw.items.length) continue;
      hostMeta[t] = { updated_at_ms: raw.updated_at_ms, items: raw.items.map(normalizeCatalogItem).filter(Boolean) };
    }

    rebuildAutocompleteIndexes(hostMeta);
  }

  if (state && state.selectedHostId) hydrateFromStorage(state.selectedHostId);

  let refreshTimer = 0;

  function scheduleBackgroundRefresh(delay = refreshPollMs) {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = 0;
    if (document.hidden) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = 0;
      try {
        maybeRefreshOnLoad();
      } catch {
      }
      scheduleBackgroundRefresh();
    }, delay);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = 0;
      return;
    }
    try {
      maybeRefreshOnLoad();
    } catch {
    }
    scheduleBackgroundRefresh();
  });

  scheduleBackgroundRefresh();

  ns.meta = { maybeRefreshOnUserAction, maybeRefreshOnLoad, ensureColumns, hydrateFromStorage, fetchAndStore };
})();
