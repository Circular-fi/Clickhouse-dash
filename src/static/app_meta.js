(() => {
  "use strict";

  const ns = window.ChDash;
  if (!ns) return;

  const { api, state, storage } = ns;
  const clientTtlMs = 30 * 60 * 1000;
  const refreshPollMs = 5 * 60 * 1000;
  const maxCachedHosts = 2;
  const maxColumnTablesPerHost = 32;
  const maxColumnsPerHost = 10000;

  const catalogTypes = [
    "keywords",
    "functions",
    "databases",
    "tables",
    "table_functions",
    "formats",
    "settings",
    "data_types",
  ];
  const rawTypes = new Set(catalogTypes.filter((type) => type !== "keywords"));
  const inflight = new Map();
  const activatedHosts = new Set();
  const hydratedHosts = new Set();

  function normalizeType(type) {
    return String(type || "").trim().toLowerCase();
  }

  function normalizeScopePart(value) {
    return String(value || "").trim();
  }

  function columnTableKey(database, table) {
    return `${normalizeScopePart(database)}.${normalizeScopePart(table)}`.toLowerCase();
  }

  function pruneHostMetadata(activeHostId) {
    const hosts = state?.meta?.hosts;
    if (!hosts) return;
    const entries = Object.entries(hosts);
    if (entries.length <= maxCachedHosts) return;
    entries
      .filter(([hostId]) => String(hostId) !== String(activeHostId || ""))
      .sort((a, b) => Number(a[1]?.last_access_ms || 0) - Number(b[1]?.last_access_ms || 0))
      .slice(0, Math.max(0, entries.length - maxCachedHosts))
      .forEach(([hostId]) => {
        delete hosts[hostId];
        activatedHosts.delete(hostId);
        hydratedHosts.delete(hostId);
      });
  }

  function getHostMeta(hostId) {
    const normalizedHostId = String(hostId || "");
    if (!normalizedHostId) return null;
    const root = state.meta;
    if (!root.hosts[normalizedHostId]) root.hosts[normalizedHostId] = Object.create(null);
    const hostMeta = root.hosts[normalizedHostId];
    hostMeta.last_access_ms = Date.now();
    if (!(hostMeta.columnTables instanceof Map)) hostMeta.columnTables = new Map();
    pruneHostMetadata(normalizedHostId);
    return hostMeta;
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
    const tablesByDatabase = new Map();
    for (const table of tables) {
      const databaseKey = String(table.database || "").toLowerCase();
      if (!tablesByDatabase.has(databaseKey)) tablesByDatabase.set(databaseKey, []);
      tablesByDatabase.get(databaseKey).push(table);
    }
    hostMeta.autocomplete = { tablesByDatabase };
  }

  function notifyMetaChanged(hostId) {
    if (String(state.selectedHostId || "") !== String(hostId)) return;
    if (state.highlightCtrl && typeof state.highlightCtrl.refresh === "function") state.highlightCtrl.refresh();
    if (ns.autocomplete && typeof ns.autocomplete.refresh === "function") ns.autocomplete.refresh();
  }

  function applyKeywords(hostId, payload) {
    const data = payload?.data?.keywords;
    if (!data || !Array.isArray(data.items)) return;
    const updatedAt = typeof data.updated_at_ms === "number" ? data.updated_at_ms : 0;
    const items = data.items.map((value) => String(value || "")).filter(Boolean);
    storage.writeMeta(hostId, "keywords", updatedAt, items);

    const hostMeta = getHostMeta(hostId);
    hostMeta.keywords = { updated_at_ms: updatedAt, items, set: new Set(items) };
    notifyMetaChanged(hostId);
  }

  function applyFunctions(hostId, payload) {
    const data = payload?.data?.functions;
    if (!data || !Array.isArray(data.items)) return;

    const updatedAt = typeof data.updated_at_ms === "number" ? data.updated_at_ms : 0;
    const items = data.items
      .map((value) => (value && typeof value === "object" ? value : null))
      .filter(Boolean)
      .map((value) => ({
        name: String(value.name || ""),
        is_aggregate: Boolean(value.is_aggregate),
        case_insensitive: Boolean(value.case_insensitive),
        is_user_defined: Boolean(value.is_user_defined),
        origin: value.origin == null ? "" : String(value.origin),
      }))
      .filter((value) => value.name);

    storage.writeMetaRaw(hostId, "functions", updatedAt, items);

    const hostMeta = getHostMeta(hostId);
    const caseInsensitive = new Set();
    const caseSensitive = new Set();
    const metadata = new Map();
    for (const item of items) {
      metadata.set(item.name, item);
      if (item.case_insensitive) caseInsensitive.add(item.name.toLowerCase());
      else caseSensitive.add(item.name);
    }
    hostMeta.functions = {
      updated_at_ms: updatedAt,
      items,
      ci: caseInsensitive,
      cs: caseSensitive,
      meta: metadata,
    };
    notifyMetaChanged(hostId);
  }

  function applyCatalog(hostId, type, payload) {
    const data = payload?.data?.[type];
    if (!data || !Array.isArray(data.items)) return;
    const updatedAt = typeof data.updated_at_ms === "number" ? data.updated_at_ms : 0;
    const items = data.items.map(normalizeCatalogItem).filter(Boolean);
    storage.writeMetaRaw(hostId, type, updatedAt, items);

    const hostMeta = getHostMeta(hostId);
    hostMeta[type] = { updated_at_ms: updatedAt, items };
    rebuildAutocompleteIndexes(hostMeta);
    notifyMetaChanged(hostId);
  }

  function pruneColumnTables(hostMeta) {
    const cache = hostMeta?.columnTables;
    if (!(cache instanceof Map)) return;
    let totalColumns = 0;
    for (const entry of cache.values()) totalColumns += Array.isArray(entry?.items) ? entry.items.length : 0;
    while (cache.size > maxColumnTablesPerHost || totalColumns > maxColumnsPerHost) {
      const oldest = cache.entries().next();
      if (oldest.done) break;
      const [, entry] = oldest.value;
      totalColumns -= Array.isArray(entry?.items) ? entry.items.length : 0;
      cache.delete(oldest.value[0]);
    }
  }

  function applyScopedColumns(hostId, database, table, payload) {
    const data = payload?.data?.columns;
    if (!data || !Array.isArray(data.items)) return;
    const normalizedDatabase = normalizeScopePart(database);
    const normalizedTable = normalizeScopePart(table);
    if (!normalizedDatabase || !normalizedTable) return;

    const items = data.items
      .map(normalizeCatalogItem)
      .filter(Boolean)
      .map((item) => ({
        ...item,
        database: item.database || normalizedDatabase,
        table: item.table || normalizedTable,
      }));
    const updatedAt = typeof data.updated_at_ms === "number" ? data.updated_at_ms : Date.now();
    const hostMeta = getHostMeta(hostId);
    const key = columnTableKey(normalizedDatabase, normalizedTable);
    hostMeta.columnTables.delete(key);
    hostMeta.columnTables.set(key, { updated_at_ms: updatedAt, items });
    pruneColumnTables(hostMeta);
    notifyMetaChanged(hostId);
  }

  function readClientUpdatedAt(hostId, type) {
    const normalizedType = normalizeType(type);
    const hostMeta = state?.meta?.hosts?.[String(hostId || "")];
    const value = hostMeta && hostMeta[normalizedType];
    return value && typeof value.updated_at_ms === "number" ? value.updated_at_ms : 0;
  }

  function shouldRefresh(hostId, type) {
    const updatedAt = readClientUpdatedAt(hostId, type);
    return !updatedAt || Date.now() - updatedAt > clientTtlMs;
  }

  async function fetchAndStore(hostId, types, scope = null) {
    const normalizedTypes = Array.from(new Set(types.map(normalizeType).filter(Boolean))).sort();
    const database = normalizeScopePart(scope?.database);
    const table = normalizeScopePart(scope?.table);
    const key = `${hostId}::${normalizedTypes.join(",")}::${database}::${table}`;
    if (inflight.has(key)) return inflight.get(key);

    const request = (async () => {
      const payload = await api.getMeta(hostId, normalizedTypes, database && table ? { database, table } : null);
      const requestedTypes = new Set(normalizedTypes);
      if (requestedTypes.has("keywords")) applyKeywords(hostId, payload);
      if (requestedTypes.has("functions")) applyFunctions(hostId, payload);
      for (const type of catalogTypes) {
        if (type !== "keywords" && type !== "functions" && requestedTypes.has(type)) {
          applyCatalog(hostId, type, payload);
        }
      }
      if (requestedTypes.has("columns") && database && table) {
        applyScopedColumns(hostId, database, table, payload);
      }
      return payload;
    })()
      .catch(() => null)
      .finally(() => inflight.delete(key));

    inflight.set(key, request);
    return request;
  }

  function refreshTypes(types) {
    const hostId = state.selectedHostId;
    if (!hostId) return null;
    const neededTypes = types.filter((type) => shouldRefresh(hostId, type));
    if (!neededTypes.length) return null;
    return fetchAndStore(String(hostId), neededTypes);
  }

  function prepareHost(hostId) {
    const normalizedHostId = String(hostId || "");
    if (!normalizedHostId) return null;
    const hostMeta = getHostMeta(normalizedHostId);

    // Delete the old cluster-wide column payload by key only. Never read or
    // parse it: a large system.columns catalog can expand to hundreds of
    // megabytes once represented as JavaScript objects and autocomplete maps.
    storage.removeMeta(normalizedHostId, "columns");
    return hostMeta;
  }

  function activateHost(hostId) {
    const normalizedHostId = String(hostId || "");
    if (!normalizedHostId) return null;
    prepareHost(normalizedHostId);
    activatedHosts.add(normalizedHostId);
    hydrateFromStorage(normalizedHostId);
    scheduleBackgroundRefresh();
    return normalizedHostId;
  }

  function maybeRefreshOnUserAction() {
    const hostId = activateHost(state.selectedHostId);
    if (!hostId) return null;
    return refreshTypes(catalogTypes);
  }

  function maybeRefreshOnLoad() {
    const hostId = String(state.selectedHostId || "");
    if (!hostId || !activatedHosts.has(hostId)) return null;
    return refreshTypes(catalogTypes);
  }

  function getTableColumns(database, table) {
    const hostId = String(state.selectedHostId || "");
    const normalizedDatabase = normalizeScopePart(database);
    const normalizedTable = normalizeScopePart(table);
    if (!hostId || !normalizedDatabase || !normalizedTable) return null;
    const hostMeta = getHostMeta(hostId);
    const key = columnTableKey(normalizedDatabase, normalizedTable);
    const entry = hostMeta.columnTables.get(key);
    if (!entry) return null;
    hostMeta.columnTables.delete(key);
    hostMeta.columnTables.set(key, entry);
    return Array.isArray(entry.items) ? entry.items : [];
  }

  function ensureTableColumns(database, table) {
    const hostId = String(state.selectedHostId || "");
    const normalizedDatabase = normalizeScopePart(database);
    const normalizedTable = normalizeScopePart(table);
    if (!hostId || !normalizedDatabase || !normalizedTable) return null;

    const hostMeta = getHostMeta(hostId);
    const key = columnTableKey(normalizedDatabase, normalizedTable);
    const entry = hostMeta.columnTables.get(key);
    if (entry && Date.now() - Number(entry.updated_at_ms || 0) <= clientTtlMs) {
      hostMeta.columnTables.delete(key);
      hostMeta.columnTables.set(key, entry);
      return Promise.resolve(entry.items);
    }
    return fetchAndStore(hostId, ["columns"], {
      database: normalizedDatabase,
      table: normalizedTable,
    });
  }

  function hydrateFunctions(hostMeta, raw) {
    const caseInsensitive = new Set();
    const caseSensitive = new Set();
    const metadata = new Map();
    const items = [];
    for (const rawItem of raw.items) {
      if (!rawItem || typeof rawItem !== "object") continue;
      const name = String(rawItem.name || "");
      if (!name) continue;
      const item = {
        name,
        is_aggregate: Boolean(rawItem.is_aggregate),
        case_insensitive: Boolean(rawItem.case_insensitive),
        is_user_defined: Boolean(rawItem.is_user_defined),
        origin: rawItem.origin == null ? "" : String(rawItem.origin),
      };
      items.push(item);
      metadata.set(name, item);
      if (item.case_insensitive) caseInsensitive.add(name.toLowerCase());
      else caseSensitive.add(name);
    }
    hostMeta.functions = {
      updated_at_ms: raw.updated_at_ms,
      items,
      ci: caseInsensitive,
      cs: caseSensitive,
      meta: metadata,
    };
  }

  function hydrateFromStorage(hostId) {
    const normalizedHostId = String(hostId || "");
    if (!normalizedHostId || hydratedHosts.has(normalizedHostId)) return;
    const hostMeta = prepareHost(normalizedHostId);
    if (!hostMeta) return;
    hydratedHosts.add(normalizedHostId);

    const keywords = storage.readMeta(normalizedHostId, "keywords");
    if (keywords && Array.isArray(keywords.items) && keywords.items.length) {
      const items = keywords.items.map((value) => String(value || "")).filter(Boolean);
      hostMeta.keywords = { updated_at_ms: keywords.updated_at_ms, items, set: new Set(items) };
    }

    const functions = storage.readMetaRaw(normalizedHostId, "functions");
    if (functions && Array.isArray(functions.items) && functions.items.length) {
      hydrateFunctions(hostMeta, functions);
    }

    for (const type of catalogTypes) {
      if (type === "keywords" || type === "functions") continue;
      const raw = storage.readMetaRaw(normalizedHostId, type);
      if (!raw || !Array.isArray(raw.items) || !raw.items.length) continue;
      hostMeta[type] = {
        updated_at_ms: raw.updated_at_ms,
        items: raw.items.map(normalizeCatalogItem).filter(Boolean),
      };
    }

    rebuildAutocompleteIndexes(hostMeta);
  }

  if (state?.selectedHostId) prepareHost(state.selectedHostId);

  let refreshTimer = 0;

  function scheduleBackgroundRefresh(delay = refreshPollMs) {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = 0;
    const hostId = String(state.selectedHostId || "");
    if (document.hidden || !hostId || !activatedHosts.has(hostId)) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = 0;
      try {
        maybeRefreshOnLoad();
      } catch {
        // A later user action or scheduled refresh will retry.
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
      // A later user action or scheduled refresh will retry.
    }
    scheduleBackgroundRefresh();
  });

  ns.meta = {
    prepareHost,
    activateHost,
    maybeRefreshOnUserAction,
    maybeRefreshOnLoad,
    ensureTableColumns,
    getTableColumns,
    hydrateFromStorage,
    fetchAndStore,
  };
})();
