(() => {
  "use strict";

  const ns = window.ChDash;
  if (!ns) return;

  const THEME_STORAGE_KEY = "chdash.theme";
  const HOST_STORAGE_KEY = "chdash.selectedHost";
  const HISTORY_STORAGE_KEY = "chdash.queryHistory.v1";
  const SAVED_QUERIES_STORAGE_KEY = "chdash.savedQueries.v1";
  const RUN_OPTIONS_STORAGE_KEY = "chdash.runOptions.v1";
  const EDITOR_STORAGE_KEY = "chdash.editorSql.v1";
  const EDITOR_HEIGHT_PREFIX = "chdash.editorHeight.v1";
  const META_PREFIX = "chdash.meta.v1.";
  const HISTORY_MAX_ENTRIES = 50;
  const HISTORY_MAX_BYTES = 2 * 1024 * 1024;
  const HISTORY_MAX_SQL_BYTES = 256 * 1024;

  const safeRead = (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  };

  const safeWrite = (key, value) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      return;
    }
  };

  const safeRemove = (key) => {
    try {
      localStorage.removeItem(key);
    } catch {
      return;
    }
  };

  const safeReadSession = (key) => {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  };

  const safeWriteSession = (key, value) => {
    try {
      sessionStorage.setItem(key, value);
    } catch {
      return;
    }
  };

  const safeReadJson = (key, fallback) => {
    try {
      const raw = safeRead(key);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      return parsed === undefined ? fallback : parsed;
    } catch {
      return fallback;
    }
  };

  const safeWriteJson = (key, value) => {
    try {
      safeWrite(key, JSON.stringify(value));
    } catch {
      return;
    }
  };

  const normalizeHistoryEntry = (entry) => {
    if (!entry || typeof entry !== "object") return null;
    if (typeof entry.ts_ms !== "number" || typeof entry.sql_raw !== "string") return null;
    const sqlRaw = entry.sql_raw.slice(0, HISTORY_MAX_SQL_BYTES);
    const formattedSource = typeof entry.sql_formatted === "string" ? entry.sql_formatted : entry.sql_raw;
    return {
      ts_ms: entry.ts_ms,
      sql_raw: sqlRaw,
      sql_formatted: formattedSource.slice(0, HISTORY_MAX_SQL_BYTES),
      host_id: entry.host_id == null ? null : String(entry.host_id),
    };
  };

  const boundedHistory = (items) => {
    const out = [];
    let estimatedBytes = 2;
    for (const item of items.slice(0, HISTORY_MAX_ENTRIES)) {
      const itemBytes = String(item.sql_raw || "").length * 2
        + String(item.sql_formatted || "").length * 2
        + String(item.host_id || "").length * 2
        + 96;
      if (out.length && estimatedBytes + itemBytes > HISTORY_MAX_BYTES) break;
      estimatedBytes += itemBytes;
      out.push(item);
    }
    return out;
  };

  const normalizeSavedQueryEntry = (entry) => {
    if (!entry || typeof entry !== "object") return null;
    if (typeof entry.name !== "string" || typeof entry.sql_raw !== "string") return null;
    return {
      name: entry.name,
      sql_raw: entry.sql_raw,
      sql_formatted: typeof entry.sql_formatted === "string" ? entry.sql_formatted : entry.sql_raw,
      host_id: entry.host_id == null ? null : String(entry.host_id),
      created_at_ms: typeof entry.created_at_ms === "number" ? entry.created_at_ms : typeof entry.ts_ms === "number" ? entry.ts_ms : Date.now(),
    };
  };

  const normalizeSavedQueryName = (name) => String(name || "").trim().toLocaleLowerCase();

  const storage = {
    THEME_STORAGE_KEY,
    HOST_STORAGE_KEY,
    HISTORY_STORAGE_KEY,
    SAVED_QUERIES_STORAGE_KEY,
    RUN_OPTIONS_STORAGE_KEY,
    EDITOR_STORAGE_KEY,
    EDITOR_HEIGHT_PREFIX,
    META_PREFIX,

    getSavedThemeMode() {
      const v = safeRead(THEME_STORAGE_KEY);
      if (v === "light" || v === "dark" || v === "system") return v;
      return "system";
    },

    setSavedThemeMode(mode) {
      safeWrite(THEME_STORAGE_KEY, String(mode));
    },

    getStoredHostId() {
      const v = safeRead(HOST_STORAGE_KEY);
      return v ? String(v) : null;
    },

    setStoredHostId(hostId) {
      safeWrite(HOST_STORAGE_KEY, String(hostId || ""));
    },

    loadRunOptions() {
      const obj = safeReadJson(RUN_OPTIONS_STORAGE_KEY, null);
      if (!obj || typeof obj !== "object") {
        return { autoFormat: true, multiQuery: false };
      }
      return { autoFormat: !!obj.autoFormat, multiQuery: !!obj.multiQuery };
    },

    saveRunOptions({ autoFormat, multiQuery }) {
      safeWriteJson(RUN_OPTIONS_STORAGE_KEY, { autoFormat: !!autoFormat, multiQuery: !!multiQuery });
    },

    loadHistory() {
      const arr = safeReadJson(HISTORY_STORAGE_KEY, []);
      if (!Array.isArray(arr)) return [];
      return boundedHistory(arr.map(normalizeHistoryEntry).filter(Boolean));
    },

    saveHistory(items) {
      const normalized = Array.isArray(items) ? items.map(normalizeHistoryEntry).filter(Boolean) : [];
      safeWriteJson(HISTORY_STORAGE_KEY, boundedHistory(normalized));
    },

    addHistoryEntry(entry) {
      const normalizedEntry = normalizeHistoryEntry(entry);
      if (!normalizedEntry) return;

      const items = storage.loadHistory();
      items.unshift(normalizedEntry);

      const seen = new Set();
      const deduped = [];
      for (const it of items) {
        const key = `${it.host_id || ""}::${it.sql_raw || ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(it);
        if (deduped.length >= HISTORY_MAX_ENTRIES) break;
      }
      storage.saveHistory(deduped);
    },

    loadSavedQueries() {
      const arr = safeReadJson(SAVED_QUERIES_STORAGE_KEY, []);
      if (!Array.isArray(arr)) return [];
      return arr.map(normalizeSavedQueryEntry).filter(Boolean);
    },

    saveSavedQueries(items) {
      const normalized = Array.isArray(items) ? items.map(normalizeSavedQueryEntry).filter(Boolean) : [];
      safeWriteJson(SAVED_QUERIES_STORAGE_KEY, normalized);
    },

    addSavedQuery(entry) {
      const normalizedEntry = normalizeSavedQueryEntry(entry);
      if (!normalizedEntry) return false;
      const normalizedName = normalizeSavedQueryName(normalizedEntry.name);
      const items = storage.loadSavedQueries();
      if (items.some((x) => normalizeSavedQueryName(x.name) === normalizedName)) return false;
      items.unshift(normalizedEntry);
      storage.saveSavedQueries(items);
      return true;
    },

    deleteSavedQuery(name) {
      const items = storage.loadSavedQueries().filter((x) => x.name !== name);
      storage.saveSavedQueries(items);
    },

    loadEditorSql() {
      const v = safeRead(EDITOR_STORAGE_KEY);
      return v ? String(v) : "";
    },

    saveEditorSql(sqlText) {
      safeWrite(EDITOR_STORAGE_KEY, String(sqlText ?? ""));
    },

    editorHeightKey(hostId) {
      return EDITOR_HEIGHT_PREFIX;
    },

    loadEditorHeight(hostId) {
      const raw = safeReadSession(storage.editorHeightKey(hostId));
      const v = raw != null ? Number(raw) : NaN;
      return Number.isFinite(v) && v > 0 ? v : null;
    },

    saveEditorHeight(hostId, heightPx) {
      const v = Number(heightPx);
      if (!Number.isFinite(v) || v <= 0) return;
      safeWriteSession(storage.editorHeightKey(hostId), String(Math.round(v)));
    },

    metaKey(hostId, type) {
      const h = String(hostId || "");
      const t = String(type || "");
      return `${META_PREFIX}${h}.${t}`;
    },

    readMeta(hostId, type) {
      const key = storage.metaKey(hostId, type);
      const obj = safeReadJson(key, null);
      if (!obj || typeof obj !== "object") return null;
      if (typeof obj.updated_at_ms !== "number" || !Array.isArray(obj.items)) return null;
      return { updated_at_ms: obj.updated_at_ms, items: obj.items.map((x) => String(x || "")) };
    },

    readMetaRaw(hostId, type) {
      const key = storage.metaKey(hostId, type);
      const obj = safeReadJson(key, null);
      if (!obj || typeof obj !== "object") return null;
      if (typeof obj.updated_at_ms !== "number" || !Array.isArray(obj.items)) return null;
      return { updated_at_ms: obj.updated_at_ms, items: obj.items };
    },

    writeMeta(hostId, type, updatedAtMs, items) {
      const key = storage.metaKey(hostId, type);
      const payload = { updated_at_ms: Number(updatedAtMs) || 0, items: Array.isArray(items) ? items : [] };
      safeWriteJson(key, payload);
    },

    writeMetaRaw(hostId, type, updatedAtMs, items) {
      const key = storage.metaKey(hostId, type);
      const payload = { updated_at_ms: Number(updatedAtMs) || 0, items: Array.isArray(items) ? items : [] };
      safeWriteJson(key, payload);
    },

    removeMeta(hostId, type) {
      safeRemove(storage.metaKey(hostId, type));
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

  const state = {
    hostsSnapshot: null,
    selectedHostId: storage.getStoredHostId(),
    apiOnline: true,

    runOptAutoFormat: runOpts.autoFormat,
    runOptMultiQuery: runOpts.multiQuery,

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

  ns.storage = storage;
  ns.state = state;
})();