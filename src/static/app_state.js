(() => {
  "use strict";

  const ns = window.ChDash;
  if (!ns) return;

  const THEME_STORAGE_KEY = "chdash.theme";
  const HOST_STORAGE_KEY = "chdash.selectedHost";
  const HISTORY_STORAGE_KEY = "chdash.queryHistory.v1";
  const SAVED_QUERIES_STORAGE_KEY = "chdash.savedQueries.v1";
  const SAVED_TREE_STORAGE_KEY = "chdash.savedTree.v1";
  const RUN_OPTIONS_STORAGE_KEY = "chdash.runOptions.v1";
  const EDITOR_STORAGE_KEY = "chdash.editorSql.v1";
  const EDITOR_HEIGHT_PREFIX = "chdash.editorHeight.v1";
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
    return {
      ts_ms: entry.ts_ms,
      sql_raw: entry.sql_raw,
      sql_formatted: typeof entry.sql_formatted === "string" ? entry.sql_formatted : entry.sql_raw,
      host_id: entry.host_id == null ? null : String(entry.host_id),
      label: typeof entry.label === "string" ? entry.label : "",
    };
  };

  // A library node is either a folder or a saved query, stored flat with a
  // parentId reference so folders/subfolders, moves and reordering are cheap.
  let nodeIdCounter = 0;
  const genNodeId = () => {
    nodeIdCounter += 1;
    return `n_${Date.now().toString(36)}_${nodeIdCounter}`;
  };

  const normalizeTreeNode = (node) => {
    if (!node || typeof node !== "object") return null;
    const id = String(node.id || "");
    const type = node.type === "folder" ? "folder" : "query";
    if (!id) return null;
    const base = {
      id,
      type,
      name: typeof node.name === "string" ? node.name : "",
      parentId: node.parentId == null ? null : String(node.parentId),
      order: Number.isFinite(node.order) ? Number(node.order) : 0,
    };
    if (type === "query") {
      if (typeof node.sql_raw !== "string") return null;
      base.sql_raw = node.sql_raw;
      base.sql_formatted = typeof node.sql_formatted === "string" ? node.sql_formatted : node.sql_raw;
      base.host_id = node.host_id == null ? null : String(node.host_id);
      base.created_at_ms = typeof node.created_at_ms === "number" ? node.created_at_ms : Date.now();
    }
    return base;
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
      return arr.map(normalizeHistoryEntry).filter(Boolean).slice(0, HISTORY_MAX_ENTRIES);
    },

    saveHistory(items) {
      const normalized = Array.isArray(items) ? items.map(normalizeHistoryEntry).filter(Boolean) : [];
      safeWriteJson(HISTORY_STORAGE_KEY, normalized.slice(0, HISTORY_MAX_ENTRIES));
    },

    addHistoryEntry(entry) {
      const normalizedEntry = normalizeHistoryEntry(entry);
      if (!normalizedEntry) return;

      const items = storage.loadHistory();

      // Preserve a user-given label across re-runs of the same query/host.
      if (!normalizedEntry.label) {
        const newKey = `${normalizedEntry.host_id || ""}::${normalizedEntry.sql_raw || ""}`;
        const prior = items.find((it) => `${it.host_id || ""}::${it.sql_raw || ""}` === newKey && it.label);
        if (prior) normalizedEntry.label = prior.label;
      }

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

    // Attach (or clear) a friendly label on the history entry matching host+sql.
    setHistoryLabel(hostId, sqlRaw, label) {
      const key = `${hostId || ""}::${sqlRaw || ""}`;
      const items = storage.loadHistory();
      let changed = false;
      for (const it of items) {
        if (`${it.host_id || ""}::${it.sql_raw || ""}` === key) {
          it.label = String(label || "");
          changed = true;
        }
      }
      if (changed) storage.saveHistory(items);
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

    genNodeId,

    // Saved library as a node tree. On first access it migrates the legacy flat
    // saved-queries list into root-level query nodes.
    loadSavedTree() {
      const raw = safeReadJson(SAVED_TREE_STORAGE_KEY, null);
      if (raw && typeof raw === "object" && Array.isArray(raw.nodes)) {
        return { version: 1, nodes: raw.nodes.map(normalizeTreeNode).filter(Boolean) };
      }
      const legacy = storage.loadSavedQueries();
      const nodes = legacy.map((q, i) => ({
        id: genNodeId(),
        type: "query",
        name: q.name,
        parentId: null,
        order: i,
        sql_raw: q.sql_raw,
        sql_formatted: q.sql_formatted,
        host_id: q.host_id,
        created_at_ms: q.created_at_ms,
      }));
      const tree = { version: 1, nodes };
      storage.saveSavedTree(tree);
      return tree;
    },

    saveSavedTree(tree) {
      const nodes = tree && Array.isArray(tree.nodes) ? tree.nodes.map(normalizeTreeNode).filter(Boolean) : [];
      safeWriteJson(SAVED_TREE_STORAGE_KEY, { version: 1, nodes });
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
  };

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