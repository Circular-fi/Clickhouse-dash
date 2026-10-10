(() => {
  "use strict";

  // The query History (docs/query-library.md, "History"): the runs of this browser, one list for each host. It is
  // kept in IndexedDB, not in localStorage: a run costs one small write of its own record (never a read and a
  // write of the whole list), and a full browser quota shows as a visible warning instead of a history that stops
  // without a word.
  //
  //   ns.history.list(hostId)                  Promise<entry[]>   the runs of a host, the newest first
  //   ns.history.add(entry)                    Promise<boolean>   the record of a run that starts (false: not kept)
  //   ns.history.complete(tsMs, sqlRaw, outcome, hostId)
  //                                            Promise<boolean>   its outcome (status, elapsed_ms, rows, error),
  //                                                               or its formatted text, once it is known
  //   ns.history.ready                         Promise            the store is open and the older list is moved in
  //   ns.history.status()                      { stored, error }  stored: false when the runs stay in this page only
  //
  // A change fires `chdash:query-history-changed` ({ detail: { hostId } }) on window, also when another tab made it.
  // The list of a host is read once for each page (then kept here, bounded) and again only when another tab wrote.
  // An entry is { ts_ms, host_id, sql_raw, sql_formatted, formatted?, status?, elapsed_ms?, rows?, error?, truncated? }.
  // The History is the browser's: it is never sent to the server.
  const ns = window.ChDash;
  if (!ns) return;

  const DB_NAME = "chdash";
  const DB_VERSION = 1;
  const STORE = "queryHistory";
  const LEGACY_KEY = ns.storage.KEYS.queryHistory;
  // The caps apply to each host: a host that runs a lot does not push the runs of the others out.
  const HISTORY_MAX_ENTRIES = 50;
  const HISTORY_MAX_BYTES = 2 * 1024 * 1024;
  const HISTORY_MAX_SQL_BYTES = 256 * 1024;
  const HISTORY_MAX_ERROR_CHARS = 2048;
  const HISTORY_STATUSES = ["ok", "error", "cancelled"];
  const NOTICE_MS = 12000;

  // A History entry belongs to the host it ran on: an entry without one is dropped (docs/query-library.md, "Entries
  // without a host"). A text longer than the cap is cut, and the entry says so (`truncated`).
  function normalize(entry) {
    if (!entry || typeof entry !== "object") return null;
    if (typeof entry.ts_ms !== "number" || typeof entry.sql_raw !== "string") return null;
    if (entry.host_id == null || entry.host_id === "") return null;
    const formattedSource = typeof entry.sql_formatted === "string" ? entry.sql_formatted : entry.sql_raw;
    const out = {
      ts_ms: entry.ts_ms,
      sql_raw: entry.sql_raw.slice(0, HISTORY_MAX_SQL_BYTES),
      sql_formatted: formattedSource.slice(0, HISTORY_MAX_SQL_BYTES),
      host_id: String(entry.host_id),
    };
    if (entry.sql_raw.length > HISTORY_MAX_SQL_BYTES || formattedSource.length > HISTORY_MAX_SQL_BYTES || entry.truncated === true) out.truncated = true;
    // sql_formatted was written by the formatter (older entries and runs of a query typed unformatted have none).
    if (entry.formatted === true) out.formatted = true;
    // Outcome of the run, once it ended (older entries have none).
    if (HISTORY_STATUSES.includes(entry.status)) out.status = entry.status;
    if (Number.isFinite(entry.elapsed_ms) && entry.elapsed_ms >= 0) out.elapsed_ms = entry.elapsed_ms;
    if (Number.isFinite(entry.rows) && entry.rows >= 0) out.rows = Math.trunc(entry.rows);
    if (typeof entry.error === "string" && entry.error) out.error = entry.error.slice(0, HISTORY_MAX_ERROR_CHARS);
    return out;
  }

  const sizeOf = (item) => String(item.sql_raw || "").length * 2 + String(item.sql_formatted || "").length * 2 + String(item.error || "").length * 2 + 160;

  // The entries of a host that stay, newest first: at most HISTORY_MAX_ENTRIES and HISTORY_MAX_BYTES (the newest is
  // always kept). `dropped` are the older ones that go.
  function bound(items) {
    const kept = [];
    const dropped = [];
    let bytes = 0;
    for (const item of items) {
      const cost = sizeOf(item);
      if (kept.length && (kept.length >= HISTORY_MAX_ENTRIES || bytes + cost > HISTORY_MAX_BYTES)) dropped.push(item);
      else {
        kept.push(item);
        bytes += cost;
      }
    }
    return { kept, dropped };
  }

  // ---- the database ------------------------------------------------------------------------------------------------

  let dbPromise = null;
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      if (!window.indexedDB) {
        resolve(null);
        return;
      }
      let request;
      try {
        request = window.indexedDB.open(DB_NAME, DB_VERSION);
      } catch {
        resolve(null);
        return;
      }
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
        store.createIndex("host", ["host_id", "ts_ms"]);
      };
      request.onsuccess = () => {
        const db = request.result;
        // Another tab upgrades the database: this connection steps aside, and the next write opens it again.
        db.onversionchange = () => { db.close(); dbPromise = null; };
        resolve(db);
      };
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
    return dbPromise;
  }

  // One transaction: `work(store)` queues its requests; resolves when it commits, rejects with its error.
  function transact(db, mode, work) {
    return new Promise((resolve, reject) => {
      let tx;
      try {
        tx = db.transaction(STORE, mode);
        work(tx.objectStore(STORE));
      } catch (error) {
        reject(error);
        return;
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("The History transaction was aborted."));
    });
  }

  function request(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // ---- the lists -----------------------------------------------------------------------------------------------------

  // host -> entries, newest first, each with its `id` once stored. Bounded: HISTORY_MAX_ENTRIES for each host, and
  // only the hosts this page used.
  const lists = new Map();
  let stored = true;
  let lastError = "";
  // Writes go one after the other: a run's two records never overtake each other.
  let queue = Promise.resolve();
  const enqueue = (job) => {
    const next = queue.then(job, job);
    queue = next.catch(() => {});
    return next;
  };

  let channel = null;
  try {
    channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("chdash-query-history") : null;
  } catch {
    channel = null;
  }

  function changed(hostId, { broadcast = true } = {}) {
    if (broadcast) {
      try { channel?.postMessage({ hostId }); } catch { /* the other tabs read it at their next list() */ }
    }
    try {
      window.dispatchEvent(new CustomEvent("chdash:query-history-changed", { detail: { hostId } }));
    } catch { /* no listener */ }
  }

  if (channel) {
    channel.onmessage = (event) => {
      const hostId = String(event?.data?.hostId || "");
      if (hostId) lists.delete(hostId);
      else lists.clear();
      changed(hostId, { broadcast: false });
    };
  }

  // A visible warning when a write fails or nothing can be stored: a toast above the page, for a few seconds.
  let noticeTimer = 0;
  function notice(message) {
    lastError = message;
    let el = ns.dom.byId("historyToast");
    if (!el) {
      el = document.createElement("div");
      el.id = "historyToast";
      el.className = "historyToast";
      // Dismissed by a click; in the dialog on top, when one is open (the page behind a modal dialog is inert).
      el.dataset.dialogFloat = "";
      el.addEventListener("click", () => { el.hidden = true; });
    }
    const layer = ns.dialog?.host?.() || document.body;
    if (el.parentNode !== layer) layer.appendChild(el);
    ns.uiState.banner(el, { message });
    el.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { el.hidden = true; }, NOTICE_MS);
  }

  function failureText(error) {
    const full = error && (error.name === "QuotaExceededError" || /quota/i.test(String(error?.message ?? "")));
    return full
      ? "History could not be saved: the browser storage is full. Free some space (site data) and run again."
      : "History could not be saved: the browser storage is unavailable.";
  }

  // The older list, localStorage["chdash.queryHistory.v1"]: moved into the database once, then removed.
  async function migrate(db) {
    const legacy = ns.storage.pref(LEGACY_KEY, null, { json: true });
    const parsed = legacy.get();
    if (parsed == null) return;
    const older = (Array.isArray(parsed) ? parsed : []).map(normalize).filter(Boolean);
    if (older.length) {
      const hosts = new Map();
      for (const item of older) {
        if (!hosts.has(item.host_id)) hosts.set(item.host_id, []);
        hosts.get(item.host_id).push(item);
      }
      for (const [hostId, items] of hosts) {
        const current = await readHost(db, hostId);
        const seen = new Set(current.map((item) => item.sql_raw));
        const merged = current.concat(items.filter((item) => !seen.has(item.sql_raw)))
          .sort((a, b) => b.ts_ms - a.ts_ms);
        const { kept, dropped } = bound(merged);
        await transact(db, "readwrite", (store) => {
          for (const item of dropped) if (item.id != null) store.delete(item.id);
          for (const item of kept) if (item.id == null) store.add(item);
        });
        lists.delete(hostId);
      }
    }
    legacy.remove();
  }

  async function readHost(db, hostId) {
    const range = IDBKeyRange.bound([hostId, 0], [hostId, Number.MAX_SAFE_INTEGER]);
    const rows = await request(db.transaction(STORE, "readonly").objectStore(STORE).index("host").getAll(range));
    return rows.map((row) => ({ ...normalize(row), id: row.id })).filter((row) => row.host_id).sort((a, b) => b.ts_ms - a.ts_ms);
  }

  const ready = (async () => {
    const db = await openDb();
    if (!db) {
      stored = false;
      return;
    }
    try {
      await migrate(db);
    } catch (error) {
      // The older list stays where it is; the next page tries again.
      notice(failureText(error).replace("could not be saved", "could not be moved"));
    }
  })();

  async function hostList(hostId) {
    await ready;
    const key = String(hostId || "");
    if (lists.has(key)) return lists.get(key);
    const db = stored ? await openDb() : null;
    let items = [];
    if (db) {
      try {
        items = await readHost(db, key);
      } catch {
        items = [];
      }
    }
    // A list read while another one was in flight keeps the first answer.
    if (!lists.has(key)) lists.set(key, items);
    return lists.get(key);
  }

  const copy = (item) => { const { id, ...rest } = item; return rest; };

  async function list(hostId) {
    return (await hostList(hostId)).map(copy);
  }

  // Writes the records of one host that changed (`put`) and removes the ones that dropped out (`drop`).
  async function persist(put, drop) {
    if (!stored) return true;
    const db = await openDb();
    if (!db) {
      stored = false;
      return true;
    }
    try {
      await transact(db, "readwrite", (store) => {
        for (const item of drop) if (item.id != null) store.delete(item.id);
        for (const item of put) {
          const req = store.put(item.id != null ? { ...item } : copy(item));
          if (item.id == null) req.onsuccess = () => { item.id = req.result; };
        }
      });
      return true;
    } catch (error) {
      notice(failureText(error));
      return false;
    }
  }

  // The record of a run when it starts. The same SQL on the same host moves to the top instead of repeating.
  function add(entry) {
    const item = normalize(entry);
    if (!item) return Promise.resolve(false);
    return enqueue(async () => {
      await ready;
      const items = await hostList(item.host_id);
      const same = items.filter((other) => other.sql_raw === item.sql_raw);
      const rest = items.filter((other) => other.sql_raw !== item.sql_raw);
      const { kept, dropped } = bound([item, ...rest]);
      lists.set(item.host_id, kept);
      const ok = await persist([item], same.concat(dropped));
      changed(item.host_id);
      if (!stored && !lastError) notice("History is kept in this page only: the browser blocks storage.");
      return ok;
    });
  }

  // The outcome of a run (or its formatted text) once it is known: the record is changed in place.
  function complete(tsMs, sqlRaw, outcome, hostId = "") {
    if (!outcome || typeof outcome !== "object") return Promise.resolve(false);
    return enqueue(async () => {
      await ready;
      const sqlKey = String(sqlRaw || "").slice(0, HISTORY_MAX_SQL_BYTES);
      const hosts = hostId ? [String(hostId)] : [...lists.keys()];
      for (const host of hosts) {
        const items = await hostList(host);
        const target = items.find((item) => item.ts_ms === tsMs && item.sql_raw === sqlKey);
        if (!target) continue;
        const next = normalize({ ...target, ...outcome });
        Object.assign(target, next);
        const ok = await persist([target], []);
        changed(host);
        return ok;
      }
      return false;
    });
  }

  ns.history = Object.freeze({
    list,
    add,
    complete,
    ready,
    status: () => ({ stored, error: lastError }),
    LIMITS: Object.freeze({ entries: HISTORY_MAX_ENTRIES, bytes: HISTORY_MAX_BYTES, sqlChars: HISTORY_MAX_SQL_BYTES }),
  });
})();
