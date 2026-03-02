(() => {
  "use strict";

  const ns = window.ChDash;
  if (!ns) return;

  const { api, state, storage } = ns;
  const clientTtlMs = 30 * 60 * 1000;
  const refreshPollMs = 5 * 60 * 1000;

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

  function applyKeywords(hostId, payload) {
    const data = payload && payload.data && payload.data.keywords ? payload.data.keywords : null;
    if (!data || !Array.isArray(data.items)) return;
    const updatedAt = typeof data.updated_at_ms === "number" ? data.updated_at_ms : 0;
    const items = data.items.map((x) => String(x || "")).filter((x) => x);
    storage.writeMeta(hostId, "keywords", updatedAt, items);

    const hostMeta = getHostMeta(hostId);
    hostMeta.keywords = { updated_at_ms: updatedAt, set: new Set(items) };

    if (state.highlightCtrl && String(state.selectedHostId || "") === String(hostId)) {
      state.highlightCtrl.refresh();
    }
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
    hostMeta.functions = { updated_at_ms: updatedAt, ci, cs, meta };

    if (state.highlightCtrl && String(state.selectedHostId || "") === String(hostId)) {
      state.highlightCtrl.refresh();
    }
  }

  function readClientUpdatedAt(hostId, type) {
    const t = normalizeType(type);
    const v = t === "functions" ? storage.readMetaRaw(hostId, t) : storage.readMeta(hostId, t);
    return v && typeof v.updated_at_ms === "number" ? v.updated_at_ms : 0;
  }

  function shouldRefresh(hostId, type) {
    const updatedAt = readClientUpdatedAt(hostId, type);
    if (!updatedAt) return true;
    const age = Date.now() - updatedAt;
    return age > clientTtlMs;
  }

  async function fetchAndStore(hostId, types) {
    const key = `${hostId}::${types.join(",")}`;
    if (inflight.has(key)) return inflight.get(key);

    const p = (async () => {
      const payload = await api.getMeta(hostId, types);
      const tset = new Set(types);
      if (tset.has("keywords")) applyKeywords(hostId, payload);
      if (tset.has("functions")) applyFunctions(hostId, payload);
      return payload;
    })()
      .catch(() => null)
      .finally(() => inflight.delete(key));

    inflight.set(key, p);
    return p;
  }

  function maybeRefreshOnUserAction() {
    const hostId = state.selectedHostId;
    if (!hostId) return;
    const types = ["keywords", "functions"].map(normalizeType);
    const need = types.filter((t) => shouldRefresh(hostId, t));
    if (!need.length) return;
    fetchAndStore(String(hostId), need);
  }

  function maybeRefreshOnLoad() {
    const hostId = state.selectedHostId;
    if (!hostId) return;
    const types = ["keywords", "functions"].map(normalizeType);
    const need = types.filter((t) => shouldRefresh(hostId, t));
    if (!need.length) return;
    fetchAndStore(String(hostId), need);
  }

  function hydrateFromStorage(hostId) {
    const h = String(hostId || "");
    if (!h) return;
    const kw = storage.readMeta(h, "keywords");
    if (kw && Array.isArray(kw.items) && kw.items.length) {
      const hostMeta = getHostMeta(h);
      hostMeta.keywords = { updated_at_ms: kw.updated_at_ms, set: new Set(kw.items.map((x) => String(x || "")).filter((x) => x)) };
    }

    const fn = storage.readMetaRaw(h, "functions");
    if (fn && Array.isArray(fn.items) && fn.items.length) {
      const hostMeta = getHostMeta(h);
      const ci = new Set();
      const cs = new Set();
      const meta = new Map();
      for (const raw of fn.items) {
        if (!raw || typeof raw !== "object") continue;
        const name = String(raw.name || "");
        if (!name) continue;
        const it = { name, is_aggregate: Boolean(raw.is_aggregate), case_insensitive: Boolean(raw.case_insensitive) };
        meta.set(name, it);
        if (it.case_insensitive) ci.add(name.toLowerCase());
        else cs.add(name);
      }
      hostMeta.functions = { updated_at_ms: fn.updated_at_ms, ci, cs, meta };
    }
  }

  if (state && state.selectedHostId) hydrateFromStorage(state.selectedHostId);

  setInterval(() => {
    try {
      maybeRefreshOnLoad();
    } catch {
    }
  }, refreshPollMs);

  ns.meta = { maybeRefreshOnUserAction, maybeRefreshOnLoad, hydrateFromStorage };
})();
