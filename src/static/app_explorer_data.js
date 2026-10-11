// What the Catalog reads from the server and keeps: the tables of a database (a branch of the tree, loaded once for each host), and the
// card of a table (a bounded cache, checked against the catalog's metadata revision).

import { api } from "./app_api.js";
import { actions, model } from "./app_explorer_store.js";
import { state } from "./app_state.js";
import { util } from "./app_util.js";

function detailCacheKey(hostId, database, table) {
  return `${String(hostId || "")}\0${String(database || "")}\0${String(table || "")}`;
}

function currentCatalogTable(database, table) {
  return (model.catalog?.tables || []).find((item) => String(item.database || "") === String(database || "") && String(item.name || "") === String(table || "")) || null;
}

function metadataRevision(table) {
  return String(table?.metadata_modification_time || "");
}

function detailMatchesCatalog(detail, database, table) {
  const current = currentCatalogTable(database, table);
  const navRevision = metadataRevision(current);
  const detailRevision = metadataRevision(detail?.summary);
  // Older ClickHouse versions / restricted accounts may not expose a revision.
  // In that case fall back to the bounded detail TTL instead of invalidating
  // every time the lightweight navigation catalog refreshes.
  return !navRevision || !detailRevision || navRevision === detailRevision;
}

function applyFreshSidebarSummary(detail, database, table) {
  const current = currentCatalogTable(database, table);
  if (!detail?.summary || !current) return detail;
  detail.summary.engine = current.engine || detail.summary.engine;
  detail.summary.metadata_modification_time = current.metadata_modification_time || detail.summary.metadata_modification_time || "";
  if (current.rows != null) detail.summary.rows = current.rows;
  if (current.bytes != null) {
    if (detail.summary.resident_bytes != null) detail.summary.resident_bytes = current.bytes;
    else {
      detail.summary.logical_bytes = current.bytes;
      detail.summary.compressed_bytes = current.bytes;
      if (detail.summary.physical_bytes != null) detail.summary.physical_bytes = current.bytes;
    }
  }
  return detail;
}

const DETAIL_CACHE_MAX_ENTRIES = 64;

// Every Explorer read is cancelable: a slot of util.latest ("explorer.<what>") holds the newest request of that
// kind, a newer one aborts the older, and a host change aborts them all (resetForHost). An aborted read rejects with
// an AbortError (util.isAbort) that the callers drop without a message.
async function fetchTableDetail(hostId, database, table, force = false, signal = undefined) {
  const key = detailCacheKey(hostId, database, table);
  if (force) model.detailCache.delete(key);
  const cached = model.detailCache.get(key);
  const ttl = Math.max(0, Number(cached?.detail?.cache_ttl_ms ?? 30000));
  const freshByAge = !!cached && (Date.now() - Number(cached.cachedAtMs || 0) < ttl);
  if (!force && cached?.detail && freshByAge && detailMatchesCatalog(cached.detail, database, table)) {
    return applyFreshSidebarSummary(cached.detail, database, table);
  }
  let detail = await api.getExplorerTable(hostId, database, table, !!force, { signal });
  // A 30s rich-detail cache keeps clicks responsive, while the 5s navigation
  // catalog carries ClickHouse's metadata_modification_time. If the schema
  // changed since the cached detail was produced, bypass the server cache
  // exactly once; row/byte-only changes are overlaid from the sidebar.
  if (!force && !detailMatchesCatalog(detail, database, table)) {
    detail = await api.getExplorerTable(hostId, database, table, true, { signal });
  }
  applyFreshSidebarSummary(detail, database, table);
  // Map preserves insertion order: re-inserting keeps LRU order and the
  // oldest entries are evicted. Rich details (columns, parts, DDL) were
  // otherwise retained for every object visited during the session.
  model.detailCache.delete(key);
  model.detailCache.set(key, { detail, cachedAtMs: Date.now() });
  while (model.detailCache.size > DETAIL_CACHE_MAX_ENTRIES) {
    model.detailCache.delete(model.detailCache.keys().next().value);
  }
  return detail;
}

function mergeDatabaseCatalog(database, payload) {
  if (!model.catalog) model.catalog = { databases: [], tables: [] };
  const name = String(database || "");
  // The branch's database joins the list only when the server names it (or
  // returns its objects): an unknown name never becomes a tree row.
  const known = (payload?.databases || []).includes(name) || (Array.isArray(payload?.tables) && payload.tables.length > 0);
  const databases = new Set([...(model.catalog.databases || []), ...(payload?.databases || []), known ? name : ""].filter(Boolean));
  const retained = (model.catalog.tables || []).filter((table) => String(table.database || "") !== name);
  model.catalog = {
    ...model.catalog,
    databases: [...databases].sort((a, b) => a.localeCompare(b)),
    tables: retained.concat(Array.isArray(payload?.tables) ? payload.tables : []),
  };
  model.databaseDisks.set(name, Array.isArray(payload?.disks) ? payload.disks : []);
}

// A branch (the tables of one database) loads once per host: the key names the host, so the end of a request of the
// old host never clears the loading state or the promise of the new one. A forced load replaces a plain one in flight.
async function loadDatabaseTables(database, force = false) {
  const name = String(database || "");
  if (!name || !model.active) return;
  if (!force && model.databaseTablesLoaded.has(name)) return;
  const hostId = String(state.selectedHostId || "");
  if (!hostId) return;
  const key = `${hostId}\0${name}`;
  const existing = model.databaseLoadPromises.get(key);
  if (existing && (!force || existing.force)) return existing;

  const req = util.latest(`explorer.branch.${key}`);
  let promise = null;
  promise = (async () => {
    model.databaseTablesLoading.add(name);
    model.databaseLoadErrors.delete(name);
    actions.renderTableList();
    try {
      const payload = await api.getExplorerCatalog(hostId, name, !!force, { signal: req.signal });
      if (!req.isCurrent() || !model.active || String(state.selectedHostId || "") !== hostId) return;
      mergeDatabaseCatalog(name, payload);
      model.databaseTablesLoaded.add(name);
      actions.renderTableList();
      if (model.selectedDatabase === name && model.mode === "browse") actions.renderDatabaseDetail(name);
    } catch (error) {
      if (!req.isCurrent() || util.isAbort(error) || !model.active || String(state.selectedHostId || "") !== hostId) return;
      model.databaseLoadErrors.set(name, error);
      actions.renderTableList();
      if (model.selectedDatabase === name && model.mode === "browse") actions.renderDatabaseDetail(name);
    } finally {
      if (model.databaseLoadPromises.get(key) === promise) {
        model.databaseTablesLoading.delete(name);
        model.databaseLoadPromises.delete(key);
        actions.renderTableList();
      }
    }
  })();
  promise.force = !!force;
  model.databaseLoadPromises.set(key, promise);
  return promise;
}

function catalogContainsTable(payload, database, table) {
  return (payload?.tables || []).some((item) => item.database === database && item.name === table);
}

// The expanded databases of a forced Refresh load this many at a time.
const BRANCH_CONCURRENCY = 4;

async function loadBranches(names, force, isCurrent) {
  const queue = [...names];
  const worker = async () => {
    while (queue.length && isCurrent()) await loadDatabaseTables(queue.shift(), force);
  };
  await Promise.all(Array.from({ length: Math.min(BRANCH_CONCURRENCY, queue.length) }, worker));
}

export { catalogContainsTable, fetchTableDetail, loadBranches, loadDatabaseTables };
