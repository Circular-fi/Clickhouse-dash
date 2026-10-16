// This file holds what the Catalog reads from the server and keeps.
// It holds the tables of a database. A branch of the tree loads them once for each host.
// It also holds the card of a table. The card is a bounded cache. The code checks it against the catalog's metadata revision.

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
  // Older ClickHouse versions and restricted accounts can omit the revision.
  // In that case, the code uses the bounded detail TTL. It does not clear the cache each time the lightweight navigation catalog refreshes.
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

// Every Explorer read can be canceled. A slot of util.latest ("explorer.<what>") holds the newest request of that kind.
// A newer request aborts the older one. A host change aborts all requests (resetForHost).
// An aborted read rejects with an AbortError (util.isAbort). The callers drop this error without a message.
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
  // A 30s rich-detail cache keeps clicks quick. The 5s navigation catalog carries ClickHouse's metadata_modification_time.
  // If the schema changed after the cached detail was made, the code bypasses the server cache one time.
  // Changes to rows or bytes only are overlaid from the sidebar.
  if (!force && !detailMatchesCatalog(detail, database, table)) {
    detail = await api.getExplorerTable(hostId, database, table, true, { signal });
  }
  applyFreshSidebarSummary(detail, database, table);
  // A Map keeps the insertion order. When an entry is inserted again, it keeps its LRU order. The oldest entries are evicted.
  // Without this limit, the rich details (columns, parts, DDL) stay in memory for every object visited during the session.
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
  // The database of the branch joins the list only when the server names it, or when the server returns its objects.
  // An unknown name never becomes a tree row.
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

// A branch (the tables of one database) loads once for each host. The key names the host.
// So the end of a request from the old host never clears the loading state or the promise of the new host.
// A forced load replaces a plain load that is in flight.
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

// A forced Refresh loads this number of expanded databases at a time.
const BRANCH_CONCURRENCY = 4;

async function loadBranches(names, force, isCurrent) {
  const queue = [...names];
  const worker = async () => {
    while (queue.length && isCurrent()) await loadDatabaseTables(queue.shift(), force);
  };
  await Promise.all(Array.from({ length: Math.min(BRANCH_CONCURRENCY, queue.length) }, worker));
}

export { catalogContainsTable, fetchTableDetail, loadBranches, loadDatabaseTables };
