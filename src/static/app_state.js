(() => {
  "use strict";

  const ns = window.ChDash;
  if (!ns) return;

  const THEME_STORAGE_KEY = "chdash.theme";
  const HOST_STORAGE_KEY = "chdash.selectedHost";
  const HISTORY_STORAGE_KEY = "chdash.queryHistory.v1";
  const RUN_OPTIONS_STORAGE_KEY = "chdash.runOptions.v1";
  const EDITOR_STORAGE_KEY = "chdash.editorSql.v1";
  const EDITOR_HEIGHT_PREFIX = "chdash.editorHeight.v1.";
  const META_PREFIX = "chdash.meta.v1.";
  const HISTORY_MAX_ENTRIES = 100;

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

  const storage = {
    THEME_STORAGE_KEY,
    HOST_STORAGE_KEY,
    HISTORY_STORAGE_KEY,
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
      return arr
        .filter((x) => x && typeof x === "object" && typeof x.ts_ms === "number" && typeof x.sql_raw === "string")
        .slice(0, HISTORY_MAX_ENTRIES);
    },

    saveHistory(items) {
      const trimmed = Array.isArray(items) ? items.slice(0, HISTORY_MAX_ENTRIES) : [];
      safeWriteJson(HISTORY_STORAGE_KEY, trimmed);
    },

    addHistoryEntry(entry) {
      const items = storage.loadHistory();
      items.unshift(entry);

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

    loadEditorSql() {
      const v = safeRead(EDITOR_STORAGE_KEY);
      return v ? String(v) : "";
    },

    saveEditorSql(sqlText) {
      safeWrite(EDITOR_STORAGE_KEY, String(sqlText ?? ""));
    },

    editorHeightKey(hostId) {
      const h = String(hostId || "");
      return `${EDITOR_HEIGHT_PREFIX}${h}`;
    },

    loadEditorHeight(hostId) {
      const raw = safeRead(storage.editorHeightKey(hostId));
      const v = raw != null ? Number(raw) : NaN;
      return Number.isFinite(v) && v > 0 ? v : null;
    },

    saveEditorHeight(hostId, heightPx) {
      const v = Number(heightPx);
      if (!Number.isFinite(v) || v <= 0) return;
      safeWrite(storage.editorHeightKey(hostId), String(Math.round(v)));
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
  };

  const runOpts = storage.loadRunOptions();

  const state = {
    hostsSnapshot: null,
    selectedHostId: storage.getStoredHostId(),

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