(() => {
  "use strict";

  const ns = window.ChDash;
  if (!ns) return;

  const { api, state, storage } = ns;
  const clientTtlMs = 30 * 60 * 1000;

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

  function readClientUpdatedAt(hostId, type) {
    const v = storage.readMeta(hostId, type);
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
    const types = ["keywords"].map(normalizeType);
    const need = types.filter((t) => shouldRefresh(hostId, t));
    if (!need.length) return;
    fetchAndStore(String(hostId), need);
  }

  function maybeRefreshOnLoad() {
    const hostId = state.selectedHostId;
    if (!hostId) return;
    const types = ["keywords"].map(normalizeType);
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
  }

  if (state && state.selectedHostId) hydrateFromStorage(state.selectedHostId);

  ns.meta = { maybeRefreshOnUserAction, maybeRefreshOnLoad, hydrateFromStorage };
})();
