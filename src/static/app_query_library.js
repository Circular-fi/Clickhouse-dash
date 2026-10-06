(() => {
  "use strict";

  // Query library and History: the two tabs (Saved, History) of the dialog the
  // Query toolbar's book button opens (the shared modal dialog of
  // app_ui_dialog.js; app_ui.js builds it, this module adds the preview pane).
  //
  // app_ui.js loads this module the first time the dialog opens (or Ctrl+S is
  // used) and drives it through ns.queryLibrary. Its prompts (forms, confirms)
  // are ns.dialog dialogs stacked over the library.
  //
  // Saved queries, folders and History are per host: the dialog shows the
  // selected host's only and follows a host switch (chdash:host-changed).
  // Saved holds two root folders, two storages with the same adapter
  // interface, browsable side by side:
  //   - "Shared server storage" (server): the REST API of
  //     features.query_library (/api/query-library?host_id=, through
  //     api.request), shown only when the feature is enabled; read-only when
  //     the server says writable = false (the root then has no edit tools).
  //     Every folder / query change sends If-Match: <revision>; a 409 conflict
  //     reloads the library and retries once before the user is told.
  //   - "Local browser storage" (local): this browser (localStorage
  //     chdash.queryLibrary.v2, every folder and query with its host_id).
  //     Always editable. Entries without a host are purged on the first read.
  // The save, move and folder pickers offer both roots; moving an item from
  // one root to the other copies it into the target, then removes it from
  // its source. History is this browser's (chdash.queryHistory.v1), never the
  // server's.
  // Both adapters resolve every change with the host's whole new library, so
  // the view never guesses what the server did.
  //
  // The list on the left only selects; every action of the selected item
  // (edit, move, remove...) is an icon button of the preview pane's head on
  // the right, and its foot holds one action: "Load in editor".

  const ns = window.ChDash;
  if (!ns || ns.queryLibrary) return;
  const { byId, $, $$ } = ns.dom;

  const { dom, state, storage, util, h } = ns;

  const LOCAL_KEY = storage.KEYS.queryLibrary;
  const HISTORY_KEY = storage.KEYS.queryHistory;
  const UI_KEY = storage.KEYS.queryLibraryUi;
  const API_BASE = "api/query-library";
  const MAX_DEPTH = 8;
  const MAX_NAME_CHARS = 200;
  const MAX_DESCRIPTION_CHARS = 4000;
  const MAX_SQL_CHARS = 256 * 1024;
  const MAX_TAGS = 16;
  const PROMPT_SQL_CHARS = 4000;
  const PANE_SQL_CHARS = 20000;
  const SERVER_RELOAD_AFTER_MS = 30000;
  const HOST_WAIT_MS = 5000;
  // util.latest keys of the list reloads.
  const LIBRARY_REQUEST = "queryLibrary:library";
  const HISTORY_REQUEST = "queryLibrary:history";
  const ELLIPSIS = "\u2026";
  const MIDDOT = " \u00b7 ";

  // The two roots of Saved, in their order.
  const STORES = ["server", "local"];
  const ROOT_LABELS = { server: "Shared server storage", local: "Local browser storage" };
  const ROOT_HINTS = {
    server: "Shared by everyone using this ChDash server, in its query library file.",
    local: "Only this browser sees these queries (its localStorage).",
  };

  // ---------------------------------------------------------------- helpers

  const fold = (value) => String(value == null ? "" : value).trim().toLocaleLowerCase();
  const newId = (prefix) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const byName = (a, b) => String(a.name).localeCompare(String(b.name), "en", { numeric: true, sensitivity: "base" });

  // The library's names for the sprite's drawings (ns.icon).
  const ICONS = {
    search: "search", lock: "lock", folder: "folder", folderOpen: "folder-open", folderPlus: "folder-plus", query: "file", plus: "plus",
    back: "chevron-left", server: "database", local: "device-desktop", edit: "pencil", move: "folder-symlink", remove: "trash", save: "device-floppy",
  };

  function icon(name) {
    return ns.icon.el(ICONS[name], { className: `qlIcon qlIcon--${name}` });
  }

  function iconButton(name, label, action) {
    const button = h("button", { class: "qlIconButton" });
    button.type = "button";
    button.dataset.action = action;
    button.setAttribute("aria-label", label);
    button.title = label;
    button.appendChild(icon(name));
    return button;
  }

  function oneLine(text, max = 160) {
    const flat = String(text || "").replace(/\s+/g, " ").trim();
    return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}${ELLIPSIS}` : flat;
  }

  function parseTags(text) {
    const seen = new Set();
    const out = [];
    for (const raw of String(text || "").split(",")) {
      const tag = raw.trim().slice(0, 64);
      if (!tag || seen.has(fold(tag))) continue;
      seen.add(fold(tag));
      out.push(tag);
      if (out.length >= MAX_TAGS) break;
    }
    return out;
  }

  // Instants and counts in ns.format (docs/ui-foundations.md): browser-local
  // 24 h "Sep 12 16:29:57" ("16:29:57" under a day heading), "1,234 queries".
  const format = ns.format;

  function dayKey(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }

  function dayLabel(ms) {
    const today = new Date();
    const key = dayKey(ms);
    if (key === dayKey(today.getTime())) return "Today";
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    if (key === dayKey(yesterday.getTime())) return "Yesterday";
    const d = new Date(ms);
    const opts = { weekday: "short", month: "short", day: "numeric" };
    if (d.getFullYear() !== today.getFullYear()) opts.year = "numeric";
    return d.toLocaleDateString("en-US", opts);
  }

  function readJson(key, fallback) {
    const value = storage.pref(key, null, { json: true }).get();
    return value == null ? fallback : value;
  }

  // false when the browser refused the write (quota, private mode).
  function writeJson(key, value) {
    return storage.pref(key, null, { json: true }).set(value);
  }

  // The host whose library is shown: the one selected in the header.
  const currentHost = () => String(state.selectedHostId || "");

  // The editor's line-number setting (app_autocomplete.js keeps the root
  // class in step with it): the SQL preview shows its gutter when it is on.
  const lineNumbersOn = () => !document.documentElement.classList.contains("chdash-line-numbers-hidden");

  class LibraryError extends Error {
    constructor(code, message, extra = {}) {
      super(message);
      this.code = code;
      this.field = extra.field || "";
      this.status = extra.status || 0;
    }
  }

  const validation = (field, message) => new LibraryError("validation", message, { field });

  // ------------------------------------------------------------------ model

  function cleanText(value, max) {
    return typeof value === "string" ? value.slice(0, max) : "";
  }

  const hostOf = (item) => (typeof item?.host_id === "string" ? item.host_id : item?.host_id == null ? "" : String(item.host_id));
  const emptyLibrary = () => ({ revision: 0, folders: [], queries: [] });

  // Every folder and query belongs to one host: one without a host_id is
  // dropped (docs/query-library.md, "Entries without a host").
  function normalizeLibrary(raw) {
    const folders = [];
    const queries = [];
    const ids = new Set();
    for (const f of Array.isArray(raw?.folders) ? raw.folders : []) {
      if (!f || typeof f.id !== "string" || typeof f.name !== "string" || !hostOf(f) || ids.has(f.id)) continue;
      ids.add(f.id);
      folders.push({
        id: f.id,
        host_id: hostOf(f),
        parent_id: typeof f.parent_id === "string" && f.parent_id ? f.parent_id : null,
        name: f.name,
        description: cleanText(f.description, MAX_DESCRIPTION_CHARS),
        created_at_ms: Number(f.created_at_ms) || 0,
        updated_at_ms: Number(f.updated_at_ms) || Number(f.created_at_ms) || 0,
      });
    }
    const folderHosts = new Map(folders.map((f) => [f.id, f.host_id]));
    // A parent that does not exist, belongs to another host (or a cycle) puts
    // the folder at the top level of its host.
    for (const f of folders) {
      if (f.parent_id && folderHosts.get(f.parent_id) !== f.host_id) f.parent_id = null;
      const seen = new Set([f.id]);
      let cur = f.parent_id;
      while (cur) {
        if (seen.has(cur)) {
          f.parent_id = null;
          break;
        }
        seen.add(cur);
        cur = folders.find((x) => x.id === cur)?.parent_id || null;
      }
    }
    for (const q of Array.isArray(raw?.queries) ? raw.queries : []) {
      if (!q || typeof q.id !== "string" || typeof q.name !== "string" || typeof q.sql !== "string" || !hostOf(q) || ids.has(q.id)) continue;
      ids.add(q.id);
      queries.push({
        id: q.id,
        folder_id: typeof q.folder_id === "string" && folderHosts.get(q.folder_id) === hostOf(q) ? q.folder_id : null,
        name: q.name,
        description: cleanText(q.description, MAX_DESCRIPTION_CHARS),
        sql: q.sql,
        host_id: hostOf(q),
        tags: Array.isArray(q.tags) ? q.tags.filter((t) => typeof t === "string" && t).slice(0, MAX_TAGS) : [],
        created_at_ms: Number(q.created_at_ms) || 0,
        updated_at_ms: Number(q.updated_at_ms) || Number(q.created_at_ms) || 0,
      });
    }
    return { revision: Number(raw?.revision) || 0, folders, queries };
  }

  // The part of a library that belongs to one host.
  function scopeToHost(lib, host) {
    return {
      revision: lib.revision,
      folders: lib.folders.filter((f) => f.host_id === host),
      queries: lib.queries.filter((q) => q.host_id === host),
    };
  }

  const folderById = (lib, id) => (id ? lib.folders.find((f) => f.id === id) || null : null);
  const queryById = (lib, id) => lib.queries.find((q) => q.id === id) || null;
  const childFolders = (lib, parentId) => lib.folders.filter((f) => f.parent_id === (parentId || null)).sort(byName);
  const childQueries = (lib, folderId) => lib.queries.filter((q) => q.folder_id === (folderId || null)).sort(byName);

  // Level of a folder: 1 for a top-level folder.
  function folderDepth(lib, id) {
    let depth = 0;
    let cur = folderById(lib, id);
    while (cur && depth <= MAX_DEPTH + 1) {
      depth += 1;
      cur = folderById(lib, cur.parent_id);
    }
    return depth;
  }

  // Levels a folder occupies with its subfolders: 1 for a leaf folder.
  function subtreeHeight(lib, id) {
    const kids = childFolders(lib, id);
    return 1 + (kids.length ? Math.max(...kids.map((k) => subtreeHeight(lib, k.id))) : 0);
  }

  function isInside(lib, folderId, ancestorId) {
    let cur = folderById(lib, folderId);
    while (cur) {
      if (cur.id === ancestorId) return true;
      cur = folderById(lib, cur.parent_id);
    }
    return false;
  }

  function folderPath(lib, id) {
    const names = [];
    let cur = folderById(lib, id);
    while (cur && names.length <= MAX_DEPTH) {
      names.unshift(cur.name);
      cur = folderById(lib, cur.parent_id);
    }
    return names;
  }

  // A folder as the pickers and the preview write it: "/" for the top
  // level of a root, then "/Operations", "/Operations/Merges".
  const folderPathText = (lib, id) => `/${folderPath(lib, id).join("/")}`;

  function subtreeCounts(lib, id) {
    let folders = 0;
    let queries = childQueries(lib, id).length;
    for (const child of childFolders(lib, id)) {
      const sub = subtreeCounts(lib, child.id);
      folders += 1 + sub.folders;
      queries += sub.queries;
    }
    return { folders, queries };
  }

  // A folder and everything in it, as a copy: its folders parents first (the
  // folder itself without a parent), their queries.
  function subtreeOf(lib, folderId) {
    const folders = [];
    const queries = [];
    const walk = (id) => {
      const f = folderById(lib, id);
      if (!f) return;
      folders.push({ id: f.id, parent_id: f.id === folderId ? null : f.parent_id, name: f.name, description: f.description, created_at_ms: f.created_at_ms });
      for (const q of childQueries(lib, id)) {
        queries.push({ folder_id: id, name: q.name, description: q.description, sql: q.sql, tags: q.tags, created_at_ms: q.created_at_ms, updated_at_ms: q.updated_at_ms });
      }
      for (const child of childFolders(lib, id)) walk(child.id);
    };
    walk(folderId);
    return { folders, queries };
  }

  function validName(value, field = "name") {
    const name = String(value || "").trim();
    if (!name) throw validation(field, "A name is required.");
    if (name.length > MAX_NAME_CHARS) throw validation(field, `A name is at most ${MAX_NAME_CHARS} characters.`);
    return name;
  }

  function validDescription(value) {
    const text = String(value || "").trim();
    if (text.length > MAX_DESCRIPTION_CHARS) throw validation("description", `A description is at most ${MAX_DESCRIPTION_CHARS} characters.`);
    return text;
  }

  function validSql(value) {
    const sql = String(value || "").trim();
    if (!sql) throw validation("sql", "The query is empty.");
    if (sql.length > MAX_SQL_CHARS) throw new LibraryError("too_large", "The query is too large to be saved.", { field: "sql" });
    return sql;
  }

  function assertUniqueFolder(lib, parentId, name, exceptId) {
    if (lib.folders.some((f) => f.parent_id === (parentId || null) && f.id !== exceptId && fold(f.name) === fold(name))) {
      throw validation("name", `A folder named \u201c${name}\u201d already exists here.`);
    }
  }

  function assertUniqueQuery(lib, folderId, name, exceptId) {
    if (lib.queries.some((q) => q.folder_id === (folderId || null) && q.id !== exceptId && fold(q.name) === fold(name))) {
      throw validation("name", `A query named \u201c${name}\u201d already exists in this folder.`);
    }
  }

  function assertFolderTarget(lib, folderId) {
    if (folderId && !folderById(lib, folderId)) throw new LibraryError("not_found", "That folder no longer exists.");
  }

  // ----------------------------------------------------------- local adapter

  class NoHostError extends LibraryError {
    constructor() {
      super("no_host", "Select a host first: saved queries belong to a host.");
    }
  }

  function requireHost() {
    const host = currentHost();
    if (!host) throw new NoHostError();
    return host;
  }

  // chdash.queryLibrary.v2 holds the folders and queries of every host, each
  // with its host_id. An entry without a host is purged from the key the
  // first time it is read (no import of host-less entries: the old flat
  // chdash.savedQueries.v1 list is not read any more).
  function readLocalLibrary() {
    const raw = readJson(LOCAL_KEY, null);
    if (!raw || typeof raw !== "object" || raw.version !== 2) return emptyLibrary();
    const lib = normalizeLibrary(raw);
    const stored = (Array.isArray(raw.folders) ? raw.folders.length : 0) + (Array.isArray(raw.queries) ? raw.queries.length : 0);
    if (lib.folders.length + lib.queries.length < stored) writeJson(LOCAL_KEY, localPayload(lib));
    return lib;
  }

  function localPayload(lib) {
    return { version: 2, revision: lib.revision, updated_at_ms: Date.now(), folders: lib.folders, queries: lib.queries };
  }

  function writeLocalLibrary(lib) {
    if (!writeJson(LOCAL_KEY, localPayload(lib))) throw new LibraryError("too_large", "The browser storage is full: the change was not saved.");
  }

  // chdash.queryHistory.v1: storage.loadHistory() drops the entries without
  // a host; saving what it read purges them from the key.
  function purgeLocalHistory() {
    const raw = readJson(HISTORY_KEY, null);
    if (Array.isArray(raw) && raw.some((it) => !it || it.host_id == null || it.host_id === "")) storage.saveHistory(storage.loadHistory());
  }

  function createLocalAdapter() {
    // Each change re-reads the stored library (another tab may have changed
    // it), applies one validated edit to the current host's part and stores
    // the whole library with the next revision.
    const change = async (edit) => {
      const host = requireHost();
      const all = readLocalLibrary();
      const lib = scopeToHost(all, host);
      const id = edit(lib, host);
      all.folders = [...all.folders.filter((f) => f.host_id !== host), ...lib.folders];
      all.queries = [...all.queries.filter((q) => q.host_id !== host), ...lib.queries];
      all.revision += 1;
      writeLocalLibrary(all);
      lib.revision = all.revision;
      return { library: lib, id };
    };
    return {
      kind: "local",
      async load() {
        return { library: scopeToHost(readLocalLibrary(), currentHost()), writable: true };
      },
      createFolder({ parent_id = null, name, description = "" }) {
        return change((lib, host) => {
          assertFolderTarget(lib, parent_id);
          const clean = validName(name);
          if (folderDepth(lib, parent_id) + 1 > MAX_DEPTH) throw validation("parent_id", `Folders nest at most ${MAX_DEPTH} levels deep.`);
          assertUniqueFolder(lib, parent_id, clean);
          const ts = Date.now();
          const folder = { id: newId("f"), host_id: host, parent_id: parent_id || null, name: clean, description: validDescription(description), created_at_ms: ts, updated_at_ms: ts };
          lib.folders.push(folder);
          return folder.id;
        });
      },
      updateFolder(id, patch) {
        return change((lib) => {
          const folder = folderById(lib, id);
          if (!folder) throw new LibraryError("not_found", "That folder no longer exists.");
          const parent = patch.parent_id !== undefined ? patch.parent_id || null : folder.parent_id;
          const name = patch.name !== undefined ? validName(patch.name) : folder.name;
          if (parent !== folder.parent_id) {
            assertFolderTarget(lib, parent);
            if (parent === id || isInside(lib, parent, id)) throw validation("parent_id", "A folder cannot move into itself.");
            if (folderDepth(lib, parent) + subtreeHeight(lib, id) > MAX_DEPTH) throw validation("parent_id", `Folders nest at most ${MAX_DEPTH} levels deep.`);
          }
          assertUniqueFolder(lib, parent, name, id);
          folder.parent_id = parent;
          folder.name = name;
          if (patch.description !== undefined) folder.description = validDescription(patch.description);
          folder.updated_at_ms = Date.now();
          return id;
        });
      },
      deleteFolder(id, { recursive = false } = {}) {
        return change((lib) => {
          if (!folderById(lib, id)) throw new LibraryError("not_found", "That folder no longer exists.");
          const doomed = new Set([id, ...lib.folders.filter((f) => isInside(lib, f.id, id)).map((f) => f.id)]);
          const queries = lib.queries.filter((q) => doomed.has(q.folder_id));
          if (!recursive && (doomed.size > 1 || queries.length)) throw new LibraryError("not_empty", "The folder is not empty.");
          lib.folders = lib.folders.filter((f) => !doomed.has(f.id));
          lib.queries = lib.queries.filter((q) => !doomed.has(q.folder_id));
          return id;
        });
      },
      createQuery({ folder_id = null, name, description = "", sql, tags = [] }) {
        return change((lib, host) => {
          assertFolderTarget(lib, folder_id);
          const clean = validName(name);
          assertUniqueQuery(lib, folder_id, clean);
          const ts = Date.now();
          const query = {
            id: newId("q"), folder_id: folder_id || null, name: clean, description: validDescription(description), sql: validSql(sql),
            host_id: host, tags: Array.isArray(tags) ? tags.slice(0, MAX_TAGS) : [], created_at_ms: ts, updated_at_ms: ts,
          };
          lib.queries.push(query);
          return query.id;
        });
      },
      updateQuery(id, patch) {
        return change((lib) => {
          const query = queryById(lib, id);
          if (!query) throw new LibraryError("not_found", "That query no longer exists.");
          const folder = patch.folder_id !== undefined ? patch.folder_id || null : query.folder_id;
          if (folder !== query.folder_id) assertFolderTarget(lib, folder);
          const name = patch.name !== undefined ? validName(patch.name) : query.name;
          assertUniqueQuery(lib, folder, name, id);
          query.folder_id = folder;
          query.name = name;
          if (patch.description !== undefined) query.description = validDescription(patch.description);
          if (patch.sql !== undefined) query.sql = validSql(patch.sql);
          if (patch.tags !== undefined) query.tags = Array.isArray(patch.tags) ? patch.tags.slice(0, MAX_TAGS) : [];
          query.updated_at_ms = Date.now();
          return id;
        });
      },
      deleteQuery(id) {
        return change((lib) => {
          if (!queryById(lib, id)) throw new LibraryError("not_found", "That query no longer exists.");
          lib.queries = lib.queries.filter((q) => q.id !== id);
          return id;
        });
      },
      // A folder copied in from the other root (subtreeOf), under parent_id:
      // new ids, nothing merged or renamed. Resolves with the copy's id.
      copyTree({ parent_id = null, folders = [], queries = [] }) {
        return change((lib, host) => {
          assertFolderTarget(lib, parent_id);
          const ids = new Map();
          const ts = Date.now();
          for (const f of folders) {
            const parent = f.parent_id && ids.has(f.parent_id) ? ids.get(f.parent_id) : parent_id || null;
            const name = validName(f.name);
            if (folderDepth(lib, parent) + 1 > MAX_DEPTH) throw validation("parent_id", `Folders nest at most ${MAX_DEPTH} levels deep.`);
            assertUniqueFolder(lib, parent, name);
            const folder = { id: newId("f"), host_id: host, parent_id: parent, name, description: validDescription(f.description), created_at_ms: Number(f.created_at_ms) || ts, updated_at_ms: ts };
            lib.folders.push(folder);
            ids.set(f.id, folder.id);
          }
          for (const q of queries) {
            const folder = q.folder_id && ids.has(q.folder_id) ? ids.get(q.folder_id) : parent_id || null;
            const name = validName(q.name);
            assertUniqueQuery(lib, folder, name);
            lib.queries.push({
              id: newId("q"), folder_id: folder, name, description: validDescription(q.description), sql: validSql(q.sql), host_id: host,
              tags: Array.isArray(q.tags) ? q.tags.slice(0, MAX_TAGS) : [], created_at_ms: Number(q.created_at_ms) || ts, updated_at_ms: Number(q.updated_at_ms) || ts,
            });
          }
          return ids.get(folders[0]?.id) || "";
        });
      },
    };
  }

  // The browser History (chdash.queryHistory.v1, written by app_run.js): the
  // runs of the current host.
  function createLocalHistory() {
    const toEntry = (it) => ({
      id: `h_${it.ts_ms}`,
      sql: String(it.sql_formatted || it.sql_raw || ""),
      host_id: it.host_id || null,
      ran_at_ms: it.ts_ms,
      elapsed_ms: Number.isFinite(it.elapsed_ms) ? it.elapsed_ms : null,
      rows: Number.isFinite(it.rows) ? it.rows : null,
      status: it.status || "",
      error: it.error || "",
    });
    return {
      async list({ q = "" } = {}) {
        const host = currentHost();
        const terms = fold(q).split(/\s+/).filter(Boolean);
        const entries = storage.loadHistory().filter((it) => it.host_id === host).map(toEntry).filter((e) => {
          if (!terms.length) return true;
          const hay = fold(`${e.sql} ${e.error}`);
          return terms.every((t) => hay.includes(t));
        });
        return { entries };
      },
      async remove(id) {
        storage.saveHistory(storage.loadHistory().filter((it) => `h_${it.ts_ms}` !== id));
      },
    };
  }

  // ---------------------------------------------------------- server adapter

  const STATUS_CODES = { 400: "validation", 403: "read_only", 404: "not_found", 409: "conflict", 413: "too_large" };

  function errorFromResponse(status, payload) {
    const raw = String(payload?.error || payload?.error_code || "");
    let code = STATUS_CODES[status] || "server";
    if (raw === "not_empty" || raw === "read_only" || raw === "conflict" || raw === "too_large" || raw === "not_found") code = raw;
    if (status === 400 || raw === "validation" || raw === "invalid") code = "validation";
    const fallback = {
      validation: "The server rejected the change.",
      read_only: "The library is read-only on this server.",
      not_found: "That item no longer exists.",
      conflict: "The library was changed elsewhere.",
      not_empty: "The folder is not empty.",
      too_large: "The library is full: the change is too large.",
      server: `The server answered ${status}.`,
    }[code];
    return new LibraryError(code, String(payload?.message || fallback), { field: payload?.field, status });
  }

  function createServerAdapter() {
    let revision = null;

    // api.request (app_api.js), with the library revision as If-Match. Writes
    // are accepted from this page only: a same-origin request with a JSON
    // content type (the server refuses other types with 415).
    async function request(method, path, body, { ifMatch = true, signal } = {}) {
      const headers = {};
      if (ifMatch && revision != null) headers["If-Match"] = String(revision);
      try {
        return await ns.api.request(`${API_BASE}${path}`, { method, body, headers, signal });
      } catch (err) {
        if (util.isAbort(err)) throw err;
        if (err && err.status) throw errorFromResponse(err.status, err.body);
        throw new LibraryError("network", "The server could not be reached.");
      }
    }

    const enc = encodeURIComponent;

    async function load({ signal } = {}) {
      const data = await request("GET", `?host_id=${enc(requireHost())}`, undefined, { ifMatch: false, signal });
      revision = Number.isFinite(Number(data.revision)) ? Number(data.revision) : null;
      return {
        library: normalizeLibrary(data),
        writable: data.writable === true && !data.load_error,
        loadError: data.load_error ? String(data.load_error) : "",
      };
    }

    // One change: on a 409 conflict, reload (new revision) and retry once.
    // idOf picks the new item's id out of the answer.
    async function change(method, path, body, idOf = (response) => response?.id || "") {
      const attempt = async () => {
        const response = await request(method, path, body);
        const loaded = await load();
        return { ...loaded, id: idOf(response) };
      };
      try {
        return await attempt();
      } catch (err) {
        if (err.code !== "conflict") throw err;
        await load();
        try {
          return await attempt();
        } catch (again) {
          if (again.code === "conflict") {
            throw new LibraryError("conflict", "The library was changed by someone else at the same time; your change was not applied. The library has been reloaded.");
          }
          throw again;
        }
      }
    }

    // New folders and queries belong to the current host.
    return {
      kind: "server",
      load,
      createFolder: (input) => change("POST", "/folders", { host_id: requireHost(), parent_id: input.parent_id || null, name: input.name, description: input.description || "" }),
      updateFolder: (id, patch) => change("PATCH", `/folders/${enc(id)}`, patch),
      deleteFolder: (id, { recursive = false } = {}) => change("DELETE", `/folders/${enc(id)}${recursive ? "?recursive=1" : ""}`),
      createQuery: (input) => change("POST", "/queries", { ...input, host_id: requireHost() }),
      updateQuery: (id, patch) => change("PATCH", `/queries/${enc(id)}`, patch),
      deleteQuery: (id) => change("DELETE", `/queries/${enc(id)}`),
      // A folder copied in from the browser's root: one all-or-nothing
      // import in copy mode (nothing merged, skipped or renamed), under
      // parent_id. Resolves with the copy's id.
      copyTree: ({ parent_id = null, folders = [], queries = [] }) => change("POST", "/import", {
        host_id: requireHost(),
        copy: true,
        folders: folders.map((f) => ({ id: f.id, parent_id: f.parent_id || parent_id || null, name: f.name, description: f.description || "" })),
        queries: queries.map((q) => ({ folder_id: q.folder_id || parent_id || null, name: q.name, description: q.description || "", sql: q.sql, tags: q.tags || [], created_at_ms: q.created_at_ms || undefined, updated_at_ms: q.updated_at_ms || undefined })),
      }, (response) => response?.folder_ids?.[folders[0]?.id] || ""),
    };
  }

  // -------------------------------------------------------------- controller

  function freshHistoryState(q = "") {
    return { entries: [], loading: false, loaded: false, q, error: "" };
  }

  // One root: its adapter, the current host's library and its state.
  function newStore(kind, adapter, writable) {
    return { kind, adapter, writable, library: emptyLibrary(), loadError: "", fatal: "", loadedAt: 0 };
  }

  const uiPrefs = readJson(UI_KEY, {});
  const ctl = {
    started: null,
    // The roots: "local" always, "server" when features.query_library is on.
    stores: { server: null, local: null },
    history: null,
    // The host the shown library and History belong to.
    host: "",
    // Open folders ("<store>:<folder id>") and closed roots ("<store>").
    expanded: new Set(Array.isArray(uiPrefs.expanded) ? uiPrefs.expanded.filter((x) => typeof x === "string" && x.includes(":")) : []),
    closedRoots: new Set(Array.isArray(uiPrefs.closedRoots) ? uiPrefs.closedRoots.filter((x) => STORES.includes(x)) : []),
    // The selected item of each tab (its data-key), shown in the preview.
    selection: { saved: "", history: "" },
    search: "",
    // The saved query the editor holds: { store, id, sql }.
    opened: null,
    busy: false,
    historyState: freshHistoryState(),
    shown: "",
    rendered: { library: false, history: false },
  };

  const storeList = () => STORES.map((kind) => ctl.stores[kind]).filter(Boolean);
  const storeOf = (kind) => ctl.stores[kind] || null;
  const editableStore = (store) => !!store && store.writable && !store.fatal && !!ctl.host;
  const anyEditable = () => storeList().some(editableStore);
  // Where a new folder or query goes by default: the server root when it
  // can take it, else this browser's.
  const defaultStore = () => (editableStore(ctl.stores.server) ? "server" : "local");

  function saveUiPrefs() {
    writeJson(UI_KEY, { expanded: [...ctl.expanded].slice(-400), closedRoots: [...ctl.closedRoots] });
  }

  // /api/version picks the roots; without an answer in 4 s, the browser's only.
  function waitForFeatures() {
    return Promise.race([ns.features.ready, new Promise((resolve) => setTimeout(resolve, 4000))]);
  }

  // The library belongs to a host: at page load (a ?saved= link) the hosts
  // may not be known yet, so the first selection is awaited (5 s at most).
  function waitForHost() {
    if (currentHost()) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        window.removeEventListener("chdash:host-changed", done);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, HOST_WAIT_MS);
      window.addEventListener("chdash:host-changed", done);
    });
  }

  function start() {
    if (!ctl.started) {
      ctl.started = (async () => {
        await Promise.all([waitForFeatures(), waitForHost()]);
        const features = ns.features.get("query_library");
        ctl.stores.local = newStore("local", createLocalAdapter(), true);
        readLocalLibrary();
        if (features.enabled) {
          ctl.stores.server = newStore("server", createServerAdapter(), features.writable === true);
        }
        ctl.history = createLocalHistory();
        purgeLocalHistory();
        await reloadLibrary();
      })();
    }
    return ctl.started;
  }

  // One root's library for the current host. A reload supersedes the one in
  // flight (util.latest): only the answer for the host shown now is used.
  async function reloadStore(store) {
    const token = util.latest(`${LIBRARY_REQUEST}:${store.kind}`);
    const host = currentHost();
    if (!host) {
      Object.assign(store, { library: emptyLibrary(), fatal: "", loadError: "" });
      return;
    }
    try {
      const loaded = await store.adapter.load({ signal: token.signal });
      if (!token.isCurrent()) return;
      store.library = loaded.library;
      store.loadError = loaded.loadError || "";
      store.fatal = "";
      if (store.kind === "server") store.writable = loaded.writable === true;
      store.loadedAt = Date.now();
    } catch (err) {
      if (util.isAbort(err) || !token.isCurrent()) return;
      store.fatal = err instanceof LibraryError ? err.message : "The library could not be loaded.";
    }
  }

  // Both roots of the current host.
  async function reloadLibrary() {
    ctl.host = currentHost();
    await Promise.all(storeList().map((store) => reloadStore(store)));
    if (ctl.rendered.library) renderLibrary();
  }

  // Another host is selected: its library and History replace the shown
  // ones (selection, preview and the opened query are the old host's).
  function onHostChanged() {
    if (!ctl.started || currentHost() === ctl.host) return;
    ctl.selection = { saved: "", history: "" };
    ctl.opened = null;
    setPreviewStep(false);
    const historyShown = ctl.historyState.loaded || ctl.rendered.history;
    ctl.historyState = freshHistoryState(ctl.historyState.q);
    void ctl.started.then(async () => {
      await reloadLibrary();
      if (historyShown) await loadHistory();
      if (ctl.shown) renderPreview();
    });
  }

  window.addEventListener("chdash:host-changed", onHostChanged);

  // A change's answer: the root's new library (and the server's writable).
  function takeResult(store, result) {
    store.library = result.library;
    if (result.loadError !== undefined) store.loadError = result.loadError || "";
    if (store.kind === "server" && result.writable !== undefined) store.writable = result.writable === true;
    store.loadedAt = Date.now();
  }

  // Runs one change of a root through its adapter, re-renders with the new
  // library and tells the user what failed (after a conflict retry, a
  // read-only answer...): in the dialog that asked for it (inDialog), else in
  // a toast. Validation errors always go back to the caller.
  async function apply(storeKind, operation, { success = "", select = null, inDialog = false } = {}) {
    const store = storeOf(storeKind);
    if (!editableStore(store)) {
      toast(ctl.host ? `${ROOT_LABELS[storeKind]} is read-only.` : new NoHostError().message, "error");
      return null;
    }
    ctl.busy = true;
    try {
      const result = await operation(store.adapter);
      takeResult(store, result);
      if (typeof select === "function") ctl.selection.saved = select(result.id) || ctl.selection.saved;
      else if (select) ctl.selection.saved = select;
      renderLibrary({ keepFocus: true });
      if (success) toast(success);
      return result;
    } catch (err) {
      if (err instanceof LibraryError && err.code === "validation") throw err;
      const message = err instanceof LibraryError ? err.message : "The change failed.";
      if (err instanceof LibraryError && err.code === "read_only") store.writable = false;
      if (store.kind === "server") await reloadStore(store);
      renderLibrary({ keepFocus: true });
      if (inDialog) throw new LibraryError(err instanceof LibraryError ? err.code : "server", message);
      toast(message, "error");
      return null;
    } finally {
      ctl.busy = false;
    }
  }

  // A place in the library: a root and a folder of it (null: its top).
  const locValue = (loc) => `${loc.store}:${loc.folderId || ""}`;
  function parseLoc(value) {
    const text = String(value || "");
    const at = text.indexOf(":");
    const store = at > 0 ? text.slice(0, at) : "";
    return STORES.includes(store) ? { store, folderId: text.slice(at + 1) || null } : null;
  }
  const whereText = (loc) => `${ROOT_LABELS[loc.store]} ${folderPathText(storeOf(loc.store)?.library || emptyLibrary(), loc.folderId)}`;

  // Moves a query or a folder from one root to the other: a copy into the
  // target (the server's in one all-or-nothing request), then the removal
  // from the source. `patch` changes the query on the way (Edit, Save).
  async function moveAcross(item, target, { inDialog = false, patch = null } = {}) {
    const source = storeOf(item.store);
    const dest = storeOf(target.store);
    if (!editableStore(source) || !editableStore(dest)) {
      const message = `${ROOT_LABELS[editableStore(dest) ? item.store : target.store]} is read-only.`;
      if (inDialog) throw new LibraryError("read_only", message);
      toast(message, "error");
      return false;
    }
    const srcLib = source.library;
    const dstLib = dest.library;
    const folderId = target.folderId || null;
    ctl.busy = true;
    let copied = null;
    let sql = "";
    try {
      assertFolderTarget(dstLib, folderId);
      if (item.kind === "query") {
        const query = queryById(srcLib, item.id);
        if (!query) throw new LibraryError("not_found", "That query no longer exists.");
        const input = { folder_id: folderId, name: query.name, description: query.description, sql: query.sql, tags: query.tags, ...(patch || {}) };
        input.name = validName(input.name);
        assertUniqueQuery(dstLib, folderId, input.name);
        sql = String(input.sql);
        copied = await dest.adapter.createQuery(input);
      } else {
        const folder = folderById(srcLib, item.id);
        if (!folder) throw new LibraryError("not_found", "That folder no longer exists.");
        if (folderDepth(dstLib, folderId) + subtreeHeight(srcLib, folder.id) > MAX_DEPTH) throw validation("target", `Folders nest at most ${MAX_DEPTH} levels deep.`);
        assertUniqueFolder(dstLib, folderId, folder.name);
        copied = await dest.adapter.copyTree({ parent_id: folderId, ...subtreeOf(srcLib, folder.id) });
      }
    } catch (err) {
      ctl.busy = false;
      if (dest.kind === "server" && !(err instanceof LibraryError && err.code === "validation")) await reloadStore(dest);
      renderLibrary({ keepFocus: true });
      if (inDialog) throw err;
      toast(util.errorText(err, "The item could not be moved."), "error");
      return false;
    }
    takeResult(dest, copied);
    // The copy is in: the source's item goes.
    let removed = true;
    try {
      const gone = item.kind === "query" ? await source.adapter.deleteQuery(item.id) : await source.adapter.deleteFolder(item.id, { recursive: true });
      takeResult(source, gone);
    } catch (err) {
      removed = false;
      await reloadStore(source);
      toast(`Copied to ${ROOT_LABELS[target.store]}, but it could not be removed from ${ROOT_LABELS[item.store]}: ${util.errorText(err, "the change failed")}`, "error");
    } finally {
      ctl.busy = false;
    }
    if (item.kind === "query" && ctl.opened?.store === item.store && ctl.opened.id === item.id) {
      ctl.opened = { store: target.store, id: copied.id, sql: sql || ctl.opened.sql };
    }
    ctl.selection.saved = keyOf(item.kind, target.store, copied.id);
    ctl.closedRoots.delete(target.store);
    if (folderId) expandPath(target.store, folderId);
    else saveUiPrefs();
    renderLibrary({ keepFocus: true });
    if (removed) toast(`Moved to ${whereText(target)}.`);
    return true;
  }

  // ------------------------------------------------------------ editor glue

  function editorSql() {
    return String(dom.queryTextArea?.value || "");
  }

  function setEditorSql(sql) {
    if (!dom.queryTextArea) return;
    util.replaceTextAreaValue(dom.queryTextArea, String(sql || ""));
  }

  // Opening a query closes the dialog; the editor takes the focus.
  function closePanel() {
    ns.ui?.closeQueryLibrary?.({ restoreFocus: false });
  }

  // "Load in editor": the editor takes the SQL (a saved query is then the
  // opened one, marked in the tree) and the dialog closes.
  function openInEditor(item, { store = "", savedQuery = null } = {}) {
    if (!item) return;
    setEditorSql(item.sql);
    ctl.opened = savedQuery ? { store, id: savedQuery.id, sql: String(savedQuery.sql) } : null;
    ns.ui?.syncQueryUrl?.(item.sql);
    closePanel();
    dom.queryTextArea?.focus({ preventScroll: true });
    if (ctl.rendered.library) renderTree();
  }

  // ------------------------------------------------------------------ toast

  // In the top dialog (the page under a modal dialog is inert and hidden from
  // assistive technology); data-dialog-float moves it to the next one down
  // when that dialog closes.
  let toastTimer = 0;
  function toast(message, kind = "info") {
    let node = $(".qlToast");
    if (!node) {
      node = h("div", { class: "qlToast" });
      node.dataset.dialogFloat = "";
    }
    const layer = ns.dialog?.host?.() || document.body;
    if (node.parentNode !== layer) layer.appendChild(node);
    node.textContent = message;
    node.className = `qlToast qlToast--${kind}`;
    node.setAttribute("role", kind === "error" ? "alert" : "status");
    node.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      node.hidden = true;
    }, kind === "error" ? 7000 : 3500);
  }

  // ---------------------------------------------------------------- dialogs

  // A form prompt: the shared ns.dialog (app_ui_dialog.js), stacked over the
  // library. Resolves with the submitted value, or null when dismissed.
  function openDialog({ title, body, submitLabel = "Save", extraButtons = [], danger = false, onSubmit }) {
    return ns.dialog.open({
      title,
      body,
      className: "qlDialog",
      actions: [
        { label: "Cancel", value: null },
        ...extraButtons.map((extra) => ({ label: extra.label, value: extra.value })),
        { label: submitLabel, value: "submit", kind: danger ? "danger" : "primary", submit: true },
      ],
      onSubmit,
    });
  }

  function field(label, control, hint) {
    const wrap = h("label", { class: "qlField" });
    wrap.appendChild(h("span", { class: "qlField__label" }, label));
    wrap.appendChild(control);
    if (hint) wrap.appendChild(h("span", { class: "qlField__hint" }, hint));
    return wrap;
  }

  function textInput(name, value, { placeholder = "", maxLength = MAX_NAME_CHARS, autofocus = false } = {}) {
    const input = h("input", { class: "qlInput" });
    input.type = "text";
    input.name = name;
    input.dataset.field = name;
    input.value = value || "";
    input.placeholder = placeholder;
    input.maxLength = maxLength;
    input.autocomplete = "off";
    input.spellcheck = false;
    if (autofocus) input.autofocus = true;
    return input;
  }

  function textArea(name, value, placeholder) {
    const area = h("textarea", { class: "qlInput qlInput--area" });
    area.name = name;
    area.dataset.field = name;
    area.value = value || "";
    area.placeholder = placeholder || "";
    area.rows = 3;
    area.maxLength = MAX_DESCRIPTION_CHARS;
    return area;
  }

  // Folder <select> (Save, Edit, Move, New folder): one group per root
  // ("Shared server storage", "Local browser storage"), each with "/" for
  // its top level, then every folder of the host as its path
  // ("/Operations/Merges"). A read-only root's group is disabled. `exclude`
  // ({ store, id }): a folder being moved, which cannot go into itself;
  // a target too deep for it is disabled.
  function folderSelect(name, selected, { exclude = null } = {}) {
    const select = h("select", { class: "qlInput qlSelect" });
    select.name = name;
    select.dataset.field = name;
    const movedLib = exclude ? storeOf(exclude.store)?.library : null;
    const height = exclude && movedLib ? subtreeHeight(movedLib, exclude.id) : 0;
    for (const store of storeList()) {
      const lib = store.library;
      const group = h("optgroup");
      const writable = editableStore(store);
      group.label = writable ? ROOT_LABELS[store.kind] : `${ROOT_LABELS[store.kind]} (read-only)`;
      group.dataset.store = store.kind;
      if (!writable) group.disabled = true;
      const top = h("option", null, "/");
      top.value = `${store.kind}:`;
      if (exclude && height > MAX_DEPTH) top.disabled = true;
      group.appendChild(top);
      const walk = (parentId) => {
        for (const folder of childFolders(lib, parentId)) {
          if (exclude && exclude.store === store.kind && (folder.id === exclude.id || isInside(lib, folder.id, exclude.id))) continue;
          const option = h("option", null, folderPathText(lib, folder.id));
          option.value = `${store.kind}:${folder.id}`;
          if (exclude && folderDepth(lib, folder.id) + height > MAX_DEPTH) option.disabled = true;
          group.appendChild(option);
          walk(folder.id);
        }
      };
      walk(null);
      select.appendChild(group);
    }
    const wanted = selected ? locValue(selected) : `${defaultStore()}:`;
    const options = [...select.options];
    const usable = (option) => option && !option.disabled && !option.parentElement?.disabled;
    const pick = options.find((o) => o.value === wanted && usable(o)) || options.find((o) => o.value === `${defaultStore()}:` && usable(o)) || options.find(usable);
    if (pick) select.value = pick.value;
    return select;
  }

  // Highlighted SQL, clipped (a prompt shows the start, the pane more):
  // the shared read-only SQL block (ui.sqlBlock). The pane's block has its
  // copy button and, when the editor shows line numbers, their gutter (its
  // lines then scroll rather than wrap, so each number stays on its line).
  function sqlPreview(sql, max = PROMPT_SQL_CHARS, { pane = false } = {}) {
    const text = String(sql || "");
    const clipped = text.length > max ? `${text.slice(0, max)}\n${ELLIPSIS}` : text;
    const gutter = pane && lineNumbersOn();
    return ns.ui.sqlBlock({ sql: clipped, wrap: !gutter, gutter, copy: pane, label: "Query", className: "qlSql" });
  }

  // The selected place in Saved, as a default target: the selected root or
  // folder, a selected query's folder.
  function selectedLoc() {
    const sel = parseKey(ctl.selection.saved);
    if (!sel || !storeOf(sel.store)) return null;
    const lib = storeOf(sel.store).library;
    if (sel.kind === "root") return { store: sel.store, folderId: null };
    if (sel.kind === "folder" && folderById(lib, sel.id)) return { store: sel.store, folderId: sel.id };
    if (sel.kind === "query") return { store: sel.store, folderId: queryById(lib, sel.id)?.folder_id || null };
    return null;
  }

  // The saved query the editor holds (Ctrl+S updates it): { store, query }.
  function openedQuery() {
    const store = ctl.opened ? storeOf(ctl.opened.store) : null;
    const query = store ? queryById(store.library, ctl.opened.id) : null;
    return query ? { store: store.kind, query } : null;
  }

  // Save the editor (or a History entry) as a library query, in either
  // root. When the editor holds a query opened from an editable root, the
  // dialog offers to update it.
  async function saveDialog({ sql = null, fromHistory = null } = {}) {
    await start();
    if (!ctl.host) {
      toast(new NoHostError().message, "error");
      return;
    }
    if (!anyEditable()) {
      toast("The library is read-only.", "error");
      return;
    }
    const text = String(sql != null ? sql : editorSql()).trim();
    if (!text) {
      toast("Write a query first: the editor is empty.", "error");
      dom.queryTextArea?.focus();
      return;
    }
    const held = sql == null ? openedQuery() : null;
    const opened = held && editableStore(storeOf(held.store)) ? held : null;
    const where = opened ? { store: opened.store, folderId: opened.query.folder_id } : selectedLoc();
    const body = h("div", { class: "qlForm" });
    const name = textInput("name", opened ? opened.query.name : "", { placeholder: "e.g. Largest tables", autofocus: true });
    const description = textArea("description", opened ? opened.query.description : "", "What it answers, when to use it (optional)");
    const folder = folderSelect("folder_id", where);
    const tags = textInput("tags", opened ? opened.query.tags.join(", ") : "", { placeholder: "comma, separated (optional)", maxLength: 600 });
    body.append(field("Name", name), field("Description", description), field("Folder", folder), field("Tags", tags));
    const preview = h("div", { class: "qlField" });
    preview.appendChild(h("span", { class: "qlField__label" }, fromHistory ? "SQL (from History)" : "SQL (from the editor)"));
    preview.appendChild(sqlPreview(text));
    body.appendChild(preview);
    await openDialog({
      title: opened ? `Save \u201c${opened.query.name}\u201d` : "Save to library",
      body,
      submitLabel: opened ? "Update" : "Save",
      extraButtons: opened ? [{ label: "Save as new", value: "new" }] : [],
      onSubmit: async (action) => {
        const target = parseLoc(folder.value);
        if (!target) throw validation("folder_id", "Pick a folder.");
        const input = { folder_id: target.folderId, name: validName(name.value), description: validDescription(description.value), sql: text, tags: parseTags(tags.value) };
        const update = opened && action !== "new";
        let savedId = "";
        if (update && target.store !== opened.store) {
          // The opened query moves to the other root with its new content.
          const ok = await moveAcross({ kind: "query", store: opened.store, id: opened.query.id }, target, { inDialog: true, patch: input });
          if (!ok) return false;
          savedId = parseKey(ctl.selection.saved)?.id || "";
        } else {
          const result = await apply(
            target.store,
            (adapter) => (update ? adapter.updateQuery(opened.query.id, input) : adapter.createQuery(input)),
            { success: update ? "Query updated." : "Query saved.", select: (id) => keyOf("query", target.store, update ? opened.query.id : id), inDialog: true },
          );
          if (!result) return false;
          savedId = update ? opened.query.id : result.id;
        }
        if (sql == null && savedId) ctl.opened = { store: target.store, id: savedId, sql: text };
        ctl.closedRoots.delete(target.store);
        if (target.folderId) expandPath(target.store, target.folderId);
        else saveUiPrefs();
        renderLibrary({ keepFocus: false });
        return true;
      },
    });
  }

  async function editQueryDialog(storeKind, query) {
    const body = h("div", { class: "qlForm" });
    const name = textInput("name", query.name, { autofocus: true });
    const description = textArea("description", query.description, "What it answers, when to use it (optional)");
    const folder = folderSelect("folder_id", { store: storeKind, folderId: query.folder_id });
    const tags = textInput("tags", query.tags.join(", "), { placeholder: "comma, separated (optional)", maxLength: 600 });
    const replace = h("input");
    replace.type = "checkbox";
    replace.name = "replace_sql";
    const editor = editorSql().trim();
    replace.disabled = !editor || editor === query.sql.trim();
    const replaceLabel = h("label", { class: "qlCheck" });
    replaceLabel.append(replace, h("span", null, replace.disabled && editor ? "The editor holds this SQL" : "Replace the SQL with the editor content"));
    body.append(field("Name", name), field("Description", description), field("Folder", folder), field("Tags", tags), replaceLabel);
    const preview = h("div", { class: "qlField" });
    preview.appendChild(h("span", { class: "qlField__label" }, "SQL"));
    preview.appendChild(sqlPreview(query.sql));
    body.appendChild(preview);
    await openDialog({
      title: "Edit query",
      body,
      onSubmit: async () => {
        const target = parseLoc(folder.value) || { store: storeKind, folderId: query.folder_id };
        const patch = { name: validName(name.value), description: description.value, folder_id: target.folderId, tags: parseTags(tags.value) };
        if (replace.checked) patch.sql = validSql(editor);
        if (target.store !== storeKind) {
          if (!(await moveAcross({ kind: "query", store: storeKind, id: query.id }, target, { inDialog: true, patch }))) return false;
        } else {
          const result = await apply(storeKind, (adapter) => adapter.updateQuery(query.id, patch), { success: "Query updated.", select: keyOf("query", storeKind, query.id), inDialog: true });
          if (!result) return false;
        }
        if (target.folderId) expandPath(target.store, target.folderId);
        renderLibrary({ keepFocus: false });
        return true;
      },
    });
    focusSelected();
  }

  // Rename a folder, or a new folder (in `parent`, a { store, folderId }).
  async function folderDialog({ storeKind = "", folder = null, parent = null } = {}) {
    const body = h("div", { class: "qlForm" });
    const name = textInput("name", folder ? folder.name : "", { placeholder: "e.g. Monitoring", autofocus: true });
    const description = textArea("description", folder ? folder.description : "", "Optional");
    body.append(field("Name", name), field("Description", description));
    let inside = null;
    if (!folder) {
      inside = folderSelect("parent_id", parent);
      body.appendChild(field("Inside", inside));
    }
    await openDialog({
      title: folder ? "Rename folder" : "New folder",
      submitLabel: folder ? "Save" : "Create",
      body,
      onSubmit: async () => {
        validName(name.value);
        const target = folder ? { store: storeKind, folderId: folder.parent_id } : parseLoc(inside.value);
        if (!target) throw validation("parent_id", "Pick a folder.");
        const result = await apply(
          target.store,
          (adapter) => (folder
            ? adapter.updateFolder(folder.id, { name: name.value, description: description.value })
            : adapter.createFolder({ parent_id: target.folderId, name: name.value, description: description.value })),
          { success: folder ? "Folder renamed." : "Folder created.", select: (id) => keyOf("folder", target.store, folder ? folder.id : id), inDialog: true },
        );
        if (!result) return false;
        ctl.closedRoots.delete(target.store);
        if (target.folderId) expandPath(target.store, target.folderId);
        else saveUiPrefs();
        renderLibrary({ keepFocus: false });
        return true;
      },
    });
    focusSelected();
  }

  async function moveDialog(item) {
    const isFolder = item.kind === "folder";
    const lib = storeOf(item.store)?.library;
    const entity = !lib ? null : isFolder ? folderById(lib, item.id) : queryById(lib, item.id);
    if (!entity) return;
    const current = { store: item.store, folderId: isFolder ? entity.parent_id : entity.folder_id };
    const select = folderSelect("target", current, { exclude: isFolder ? { store: item.store, id: entity.id } : null });
    select.size = Math.min(12, Math.max(4, select.options.length + $$("optgroup", select).length));
    select.classList.add("qlSelect--list");
    const body = h("div", { class: "qlForm" });
    body.appendChild(field(`Move \u201c${entity.name}\u201d to`, select));
    await openDialog({
      title: "Move to\u2026",
      submitLabel: "Move",
      body,
      onSubmit: async () => {
        const target = parseLoc(select.value);
        if (!target || locValue(target) === locValue(current)) return true;
        return moveItem(item, target, { inDialog: true });
      },
    });
    focusSelected();
  }

  // Moves a query or a folder within its root, or into the other root
  // (moveAcross). From the Move dialog (inDialog) a failure is thrown to the
  // dialog; from a drop it is a toast.
  async function moveItem(item, target, { inDialog = false } = {}) {
    if (target.store !== item.store) return moveAcross(item, target, { inDialog });
    const lib = storeOf(item.store)?.library || emptyLibrary();
    const folderId = target.folderId || null;
    if (item.kind === "folder") {
      const folder = folderById(lib, item.id);
      if (!folder || folder.parent_id === folderId) return true;
      if (folderId && (folderId === folder.id || isInside(lib, folderId, folder.id))) {
        if (inDialog) throw validation("target", "A folder cannot move into itself.");
        toast("A folder cannot move into itself.", "error");
        return false;
      }
    } else {
      const query = queryById(lib, item.id);
      if (!query || query.folder_id === folderId) return true;
    }
    const where = storeList().length > 1 ? whereText(target) : folderPathText(lib, folderId);
    try {
      const result = await apply(
        item.store,
        (adapter) => (item.kind === "folder" ? adapter.updateFolder(item.id, { parent_id: folderId }) : adapter.updateQuery(item.id, { folder_id: folderId })),
        { success: `Moved to ${where}.`, select: keyOf(item.kind, item.store, item.id), inDialog },
      );
      if (result && folderId) {
        expandPath(item.store, folderId);
        renderLibrary({ keepFocus: true });
      }
      return !!result;
    } catch (err) {
      if (inDialog) throw err;
      toast(util.errorText(err, "The item could not be moved."), "error");
      return false;
    }
  }

  // Yes / no on the shared dialog (the focus starts on Cancel).
  function confirmDialog({ title, message, confirmLabel = "Remove", danger = true }) {
    return ns.dialog.confirm({ title, message, confirmLabel, danger, className: "qlDialog" });
  }

  async function deleteItem(item) {
    const lib = storeOf(item.store)?.library;
    if (!lib) return;
    if (item.kind === "folder") {
      const folder = folderById(lib, item.id);
      if (!folder) return;
      const counts = subtreeCounts(lib, folder.id);
      const empty = !counts.folders && !counts.queries;
      const parts = [];
      if (counts.queries) parts.push(format.countLabel(counts.queries, "query", "queries"));
      if (counts.folders) parts.push(format.countLabel(counts.folders, "subfolder"));
      const ok = await confirmDialog({
        title: "Remove folder",
        message: empty
          ? `Remove the empty folder \u201c${folder.name}\u201d?`
          : `Remove \u201c${folder.name}\u201d and everything in it (${parts.join(" and ")})? This cannot be undone.`,
        confirmLabel: empty ? "Remove" : "Remove all",
      });
      if (!ok) {
        focusSelected();
        return;
      }
      const next = neighbourKey(keyOf("folder", item.store, folder.id));
      await apply(item.store, (adapter) => adapter.deleteFolder(folder.id, { recursive: !empty }), { success: "Folder removed.", select: next });
    } else {
      const query = queryById(lib, item.id);
      if (!query) return;
      const ok = await confirmDialog({ title: "Remove query", message: `Remove \u201c${query.name}\u201d? This cannot be undone.` });
      if (!ok) {
        focusSelected();
        return;
      }
      const next = neighbourKey(keyOf("query", item.store, query.id));
      await apply(item.store, (adapter) => adapter.deleteQuery(query.id), { success: "Query removed.", select: next });
      if (ctl.opened?.store === item.store && ctl.opened.id === query.id) ctl.opened = null;
    }
    focusSelected();
  }

  // ------------------------------------------------------------ library view

  const libraryEls = {};

  // Item keys: "r:<store>" a root, "f:<store>:<id>" a folder, "q:<store>:<id>" a query.
  function keyOf(kind, store, id) {
    if (kind === "root") return `r:${store}`;
    return `${kind === "folder" ? "f" : "q"}:${store}:${id}`;
  }

  function parseKey(key) {
    const text = String(key || "");
    let m = /^r:(server|local)$/.exec(text);
    if (m) return { kind: "root", store: m[1], id: "" };
    m = /^([fq]):(server|local):(.+)$/.exec(text);
    return m ? { kind: m[1] === "f" ? "folder" : "query", store: m[2], id: m[3] } : null;
  }

  const itemOfLi = (li) => ({ kind: li.dataset.kind, store: li.dataset.store, id: li.dataset.id || "" });

  function expandPath(storeKind, folderId) {
    const lib = storeOf(storeKind)?.library;
    let cur = lib ? folderById(lib, folderId) : null;
    while (cur) {
      ctl.expanded.add(`${storeKind}:${cur.id}`);
      cur = folderById(lib, cur.parent_id);
    }
    ctl.closedRoots.delete(storeKind);
    saveUiPrefs();
  }

  // The head of a tab's list (Saved and History alike): the search, then the
  // tab's own tools at the right end.
  function listHead(placeholder, { title = "" } = {}) {
    const head = h("div", { class: "ql__head" });
    const search = h("div", { class: "qlSearch" });
    search.appendChild(icon("search"));
    const input = h("input", { class: "qlSearch__input" });
    input.type = "search";
    input.placeholder = placeholder;
    if (title) input.title = title;
    input.setAttribute("aria-label", placeholder);
    input.autocomplete = "off";
    input.spellcheck = false;
    search.appendChild(input);
    const actions = h("div", { class: "ql__actions" });
    head.append(search, actions);
    return { head, input, actions };
  }

  function buildLibraryShell(root) {
    root.replaceChildren();
    root.dataset.rendered = "1";
    const wrap = h("div", { class: "ql" });
    const { head, input, actions } = listHead("Search the library", { title: "Searches names, descriptions, tags and SQL" });
    const newFolder = iconButton("folderPlus", "New folder", "new-folder");
    const save = iconButton("plus", "Save the editor query", "save");
    actions.append(newFolder, save);
    const notice = h("div", { class: "ql__notice" });
    const tree = h("ul", { class: "qlTree" });
    tree.setAttribute("role", "tree");
    tree.setAttribute("aria-label", "Saved queries");
    const foot = h("div", { class: "ql__foot" });
    wrap.append(head, notice, tree, foot);
    root.appendChild(wrap);
    Object.assign(libraryEls, { root, wrap, input, actions, newFolder, save, notice, tree, foot });

    // ns.search: the one delay; Enter (before the handler below) and Escape (a
    // filled field) apply the field at once.
    const searchField = ns.search.bind(input, (value) => {
      ctl.search = value;
      renderTree();
    });
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        searchField.flush();
        select("saved", treeItems()[0]);
      } else if (ev.key === "Enter") {
        // The first query found, in the preview.
        ev.preventDefault();
        const first = treeItems().find((li) => li.dataset.kind === "query");
        if (first) {
          select("saved", first);
          enterPreview();
        }
      }
    });
    newFolder.addEventListener("click", () => folderDialog({ parent: selectedLoc() }));
    save.addEventListener("click", () => saveDialog());

    tree.addEventListener("click", onTreeClick);
    tree.addEventListener("keydown", onTreeKeydown);
    tree.addEventListener("focusin", onTreeFocus);
    tree.addEventListener("dragstart", onDragStart);
    tree.addEventListener("dragover", onDragOver);
    tree.addEventListener("dragleave", onDragLeave);
    tree.addEventListener("drop", onDrop);
    tree.addEventListener("dragend", onDragEnd);
  }

  function renderLibrary({ keepFocus = false } = {}) {
    const root = dom.queryLibraryViewSaved;
    if (!root) return;
    if (!ctl.rendered.library || !libraryEls.tree || !root.contains(libraryEls.tree)) {
      buildLibraryShell(root);
      ctl.rendered.library = true;
    }
    const canEdit = anyEditable();
    libraryEls.actions.hidden = !canEdit;
    libraryEls.wrap.classList.toggle("is-readonly", !canEdit);
    renderNotice();
    renderFoot();
    renderTree({ keepFocus });
  }

  function renderNotice() {
    const notice = libraryEls.notice;
    notice.replaceChildren();
    if (!ctl.host) notice.appendChild(ns.uiState.banner(h("div"), { message: "Select a ClickHouse host: saved queries and History belong to a host.", inset: true }));
    for (const store of storeList()) {
      if (store.fatal) {
        notice.appendChild(ns.uiState.banner(h("div"), { message: `${ROOT_LABELS[store.kind]}: ${store.fatal}`, retry: () => void reloadStore(store).then(() => renderLibrary()), inset: true }));
      }
      if (store.loadError) {
        notice.appendChild(ns.uiState.banner(h("div"), { message: `The library file could not be read (${store.loadError}); ${ROOT_LABELS[store.kind]} is shown read-only.`, inset: true }));
      }
    }
    notice.hidden = !notice.childElementCount;
  }

  function renderFoot() {
    const foot = libraryEls.foot;
    const count = format.countLabel(storeList().reduce((n, store) => n + store.library.queries.length, 0), "query", "queries");
    foot.textContent = ctl.host ? `${count}${MIDDOT}${ctl.host}` : count;
    foot.title = storeList().map((store) => `${ROOT_LABELS[store.kind]}: ${format.countLabel(store.library.queries.length, "query", "queries")}`).join("\n");
  }

  function searchMatches() {
    const terms = fold(ctl.search).split(/\s+/).filter(Boolean);
    if (!terms.length) return null;
    const out = [];
    for (const store of storeList()) {
      const lib = store.library;
      for (const q of lib.queries) {
        const path = `${ROOT_LABELS[store.kind]} ${folderPathText(lib, q.folder_id)}`;
        const hay = fold(`${q.name}\n${q.description}\n${q.sql}\n${q.tags.join(" ")}\n${folderPathText(lib, q.folder_id)}`);
        if (!terms.every((t) => hay.includes(t))) continue;
        const nameHits = terms.filter((t) => fold(q.name).includes(t)).length;
        out.push({ store: store.kind, q, path, score: nameHits });
      }
    }
    out.sort((a, b) => b.score - a.score || byName(a.q, b.q));
    return { terms, results: out };
  }

  function nameWithMarks(name, terms) {
    const span = h("span", { class: "qlRow__name" });
    if (!terms || !terms.length) {
      span.textContent = name;
      return span;
    }
    const lower = name.toLocaleLowerCase();
    const ranges = [];
    for (const term of terms) {
      let at = lower.indexOf(term);
      while (at >= 0 && term) {
        ranges.push([at, at + term.length]);
        at = lower.indexOf(term, at + term.length);
      }
    }
    ranges.sort((a, b) => a[0] - b[0]);
    let pos = 0;
    for (const [s, e] of ranges) {
      if (s < pos) continue;
      if (s > pos) span.appendChild(document.createTextNode(name.slice(pos, s)));
      span.appendChild(h("mark", null, name.slice(s, e)));
      pos = e;
    }
    if (pos < name.length) span.appendChild(document.createTextNode(name.slice(pos)));
    return span;
  }

  function treeRow(kind, storeKind, entity, level, { terms = null, path = "" } = {}) {
    const store = storeOf(storeKind);
    const li = h("li", { class: `qlNode qlNode--${kind}` });
    li.setAttribute("role", "treeitem");
    li.setAttribute("aria-level", String(level));
    li.dataset.kind = kind;
    li.dataset.store = storeKind;
    li.dataset.id = entity.id;
    li.dataset.key = keyOf(kind, storeKind, entity.id);
    li.tabIndex = -1;
    li.setAttribute("aria-selected", "false");
    if (editableStore(store)) li.draggable = true;
    const row = h("div", { class: "qlRow" });
    row.style.setProperty("--qlDepth", String(level - 1));
    const twisty = h("span", { class: "qlRow__twisty" });
    twisty.setAttribute("aria-hidden", "true");
    row.appendChild(twisty);
    row.appendChild(icon(kind === "folder" ? (ctl.expanded.has(`${storeKind}:${entity.id}`) ? "folderOpen" : "folder") : "query"));
    const text = h("span", { class: "qlRow__text" });
    text.appendChild(nameWithMarks(entity.name, terms));
    if (path) text.appendChild(h("span", { class: "qlRow__path" }, path));
    row.appendChild(text);
    if (kind === "folder") {
      const counts = childQueries(store.library, entity.id).length + childFolders(store.library, entity.id).length;
      if (counts) row.appendChild(h("span", { class: "qlRow__count" }, format.count(counts)));
    } else if (ctl.opened?.store === storeKind && ctl.opened.id === entity.id) {
      row.classList.add("is-opened");
      li.setAttribute("aria-current", "true");
    }
    li.appendChild(row);
    return li;
  }

  function appendFolderChildren(parentEl, storeKind, folderId, level) {
    const lib = storeOf(storeKind).library;
    for (const folder of childFolders(lib, folderId)) {
      const li = treeRow("folder", storeKind, folder, level);
      const open = ctl.expanded.has(`${storeKind}:${folder.id}`);
      li.setAttribute("aria-expanded", String(open));
      if (open) {
        const group = h("ul", { class: "qlTree__group" });
        group.setAttribute("role", "group");
        appendFolderChildren(group, storeKind, folder.id, level + 1);
        if (!group.childElementCount) group.appendChild(emptyFolderRow("Empty folder", level));
        li.appendChild(group);
      }
      parentEl.appendChild(li);
    }
    for (const query of childQueries(lib, folderId)) parentEl.appendChild(treeRow("query", storeKind, query, level));
  }

  function emptyFolderRow(text, level) {
    const empty = h("li", { class: "qlTree__empty" }, text);
    empty.setAttribute("role", "none");
    empty.style.setProperty("--qlDepth", String(level));
    return empty;
  }

  // A root folder: "Shared server storage" or "Local browser storage", its
  // count of queries, a lock badge when read-only; open unless closed.
  function rootRow(store) {
    const li = h("li", { class: "qlNode qlNode--root" });
    li.setAttribute("role", "treeitem");
    li.setAttribute("aria-level", "1");
    li.dataset.kind = "root";
    li.dataset.store = store.kind;
    li.dataset.id = "";
    li.dataset.key = keyOf("root", store.kind);
    li.tabIndex = -1;
    li.setAttribute("aria-selected", "false");
    const open = !ctl.closedRoots.has(store.kind);
    li.setAttribute("aria-expanded", String(open));
    const row = h("div", { class: "qlRow qlRow--root" });
    row.style.setProperty("--qlDepth", "0");
    const twisty = h("span", { class: "qlRow__twisty" });
    twisty.setAttribute("aria-hidden", "true");
    row.append(twisty, icon(store.kind));
    const text = h("span", { class: "qlRow__text" });
    text.appendChild(h("span", { class: "qlRow__name" }, ROOT_LABELS[store.kind]));
    row.appendChild(text);
    if (store.kind === "server" && !editableStore(store) && ctl.host && !store.fatal) {
      const badge = ns.badge.el("Read-only", { tone: "warn", size: "sm", shape: "pill", className: "qlBadge qlBadge--readonly" });
      badge.title = "This server shares its query library read-only: opening and copying queries works, changes are disabled.";
      badge.prepend(icon("lock"));
      row.appendChild(badge);
    }
    const n = store.library.queries.length;
    if (n) row.appendChild(h("span", { class: "qlRow__count" }, format.count(n)));
    li.appendChild(row);
    if (open) {
      const group = h("ul", { class: "qlTree__group" });
      group.setAttribute("role", "group");
      appendFolderChildren(group, store.kind, null, 2);
      if (!group.childElementCount) group.appendChild(emptyFolderRow(store.fatal ? "Not loaded" : "Empty", 1));
      li.appendChild(group);
    }
    return li;
  }

  function renderTree({ keepFocus = false } = {}) {
    const tree = libraryEls.tree;
    if (!tree) return;
    const hadFocus = keepFocus || tree.contains(document.activeElement);
    tree.replaceChildren();
    const matches = searchMatches();
    tree.classList.toggle("is-search", !!matches);
    if (matches) {
      for (const { store, q, path } of matches.results) tree.appendChild(treeRow("query", store, q, 1, { terms: matches.terms, path }));
      if (!matches.results.length) tree.appendChild(emptyRow(`No saved query matches \u201c${ctl.search.trim()}\u201d.`));
    } else if (ctl.host && storeList().every((store) => !store.fatal && !store.library.folders.length && !store.library.queries.length)) {
      // Nothing saved anywhere: one empty state (the roots show once
      // something is saved).
      tree.appendChild(anyEditable() ? emptyLibraryRow() : emptyRow("This library is empty."));
    } else if (ctl.host) {
      for (const store of storeList()) tree.appendChild(rootRow(store));
    }
    const current = restoreSelection("saved");
    if (hadFocus && current) current.focus({ preventScroll: false });
  }

  // An empty library: the one action (save the editor's query) and its
  // shortcut, which a touch screen does without.
  function emptyLibraryRow() {
    const save = h("button", { type: "button", class: "button button--small qlTree__save", "data-action": "save-current" }, "Save current query");
    save.addEventListener("click", () => saveDialog());
    const li = h("li", { class: "qlTree__empty qlTree__empty--root" },
      h("strong", { class: "qlTree__emptyTitle" }, `No saved queries on host ${ctl.host}`),
      h("span", { class: "qlTree__emptyActions" }, save,
        h("span", { class: "qlTree__hint" }, `or press ${ns.ui?.modifierKeyLabel?.() || "Ctrl"}+S in the editor`)));
    li.setAttribute("role", "none");
    return li;
  }

  function emptyRow(text) {
    const li = h("li", { class: "qlTree__empty qlTree__empty--root" }, text);
    li.setAttribute("role", "none");
    return li;
  }

  function treeItems() {
    return libraryEls.tree ? [...$$("li[role=treeitem]", libraryEls.tree)] : [];
  }

  function itemOf(target) {
    const li = target instanceof Element ? target.closest("li[role=treeitem]") : null;
    return li && libraryEls.tree?.contains(li) ? li : null;
  }

  function neighbourKey(key) {
    const items = treeItems();
    const index = items.findIndex((li) => li.dataset.key === key);
    if (index < 0) return "";
    const li = items[index];
    const outside = items.filter((x) => x !== li && !li.contains(x));
    const after = outside.find((x) => items.indexOf(x) > index);
    const before = [...outside].reverse().find((x) => items.indexOf(x) < index);
    return (after || before)?.dataset.key || "";
  }

  function focusSelected() {
    selectedItem("saved")?.focus({ preventScroll: true });
  }

  // A folder or a root opens or closes.
  function toggleFolder(li, open) {
    const isRoot = li.dataset.kind === "root";
    const key = isRoot ? li.dataset.store : `${li.dataset.store}:${li.dataset.id}`;
    const isOpen = isRoot ? !ctl.closedRoots.has(key) : ctl.expanded.has(key);
    const next = open === undefined ? !isOpen : open;
    if (isRoot) {
      if (next) ctl.closedRoots.delete(key);
      else ctl.closedRoots.add(key);
    } else if (next) ctl.expanded.add(key);
    else ctl.expanded.delete(key);
    saveUiPrefs();
    ctl.selection.saved = li.dataset.key;
    renderTree({ keepFocus: true });
  }

  function entityOf(li) {
    if (!li) return null;
    const store = storeOf(li.dataset.store);
    if (!store) return null;
    if (li.dataset.kind === "root") return { id: "", name: ROOT_LABELS[store.kind] };
    return li.dataset.kind === "folder" ? folderById(store.library, li.dataset.id) : queryById(store.library, li.dataset.id);
  }

  const isFolderLike = (li) => li.dataset.kind === "folder" || li.dataset.kind === "root";

  // A click selects: the item shows in the preview, with its actions (the
  // next step on a phone); a folder or a root also opens or closes. There is
  // no item menu: the browser's own context menu stays. On a phone the
  // twisty and the folder icon open or close a folder, its name opens its
  // preview.
  function onTreeClick(ev) {
    const li = itemOf(ev.target);
    if (!li) return;
    if (isFolderLike(li)) {
      if (isPhone() && !ev.target.closest(".qlRow__twisty, .qlRow > .qlIcon")) {
        select("saved", li);
        enterPreview();
        return;
      }
      toggleFolder(li);
      return;
    }
    select("saved", li);
    if (isPhone()) enterPreview();
  }

  // The focus and the selection move together (Tab back into the tree).
  function onTreeFocus(ev) {
    const li = itemOf(ev.target);
    if (li && li.dataset.key !== ctl.selection.saved) select("saved", li, { focus: false });
  }

  function onTreeKeydown(ev) {
    const li = itemOf(ev.target);
    if (!li || ev.target !== li) return;
    const items = treeItems();
    const index = items.indexOf(li);
    const folderLike = isFolderLike(li);
    const isRoot = li.dataset.kind === "root";
    const open = li.getAttribute("aria-expanded") === "true";
    const mod = ev.ctrlKey || ev.metaKey;
    const canEdit = !isRoot && editableStore(storeOf(li.dataset.store));
    switch (ev.key) {
      case "ArrowDown":
        ev.preventDefault();
        select("saved", items[Math.min(items.length - 1, index + 1)]);
        return;
      case "ArrowUp":
        ev.preventDefault();
        if (index === 0) libraryEls.input?.focus();
        else select("saved", items[index - 1]);
        return;
      case "Home":
        ev.preventDefault();
        select("saved", items[0]);
        return;
      case "End":
        ev.preventDefault();
        select("saved", items[items.length - 1]);
        return;
      case "ArrowRight":
        ev.preventDefault();
        if (folderLike && !open) toggleFolder(li, true);
        else if (folderLike && open) {
          const child = $(":scope > ul > li[role=treeitem]", li);
          if (child) select("saved", child);
        }
        return;
      case "ArrowLeft": {
        ev.preventDefault();
        if (folderLike && open) {
          toggleFolder(li, false);
          return;
        }
        const parent = li.parentElement?.closest("li[role=treeitem]");
        if (parent) select("saved", parent);
        return;
      }
      case "Enter":
        ev.preventDefault();
        if (folderLike) toggleFolder(li);
        else if (mod) loadSelection();
        else enterPreview();
        return;
      case " ":
        ev.preventDefault();
        if (folderLike) toggleFolder(li);
        return;
      case "F2":
        if (!canEdit) return;
        ev.preventDefault();
        editItem(li);
        return;
      case "Delete":
      case "Backspace":
        if (!canEdit) return;
        ev.preventDefault();
        deleteItem(itemOfLi(li));
        return;
      default:
        break;
    }
    if (ev.key === "/" && !mod) {
      ev.preventDefault();
      libraryEls.input?.focus();
      return;
    }
    if (canEdit && mod && !ev.shiftKey && String(ev.key).toLowerCase() === "m") {
      ev.preventDefault();
      moveDialog(itemOfLi(li));
      return;
    }
    // Type-ahead: the next visible item starting with the typed letter.
    if (ev.key.length === 1 && !mod && !ev.altKey && /\S/.test(ev.key)) {
      const letter = ev.key.toLocaleLowerCase();
      const ordered = [...items.slice(index + 1), ...items.slice(0, index + 1)];
      const hit = ordered.find((x) => fold(entityOf(x)?.name || "").startsWith(letter));
      if (hit) {
        ev.preventDefault();
        select("saved", hit);
      }
    }
  }

  function editItem(li) {
    const entity = entityOf(li);
    if (!entity) return;
    if (li.dataset.kind === "folder") folderDialog({ storeKind: li.dataset.store, folder: entity });
    else if (li.dataset.kind === "query") editQueryDialog(li.dataset.store, entity);
  }

  // ---------------------------------------------------------- drag and drop

  let dragItem = null;

  // A drop place: { store, folderId }. Within a root, a folder never goes into
  // itself; into the other root, both roots must be editable.
  function canDropInto(item, target) {
    if (!item || !target) return false;
    const source = storeOf(item.store);
    const dest = storeOf(target.store);
    if (!editableStore(source) || !editableStore(dest)) return false;
    const folderId = target.folderId || null;
    if (item.kind === "folder") {
      const folder = folderById(source.library, item.id);
      if (!folder) return false;
      if (item.store === target.store) {
        if (folderId && (folderId === folder.id || isInside(source.library, folderId, folder.id))) return false;
        if (folder.parent_id === folderId) return false;
      }
      return folderDepth(dest.library, folderId) + subtreeHeight(source.library, folder.id) <= MAX_DEPTH;
    }
    const query = queryById(source.library, item.id);
    return !!query && !(item.store === target.store && query.folder_id === folderId);
  }

  function dropTargetOf(ev) {
    const li = itemOf(ev.target);
    if (!li) {
      // The list's background: the one root's top, when there is one root.
      const only = storeList().length === 1 ? storeList()[0].kind : "";
      return only ? { target: { store: only, folderId: null }, el: libraryEls.tree } : { target: null, el: null };
    }
    if (li.dataset.kind === "root") return { target: { store: li.dataset.store, folderId: null }, el: li };
    if (li.dataset.kind === "folder") return { target: { store: li.dataset.store, folderId: li.dataset.id }, el: li };
    // Over a query: its folder (or its root).
    const parent = li.parentElement?.closest("li[role=treeitem]");
    if (parent) return { target: { store: parent.dataset.store, folderId: parent.dataset.kind === "folder" ? parent.dataset.id : null }, el: parent };
    return { target: null, el: null };
  }

  function clearDropMarks() {
    for (const node of $$(".is-dropTarget", libraryEls.tree) || []) node.classList.remove("is-dropTarget");
    libraryEls.tree?.classList.remove("is-dropTarget");
  }

  function onDragStart(ev) {
    const li = itemOf(ev.target);
    if (!li || li.dataset.kind === "root" || !editableStore(storeOf(li.dataset.store)) || ctl.search.trim()) {
      if (li && (ctl.search.trim() || li.dataset.kind === "root")) ev.preventDefault();
      return;
    }
    dragItem = itemOfLi(li);
    try {
      ev.dataTransfer.effectAllowed = "copyMove";
      ev.dataTransfer.setData("application/x-chdash-library", JSON.stringify(dragItem));
      // Dropped on the editor, a query inserts its SQL.
      if (dragItem.kind === "query") ev.dataTransfer.setData("text/plain", entityOf(li)?.sql || "");
    } catch (_) {}
    li.classList.add("is-dragging");
    libraryEls.tree.classList.add("is-dragging");
  }

  function onDragOver(ev) {
    if (!dragItem) return;
    const { target, el } = dropTargetOf(ev);
    clearDropMarks();
    if (!canDropInto(dragItem, target)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "move";
    el.classList.add("is-dropTarget");
  }

  function onDragLeave(ev) {
    if (!libraryEls.tree.contains(ev.relatedTarget)) clearDropMarks();
  }

  async function onDrop(ev) {
    if (!dragItem) return;
    ev.preventDefault();
    const { target } = dropTargetOf(ev);
    const item = dragItem;
    onDragEnd();
    if (!canDropInto(item, target)) return;
    await moveItem(item, target);
  }

  function onDragEnd() {
    dragItem = null;
    clearDropMarks();
    libraryEls.tree?.classList.remove("is-dragging");
    for (const node of $$(".is-dragging", libraryEls.tree) || []) node.classList.remove("is-dragging");
  }

  // -------------------------------------------------------------- selection

  // One selection model for both tabs. Each tab lists items that carry a
  // data-key (Saved: "r:", "f:" / "q:" tree items, History: "h:<id>"
  // options) and ctl.selection holds the selected key of each tab. The
  // selected item is aria-selected and in the Tab order (roving tabindex),
  // and the preview pane shows it. A click or the arrows select; Enter (and a
  // click on a phone) moves on to the preview, whose "Load in editor"
  // (Ctrl/Cmd+Enter) loads it.
  const views = {
    saved: { items: () => treeItems(), preview: (key) => savedPreview(key) },
    history: { items: () => historyItems(), preview: (key) => historyPreview(key) },
  };

  const isPhone = () => !!ns.ui?.isPhoneLayout?.();

  function selectedItem(tab) {
    const key = ctl.selection[tab];
    return key ? views[tab].items().find((x) => x.dataset.key === key) || null : null;
  }

  // Marks the selection. The Tab stop is the selected item, else the first.
  function markSelection(tab) {
    const items = views[tab].items();
    const current = selectedItem(tab);
    const stop = current || items[0] || null;
    for (const x of items) {
      x.tabIndex = x === stop ? 0 : -1;
      x.setAttribute("aria-selected", String(x === current));
    }
    return stop;
  }

  function select(tab, item, { focus = true } = {}) {
    if (!item) return;
    ctl.selection[tab] = item.dataset.key;
    markSelection(tab);
    if (focus) item.focus({ preventScroll: true });
    item.scrollIntoView({ block: "nearest" });
    if (ctl.shown === tab) renderPreview();
  }

  // After a render: the same key again (a renamed query, a reloaded History),
  // else the first item when the selected one is gone. Returns the Tab stop.
  function restoreSelection(tab) {
    if (ctl.selection[tab] && !selectedItem(tab)) ctl.selection[tab] = views[tab].items()[0]?.dataset.key || "";
    const stop = markSelection(tab);
    if (ctl.shown === tab) renderPreview();
    return stop;
  }

  function selectionPreview() {
    const tab = ctl.shown;
    return tab ? views[tab].preview(ctl.selection[tab]) : null;
  }

  // "Load in editor" of the selection (a folder has none).
  function loadSelection() {
    selectionPreview()?.actions?.find((a) => a.action === "load")?.run();
  }

  // The next step after a selection: its preview, focused on "Load in
  // editor" (or the first tool). On a phone the pane replaces the list
  // (.is-previewing).
  function enterPreview() {
    const model = selectionPreview();
    if (!model) return;
    if (isPhone()) setPreviewStep(true);
    const pane = previewPane();
    ($(".qlPreview__foot .button--primary", pane) || $(".qlPreview__tools button", pane) || pane)?.focus({ preventScroll: true });
  }

  // Back to the list, on the selected item.
  function leavePreview() {
    setPreviewStep(false);
    if (ctl.shown) (selectedItem(ctl.shown) || markSelection(ctl.shown))?.focus({ preventScroll: true });
  }

  function setPreviewStep(on) {
    dom.queryLibraryViewSaved?.parentElement?.classList.toggle("is-previewing", on);
  }

  // ---------------------------------------------------------- preview pane

  // The right pane of the dialog (#queryLibraryPreview, beside the views):
  // one component for both tabs, and the only place the item actions live.
  // A tab describes its selected item as
  //   { title, status, meta: node, description, facts: [[label, text | node]],
  //     error, sql, tools: [{ label, icon, action, run, danger }],
  //     actions: [{ label, action, run, primary }] }
  // and the pane renders it: its head on one line (the Back button of the
  // phone step, the title, the meta "Updated ..." or the run's time and
  // status, then the item's tools as icon buttons at the right end), the
  // facts, the highlighted SQL, then its foot: "Load in editor" alone.
  const PREVIEW_EMPTY = { saved: "Select a query to preview it here.", history: "Select a run to preview it here." };
  let paneModel = null;

  // The tab's list shows no item (its own empty state or a loader).
  function listIsEmpty(tab) {
    const list = tab === "history" ? historyEls.list : libraryEls.tree;
    if (!list || !list.isConnected) return false;
    return !$("[role=treeitem], [role=option]", list);
  }

  // The pane, added beside the views the first time the dialog shows them.
  function previewPane() {
    let pane = byId("queryLibraryPreview");
    const viewsEl = dom.queryLibraryViewSaved?.parentElement;
    if (!pane && viewsEl) {
      pane = h("aside", { class: "qlPreview" });
      pane.id = "queryLibraryPreview";
      pane.tabIndex = -1;
      pane.setAttribute("aria-label", "Preview");
      pane.addEventListener("click", onPreviewClick);
      pane.addEventListener("keydown", onPreviewKeydown);
      viewsEl.appendChild(pane);
    }
    return pane;
  }

  function onPreviewClick(ev) {
    const button = ev.target instanceof Element ? ev.target.closest("button[data-action]") : null;
    if (!button) return;
    if (button.dataset.action === "back") {
      leavePreview();
      return;
    }
    [...(paneModel?.tools || []), ...(paneModel?.actions || [])].find((a) => a.action === button.dataset.action)?.run(button);
  }

  function onPreviewKeydown(ev) {
    if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey) && !ev.altKey) {
      ev.preventDefault();
      loadSelection();
    } else if (ev.key === "Escape" && dom.queryLibraryViewSaved?.parentElement?.classList.contains("is-previewing")) {
      // The phone step: Escape goes back to the list, not out of the dialog.
      ev.preventDefault();
      ev.stopPropagation();
      leavePreview();
    }
  }

  function timeNode(ms) {
    const node = h("time", null, format.time(ms));
    node.dateTime = format.iso(ms);
    node.title = format.timeTitle(ms);
    return node;
  }

  // "Updated Oct 4 13:19:35", right of the title.
  function updatedMeta(ms) {
    if (!ms) return null;
    return h("span", { class: "qlPreview__meta" }, "Updated ", timeNode(ms));
  }

  function tagList(tags) {
    const list = h("span", { class: "qlPreview__tags" });
    for (const tag of tags) list.appendChild(ns.badge.el(tag, { tone: "accent", shape: "pill", className: "qlTag" }));
    return list;
  }

  function contentsText(counts) {
    return [counts.queries ? format.countLabel(counts.queries, "query", "queries") : "", counts.folders ? format.countLabel(counts.folders, "subfolder") : ""].filter(Boolean).join(MIDDOT) || "Empty";
  }

  function savedPreview(key) {
    const sel = parseKey(key);
    const store = sel ? storeOf(sel.store) : null;
    if (!store) return null;
    const lib = store.library;
    const canEdit = editableStore(store);
    if (sel.kind === "root") {
      const meta = h("span", { class: "qlPreview__meta" }, contentsText({ queries: lib.queries.length, folders: lib.folders.length }));
      if (store.kind === "server" && !canEdit && ctl.host && !store.fatal) meta.append(MIDDOT, "Read-only");
      return {
        title: ROOT_LABELS[store.kind],
        meta,
        description: ROOT_HINTS[store.kind],
        facts: ctl.host ? [["Host", ctl.host]] : [],
        error: store.fatal || (store.loadError ? `The library file could not be read (${store.loadError}): read-only.` : ""),
        tools: canEdit ? [{ label: "New folder", icon: "folderPlus", action: "new-subfolder", run: () => folderDialog({ parent: { store: store.kind, folderId: null } }) }] : [],
      };
    }
    if (sel.kind === "folder") {
      const folder = folderById(lib, sel.id);
      if (!folder) return null;
      const item = { kind: "folder", store: store.kind, id: folder.id };
      return {
        title: folder.name,
        meta: updatedMeta(folder.updated_at_ms),
        description: folder.description,
        facts: [["Path", `${ROOT_LABELS[store.kind]} ${folderPathText(lib, folder.id)}`], ["Contents", contentsText(subtreeCounts(lib, folder.id))]],
        tools: canEdit ? [
          { label: "Rename", icon: "edit", action: "rename", run: () => folderDialog({ storeKind: store.kind, folder }) },
          { label: "Move to\u2026", icon: "move", action: "move", run: () => moveDialog(item) },
          { label: "New subfolder", icon: "folderPlus", action: "new-subfolder", run: () => folderDialog({ parent: { store: store.kind, folderId: folder.id } }) },
          { label: "Remove", icon: "remove", action: "delete", danger: true, run: () => deleteItem(item) },
        ] : [],
      };
    }
    const query = queryById(lib, sel.id);
    if (!query) return null;
    const item = { kind: "query", store: store.kind, id: query.id };
    return {
      title: query.name,
      meta: updatedMeta(query.updated_at_ms),
      description: query.description,
      facts: query.tags.length ? [["Tags", tagList(query.tags)]] : [],
      sql: query.sql,
      tools: canEdit ? [
        { label: "Edit", icon: "edit", action: "edit", run: () => editQueryDialog(store.kind, query) },
        { label: "Move to\u2026", icon: "move", action: "move", run: () => moveDialog(item) },
        { label: "Remove", icon: "remove", action: "delete", danger: true, run: () => deleteItem(item) },
      ] : [],
      actions: [
        { label: "Load in editor", action: "load", primary: true, run: () => openInEditor(query, { store: store.kind, savedQuery: query }) },
      ],
    };
  }

  function historyPreview(key) {
    const entry = ctl.historyState.entries.find((e) => `h:${e.id}` === key);
    if (!entry) return null;
    const [status, statusText] = statusInfo(entry.status);
    const ran = Number(entry.ran_at_ms) || 0;
    const dot = h("span", { class: `qhItem__status qhItem__status--${status}` });
    dot.setAttribute("aria-hidden", "true");
    const meta = h("span", { class: "qlPreview__meta qlPreview__meta--run" }, timeNode(ran), MIDDOT, dot, statusText);
    const facts = [];
    if (entry.elapsed_ms != null && Number.isFinite(Number(entry.elapsed_ms))) facts.push(["Elapsed", format.duration.fromMs(Number(entry.elapsed_ms))]);
    if (entry.rows != null && Number.isFinite(Number(entry.rows))) facts.push(["Rows", format.count(Number(entry.rows))]);
    const tools = [];
    if (anyEditable()) tools.push({ label: "Save to library\u2026", icon: "save", action: "save", run: () => saveDialog({ sql: entry.sql, fromHistory: entry }) });
    tools.push({ label: "Remove from History", icon: "remove", action: "remove", danger: true, run: () => removeHistoryEntry(entry) });
    return {
      title: oneLine(entry.sql, 200) || "Query",
      titleClass: "qlPreview__title--sql",
      meta,
      facts,
      error: entry.status === "error" ? entry.error : "",
      sql: entry.sql,
      tools,
      actions: [
        { label: "Load in editor", action: "load", primary: true, run: () => openInEditor(entry) },
      ],
    };
  }

  // Renders the selection of the tab shown. The focus stays on the same
  // action (or the pane) when the pane had it.
  function renderPreview() {
    const pane = previewPane();
    if (!pane) return;
    const active = pane.contains(document.activeElement) ? document.activeElement : null;
    const refocus = active ? active.dataset.action || "" : null;
    const model = selectionPreview();
    paneModel = model;
    pane.replaceChildren();
    // A tab with nothing listed (an empty library or History, a search
    // without a match) is one empty state across the dialog: no second
    // "select an item" pane beside it.
    pane.parentElement?.classList.toggle("is-empty", !model && listIsEmpty(ctl.shown));
    if (!model) {
      pane.appendChild(h("div", { class: "qlPreview__empty" }, PREVIEW_EMPTY[ctl.shown] || PREVIEW_EMPTY.saved));
      setPreviewStep(false);
      if (refocus !== null) leavePreview();
      return;
    }
    const content = h("div", { class: "qlPreview__content" });
    // The head, one line: Back (phone), the title, its meta, the tools.
    const head = h("div", { class: "qlPreview__head" });
    const back = h("button", { class: "qlIconButton qlPreview__back" });
    back.type = "button";
    back.dataset.action = "back";
    back.setAttribute("aria-label", "Back to the list");
    back.title = "Back to the list";
    back.appendChild(icon("back"));
    const title = h("h3", { class: ["qlPreview__title", model.titleClass || ""] }, model.title);
    title.title = model.title;
    head.append(back, title);
    if (model.meta) head.appendChild(model.meta);
    if (model.tools && model.tools.length) {
      const tools = h("div", { class: "qlPreview__tools" });
      tools.setAttribute("role", "group");
      tools.setAttribute("aria-label", "Change this item");
      for (const tool of model.tools) {
        const button = iconButton(tool.icon, tool.label, tool.action);
        button.classList.add("qlPreview__tool");
        if (tool.danger) button.classList.add("qlPreview__tool--danger");
        tools.appendChild(button);
      }
      head.appendChild(tools);
    }
    content.appendChild(head);
    if (model.description) content.appendChild(h("p", { class: "qlPreview__description" }, model.description));
    if (model.facts && model.facts.length) {
      const facts = h("dl", { class: "qlPreview__facts" });
      for (const [label, value] of model.facts) {
        const dd = h("dd");
        dd.appendChild(value instanceof Node ? value : document.createTextNode(String(value)));
        facts.append(h("dt", null, label), dd);
      }
      content.appendChild(facts);
    }
    if (model.error) content.appendChild(h("div", { class: "qlPreview__error" }, oneLine(model.error, 600)));
    if (model.sql != null) content.appendChild(sqlPreview(model.sql, PANE_SQL_CHARS, { pane: true }));
    pane.appendChild(content);
    if (model.actions && model.actions.length) {
      const foot = h("div", { class: "qlPreview__foot" });
      foot.setAttribute("role", "group");
      foot.setAttribute("aria-label", "Use this query");
      const mod = ns.ui?.modifierKeyLabel?.() || "Ctrl";
      for (const action of model.actions) {
        const button = h("button", { class: action.primary ? "button button--primary" : "button" }, action.label);
        button.type = "button";
        button.dataset.action = action.action;
        if (action.primary) button.title = `${action.label} (${mod}+Enter)`;
        foot.appendChild(button);
      }
      pane.appendChild(foot);
    }
    if (refocus !== null) ($(`[data-action="${refocus}"]`, pane) || pane).focus({ preventScroll: true });
  }

  // ------------------------------------------------------------ history view

  const historyEls = {};

  function buildHistoryShell(root) {
    root.replaceChildren();
    root.dataset.rendered = "1";
    const wrap = h("div", { class: "ql qh" });
    // The same head as Saved: the search, its tools slot (empty here).
    const { head, input, actions } = listHead("Search the history");
    actions.hidden = true;
    const list = h("div", { class: "qhList" });
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "Query history");
    // The foot: the count and where it is stored, as Saved's.
    const foot = h("div", { class: "ql__foot" });
    wrap.append(head, list, foot);
    root.appendChild(wrap);
    Object.assign(historyEls, { root, input, list, foot });

    ns.search.bind(input, (value) => {
      ctl.historyState.q = String(value || "").trim();
      loadHistory();
    });
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        select("history", historyItems()[0]);
      }
    });
    list.addEventListener("click", onHistoryClick);
    list.addEventListener("keydown", onHistoryKeydown);
    list.addEventListener("focusin", (ev) => {
      const item = historyItemOf(ev.target);
      if (item && item.dataset.key !== ctl.selection.history) select("history", item, { focus: false });
    });
  }

  function historyEntryOf(item) {
    return ctl.historyState.entries.find((e) => String(e.id) === item?.dataset.id) || null;
  }

  function historyItems() {
    return historyEls.list ? [...$$(".qhItem", historyEls.list)] : [];
  }

  function historyItemOf(target) {
    return target instanceof Element ? target.closest(".qhItem") : null;
  }

  function statusInfo(status) {
    if (status === "ok") return ["ok", "Succeeded"];
    if (status === "error") return ["error", "Failed"];
    if (status === "cancelled" || status === "canceled") return ["cancelled", "Cancelled"];
    return ["unknown", "Outcome not recorded"];
  }

  function renderHistory({ keepFocus = false } = {}) {
    const root = dom.queryLibraryViewHistory;
    if (!root) return;
    if (!ctl.rendered.history || !historyEls.list || !root.contains(historyEls.list)) {
      buildHistoryShell(root);
      ctl.rendered.history = true;
    }
    const hs = ctl.historyState;
    const list = historyEls.list;
    const hadFocus = keepFocus || list.contains(document.activeElement);
    list.replaceChildren();
    if (hs.error) list.appendChild(ns.uiState.banner(h("div"), { message: hs.error, retry: () => void loadHistory(), inset: true }));
    let lastDay = "";
    for (const entry of hs.entries) {
      const ts = Number(entry.ran_at_ms) || 0;
      const day = dayKey(ts);
      if (day !== lastDay) {
        lastDay = day;
        const label = h("div", { class: "qhDay" }, dayLabel(ts));
        label.setAttribute("role", "presentation");
        list.appendChild(label);
      }
      const [cls, statusText] = statusInfo(entry.status);
      const item = h("div", { class: `qhItem qhItem--${cls}` });
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", "false");
      item.tabIndex = -1;
      item.dataset.id = String(entry.id);
      item.dataset.key = `h:${entry.id}`;
      const dot = h("span", { class: `qhItem__status qhItem__status--${cls}` });
      dot.title = statusText;
      dot.setAttribute("aria-label", statusText);
      dot.setAttribute("role", "img");
      const main = h("div", { class: "qhItem__main" });
      main.appendChild(h("div", { class: "qhItem__sql" }, oneLine(entry.sql, 220)));
      const meta = h("div", { class: "qhItem__meta" });
      const time = h("span", { class: "qhItem__time" }, format.time(ts, { date: "never" }));
      time.title = format.timeTitle(ts);
      meta.appendChild(time);
      if (Number.isFinite(entry.elapsed_ms) && entry.elapsed_ms != null) meta.appendChild(h("span", { class: "qhItem__elapsed" }, format.duration.fromMs(entry.elapsed_ms)));
      if (Number.isFinite(entry.rows) && entry.rows != null) meta.appendChild(h("span", { class: "qhItem__rows" }, format.countLabel(entry.rows, "row")));
      main.appendChild(meta);
      // Every action of the run is in the preview.
      item.append(dot, main);
      list.appendChild(item);
    }
    if (!hs.entries.length && !hs.loading && !hs.error) {
      list.appendChild(h("div", { class: "qlTree__empty qlTree__empty--root" }, hs.q
        ? `Nothing in the history matches \u201c${hs.q}\u201d.`
        : ctl.host ? `No history for ${ctl.host} yet: every query you run on it is listed here.` : "Select a ClickHouse host to see its History."));
    }
    if (hs.loading && !hs.entries.length) list.appendChild(ns.uiState.block("loading", { label: `Loading the history${ELLIPSIS}`, compact: true }));
    historyEls.foot.textContent = `${format.count(hs.entries.length)} ${hs.entries.length === 1 ? "entry" : "entries"}${ctl.host ? `${MIDDOT}${ctl.host}` : ""}${MIDDOT}Stored in this browser`;
    const current = restoreSelection("history");
    if (hadFocus && current) current.focus({ preventScroll: true });
  }

  // The current host's runs. A reload supersedes the one in flight
  // (util.latest), so a host switch or a typed search never shows an older
  // answer.
  async function loadHistory() {
    await start();
    const token = util.latest(HISTORY_REQUEST);
    const hs = ctl.historyState;
    if (!currentHost()) {
      Object.assign(hs, { entries: [], loading: false, loaded: true, error: "" });
      renderHistory();
      return;
    }
    hs.loading = true;
    const hadError = !!hs.error;
    hs.error = "";
    let unchanged = false;
    try {
      const page = await ctl.history.list({ q: hs.q });
      if (!token.isCurrent() || ctl.historyState !== hs) return;
      const next = page.entries;
      // Same entries (a refresh after a run that changed nothing shown): keep
      // the rows, their focus and hover.
      const signature = (list) => list.map((e) => `${e.id}|${e.status}|${e.rows}|${e.elapsed_ms}`).join("\n");
      if (!hadError && hs.loaded && signature(next) === signature(hs.entries)) {
        unchanged = true;
      }
      hs.entries = next;
      hs.loaded = true;
    } catch (err) {
      if (util.isAbort(err) || !token.isCurrent() || ctl.historyState !== hs) return;
      hs.error = err instanceof LibraryError ? err.message : "The history could not be loaded.";
    }
    hs.loading = false;
    if (!unchanged) renderHistory();
  }

  async function removeHistoryEntry(entry) {
    // The selection moves to the next run (or the previous one).
    if (ctl.selection.history === `h:${entry.id}`) {
      const items = historyItems();
      const index = items.findIndex((x) => x.dataset.key === ctl.selection.history);
      ctl.selection.history = (items[index + 1] || items[index - 1])?.dataset.key || "";
    }
    try {
      await ctl.history.remove(String(entry.id));
    } catch (err) {
      toast(err instanceof LibraryError ? err.message : "The entry could not be removed.", "error");
    }
    loadHistory();
  }

  // A click selects the run and shows it in the preview, with its actions
  // (the next step on a phone).
  function onHistoryClick(ev) {
    const item = historyItemOf(ev.target);
    if (!historyEntryOf(item)) return;
    select("history", item);
    if (isPhone()) enterPreview();
  }

  function onHistoryKeydown(ev) {
    const item = historyItemOf(ev.target);
    if (!item || ev.target !== item) return;
    const items = historyItems();
    const index = items.indexOf(item);
    const entry = historyEntryOf(item);
    const mod = ev.ctrlKey || ev.metaKey;
    switch (ev.key) {
      case "ArrowDown":
        ev.preventDefault();
        select("history", items[Math.min(items.length - 1, index + 1)]);
        return;
      case "ArrowUp":
        ev.preventDefault();
        if (index === 0) historyEls.input?.focus();
        else select("history", items[index - 1]);
        return;
      case "Home":
        ev.preventDefault();
        select("history", items[0]);
        return;
      case "End":
        ev.preventDefault();
        select("history", items[items.length - 1]);
        return;
      case "Enter":
        ev.preventDefault();
        if (mod) loadSelection();
        else enterPreview();
        return;
      case "Delete":
        ev.preventDefault();
        removeHistoryEntry(entry);
        return;
      default:
        break;
    }
    if (ev.key === "/" && !mod) {
      ev.preventDefault();
      historyEls.input?.focus();
    }
  }

  // -------------------------------------------------------------- public API

  async function show(tab) {
    const next = tab === "history" ? "history" : "saved";
    // Each tab previews its own selection; a phone starts on the list.
    if (ctl.shown !== next) setPreviewStep(false);
    ctl.shown = next;
    renderPreview();
    await start();
    if (next === "saved") {
      const server = ctl.stores.server;
      if (server && ctl.rendered.library && Date.now() - server.loadedAt > SERVER_RELOAD_AFTER_MS) {
        await reloadStore(server);
        renderLibrary();
      }
      if (!ctl.rendered.library) renderLibrary();
    } else if (!ctl.historyState.loaded) {
      renderHistory();
      await loadHistory();
    } else if (!ctl.rendered.history) {
      renderHistory();
    }
    if (ctl.shown === next) renderPreview();
  }

  async function focus(tab) {
    await show(tab);
    if (tab === "history") historyEls.input?.focus();
    else libraryEls.input?.focus();
  }

  // A burst of run-history changes reloads the list once.
  const reloadHistorySoon = util.debounce(() => loadHistory(), 150);
  function historyChanged() {
    if (ctl.historyState.loaded) reloadHistorySoon();
  }

  // Another tab changed the browser library or History.
  window.addEventListener("storage", (ev) => {
    if (ev.key === LOCAL_KEY && ctl.rendered.library && ctl.stores.local) void reloadStore(ctl.stores.local).then(() => renderLibrary());
    if (ev.key === storage.HISTORY_STORAGE_KEY && ctl.historyState.loaded) loadHistory();
  });

  // The library query the editor holds unchanged (its id), for ?saved=.
  function openedId(sqlText) {
    if (!ctl.opened) return "";
    return String(sqlText ?? editorSql()).trim() === String(ctl.opened.sql).trim() ? ctl.opened.id : "";
  }

  // ?saved=<id> at startup: the saved query of the current host (either
  // root), in the editor.
  async function openSaved(id) {
    await start();
    for (const store of storeList()) {
      const query = queryById(store.library, String(id || ""));
      if (!query) continue;
      setEditorSql(query.sql);
      ctl.opened = { store: store.kind, id: query.id, sql: String(query.sql) };
      return true;
    }
    toast(`The linked saved query is not in the library of ${ctl.host || "this host"}.`, "error");
    return false;
  }

  // The dialog closed: nothing of it stays on screen.
  function hidden() {
    setPreviewStep(false);
    ctl.shown = "";
  }

  ns.queryLibrary = {
    show,
    focus,
    hidden,
    openedId,
    openSaved,
    saveCurrent: () => saveDialog(),
    historyChanged,
    // For tests and diagnostics.
    get mode() { return ctl.stores.server ? "server" : "local"; },
    get roots() { return storeList().map((store) => store.kind); },
    get writable() { return ctl.stores.server ? !!ctl.stores.server.writable : true; },
    get host() { return ctl.host; },
  };
})();
