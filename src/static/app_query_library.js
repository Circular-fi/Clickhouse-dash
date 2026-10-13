// Query library and History: the two tabs (Saved, History) of the dialog the
// Query toolbar's book button opens (the shared modal dialog of
// app_ui_dialog.js; app_ui.js builds it, this module adds the preview pane).
//
// app_ui.js loads this module the first time the dialog opens (or Ctrl+S is
// used) and drives it through ns.queryLibrary. Save and Edit are a form in
// the preview pane (createPaneForm); Move, Remove and the other prompts are
// ns.dialog dialogs stacked over the library.
//
// Saved queries, folders and History are per host: the dialog shows the
// selected host's only and follows a host switch (chdash:host-changed).
// Saved holds root folders, storages with the same adapter interface,
// browsable side by side:
//   - one root for each library of the server (kind "server" for the first,
//     "server~<name>" for the others; features.query_library.libraries gives
//     their name and writable, and the root shows the name; a single library
//     that keeps the name "default" shows "Shared server storage"): the REST API of features.query_library
//     (/api/query-library?host_id=&library=, through api.request), shown only
//     when the feature is enabled; read-only when the server says
//     writable = false (the root then has no edit tools and takes no drop).
//     Every folder / query change sends If-Match: <revision>; a 409 conflict
//     reloads the library and retries once before the user is told.
//   - "Local browser storage" (local): this browser (localStorage
//     chdash.queryLibrary.v2, every folder and query with its host_id).
//     Always editable. Entries without a host are purged on the first read.
// The save, move and folder pickers offer both roots; moving an item from
// one root to the other copies it into the target, then removes it from
// its source. History is this browser's (IndexedDB: ns.history), never the
// server's.
// Both adapters resolve every change with the host's whole new library, so
// the view never guesses what the server did.
//
// The list on the left only selects; every action of the selected item
// (edit, move, remove...) is an icon button of the preview pane's head on
// the right, and its foot holds one action: "Load" (Save and Edit take the
// pane over with their form until they are saved or cancelled). History is the browser's
// record of what ran: it cannot be edited, and entries are never removed.

import { api } from "./app_api.js";
import { dom, h } from "./app_dom.js";
import { format } from "./app_format.js";
import { history } from "./app_history.js";
import { queryUi } from "./app_query_ui.js";
import { sql as sqlMod } from "./app_sql.js";
import { features as featuresMod, state, storage } from "./app_state.js";
import { badge as badgeMod } from "./app_ui_badge.js";
import { copy } from "./app_ui_copy.js";
import { dialog } from "./app_ui_dialog.js";
import { icon as iconMod } from "./app_ui_icon.js";
import { menu as menuMod } from "./app_ui_menu.js";
import { search } from "./app_ui_search.js";
import { sqlBlock } from "./app_ui_sql.js";
import { uiState } from "./app_ui_state.js";
import { util } from "./app_util.js";

const { byId, $, $$ } = dom;

const LOCAL_KEY = storage.KEYS.queryLibrary;
const UI_KEY = storage.KEYS.queryLibraryUi;
const API_BASE = "api/query-library";
const MAX_DEPTH = 8;
const MAX_NAME_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 4000;
// What is read keeps the server's own limit (16 KiB): a description written by an import or another client is never cut
// on the way in and then saved cut by a rename. The 4000 above is what the form takes.
const READ_DESCRIPTION_CHARS = 16384;
const MAX_SQL_CHARS = 256 * 1024;
const PROMPT_SQL_CHARS = 4000;
const PANE_SQL_CHARS = 20000;
const SERVER_RELOAD_AFTER_MS = 30000;
const HOST_WAIT_MS = 5000;
// util.latest keys of the list reloads.
const LIBRARY_REQUEST = "queryLibrary:library";
const HISTORY_REQUEST = "queryLibrary:history";
const ELLIPSIS = "\u2026";
const MIDDOT = " \u00b7 ";

// The roots of Saved, in their order: one for each query library of the server (the first is "server", the others
// "server~<name>"; /api/version lists them: features.query_library.libraries), then "local".
const LOCAL_STORE = "local";
const DEFAULT_SERVER_LABEL = "Shared server storage";
const LOCAL_LABEL = "Local browser storage";
const SERVER_HINT = "Shared by everyone using this ClickHouse Dash server, in its query library file.";
const LOCAL_HINT = "Only this browser sees these queries (its localStorage).";

// ---------------------------------------------------------------- helpers

const fold = (value) => String(value == null ? "" : value).trim().toLocaleLowerCase();
const newId = (prefix) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const byName = (a, b) => String(a.name).localeCompare(String(b.name), "en", { numeric: true, sensitivity: "base" });

// The library's names for the sprite's drawings (ns.icon).
const ICONS = {
  search: "search", lock: "lock", folder: "folder", folderOpen: "folder-open", folderPlus: "folder-plus", query: "file", file: "file", plus: "plus",
  dots: "dots", download: "arrow-down", check: "check", x: "x", chevronRight: "chevron-right", book: "book",
  back: "chevron-left", server: "database", local: "device-desktop", edit: "pencil", move: "folder-symlink", remove: "trash", save: "device-floppy",
};

function icon(name) {
  return iconMod.el(ICONS[name], { className: `qlIcon qlIcon--${name}` });
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

// Instants and counts in ns.format (docs/ui-foundations.md): browser-local
// 24 h "Sep 12 16:29:57" ("16:29:57" under a day heading), "1,234 queries".

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
// The library is the user's data and the metadata catalogue is a cache: when the browser refuses a write, the cache
// goes first and the write is tried once more.
function writeJson(key, value) {
  const pref = storage.pref(key, null, { json: true });
  if (pref.set(value)) return true;
  storage.freeMetaSpace();
  return pref.set(value);
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
      description: cleanText(q.description, READ_DESCRIPTION_CHARS),
      sql: q.sql,
      host_id: hostOf(q),
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

// The queries under every folder, subfolders included: folder id -> count (the top level is the whole library). One pass
// for a library; it is kept while the library object is the same one.
const queryCountCache = new WeakMap();
function queryCounts(lib) {
  const signature = `${lib.revision}:${lib.folders.length}:${lib.queries.length}`;
  const hit = queryCountCache.get(lib);
  if (hit && hit.signature === signature) return hit.counts;
  const parentOf = new Map(lib.folders.map((f) => [f.id, f.parent_id || null]));
  const counts = new Map();
  for (const query of lib.queries) {
    for (let id = query.folder_id || null, hops = 0; id && hops <= MAX_DEPTH + 1; id = parentOf.get(id) || null, hops += 1) {
      counts.set(id, (counts.get(id) || 0) + 1);
    }
  }
  queryCountCache.set(lib, { signature, counts });
  return counts;
}
const queriesText = (n) => (n ? format.countLabel(n, "query", "queries") : "Empty");

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
    folders.push({ id: f.id, parent_id: f.id === folderId ? null : f.parent_id, name: f.name, created_at_ms: f.created_at_ms });
    for (const q of childQueries(lib, id)) {
      queries.push({ folder_id: id, name: q.name, description: q.description, sql: q.sql, created_at_ms: q.created_at_ms, updated_at_ms: q.updated_at_ms });
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
    createFolder({ parent_id = null, name }) {
      return change((lib, host) => {
        assertFolderTarget(lib, parent_id);
        const clean = validName(name);
        if (folderDepth(lib, parent_id) + 1 > MAX_DEPTH) throw validation("parent_id", `Folders nest at most ${MAX_DEPTH} levels deep.`);
        assertUniqueFolder(lib, parent_id, clean);
        const ts = Date.now();
        const folder = { id: newId("f"), host_id: host, parent_id: parent_id || null, name: clean, created_at_ms: ts, updated_at_ms: ts };
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
    createQuery({ folder_id = null, name, description = "", sql }) {
      return change((lib, host) => {
        assertFolderTarget(lib, folder_id);
        const clean = validName(name);
        assertUniqueQuery(lib, folder_id, clean);
        const ts = Date.now();
        const query = {
          id: newId("q"), folder_id: folder_id || null, name: clean, description: validDescription(description), sql: validSql(sql),
          host_id: host, created_at_ms: ts, updated_at_ms: ts,
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
          const folder = { id: newId("f"), host_id: host, parent_id: parent, name, created_at_ms: Number(f.created_at_ms) || ts, updated_at_ms: ts };
          lib.folders.push(folder);
          ids.set(f.id, folder.id);
        }
        for (const q of queries) {
          const folder = q.folder_id && ids.has(q.folder_id) ? ids.get(q.folder_id) : parent_id || null;
          const name = validName(q.name);
          assertUniqueQuery(lib, folder, name);
          lib.queries.push({
            id: newId("q"), folder_id: folder, name, description: validDescription(q.description), sql: validSql(q.sql), host_id: host,
            created_at_ms: Number(q.created_at_ms) || ts, updated_at_ms: Number(q.updated_at_ms) || ts,
          });
        }
        return ids.get(folders[0]?.id) || "";
      });
    },
  };
}

// The browser History (ns.history, app_history.js: IndexedDB, written by app_run.js): the
// runs of the current host.
function createLocalHistory() {
  const toEntry = (it) => ({
    id: `h_${it.ts_ms}`,
    sql: String(it.sql_formatted || it.sql_raw || ""),
    raw: String(it.sql_raw || ""),
    formatted: it.formatted === true,
    host_id: it.host_id || null,
    ran_at_ms: it.ts_ms,
    elapsed_ms: Number.isFinite(it.elapsed_ms) ? it.elapsed_ms : null,
    rows: Number.isFinite(it.rows) ? it.rows : null,
    status: it.status || "",
    error: it.error || "",
    truncated: it.truncated === true,
  });
  return {
    async list({ q = "" } = {}) {
      const host = currentHost();
      const terms = fold(q).split(/\s+/).filter(Boolean);
      const entries = (await history.list(host)).map(toEntry).filter((e) => {
        if (!terms.length) return true;
        const hay = fold(`${e.sql} ${e.error}`);
        return terms.every((t) => hay.includes(t));
      });
      return { entries };
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

// library: the name of the server's library this adapter reads and writes (?library=); "" for the default one.
function createServerAdapter(library = "") {
  let revision = null;
  // The library this adapter loaded last: what a change was made from (change() compares it after a conflict).
  let known = null;

  // api.request (app_api.js), with the library revision as If-Match. Writes
  // are accepted from this page only: a same-origin request with a JSON
  // content type (the server refuses other types with 415).
  async function request(method, path, body, { ifMatch = true, signal } = {}) {
    const headers = {};
    if (ifMatch && revision != null) headers["If-Match"] = String(revision);
    const target = library ? `${path}${path.includes("?") ? "&" : "?"}library=${encodeURIComponent(library)}` : path;
    try {
      return await api.request(`${API_BASE}${target}`, { method, body, headers, signal });
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
    known = normalizeLibrary(data);
    return {
      library: known,
      writable: data.writable === true && !data.load_error,
      loadError: data.load_error ? String(data.load_error) : "",
    };
  }

  // When the item a change names was changed in the meantime (its own updated_at_ms moved), the retry after a
  // conflict does not replay it: it would overwrite the other person's edit, which is what If-Match is there to stop.
  const stamp = (library, entity) => {
    if (!library || !entity) return null;
    const list = entity.kind === "folder" ? library.folders : library.queries;
    const found = list.find((item) => item.id === entity.id);
    return found ? found.updated_at_ms : null;
  };

  // One change: on a 409 conflict, reload (new revision) and retry once, unless the item changed.
  // idOf picks the new item's id out of the answer. entity: { kind, id } of the item an update or a delete names.
  // The change itself is the answer: when it went through and the reload after it failed, the result says `stale`
  // (the caller shows no error and reads the library again), never "the change failed".
  async function change(method, path, body, idOf = (response) => response?.id || "", entity = null) {
    const before = stamp(known, entity);
    const attempt = async () => {
      const response = await request(method, path, body);
      const id = idOf(response);
      try {
        return { ...(await load()), id };
      } catch (reloadError) {
        if (util.isAbort(reloadError)) throw reloadError;
        return { stale: true, id };
      }
    };
    try {
      return await attempt();
    } catch (err) {
      if (err.code !== "conflict") throw err;
      await load();
      if (entity && stamp(known, entity) !== before) {
        throw new LibraryError("conflict", "That item was changed by someone else; your change was not applied. The library has been reloaded.");
      }
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
    createFolder: (input) => change("POST", "/folders", { host_id: requireHost(), parent_id: input.parent_id || null, name: input.name }),
    updateFolder: (id, patch) => change("PATCH", `/folders/${enc(id)}`, patch, undefined, { kind: "folder", id }),
    deleteFolder: (id, { recursive = false } = {}) => change("DELETE", `/folders/${enc(id)}${recursive ? "?recursive=1" : ""}`, undefined, undefined, { kind: "folder", id }),
    createQuery: (input) => change("POST", "/queries", { ...input, host_id: requireHost() }),
    updateQuery: (id, patch) => change("PATCH", `/queries/${enc(id)}`, patch, undefined, { kind: "query", id }),
    deleteQuery: (id) => change("DELETE", `/queries/${enc(id)}`, undefined, undefined, { kind: "query", id }),
    // A folder copied in from the browser's root: one all-or-nothing
    // import in copy mode (nothing merged, skipped or renamed), under
    // parent_id. Resolves with the copy's id.
    copyTree: ({ parent_id = null, folders = [], queries = [] }) => change("POST", "/import", {
      host_id: requireHost(),
      copy: true,
      folders: folders.map((f) => ({ id: f.id, parent_id: f.parent_id || parent_id || null, name: f.name })),
      queries: queries.map((q) => ({ folder_id: q.folder_id || parent_id || null, name: q.name, description: q.description || "", sql: q.sql, created_at_ms: q.created_at_ms || undefined, updated_at_ms: q.updated_at_ms || undefined })),
    }, (response) => response?.folder_ids?.[folders[0]?.id] || ""),
  };
}

// -------------------------------------------------------------- controller

function freshHistoryState(q = "") {
  return { entries: [], loading: false, loaded: false, q, error: "" };
}

// One root: its adapter, the current host's library and its state. label and hint are what the tree and the preview say of it.
function newStore(kind, adapter, writable, { label, hint }) {
  return { kind, adapter, writable, label, hint, library: emptyLibrary(), loadError: "", fatal: "", loadedAt: 0 };
}

// Every root but the browser's is a library of the server.
const isServerStore = (store) => store.kind !== LOCAL_STORE;
const rootLabel = (kind) => ctl.stores[kind]?.label || (kind === LOCAL_STORE ? LOCAL_LABEL : DEFAULT_SERVER_LABEL);

const uiPrefs = readJson(UI_KEY, {});
const ctl = {
  started: null,
  // The roots by kind: "local" always, one for each library of the server when features.query_library is on; order is
  // their order in the tree.
  stores: {},
  order: [],
  history: null,
  // The host the shown library and History belong to.
  host: "",
  // Open folders ("<store>:<folder id>") and closed roots ("<store>").
  expanded: new Set(Array.isArray(uiPrefs.expanded) ? uiPrefs.expanded.filter((x) => typeof x === "string" && x.includes(":")) : []),
  closedRoots: new Set(Array.isArray(uiPrefs.closedRoots) ? uiPrefs.closedRoots.filter((x) => typeof x === "string") : []),
  // The folders chosen last in the folder picker ("<store>:<folder id>"), the newest first.
  recent: Array.isArray(uiPrefs.recentFolders) ? uiPrefs.recentFolders.filter((x) => typeof x === "string" && x.includes(":")).slice(0, 8) : [],
  // The name being typed in a row: { mode, ... }.
  editing: null,
  // The Save / Edit form shown in the pane in place of the preview (createPaneForm), or null.
  form: null,
  // The highlighted item of each tab (its data-key), shown in the preview.
  selection: { saved: "", history: "" },
  search: "",
  // The saved query the editor holds: { store, id, sql }.
  opened: null,
  busy: false,
  historyState: freshHistoryState(),
  shown: "",
  rendered: { library: false, history: false },
};

const storeList = () => ctl.order.map((kind) => ctl.stores[kind]).filter(Boolean);
const storeOf = (kind) => (Object.hasOwn(ctl.stores, kind) ? ctl.stores[kind] : null);
const editableStore = (store) => !!store && store.writable && !store.fatal && !!ctl.host;
const anyEditable = () => storeList().some(editableStore);
// Where a new folder or query goes by default: the first library of the server that can take it, else this browser's.
const defaultStore = () => storeList().find((store) => isServerStore(store) && editableStore(store))?.kind || LOCAL_STORE;

function saveUiPrefs() {
  writeJson(UI_KEY, { expanded: [...ctl.expanded].slice(-400), closedRoots: [...ctl.closedRoots], recentFolders: ctl.recent });
}

// /api/version picks the roots; without an answer in 4 s, the browser's only.
function waitForFeatures() {
  return Promise.race([featuresMod.ready, new Promise((resolve) => setTimeout(resolve, 4000))]);
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
      const features = featuresMod.get("query_library");
      ctl.stores = {};
      ctl.order = [];
      if (features.enabled) {
        // Older servers list no libraries: one, the default.
        const libraries = Array.isArray(features.libraries) && features.libraries.length
          ? features.libraries
          : [{ name: "", writable: features.writable === true }];
        libraries.forEach((library, index) => {
          // The kind goes into keys split on ":" and into attributes: the name is encoded (a name may hold any text).
          const kind = index === 0 ? "server" : `server~${encodeURIComponent(library.name)}`;
          // The name is what the tree shows; a single library that was never named keeps the old "Shared server storage".
          const label = libraries.length === 1 && (!library.name || library.name === "default") ? DEFAULT_SERVER_LABEL : String(library.name);
          ctl.stores[kind] = newStore(kind, createServerAdapter(index === 0 && !library.name ? "" : String(library.name)), library.writable === true, { label, hint: SERVER_HINT });
          ctl.order.push(kind);
        });
      }
      ctl.stores.local = newStore(LOCAL_STORE, createLocalAdapter(), true, { label: LOCAL_LABEL, hint: LOCAL_HINT });
      ctl.order.push(LOCAL_STORE);
      readLocalLibrary();
      ctl.history = createLocalHistory();
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
    if (isServerStore(store)) store.writable = loaded.writable === true;
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
  ctl.editing = null;
  ctl.form = null;
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
  // The change went through but the library could not be read after it: the shown one is read again.
  if (result.stale) {
    void reloadStore(store).then(() => renderLibrary({ keepFocus: true }));
    return;
  }
  store.library = result.library;
  if (result.loadError !== undefined) store.loadError = result.loadError || "";
  if (isServerStore(store) && result.writable !== undefined) store.writable = result.writable === true;
  store.loadedAt = Date.now();
}

// Runs one change of a root through its adapter, re-renders with the new
// library and tells the user what failed (after a conflict retry, a
// read-only answer...): in the dialog that asked for it (inDialog), else in
// a toast. Validation errors always go back to the caller.
async function apply(storeKind, operation, { success = "", select = null, inDialog = false } = {}) {
  const store = storeOf(storeKind);
  if (!editableStore(store)) {
    toast(ctl.host ? `${rootLabel(storeKind)} is read-only.` : new NoHostError().message, "error");
    return null;
  }
  ctl.busy = true;
  const host = currentHost();
  try {
    const result = await operation(store.adapter);
    // The host changed while the change was on its way: its answer is the old host's library, which must not replace
    // the one that the new host is loading (the change itself was made, on the host it was asked for).
    if (currentHost() !== host) return result;
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
    if (isServerStore(store)) await reloadStore(store);
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
  return storeOf(store) ? { store, folderId: text.slice(at + 1) || null } : null;
}
const whereText = (loc) => `${rootLabel(loc.store)} ${folderPathText(storeOf(loc.store)?.library || emptyLibrary(), loc.folderId)}`;

// Moves a query or a folder from one root to the other: a copy into the
// target (the server's in one all-or-nothing request), then the removal
// from the source. `patch` changes the query on the way (Edit, Save).
async function moveAcross(item, target, { inDialog = false, patch = null } = {}) {
  const source = storeOf(item.store);
  const dest = storeOf(target.store);
  if (!editableStore(source) || !editableStore(dest)) {
    const message = `${rootLabel(editableStore(dest) ? item.store : target.store)} is read-only.`;
    if (inDialog) throw new LibraryError("read_only", message);
    toast(message, "error");
    return false;
  }
  // A second move while the first runs would copy the item twice and fail its removal.
  if (ctl.busy) {
    const message = "Another change is still running.";
    if (inDialog) throw new LibraryError("busy", message);
    toast(message, "error");
    return false;
  }
  const srcLib = source.library;
  const dstLib = dest.library;
  const folderId = target.folderId || null;
  ctl.busy = true;
  const host = currentHost();
  let copied = null;
  let sql = "";
  try {
    assertFolderTarget(dstLib, folderId);
    if (item.kind === "query") {
      const query = queryById(srcLib, item.id);
      if (!query) throw new LibraryError("not_found", "That query no longer exists.");
      const input = { folder_id: folderId, name: query.name, description: query.description, sql: query.sql, ...(patch || {}) };
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
    if (isServerStore(dest) && !(err instanceof LibraryError && err.code === "validation")) await reloadStore(dest);
    renderLibrary({ keepFocus: true });
    if (inDialog) throw err;
    toast(util.errorText(err, "The item could not be moved."), "error");
    return false;
  }
  if (currentHost() === host) takeResult(dest, copied);
  // The copy is in: the source's item goes.
  let removed = true;
  try {
    const gone = item.kind === "query" ? await source.adapter.deleteQuery(item.id) : await source.adapter.deleteFolder(item.id, { recursive: true });
    if (currentHost() === host) takeResult(source, gone);
  } catch (err) {
    removed = false;
    await reloadStore(source);
    toast(`Copied to ${rootLabel(target.store)}, but it could not be removed from ${rootLabel(item.store)}: ${util.errorText(err, "the change failed")}`, "error");
  } finally {
    ctl.busy = false;
  }
  if (item.kind === "query" && ctl.opened?.store === item.store && ctl.opened.id === item.id) {
    ctl.opened = { store: target.store, id: copied.id, sql: sql || ctl.opened.sql };
  }
  ctl.selection.saved = keyOf(item.kind, target.store, copied.id);
  expandPath(target.store, folderId);
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
  queryUi.closeQueryLibrary({ restoreFocus: false });
}

// "Load": the editor takes the SQL (a saved query is then the
// opened one, marked in the tree) and the dialog closes.
function openInEditor(item, { store = "", savedQuery = null } = {}) {
  if (!item) return;
  setEditorSql(item.sql);
  ctl.opened = savedQuery ? { store, id: savedQuery.id, sql: String(savedQuery.sql) } : null;
  queryUi.syncQueryUrl(item.sql);
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
  const layer = dialog?.host?.() || document.body;
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
function openDialog({ title, body, submitLabel = "Save", extraButtons = [], danger = false, wide = false, onSubmit }) {
  return dialog.open({
    title,
    body,
    className: wide ? "qlDialog qlDialog--wide" : "qlDialog",
    actions: [
      { label: "Cancel", value: null },
      ...extraButtons.map((extra) => ({ label: extra.label, value: extra.value })),
      { label: submitLabel, value: "submit", kind: danger ? "danger" : "primary", submit: true },
    ],
    onSubmit,
  });
}

function field(label, control, hint) {
  const wrap = h("label", { class: "uiField" });
  wrap.appendChild(h("span", { class: "uiField__label" }, label));
  wrap.appendChild(control);
  if (hint) wrap.appendChild(h("span", { class: "uiField__hint" }, hint));
  return wrap;
}

function textInput(name, value, { placeholder = "", maxLength = MAX_NAME_CHARS, autofocus = false } = {}) {
  const input = h("input", { class: "uiInput" });
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
  const area = h("textarea", { class: "uiInput uiInput--area" });
  area.name = name;
  area.dataset.field = name;
  area.value = value || "";
  area.placeholder = placeholder || "";
  area.rows = 3;
  area.maxLength = MAX_DESCRIPTION_CHARS;
  return area;
}

// ------------------------------------------------------------ the folder picker

// Where a query goes: the Folder of the Save and Edit form, and the target of Move to. It follows what the drives do
// (Google Drive "Move to", Nextcloud "Choose target folder", Dropbox "Save to"): the choice reads as a path
// (Team queries > Reports > Daily); it opens on a tree of the storages and their folders to browse (twisties and arrow
// keys); the places chosen last come first; a box filters by name when there are many folders. A storage that cannot be
// written is shown locked and cannot be chosen. In Move to, the tree is always open (inline).
//
//   const picker = createFolderPicker({ name, selected, exclude, inline, labelId });
//   picker.el            the control (a "change" event bubbles from it when the user picks a place)
//   picker.value         "<store>:<folder id>" ("<store>:" is the top of a storage), "" when nothing can be chosen
//   picker.set(loc)      picks a place (no event); false when it cannot be chosen
//   picker.refresh()     the folders changed: builds the tree again with the same choice; true when it differed
//   picker.focus() / picker.hasFocus()
// `exclude` ({ store, id } or a list): the folders being moved, which cannot go into themselves (nor deeper than MAX_DEPTH).
const PICKER_RECENT_SHOWN = 3;
const PICKER_FILTER_FROM = 8;
let pickerSeq = 0;

function rememberPlace(value) {
  if (!value || value.endsWith(":")) return;
  ctl.recent = [value, ...ctl.recent.filter((entry) => entry !== value)].slice(0, 8);
  saveUiPrefs();
}

function createFolderPicker({ name, selected = null, exclude = null, inline = false, labelId = "" }) {
  const uid = ++pickerSeq;
  const moved = exclude ? [].concat(exclude) : [];
  const height = Math.max(0, ...moved.map((m) => (storeOf(m.store) ? subtreeHeight(storeOf(m.store).library, m.id) : 0)));
  const expanded = new Set();
  let nodes = new Map();
  let value = "";
  let isOpen = inline;
  let filter = "";
  let signature = "";

  const buildNodes = () => {
    const out = new Map();
    for (const store of storeList()) {
      const lib = store.library;
      const writable = editableStore(store);
      const top = { key: `${store.kind}:`, store, label: rootLabel(store.kind), depth: 1, parent: null, children: [], locked: !writable, disabled: !writable || (moved.length > 0 && height > MAX_DEPTH), root: true };
      out.set(top.key, top);
      const walk = (parentId, parent, depth) => {
        for (const folder of childFolders(lib, parentId)) {
          if (moved.some((m) => m.store === store.kind && (folder.id === m.id || isInside(lib, folder.id, m.id)))) continue;
          const node = { key: `${store.kind}:${folder.id}`, store, label: folder.name, depth, parent, children: [], locked: false, disabled: !writable || (moved.length > 0 && folderDepth(lib, folder.id) + height > MAX_DEPTH), root: false };
          out.set(node.key, node);
          parent.children.push(node);
          walk(folder.id, node, depth + 1);
        }
      };
      walk(null, top, 2);
    }
    return out;
  };
  const usable = (key) => {
    const node = nodes.get(key);
    return !!node && !node.disabled;
  };
  const chain = (node) => {
    const path = [];
    for (let n = node; n; n = n.parent) path.unshift(n);
    return path;
  };
  const reveal = (key) => {
    for (let n = nodes.get(key)?.parent; n; n = n.parent) expanded.add(n.key);
  };
  const signatureOf = () => [...nodes.values()].map((n) => `${n.key}|${n.label}|${n.depth}|${n.disabled ? 1 : 0}`).join("\n");
  const firstChoice = (wanted) => {
    const fallback = `${defaultStore()}:`;
    if (wanted && usable(wanted)) return wanted;
    if (usable(fallback)) return fallback;
    return [...nodes.keys()].find(usable) || "";
  };

  const el = h("div", { class: `qlPicker${inline ? " qlPicker--inline" : ""}` });
  const panel = h("div", { class: "qlPicker__panel", id: `qlPicker-${uid}` });
  const filterInput = h("input", { class: "uiInput qlPicker__filter", type: "search", placeholder: "Filter folders", autocomplete: "off", spellcheck: "false" });
  filterInput.setAttribute("aria-label", "Filter folders");
  filterInput.hidden = true;
  const recentLabel = h("div", { class: "qlPicker__label" }, "Recent");
  const recentList = h("ul", { class: "qlPicker__list", role: "group" });
  recentList.setAttribute("aria-label", "Recent folders");
  const tree = h("ul", { class: "qlPicker__list qlPicker__tree", role: "tree" });
  tree.setAttribute("aria-label", "Folders");
  const emptyRow = h("div", { class: "qlPicker__empty" }, "No folder matches.");
  emptyRow.hidden = true;
  panel.append(filterInput, recentLabel, recentList, tree, emptyRow);

  let trigger = null;
  let triggerCrumbs = null;
  if (!inline) {
    triggerCrumbs = h("span", { class: "qlPicker__crumbs", id: `qlPickerValue-${uid}` });
    const chevron = h("span", { class: "qlPicker__chevron" });
    chevron.setAttribute("aria-hidden", "true");
    trigger = h("button", { class: "uiInput qlPicker__button", type: "button" }, triggerCrumbs, chevron);
    trigger.dataset.field = name;
    trigger.setAttribute("aria-haspopup", "tree");
    trigger.setAttribute("aria-controls", panel.id);
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-labelledby", `${labelId ? `${labelId} ` : ""}${triggerCrumbs.id}`);
    el.append(trigger, panel);
  } else {
    tree.dataset.field = name;
    tree.tabIndex = -1;
    el.append(panel);
  }
  panel.hidden = !isOpen;

  const iconFor = (node) => {
    if (node.root) return icon(isServerStore(node.store) ? "server" : "local");
    return icon(expanded.has(node.key) && node.children.length ? "folderOpen" : "folder");
  };
  const pathText = (node) => chain(node).map((n) => n.label).join(" › ");
  // "/" for the top of a storage, "/Reports/Daily" for a folder (what the data attributes say, for tests and tools).
  const pathOf = (node) => (node.root ? "/" : `/${chain(node).slice(1).map((n) => n.label).join("/")}`);

  const drawTrigger = () => {
    el.dataset.value = value;
    el.dataset.path = nodes.get(value) ? pathOf(nodes.get(value)) : "";
    if (!triggerCrumbs) return;
    const node = nodes.get(value);
    triggerCrumbs.replaceChildren();
    if (!node) {
      triggerCrumbs.textContent = "No folder to save to";
      return;
    }
    const parts = chain(node);
    triggerCrumbs.appendChild(iconFor(parts[0]));
    parts.forEach((part, index) => {
      if (index) triggerCrumbs.appendChild(h("span", { class: "qlPicker__sep" }, "›"));
      triggerCrumbs.appendChild(h("span", { class: index === parts.length - 1 ? "qlPicker__crumb qlPicker__crumb--last" : "qlPicker__crumb" }, part.label));
    });
    trigger.title = pathText(node);
  };

  const rowFor = (node, { section, flat = false }) => {
    const li = h("li", { class: "qlPicker__item", role: "treeitem" });
    li.dataset.key = node.key;
    li.dataset.section = section;
    li.dataset.path = pathOf(node);
    li.tabIndex = -1;
    // The dialog of Move to puts the focus on the chosen place when it opens.
    if (inline && node.key === value && section === "tree") li.setAttribute("autofocus", "");
    li.setAttribute("aria-level", String(flat ? 1 : node.depth));
    li.setAttribute("aria-selected", String(node.key === value));
    if (node.disabled) li.setAttribute("aria-disabled", "true");
    if (!flat && node.children.length) li.setAttribute("aria-expanded", String(expanded.has(node.key)));
    li.style.setProperty("--depth", String(flat ? 0 : node.depth - 1));
    const row = h("div", { class: "qlPicker__row" });
    const twisty = h("span", { class: "qlPicker__twisty" });
    twisty.setAttribute("aria-hidden", "true");
    if (!flat && node.children.length) twisty.dataset.twisty = "";
    else twisty.classList.add("qlPicker__twisty--none");
    row.append(twisty, iconFor(node), h("span", { class: `qlPicker__name${node.root ? " qlPicker__name--root" : ""}` }, node.label));
    if (flat && node.parent) row.appendChild(h("span", { class: "qlPicker__path" }, chain(node.parent).map((n) => n.label).join(" › ")));
    if (node.locked) {
      const lock = h("span", { class: "qlPicker__lock", title: "Read-only: nothing can be saved here." }, icon("lock"), h("span", null, "Read-only"));
      row.appendChild(lock);
    } else if (node.key === value) {
      const check = icon("check");
      check.classList.add("qlPicker__check");
      row.appendChild(check);
    }
    li.appendChild(row);
    return li;
  };

  const folderCount = () => [...nodes.values()].filter((n) => !n.root).length;
  const recents = () => ctl.recent.filter((key) => usable(key) && nodes.get(key) && !nodes.get(key).root).slice(0, PICKER_RECENT_SHOWN);

  const render = () => {
    filterInput.hidden = folderCount() < PICKER_FILTER_FROM;
    const terms = fold(filter).split(/\s+/).filter(Boolean);
    const filtering = terms.length > 0 && !filterInput.hidden;
    recentList.replaceChildren();
    tree.replaceChildren();
    let shown = 0;
    if (filtering) {
      for (const node of nodes.values()) {
        if (node.root || node.disabled || !terms.every((t) => fold(pathText(node)).includes(t))) continue;
        tree.appendChild(rowFor(node, { section: "tree", flat: true }));
        shown += 1;
      }
    } else {
      const lastPlaces = recents();
      for (const key of lastPlaces) recentList.appendChild(rowFor(nodes.get(key), { section: "recent", flat: true }));
      const walk = (node) => {
        tree.appendChild(rowFor(node, { section: "tree" }));
        shown += 1;
        if (expanded.has(node.key)) node.children.forEach(walk);
      };
      for (const node of nodes.values()) if (node.root) walk(node);
      recentLabel.hidden = recentList.hidden = lastPlaces.length === 0;
    }
    if (filtering) recentLabel.hidden = recentList.hidden = true;
    emptyRow.hidden = shown > 0;
    tree.hidden = shown === 0;
    // One tab stop in the list: the chosen place (else the first row); the arrow keys move it.
    const stop = itemFor(value) || items()[0];
    if (stop) stop.tabIndex = 0;
  };
  const items = () => [...panel.querySelectorAll('[role="treeitem"]')];
  const itemFor = (key, section = "tree") => items().find((li) => li.dataset.key === key && li.dataset.section === section) || items().find((li) => li.dataset.key === key) || null;

  const setOpen = (open, { focus = false } = {}) => {
    if (inline || isOpen === open) return;
    isOpen = open;
    panel.hidden = !open;
    trigger.setAttribute("aria-expanded", String(open));
    if (open) {
      reveal(value);
      render();
      const target = itemFor(value) || items()[0];
      target?.scrollIntoView({ block: "nearest" });
      if (focus) target?.focus({ preventScroll: true });
      document.addEventListener("pointerdown", onOutside, true);
    } else {
      document.removeEventListener("pointerdown", onOutside, true);
      if (filter) {
        filter = "";
        filterInput.value = "";
      }
    }
  };
  const onOutside = (ev) => {
    if (!el.isConnected) document.removeEventListener("pointerdown", onOutside, true);
    else if (!el.contains(ev.target)) setOpen(false);
  };

  const choose = (key) => {
    if (!usable(key)) return;
    const changed = key !== value;
    value = key;
    rememberPlace(key);
    drawTrigger();
    if (!inline) {
      setOpen(false);
      trigger.focus({ preventScroll: true });
    } else {
      render();
      itemFor(key)?.focus({ preventScroll: true });
    }
    if (changed) el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const toggle = (key, open) => {
    const node = nodes.get(key);
    if (!node || !node.children.length) return;
    if (open === undefined ? expanded.has(key) : !open) expanded.delete(key);
    else expanded.add(key);
    render();
    itemFor(key)?.focus({ preventScroll: true });
  };

  panel.addEventListener("click", (ev) => {
    const li = ev.target instanceof Element ? ev.target.closest('[role="treeitem"]') : null;
    if (!li) return;
    if (ev.target.closest("[data-twisty]")) {
      toggle(li.dataset.key);
      return;
    }
    if (li.getAttribute("aria-disabled") === "true") return;
    choose(li.dataset.key);
  });
  panel.addEventListener("keydown", (ev) => {
    const list = items();
    const current = ev.target instanceof Element ? ev.target.closest('[role="treeitem"]') : null;
    const at = current ? list.indexOf(current) : -1;
    const move = (target) => {
      if (!target) return;
      ev.preventDefault();
      ev.stopPropagation();
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: "nearest" });
    };
    if (ev.target === filterInput) {
      if (ev.key === "ArrowDown") move(list[0]);
      else if (ev.key === "Enter" && fold(filter)) {
        ev.preventDefault();
        ev.stopPropagation();
        const first = list.find((li) => li.getAttribute("aria-disabled") !== "true");
        if (first) choose(first.dataset.key);
      } else if (ev.key === "Escape" && !inline) {
        ev.preventDefault();
        ev.stopPropagation();
        if (filter) {
          filter = "";
          filterInput.value = "";
          render();
        } else {
          setOpen(false);
          trigger.focus({ preventScroll: true });
        }
      }
      return;
    }
    if (!current) return;
    const node = nodes.get(current.dataset.key);
    switch (ev.key) {
      case "ArrowDown": move(list[Math.min(list.length - 1, at + 1)]); break;
      case "ArrowUp":
        if (at === 0 && !filterInput.hidden) move(filterInput);
        else move(list[Math.max(0, at - 1)]);
        break;
      case "Home": move(list[0]); break;
      case "End": move(list[list.length - 1]); break;
      case "ArrowRight":
        if (current.dataset.section !== "tree" || !node?.children.length) break;
        ev.preventDefault();
        ev.stopPropagation();
        if (!expanded.has(node.key)) toggle(node.key, true);
        else move(itemFor(node.children[0].key));
        break;
      case "ArrowLeft":
        if (current.dataset.section !== "tree" || !node) break;
        ev.preventDefault();
        ev.stopPropagation();
        if (node.children.length && expanded.has(node.key)) toggle(node.key, false);
        else if (node.parent) move(itemFor(node.parent.key));
        break;
      case "Enter":
      case " ":
        ev.preventDefault();
        ev.stopPropagation();
        if (current.getAttribute("aria-disabled") !== "true") choose(node.key);
        break;
      case "Escape":
        if (inline) break;
        ev.preventDefault();
        ev.stopPropagation();
        setOpen(false);
        trigger.focus({ preventScroll: true });
        break;
      default:
        break;
    }
  });
  panel.addEventListener("focusin", (ev) => {
    const li = ev.target instanceof Element ? ev.target.closest('[role="treeitem"]') : null;
    if (!li) return;
    for (const other of items()) other.tabIndex = other === li ? 0 : -1;
  });
  filterInput.addEventListener("input", () => {
    filter = filterInput.value;
    render();
  });
  el.addEventListener("focusout", (ev) => {
    if (!inline && isOpen && ev.relatedTarget && !el.contains(ev.relatedTarget)) setOpen(false);
  });
  if (trigger) {
    trigger.addEventListener("click", () => setOpen(!isOpen, { focus: !isOpen }));
    trigger.addEventListener("keydown", (ev) => {
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        ev.stopPropagation();
        setOpen(true, { focus: true });
      } else if (ev.key === "Escape" && isOpen) {
        ev.preventDefault();
        ev.stopPropagation();
        setOpen(false);
      }
    });
  }

  const start = () => {
    nodes = buildNodes();
    signature = signatureOf();
    value = firstChoice(selected ? locValue(selected) : "");
    for (const node of nodes.values()) if (node.root) expanded.add(node.key);
    reveal(value);
    drawTrigger();
    if (isOpen) render();
  };
  start();

  return {
    el,
    name,
    get value() { return value; },
    set(loc) {
      const key = loc ? locValue(loc) : "";
      if (!usable(key)) return false;
      value = key;
      reveal(key);
      drawTrigger();
      if (isOpen) render();
      return true;
    },
    refresh() {
      const next = buildNodes();
      const before = signature;
      nodes = next;
      signature = signatureOf();
      if (signature === before) return false;
      value = firstChoice(value);
      for (const node of nodes.values()) if (node.root && !expanded.has(node.key) && !before.includes(`${node.key}|`)) expanded.add(node.key);
      reveal(value);
      drawTrigger();
      if (isOpen) render();
      return true;
    },
    focus() {
      if (trigger) trigger.focus({ preventScroll: true });
      else (itemFor(value) || items()[0])?.focus({ preventScroll: true });
    },
    hasFocus: () => el.contains(document.activeElement),
  };
}

// Highlighted SQL, clipped (a prompt shows the start, the pane more):
// the shared read-only SQL block (sqlBlock). The pane's block has its
// copy button and, when the editor shows line numbers, their gutter (its
// lines then scroll rather than wrap, so each number stays on its line).
function sqlPreview(sql, max = PROMPT_SQL_CHARS, { pane = false } = {}) {
  const text = String(sql || "");
  const clipped = text.length > max ? `${text.slice(0, max)}\n${ELLIPSIS}` : text;
  const gutter = pane && lineNumbersOn();
  return sqlBlock({ sql: clipped, wrap: !gutter, gutter, copy: pane, label: "Query", className: "qlSql" });
}

// The place of a Saved row: a root, a folder, or a query's folder.
function locOfKey(key) {
  const sel = parseKey(key);
  if (!sel || !storeOf(sel.store)) return null;
  const lib = storeOf(sel.store).library;
  if (sel.kind === "root") return { store: sel.store, folderId: null };
  if (sel.kind === "folder" && folderById(lib, sel.id)) return { store: sel.store, folderId: sel.id };
  if (sel.kind === "query") return { store: sel.store, folderId: queryById(lib, sel.id)?.folder_id || null };
  return null;
}

// The selected place in Saved, as a default target: the selected root or
// folder, a selected query's folder.
const selectedLoc = () => locOfKey(ctl.selection.saved);

// The saved query the editor holds (Ctrl+S updates it): { store, query }.
function openedQuery() {
  const store = ctl.opened ? storeOf(ctl.opened.store) : null;
  const query = store ? queryById(store.library, ctl.opened.id) : null;
  return query ? { store: store.kind, query } : null;
}

// ------------------------------------------------------- the pane's form

// Save and Edit are one form in the right pane of the library (no prompt over the dialog): the
// pane shows it in place of the preview while ctl.form holds it. The form is built once and the
// pane only attaches it again, so a render of the tree or the pane never loses what was typed.
// Its folder follows the place that is selected in the tree. Escape drops it (the preview
// is back), then the dialog closes as usual.

// The server's field names, as the form's fields.
const FORM_FIELD_OF = { name: "name", description: "description", folder_id: "folder_id", parent_id: "folder_id", target: "folder_id" };

function formField(name, label, control) {
  const wrap = h("div", { class: "uiField", dataset: { wrap: name } });
  control.id = `qlForm-${name}`;
  const error = h("div", { class: "uiField__error", id: `qlFormError-${name}`, role: "alert", hidden: true });
  wrap.append(h("label", { class: "uiField__label", for: control.id, id: `qlFormLabel-${name}` }, label), control, error);
  return wrap;
}

// mode "save": rawText (the editor's or the History run's) and fromHistory; "edit": sqlText, shown only.
// `submit(action, values)` ("submit" or "new") makes the change: true when it is done (it has closed the form),
// false when it stays (the toast said why); it throws what the form shows (a LibraryError, under its field).
function createPaneForm({ mode, key, title, name = "", description = "", where = null, rawText = "", fromHistory = null, sqlText = "", submitLabel = "Save", extraLabel = "", submit }) {
  const form = h("form", { class: "qlPaneForm" });
  form.noValidate = true;
  const session = { mode, key, el: form, host: ctl.host, title, busy: false, store: "", queryId: "", folder: null };
  const head = h("div", { class: "qlPreview__head" });
  const back = h("button", { class: "qlIconButton qlPreview__back" });
  back.type = "button";
  back.dataset.action = "back";
  back.setAttribute("aria-label", "Back to the list");
  back.title = "Back to the list";
  back.appendChild(icon("back"));
  // The title names the form for a screen reader; it is not drawn (the Folder, Name and SQL say what the form is).
  const heading = h("h3", { class: "qlPreview__title srOnly", id: "qlFormTitle" }, title);
  head.append(back, heading);
  form.setAttribute("aria-labelledby", heading.id);

  const nameInput = textInput("name", name, { placeholder: "e.g. Largest tables" });
  const descriptionInput = textArea("description", description, "What it answers, when to use it (optional)");
  const folder = createFolderPicker({ name: "folder_id", selected: where, labelId: "qlFormLabel-folder_id" });
  const fields = h("div", { class: "uiForm qlPaneForm__fields" });
  const nameWrap = formField("name", "Name", nameInput);
  const descriptionWrap = formField("description", "Description", descriptionInput);
  const folderWrap = formField("folder_id", "Folder", folder.el);
  fields.append(nameWrap, descriptionWrap, folderWrap);

  // The SQL: Save writes it as the formatter does unless "Save raw" keeps it as typed. A History run that was formatted
  // has its text; the others wait for the formatter (a script it rejects is saved as typed, the box is ticked and locked).
  const sqlBox = h("div", { class: "uiField qlForm__sql" });
  sqlBox.setAttribute("role", "group");
  const sqlLabel = h("span", { class: "uiField__label", id: "qlFormSqlLabel" });
  sqlBox.setAttribute("aria-labelledby", sqlLabel.id);
  const sqlHead = h("div", { class: "qlForm__sqlHead" }, sqlLabel);
  const sqlBody = h("div", { class: "qlForm__sqlBody" });
  sqlBox.append(sqlHead, sqlBody);
  let raw = null;
  let rawLabel = null;
  let formattedText = fromHistory?.formatted ? String(fromHistory.sql || "") : null;
  let formatting = null;
  const chosen = () => (mode !== "save" ? sqlText : raw.checked || !formattedText ? rawText : formattedText);
  // The formatter changed nothing: there is one text to save, and "Save raw" would offer a choice that is not one.
  const sameText = () => !!formattedText && formattedText.trim() === rawText.trim();
  const drawSql = () => {
    if (mode === "save") {
      const source = fromHistory ? "from History" : "from the editor";
      const same = sameText();
      rawLabel.hidden = same;
      sqlLabel.textContent = `SQL (${source}${same ? "" : raw.checked || !formattedText ? (formatting ? ", formatting\u2026" : "") : ", formatted"})`;
    } else {
      sqlLabel.textContent = "SQL";
    }
    sqlBody.replaceChildren(sqlPreview(chosen(), PANE_SQL_CHARS, { pane: true }));
  };
  if (mode === "save") {
    raw = h("input", { type: "checkbox", name: "raw", id: "qlSaveRaw" });
    // A small, quiet option at the end of the SQL's heading: the formatted text is what most saves want.
    const rawTextEl = h("span", { class: "qlRawToggle__text" }, "Save raw");
    rawLabel = h("label", { class: "qlRawToggle", for: "qlSaveRaw", title: "Keep the query as typed, without formatting." }, raw, rawTextEl);
    sqlHead.appendChild(rawLabel);
    raw.addEventListener("change", drawSql);
    if (!formattedText) {
      formatting = sqlMod.formatText(ctl.host, rawText).then(
        (text) => { formattedText = text || null; },
        () => {
          formattedText = null;
          raw.checked = true;
          raw.disabled = true;
          rawTextEl.textContent = "Saved as typed";
          rawLabel.title = "The formatter does not accept this query: it is saved as typed.";
        },
      ).then(() => {
        formatting = null;
        drawSql();
      });
    }
  }
  drawSql();

  const content = h("div", { class: "qlPreview__content" }, head, fields, sqlBox);
  const formError = h("div", { class: "uiField__error qlPaneForm__error", role: "alert", hidden: true });
  const foot = h("div", { class: "qlPreview__foot" });
  foot.setAttribute("role", "group");
  foot.setAttribute("aria-label", mode === "save" ? "Save this query" : "Save the changes");
  const cancel = h("button", { class: "button" }, "Cancel");
  cancel.type = "button";
  cancel.dataset.formAction = "cancel";
  const extra = extraLabel ? h("button", { class: "button" }, extraLabel) : null;
  if (extra) {
    extra.type = "button";
    extra.dataset.formAction = "new";
  }
  const primary = h("button", { class: "button button--primary" }, submitLabel);
  primary.type = "submit";
  primary.dataset.formAction = "submit";
  primary.title = `${submitLabel} (${util.modifierKeyLabel()}+Enter)`;
  foot.append(cancel, ...(extra ? [extra] : []), primary);
  form.append(content, formError, foot);

  const fieldError = (field, message, { focus = true } = {}) => {
    const wrap = $(`[data-wrap="${field}"]`, form);
    if (!wrap) return false;
    const error = $(".uiField__error", wrap);
    error.textContent = message;
    error.hidden = !message;
    const control = $("[data-field]", wrap);
    if (control) {
      control.setAttribute("aria-invalid", message ? "true" : "false");
      if (message) control.setAttribute("aria-describedby", error.id);
      else control.removeAttribute("aria-describedby");
      if (message && focus) control.focus();
    }
    return true;
  };
  const clearErrors = () => {
    for (const field of ["name", "description", "folder_id"]) fieldError(field, "", { focus: false });
    for (const control of $$("[data-field]", form)) control.removeAttribute("aria-invalid");
    formError.textContent = "";
    formError.hidden = true;
  };
  const showError = (err) => {
    const message = err instanceof LibraryError ? err.message : util.errorText(err, "The change failed.");
    if (!fieldError(FORM_FIELD_OF[err?.field] || "", message)) {
      formError.textContent = message;
      formError.hidden = false;
    }
  };
  nameInput.addEventListener("input", () => {
    fieldError("name", "", { focus: false });
    syncGhostName();
  });
  descriptionInput.addEventListener("input", () => fieldError("description", "", { focus: false }));
  folder.el.addEventListener("change", () => {
    fieldError("folder_id", "", { focus: false });
    showGhost(session);
  });

  const send = async (action) => {
    if (session.busy) return;
    clearErrors();
    session.busy = true;
    form.setAttribute("aria-busy", "true");
    try {
      if (formatting) await formatting;
      const done = await submit(action, { name: nameInput.value, description: descriptionInput.value, folder: session.folder.value, sql: chosen(), session });
      if (done) return;
    } catch (err) {
      showError(err);
    } finally {
      session.busy = false;
      form.removeAttribute("aria-busy");
    }
  };
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void send("submit");
  });
  extra?.addEventListener("click", () => void send("new"));
  cancel.addEventListener("click", () => cancelForm());
  form.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey) && !ev.altKey) {
      ev.preventDefault();
      ev.stopPropagation();
      void send("submit");
    }
  });

  // The folders of the tree changed (a folder made while saving): the list is built again with the same choice.
  session.refreshFolders = () => {
    session.folder.refresh();
  };
  // The place picked in the tree is the folder (a root or folder of a read-only storage is not offered).
  session.pickFolder = (loc) => {
    if (!loc) return;
    const before = session.folder.value;
    if (!session.folder.set(loc)) return;
    fieldError("folder_id", "", { focus: false });
    if (session.folder.value !== before) showGhost(session);
  };
  session.draftName = () => nameInput.value.trim();
  session.focus = () => {
    nameInput.focus({ preventScroll: true });
    nameInput.select();
  };
  session.folder = folder;
  return session;
}

// Where the form's query will sit, drawn in the tree: a dashed row in the folder of the Folder field (opened for it), at the
// place its name sorts to. Edit shows it only when the query moves. It is for the eye: aria-hidden, the Folder field says it.
const GHOST_NAME = "New query";
let ghost = null;
let ghostOpens = new Set();

function ghostSpot() {
  const form = ctl.form;
  if (!form || ctl.shown !== "saved" || !form.folder) return null;
  const loc = parseLoc(form.folder.value);
  if (!loc || !storeOf(loc.store)) return null;
  const moving = form.mode === "edit";
  if (moving) {
    const current = queryById(storeOf(form.store)?.library || emptyLibrary(), form.queryId);
    if (current && form.store === loc.store && (current.folder_id || null) === (loc.folderId || null)) return null;
  }
  return { store: loc.store, folderId: loc.folderId, name: form.draftName() || GHOST_NAME, moving };
}

function planGhost() {
  ghost = ghostSpot();
  ghostOpens = new Set();
  if (!ghost) return;
  const lib = storeOf(ghost.store).library;
  for (let cur = folderById(lib, ghost.folderId); cur; cur = folderById(lib, cur.parent_id)) ghostOpens.add(`${ghost.store}:${cur.id}`);
}

const folderIsOpen = (storeKind, id) => ctl.expanded.has(`${storeKind}:${id}`) || ghostOpens.has(`${storeKind}:${id}`);

function ghostRow(level) {
  const li = h("li", { class: "qlNode qlNode--ghost" });
  li.setAttribute("role", "none");
  li.setAttribute("aria-hidden", "true");
  const row = rowLead(level);
  row.classList.add("qlRow--ghost");
  row.append(icon("query"), h("span", { class: "qlRow__text" }, h("span", { class: "qlRow__name" }, ghost.name)), h("span", { class: "qlRow__meta" }, ghost.moving ? "moves here" : "saved here"));
  li.appendChild(row);
  return li;
}

// The tree draws the place again (the Folder changed); the focus stays where it is.
function showGhost(session) {
  if (ctl.form === session && ctl.shown === "saved") renderTree();
}

// The name is typed: the dashed row follows it.
function syncGhostName() {
  const name = libraryEls.tree && $(".qlNode--ghost .qlRow__name", libraryEls.tree);
  if (name && ctl.form) name.textContent = ctl.form.draftName() || GHOST_NAME;
}

// Shows the form in the pane: the Saved tab, the form attached, its name field focused (a phone: the pane step).
async function openForm(session) {
  ctl.editing = null;
  ctl.form = session;
  await queryUi.openQueryLibrary("saved", { focus: false });
  if (ctl.form !== session) return;
  renderPreview();
  renderTree();
  if (isPhone()) setPreviewStep(true);
  session.focus();
}

// The form is there again (the same one), its name field focused.
function revealForm() {
  if (ctl.shown !== "saved") void queryUi.openQueryLibrary("saved", { focus: false }).then(() => revealForm());
  else {
    renderPreview();
    renderTree();
    if (isPhone()) setPreviewStep(true);
    if (ctl.form && !ctl.form.el.contains(document.activeElement)) ctl.form.focus();
  }
}

// The form is dropped: the preview of the selection is back, the focus on the selected row (a phone goes back to the list).
function closeForm() {
  const session = ctl.form;
  if (!session) return;
  ctl.form = null;
  if (ctl.shown === "saved") {
    renderPreview();
    renderTree();
  }
  if (isPhone()) setPreviewStep(false);
  focusSelected();
}

function cancelForm() {
  if (ctl.form && !ctl.form.busy) closeForm();
}

// The tree changed: a vanished query ends its Edit; the folder list follows the folders.
function syncForm() {
  const session = ctl.form;
  if (!session) return;
  if (session.host !== ctl.host || (session.mode === "edit" && !queryById(storeOf(session.store)?.library || emptyLibrary(), session.queryId))) {
    ctl.form = null;
    if (ctl.shown === "saved") {
      renderPreview();
      renderTree();
    }
    return;
  }
  session.refreshFolders();
}

// Escape: the form first (focus anywhere in the dialog), then the dialog closes as usual.
function onDialogKeydown(ev) {
  if (ev.key !== "Escape" || ev.defaultPrevented || ev.isComposing || !ctl.form || ctl.shown !== "saved" || rowMenu) return;
  if (ev.target instanceof Element && ev.target.closest("dialog") !== dom.queryLibraryMenu) return;
  ev.preventDefault();
  ev.stopPropagation();
  cancelForm();
}

// The tree selection (a click, the arrows, a new folder) is the form's Folder.
function formFollows(key) {
  ctl.form?.pickFolder(locOfKey(key));
}

// Save the editor (or a History run) as a library query, in either
// root. When the editor holds a query opened from an editable root, the
// form also offers to update it ("Update", and "Save as new").
async function beginSave({ sql = null, fromHistory = null } = {}) {
  await start();
  if (!ctl.host) {
    toast(new NoHostError().message, "error");
    return;
  }
  if (!anyEditable()) {
    toast("The library is read-only.", "error");
    return;
  }
  const rawText = String(sql != null ? (fromHistory?.raw || sql) : editorSql()).trim();
  if (!rawText) {
    toast("Write a query first: the editor is empty.", "error");
    dom.queryTextArea?.focus();
    return;
  }
  const key = fromHistory ? `save:history:${fromHistory.id}` : "save:editor";
  if (ctl.form?.key === key && ctl.form.host === ctl.host) {
    revealForm();
    return;
  }
  const held = sql == null ? openedQuery() : null;
  const opened = held && editableStore(storeOf(held.store)) ? held : null;
  const where = opened ? { store: opened.store, folderId: opened.query.folder_id } : selectedLoc();
  const session = createPaneForm({
    mode: "save",
    key,
    title: opened ? `Save \u201c${opened.query.name}\u201d` : "Save to library",
    name: opened ? opened.query.name : "",
    description: opened ? opened.query.description : "",
    where,
    rawText,
    fromHistory,
    submitLabel: opened ? "Update" : "Save",
    extraLabel: opened ? "Save as new" : "",
    submit: async (action, values) => {
      const target = parseLoc(values.folder);
      if (!target) throw validation("folder_id", "Pick a folder.");
      const input = { folder_id: target.folderId, name: validName(values.name), description: validDescription(values.description), sql: values.sql };
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
      if (sql == null && savedId) ctl.opened = { store: target.store, id: savedId, sql: rawText };
      // The tree opens the folder it went into, the query highlighted; the pane shows it.
      ctl.search = "";
      if (libraryEls.input) libraryEls.input.value = "";
      ctl.selection.saved = savedId ? keyOf("query", target.store, savedId) : "";
      expandPath(target.store, target.folderId);
      ctl.form = null;
      renderLibrary({ keepFocus: false });
      closeAfter();
      return true;
    },
  });
  await openForm(session);
}

// After a change: the tree row of the query has the focus (a phone: the preview of it).
function closeAfter() {
  if (isPhone()) enterPreview();
  else focusSelected();
}

// Edit (a query's name, description and folder; its SQL is only shown): the same form.
async function beginEdit(storeKind, query) {
  const key = `edit:${storeKind}:${query.id}`;
  if (ctl.form?.key === key) {
    revealForm();
    return;
  }
  const session = createPaneForm({
    mode: "edit",
    key,
    title: "Edit query",
    name: query.name,
    description: query.description,
    where: { store: storeKind, folderId: query.folder_id },
    sqlText: query.sql,
    submit: async (action, values) => {
      const target = parseLoc(values.folder) || { store: storeKind, folderId: query.folder_id };
      const patch = { name: validName(values.name), description: values.description, folder_id: target.folderId };
      if (target.store !== storeKind) {
        if (!(await moveAcross({ kind: "query", store: storeKind, id: query.id }, target, { inDialog: true, patch }))) return false;
      } else {
        const result = await apply(storeKind, (adapter) => adapter.updateQuery(query.id, patch), { success: "Query updated.", select: keyOf("query", storeKind, query.id), inDialog: true });
        if (!result) return false;
      }
      expandPath(target.store, target.folderId);
      // The change drew the tree while the query sat in a folder that was closed: it is selected again, now that the folder is open.
      ctl.selection.saved = keyOf("query", target.store, target.store === storeKind ? query.id : parseKey(ctl.selection.saved)?.id || query.id);
      ctl.form = null;
      renderLibrary({ keepFocus: false });
      closeAfter();
      return true;
    },
  });
  session.store = storeKind;
  session.queryId = query.id;
  await openForm(session);
}

// Moves one or several items into one folder of either root.
async function moveDialog(items) {
  const list = (Array.isArray(items) ? items : [items]).map((item) => {
    const lib = storeOf(item.store)?.library;
    const entity = !lib ? null : item.kind === "folder" ? folderById(lib, item.id) : queryById(lib, item.id);
    return entity ? { item, entity } : null;
  }).filter(Boolean);
  if (!list.length) return;
  const first = list[0];
  const current = { store: first.item.store, folderId: first.item.kind === "folder" ? first.entity.parent_id : first.entity.folder_id };
  const folders = list.filter((x) => x.item.kind === "folder").map((x) => ({ store: x.item.store, id: x.entity.id }));
  const picker = createFolderPicker({ name: "target", selected: current, exclude: folders, inline: true, labelId: "qlMoveLabel" });
  const body = h("div", { class: "uiForm" });
  const what = list.length === 1 ? `\u201c${first.entity.name}\u201d` : `${format.count(list.length)} items`;
  const moveField = h("div", { class: "uiField" });
  moveField.setAttribute("role", "group");
  moveField.setAttribute("aria-labelledby", "qlMoveLabel");
  moveField.append(h("span", { class: "uiField__label", id: "qlMoveLabel" }, `Move ${what} to`), picker.el);
  body.appendChild(moveField);
  await openDialog({
    title: "Move to\u2026",
    submitLabel: "Move",
    body,
    onSubmit: async () => {
      const target = parseLoc(picker.value);
      if (!target || locValue(target) === locValue(current)) return true;
      for (const { item } of list) {
        if (!(await moveItem(item, target, { inDialog: true }))) return false;
      }
      renderLibrary({ keepFocus: false });
      return true;
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
  return dialog.confirm({ title, message, confirmLabel, danger, className: "qlDialog" });
}

// Removes the given items after one confirm; a folder goes with everything in it. A folder
// the library shows (or holds the one it shows) takes you up to its parent.
async function deleteItems(items) {
  const list = (items || []).map((item) => {
    const lib = storeOf(item.store)?.library;
    const entity = !lib ? null : item.kind === "folder" ? folderById(lib, item.id) : queryById(lib, item.id);
    return entity && editableStore(storeOf(item.store)) ? { item, entity, lib } : null;
  }).filter(Boolean);
  if (!list.length) return;
  const folderCount = list.filter((x) => x.item.kind === "folder").length;
  let inside = { folders: 0, queries: 0 };
  for (const { item, lib } of list) {
    if (item.kind !== "folder") continue;
    const counts = subtreeCounts(lib, item.id);
    inside = { folders: inside.folders + counts.folders, queries: inside.queries + counts.queries };
  }
  const nothingInside = !inside.folders && !inside.queries;
  let title;
  let message;
  let confirmLabel = "Remove";
  if (list.length === 1) {
    const { item, entity } = list[0];
    if (item.kind === "folder") {
      const parts = [];
      if (inside.queries) parts.push(format.countLabel(inside.queries, "query", "queries"));
      if (inside.folders) parts.push(format.countLabel(inside.folders, "subfolder"));
      title = "Remove folder";
      message = nothingInside
        ? `Remove the empty folder \u201c${entity.name}\u201d?`
        : `Remove \u201c${entity.name}\u201d and everything in it (${parts.join(" and ")})? This cannot be undone.`;
      confirmLabel = nothingInside ? "Remove" : "Remove all";
    } else {
      title = "Remove query";
      message = `Remove \u201c${entity.name}\u201d? This cannot be undone.`;
    }
  } else {
    title = `Remove ${format.count(list.length)} items`;
    const parts = [format.countLabel(list.length - folderCount, "query", "queries"), folderCount ? format.countLabel(folderCount, "folder") : ""].filter(Boolean);
    message = `Remove ${parts.join(" and ")}${nothingInside ? "" : `, with everything in the folders (${[inside.queries ? format.countLabel(inside.queries, "query", "queries") : "", inside.folders ? format.countLabel(inside.folders, "subfolder") : ""].filter(Boolean).join(" and ")})`}? This cannot be undone.`;
    confirmLabel = "Remove all";
  }
  const ok = await confirmDialog({ title, message, confirmLabel });
  if (!ok) {
    focusSelected();
    return;
  }
  const last = list[list.length - 1].item;
  const next = list.length === 1 ? neighbourKey(keyOf(last.kind, last.store, last.id)) : "";
  let removed = 0;
  for (const { item, entity } of list) {
    const result = await apply(
      item.store,
      (adapter) => (item.kind === "folder" ? adapter.deleteFolder(entity.id, { recursive: true }) : adapter.deleteQuery(entity.id)),
      { success: list.length === 1 ? (item.kind === "folder" ? "Folder removed." : "Query removed.") : "", select: next },
    );
    if (!result) break;
    removed += 1;
    if (item.kind === "query" && ctl.opened?.store === item.store && ctl.opened.id === entity.id) ctl.opened = null;
  }
  if (list.length > 1 && removed) toast(`${format.countLabel(removed, "item")} removed.`);
  renderLibrary({ keepFocus: true });
  focusSelected();
}

// ------------------------------------------------------------ library view

// Saved is a tree, as in the Explorer: the storages ("Shared server storage"
// then "Local browser storage") are its top folders and every folder opens
// in place. A row's "..." menu (and the right click) changes it, ticked rows
// are changed together, a folder or a query is named in place, and the
// preview pane on the right shows the highlighted row.
const libraryEls = {};

// Item keys: "r:<store>" a root, "f:<store>:<id>" a folder, "q:<store>:<id>" a query.
function keyOf(kind, store, id) {
  if (kind === "root") return `r:${store}`;
  return `${kind === "folder" ? "f" : "q"}:${store}:${id}`;
}

function parseKey(key) {
  const text = String(key || "");
  let m = /^r:([^:]+)$/.exec(text);
  if (m) return { kind: "root", store: m[1], id: "" };
  m = /^([fq]):([^:]+):(.+)$/.exec(text);
  return m ? { kind: m[1] === "f" ? "folder" : "query", store: m[2], id: m[3] } : null;
}

const itemOfLi = (li) => ({ kind: li.dataset.kind, store: li.dataset.store, id: li.dataset.id || "" });

// Opens every folder from the top of a root down to `folderId` (and the root).
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
  const { head, input, actions } = listHead("Search the library", { title: "Searches names, descriptions and SQL" });
  // The head's one tool: a new folder, inside the highlighted folder (else in a root).
  const newFolder = iconButton("folderPlus", "New folder", "new-folder");
  actions.appendChild(newFolder);
  const notice = h("div", { class: "ql__notice" });
  const tree = h("ul", { class: "qlTree" });
  tree.setAttribute("role", "tree");
  tree.setAttribute("aria-label", "Saved queries");
  tree.setAttribute("aria-multiselectable", "true");
  const foot = h("div", { class: "ql__foot" });
  const count = h("span", { class: "qlFoot__count" });
  foot.append(count);
  wrap.append(head, notice, tree, foot);
  root.appendChild(wrap);
  Object.assign(libraryEls, { root, wrap, input, actions, newFolder, notice, tree, foot, count });

  // ns.search: the one delay; Enter (before the handler below) and Escape (a
  // filled field) apply the field at once.
  const searchField = search.bind(input, (value) => {
    ctl.search = value;
    ctl.editing = null;
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
  newFolder.addEventListener("click", () => {
    const loc = selectedLoc() || { store: defaultStore(), folderId: null };
    startNewFolder({ store: loc.store, parentId: loc.folderId });
  });

  tree.addEventListener("pointerdown", onTreePointerDown, true);
  tree.addEventListener("click", onTreeClick);
  tree.addEventListener("click", endTreePointer);
  tree.addEventListener("contextmenu", endTreePointer);
  tree.addEventListener("dragstart", endTreePointer);
  tree.addEventListener("pointercancel", endTreePointer);
  tree.addEventListener("dblclick", onTreeDoubleClick);
  tree.addEventListener("contextmenu", onTreeContextMenu);
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
  syncForm();
  renderTree({ keepFocus });
}

function renderNotice() {
  const notice = libraryEls.notice;
  notice.replaceChildren();
  if (!ctl.host) notice.appendChild(uiState.banner(h("div"), { message: "Select a ClickHouse host: saved queries and History belong to a host.", inset: true }));
  for (const store of storeList()) {
    if (store.fatal) {
      notice.appendChild(uiState.banner(h("div"), { message: `${rootLabel(store.kind)}: ${store.fatal}`, retry: () => void reloadStore(store).then(() => renderLibrary()), inset: true }));
    }
    if (store.loadError) {
      notice.appendChild(uiState.banner(h("div"), { message: `The library file could not be read (${store.loadError}); ${rootLabel(store.kind)} is shown read-only.`, inset: true }));
    }
  }
  notice.hidden = !notice.childElementCount;
}

// The foot: the count of queries and the host. (Saving the editor's query is the editor's own button, beside the copy button.)
function renderFoot() {
  const total = storeList().reduce((n, store) => n + store.library.queries.length, 0);
  const count = format.countLabel(total, "query", "queries");
  libraryEls.count.textContent = ctl.host ? `${count}${MIDDOT}${ctl.host}` : count;
  libraryEls.count.title = storeList().map((store) => `${rootLabel(store.kind)}: ${format.countLabel(store.library.queries.length, "query", "queries")}`).join("\n");
}

// ---- search

function searchMatches() {
  const terms = fold(ctl.search).split(/\s+/).filter(Boolean);
  if (!terms.length) return null;
  const out = [];
  for (const store of storeList()) {
    const lib = store.library;
    for (const q of lib.queries) {
      const path = `${rootLabel(store.kind)} ${folderPathText(lib, q.folder_id)}`;
      const hay = fold(`${q.name}\n${q.description}\n${q.sql}\n${folderPathText(lib, q.folder_id)}`);
      if (!terms.every((t) => hay.includes(t))) continue;
      const nameHits = terms.filter((t) => fold(q.name).includes(t)).length;
      out.push({ store: store.kind, q, path, score: nameHits });
    }
  }
  out.sort((a, b) => b.score - a.score || byName(a.q, b.q));
  return { terms, results: out };
}

function nameWithMarks(name, terms, tag = "span") {
  const span = h(tag, { class: "qlRow__name" });
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

// ---- rows

function rowShell(kind, storeKind, id, level) {
  const li = h("li", { class: `qlNode qlNode--${kind}` });
  li.setAttribute("role", "treeitem");
  li.setAttribute("aria-level", String(level));
  li.dataset.kind = kind;
  li.dataset.store = storeKind;
  li.dataset.id = id;
  li.dataset.key = keyOf(kind, storeKind, id);
  li.tabIndex = -1;
  li.setAttribute("aria-selected", "false");
  return li;
}

// The start of a row, up to its icon: the indentation, the twisty.
function rowLead(level, { twisty = false } = {}) {
  const row = h("div", { class: "qlRow" });
  row.style.setProperty("--qlDepth", String(level - 1));
  const mark = h("span", { class: "qlRow__twisty" });
  mark.setAttribute("aria-hidden", "true");
  if (!twisty) mark.classList.add("is-leaf");
  row.append(h("span", { class: "qlRow__indent", "aria-hidden": "true" }), mark);
  return row;
}

// The name typed in place: a new folder, or a folder renamed. Enter makes the change, Escape drops it.
function editorRow(li, level, { value = "", placeholder = "Folder name", mode, onCommit }) {
  const row = rowLead(level);
  row.classList.add("qlRow--edit");
  const input = h("input", { class: "uiInput qlRow__input" });
  input.type = "text";
  input.value = value;
  input.placeholder = placeholder;
  input.maxLength = MAX_NAME_CHARS;
  input.autocomplete = "off";
  input.spellcheck = false;
  input.dataset.field = "name";
  input.setAttribute("aria-label", mode === "new" ? "New folder name" : "Folder name");
  const error = h("div", { class: "qlRow__error" });
  error.setAttribute("role", "alert");
  error.hidden = true;
  const ok = iconButton("check", mode === "new" ? "Create the folder" : "Rename the folder", "edit-ok");
  const cancel = iconButton("x", "Cancel", "edit-cancel");
  const field = h("div", { class: "qlRow__field" }, input, error);
  row.append(icon("folder"), field, ok, cancel);
  li.appendChild(row);
  let busy = false;
  const fail = (message) => {
    error.textContent = message;
    error.hidden = !message;
    input.setAttribute("aria-invalid", message ? "true" : "false");
  };
  const commit = async () => {
    if (busy) return;
    busy = true;
    fail("");
    try {
      await onCommit(validName(input.value));
    } catch (err) {
      fail(err instanceof LibraryError ? err.message : util.errorText(err, "The change failed."));
      input.focus();
    } finally {
      busy = false;
    }
  };
  const stop = () => {
    ctl.editing = null;
    renderTree({ keepFocus: true });
    focusSelected();
  };
  input.addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    if (ev.key === "Enter") {
      ev.preventDefault();
      void commit();
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      stop();
    }
  });
  input.addEventListener("input", () => fail(""));
  ok.addEventListener("click", (ev) => {
    ev.stopPropagation();
    void commit();
  });
  cancel.addEventListener("click", (ev) => {
    ev.stopPropagation();
    stop();
  });
  return input;
}

// The row of a new folder, first in the folder it goes into.
function newFolderRow(level) {
  const li = h("li", { class: "qlNode qlNode--new" });
  li.setAttribute("role", "none");
  const { store, parentId } = ctl.editing;
  const input = editorRow(li, level, {
    mode: "new",
    onCommit: async (name) => {
      const result = await apply(store, (adapter) => adapter.createFolder({ parent_id: parentId, name }), { success: "Folder created.", select: (id) => keyOf("folder", store, id), inDialog: true });
      if (!result) return;
      ctl.editing = null;
      renderLibrary({ keepFocus: false });
      formFollows(ctl.selection.saved);
      focusSelected();
    },
  });
  queueMicrotask(() => input.focus());
  return li;
}

// A new folder in `parentId` (null: the top of the root): that folder opens, the name is typed in it.
function startNewFolder({ store, parentId = null }) {
  if (!store || !editableStore(storeOf(store))) return;
  ctl.search = "";
  if (libraryEls.input) libraryEls.input.value = "";
  expandPath(store, parentId);
  ctl.editing = { mode: "new", store, parentId: parentId || null };
  renderLibrary({ keepFocus: false });
}

function startRename(li) {
  ctl.editing = { mode: "rename", key: li.dataset.key };
  renderTree({ keepFocus: false });
}

function metaText(kind, store, entity) {
  if (kind === "folder") return queriesText(queryCounts(store.library).get(entity.id) || 0);
  return entity.updated_at_ms ? format.time(entity.updated_at_ms, { precision: "min" }) : "";
}

// A folder or a query row; `level` is its depth in the tree (a root is 1).
function fileRow(kind, storeKind, entity, level, { terms = null, path = "" } = {}) {
  const store = storeOf(storeKind);
  const li = rowShell(kind, storeKind, entity.id, level);
  const editable = editableStore(store);
  if (editable) li.draggable = true;
  if (ctl.editing?.mode === "rename" && ctl.editing.key === li.dataset.key) {
    const input = editorRow(li, level, {
      value: entity.name,
      mode: "rename",
      onCommit: async (name) => {
        if (name !== entity.name) {
          const result = await apply(storeKind, (adapter) => adapter.updateFolder(entity.id, { name }), { success: "Folder renamed.", select: li.dataset.key, inDialog: true });
          if (!result) return;
        }
        ctl.editing = null;
        renderLibrary({ keepFocus: false });
        focusSelected();
      },
    });
    // Once the row is in the tree: the name, selected, ready to be typed over.
    queueMicrotask(() => {
      input.focus();
      input.select();
    });
    return li;
  }
  const row = rowLead(level, { twisty: kind === "folder" });
  row.append(icon(kind === "folder" ? "folder" : "query"));
  const text = h("span", { class: "qlRow__text" });
  text.appendChild(nameWithMarks(entity.name, terms));
  if (path) text.appendChild(h("span", { class: "qlRow__path" }, path));
  row.appendChild(text);
  const meta = h("span", { class: "qlRow__meta" }, metaText(kind, store, entity));
  if (kind === "query" && entity.updated_at_ms) meta.title = format.timeTitle(entity.updated_at_ms);
  row.appendChild(meta);
  const menu = iconButton("dots", `Actions for ${entity.name}`, "row-menu");
  menu.classList.add("qlRow__menu");
  menu.tabIndex = -1;
  menu.setAttribute("aria-haspopup", "menu");
  row.appendChild(menu);
  if (kind === "folder") {
    li.setAttribute("aria-expanded", String(folderIsOpen(storeKind, entity.id)));
  } else if (ctl.opened?.store === storeKind && ctl.opened.id === entity.id) {
    row.classList.add("is-opened");
    li.setAttribute("aria-current", "true");
  }
  li.appendChild(row);
  return li;
}

// The children of a folder (or of a root: folderId null), one level deeper than their parent.
function appendFolderChildren(parentEl, storeKind, folderId, level) {
  const lib = storeOf(storeKind).library;
  if (ctl.editing?.mode === "new" && ctl.editing.store === storeKind && (ctl.editing.parentId || null) === (folderId || null)) parentEl.appendChild(newFolderRow(level));
  for (const folder of childFolders(lib, folderId)) {
    const li = fileRow("folder", storeKind, folder, level);
    if (folderIsOpen(storeKind, folder.id) && !(ctl.editing?.mode === "rename" && ctl.editing.key === li.dataset.key)) {
      const group = h("ul", { class: "qlTree__group" });
      group.setAttribute("role", "group");
      appendFolderChildren(group, storeKind, folder.id, level + 1);
      if (!group.childElementCount) group.appendChild(emptyFolderRow("Empty folder", level));
      li.appendChild(group);
    }
    parentEl.appendChild(li);
  }
  let ghostPlaced = !(ghost && ghost.store === storeKind && (ghost.folderId || null) === (folderId || null));
  for (const query of childQueries(lib, folderId)) {
    if (!ghostPlaced && byName({ name: ghost.name }, query) <= 0) {
      parentEl.appendChild(ghostRow(level));
      ghostPlaced = true;
    }
    const li = fileRow("query", storeKind, query, level);
    parentEl.appendChild(li);
  }
  if (!ghostPlaced) parentEl.appendChild(ghostRow(level));
}

function emptyFolderRow(text, level) {
  const empty = h("li", { class: "qlTree__empty" }, text);
  empty.setAttribute("role", "none");
  empty.style.setProperty("--qlDepth", String(level));
  return empty;
}

// A root: "Shared server storage" or "Local browser storage", its count of queries, a lock badge
// when read-only; open unless closed.
function rootRow(store) {
  const li = rowShell("root", store.kind, "", 1);
  const open = !ctl.closedRoots.has(store.kind) || ghost?.store === store.kind;
  li.setAttribute("aria-expanded", String(open));
  const row = rowLead(1, { twisty: true });
  row.classList.add("qlRow--root");
  row.append(icon(isServerStore(store) ? "server" : "local"));
  const text = h("span", { class: "qlRow__text" });
  text.appendChild(h("span", { class: "qlRow__name" }, rootLabel(store.kind)));
  row.appendChild(text);
  if (isServerStore(store) && !editableStore(store) && ctl.host && !store.fatal) {
    const badge = badgeMod.el("Read-only", { tone: "warn", size: "sm", shape: "pill", className: "qlBadge qlBadge--readonly" });
    badge.title = "This server shares its query library read-only: opening and copying queries works, changes are disabled.";
    badge.prepend(icon("lock"));
    row.appendChild(badge);
  }
  const n = store.library.queries.length;
  if (n) row.appendChild(h("span", { class: "qlRow__count" }, format.countLabel(n, "query", "queries")));
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

function emptyRow(text) {
  const li = h("li", { class: "qlTree__empty qlTree__empty--root" }, text);
  li.setAttribute("role", "none");
  return li;
}

function renderTree({ keepFocus = false } = {}) {
  const tree = libraryEls.tree;
  if (!tree) return;
  const hadFocus = keepFocus || tree.contains(document.activeElement);
  planGhost();
  tree.replaceChildren();
  const matches = searchMatches();
  tree.classList.toggle("is-search", !!matches);
  if (matches) {
    for (const { store, q, path } of matches.results) tree.appendChild(fileRow("query", store, q, 1, { terms: matches.terms, path }));
    if (!matches.results.length) tree.appendChild(emptyRow(`No saved query matches \u201c${ctl.search.trim()}\u201d.`));
  } else if (ctl.host) {
    // Nothing saved is not a special screen: the roots, each saying it is empty.
    for (const store of storeList()) tree.appendChild(rootRow(store));
  }
  restoreSelection("saved");
  // The focus stays in the tree: on the highlighted row, else on the first.
  if (hadFocus && !tree.contains(document.activeElement)) (selectedItem("saved") || treeItems()[0])?.focus({ preventScroll: false });
}

function treeItems() {
  return libraryEls.tree ? [...$$("li.qlNode[data-key]", libraryEls.tree)] : [];
}

function itemOf(target) {
  const li = target instanceof Element ? target.closest("li.qlNode[data-key]") : null;
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
  (selectedItem("saved") || treeItems()[0])?.focus({ preventScroll: true });
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
  formFollows(li.dataset.key);
  renderTree({ keepFocus: true });
}

function entityOf(li) {
  if (!li) return null;
  const store = storeOf(li.dataset.store);
  if (!store) return null;
  if (li.dataset.kind === "root") return { id: "", name: rootLabel(store.kind) };
  return li.dataset.kind === "folder" ? folderById(store.library, li.dataset.id) : queryById(store.library, li.dataset.id);
}

const isFolderLike = (li) => li.dataset.kind === "folder" || li.dataset.kind === "root";

// ---- a row's menu (the "..." button, the right click, Shift+F10)

let rowMenu = null;

function closeRowMenu() {
  rowMenu?.close({ focus: false });
  rowMenu = null;
}

function menuItem(label, iconName, { key = "", danger = false, run }) {
  const node = h("button", { class: `runMenu__opt qlMenu__opt${danger ? " qlMenu__opt--danger" : ""}` });
  node.type = "button";
  node.setAttribute("role", "menuitem");
  node.append(icon(iconName), h("span", { class: "runMenu__optText" }, label));
  if (key) node.appendChild(h("kbd", { class: "qlMenu__key" }, key));
  // Once the menu has closed: a prompt opened while the menu is still a layer would close with it.
  node.addEventListener("click", () => setTimeout(run, 0));
  return node;
}

const targetsOf = (li) => [itemOfLi(li)];

function openRowMenu(li, { x = 0, y = 0, anchor = null } = {}) {
  const entity = entityOf(li);
  if (!entity) return;
  closeRowMenu();
  const item = itemOfLi(li);
  const store = storeOf(item.store);
  const canEdit = item.kind !== "root" && editableStore(store);
  const menu = h("div", { class: "runMenu rowDetailsMenu qlMenu" });
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", `Actions for ${entity.name}`);
  const mod = util.modifierKeyLabel();
  if (item.kind === "query") menu.appendChild(menuItem("Load", "file", { key: `${mod}+\u21b5`, run: () => loadItem(li) }));
  else menu.appendChild(menuItem(li.getAttribute("aria-expanded") === "true" ? "Close" : "Open", "folderOpen", { key: "\u21b5", run: () => toggleFolder(li) }));
  if (item.kind === "query" && ctl.search.trim()) menu.appendChild(menuItem("Show in folder", "folder", { run: () => revealQuery(item) }));
  if (canEdit) {
    menu.appendChild(menuItem(item.kind === "query" ? "Edit\u2026" : "Rename", "edit", { key: "F2", run: () => editItem(li) }));
    menu.appendChild(menuItem("Move to\u2026", "move", { key: `${mod}+M`, run: () => moveDialog(targetsOf(li)) }));
  }
  // A folder, with everything in it, as a JSON file (a read-only storage's too: it only reads).
  if (item.kind === "folder") menu.appendChild(menuItem("Export as JSON", "download", { run: () => exportFolder(item) }));
  if (canEdit) {
    menu.appendChild(h("div", { class: "qlMenu__sep", role: "separator" }));
    menu.appendChild(menuItem("Remove", "remove", { key: "Del", danger: true, run: () => deleteItems(targetsOf(li)) }));
  }
  li.classList.add("is-menuTarget");
  rowMenu = menuMod.context(menu, {
    x,
    y,
    anchor,
    align: "end",
    within: li,
    returnFocus: li,
    expanded: anchor,
    onClose: () => {
      li.classList.remove("is-menuTarget");
      rowMenu = null;
    },
  });
}

// A folder and everything in it as a JSON file: the body POST /api/query-library/import takes (host_id,
// folders, queries), so the file can be imported again.
function exportFolder(item) {
  const lib = storeOf(item.store)?.library;
  const folder = lib ? folderById(lib, item.id) : null;
  if (!folder) return;
  const tree = subtreeOf(lib, folder.id);
  const payload = {
    host_id: ctl.host,
    folders: tree.folders.map((f) => ({ id: f.id, parent_id: f.parent_id, name: f.name })),
    queries: tree.queries.map((q) => ({ folder_id: q.folder_id, name: q.name, description: q.description || "", sql: q.sql, created_at_ms: q.created_at_ms, updated_at_ms: q.updated_at_ms })),
  };
  const name = `${folder.name.replace(/[\\/:*?"<>|\s]+/g, "_").replace(/^_+|_+$/g, "") || "folder"}.json`;
  copy.download(name, `${JSON.stringify(payload, null, 2)}\n`);
  toast(`Exported ${format.countLabel(payload.queries.length, "query", "queries")} to ${name}.`);
}

// A search result, in its folder: the search is left and the folders above it open.
function revealQuery(item) {
  const store = storeOf(item.store);
  const query = store ? queryById(store.library, item.id) : null;
  if (!query) return;
  ctl.search = "";
  if (libraryEls.input) libraryEls.input.value = "";
  expandPath(item.store, query.folder_id);
  ctl.selection.saved = keyOf("query", item.store, item.id);
  renderLibrary({ keepFocus: false });
  focusSelected();
}

// ---- clicks and keys

function loadItem(li) {
  const entity = entityOf(li);
  if (entity && li.dataset.kind === "query") openInEditor(entity, { store: li.dataset.store, savedQuery: entity });
}

// A click highlights the row (its preview on the right); a folder or a root also opens or closes. The
// box ticks the row, "..." opens its menu. On a phone the twisty and the folder icon open or close a
// folder, its name opens its preview.
function onTreeClick(ev) {
  const target = ev.target instanceof Element ? ev.target : null;
  const li = itemOf(target);
  if (!li || target.closest(".qlRow--edit")) return;
  const menuButton = target.closest('[data-action="row-menu"]');
  if (menuButton) {
    select("saved", li, { focus: false });
    openRowMenu(li, { anchor: menuButton });
    return;
  }
  // Was this row the selected one before the press? (The press focuses the row, and the focus selects it.)
  const wasSelected = treePress?.key === li.dataset.key ? treePress.wasSelected : ctl.selection.saved === li.dataset.key;
  treePress = null;
  if (isFolderLike(li)) {
    if (isPhone()) {
      // The twisty is small under a finger: the icon opens and closes too, the name shows the pane.
      if (!target.closest(".qlRow__twisty, .qlRow > .qlIcon")) {
        select("saved", li);
        enterPreview();
        return;
      }
      toggleFolder(li);
      return;
    }
    // The chevron opens and closes. A click on the row selects a folder and opens it when it is closed; on the folder that
    // is already selected (the blue frame) and open, it closes it as the chevron does.
    if (target.closest(".qlRow__twisty")) toggleFolder(li);
    else toggleFolder(li, !(wasSelected && li.getAttribute("aria-expanded") === "true"));
    return;
  }
  select("saved", li);
  if (isPhone()) enterPreview();
}

// A double click loads a query (a folder already opened or closed with the first click).
function onTreeDoubleClick(ev) {
  const li = itemOf(ev.target);
  if (!li || li.dataset.kind !== "query" || (ev.target instanceof Element && ev.target.closest(".qlRow--edit, .qlRow__menu"))) return;
  loadItem(li);
}

function onTreeContextMenu(ev) {
  const li = itemOf(ev.target);
  if (!li || (ev.target instanceof Element && ev.target.closest(".qlRow--edit"))) return;
  ev.preventDefault();
  select("saved", li, { focus: false });
  openRowMenu(li, { x: ev.clientX, y: ev.clientY });
}

// A press on a row of the tree, until its click (or its context menu, drag or cancel) ends it. The press focuses the row
// before the click: with the form open that focus sets the Folder and draws the tree again, and the row under the pointer
// would be gone before the click reached it (a twisty never opened, a folder tapped on a phone never went back to the form).
// While a press is on, the click that follows does what the focus would do.
let treePressed = false;
// The row under the last press and whether it was the selected one then (see onTreeClick): the press itself selects it.
let treePress = null;
let treePressTimer = 0;

function onTreePointerDown(ev) {
  const li = itemOf(ev.target instanceof Element ? ev.target : null);
  treePress = li ? { key: li.dataset.key, wasSelected: ctl.selection.saved === li.dataset.key } : null;
  treePressed = true;
  clearTimeout(treePressTimer);
  treePressTimer = setTimeout(endTreePointer, 800);
}

function endTreePointer() {
  treePressed = false;
  clearTimeout(treePressTimer);
}

// The focus and the highlight move together (Tab back into the list).
function onTreeFocus(ev) {
  if (treePressed && ctl.form) return;
  const li = itemOf(ev.target);
  if (li && li.dataset.key !== ctl.selection.saved && !ev.target.closest(".qlRow--edit")) select("saved", li, { focus: false });
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
        const child = $(":scope > ul > li.qlNode[data-key]", li);
        if (child) select("saved", child);
      }
      return;
    case "ArrowLeft": {
      ev.preventDefault();
      if (folderLike && open) {
        toggleFolder(li, false);
        return;
      }
      const parent = li.parentElement?.closest("li.qlNode[data-key]");
      if (parent) select("saved", parent);
      return;
    }
    case "Enter":
      ev.preventDefault();
      if (folderLike) toggleFolder(li);
      else if (mod) loadItem(li);
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
    case "ContextMenu":
      ev.preventDefault();
      openRowMenu(li, { anchor: $(":scope > .qlRow .qlRow__menu", li) || li });
      return;
    case "Delete":
    case "Backspace":
      if (!canEdit) return;
      ev.preventDefault();
      deleteItems(targetsOf(li));
      return;
    default:
      break;
  }
  if (ev.key === "F10" && ev.shiftKey) {
    ev.preventDefault();
    openRowMenu(li, { anchor: $(":scope > .qlRow .qlRow__menu", li) || li });
    return;
  }
  if (ev.key === "/" && !mod) {
    ev.preventDefault();
    libraryEls.input?.focus();
    return;
  }
  if (canEdit && mod && !ev.shiftKey && String(ev.key).toLowerCase() === "m") {
    ev.preventDefault();
    moveDialog(targetsOf(li));
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

// A folder is renamed in its row; a query has its form in the pane (name, description, folder, SQL).
function editItem(li) {
  const entity = entityOf(li);
  if (!entity) return;
  if (li.dataset.kind === "folder") startRename(li);
  else if (li.dataset.kind === "query") void beginEdit(li.dataset.store, entity);
}

// ---------------------------------------------------------- drag and drop

let dragItems = null;

// A drop place: { store, folderId }. Within a root, a folder never goes into
// itself; into the other root, both roots must be editable.
function canDropOne(item, target) {
  if (!item || !target || !target.store) return false;
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

const canDropInto = (items, target) => !!items && items.length > 0 && items.every((item) => canDropOne(item, target));

// Under the pointer: a folder or a root row, a query's folder (or root), else the one root's top.
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
  const parent = li.parentElement?.closest("li.qlNode[data-key]");
  if (parent) return { target: { store: parent.dataset.store, folderId: parent.dataset.kind === "folder" ? parent.dataset.id : null }, el: parent };
  return { target: null, el: null };
}

function clearDropMarks() {
  for (const node of libraryEls.wrap ? $$(".is-dropTarget", libraryEls.wrap) : []) node.classList.remove("is-dropTarget");
}

function onDragStart(ev) {
  const li = itemOf(ev.target);
  if (!li || li.dataset.kind === "root" || !editableStore(storeOf(li.dataset.store)) || ctl.search.trim() || li.classList.contains("qlNode--new")) {
    if (li) ev.preventDefault();
    return;
  }
  dragItems = [itemOfLi(li)];
  try {
    ev.dataTransfer.effectAllowed = "copyMove";
    ev.dataTransfer.setData("application/x-chdash-library", JSON.stringify(dragItems));
    // Dropped on the editor, a query inserts its SQL.
    if (dragItems.length === 1 && dragItems[0].kind === "query") ev.dataTransfer.setData("text/plain", entityOf(li)?.sql || "");
  } catch (_) {}
  for (const item of dragItems) treeItems().find((x) => x.dataset.key === keyOf(item.kind, item.store, item.id))?.classList.add("is-dragging");
  libraryEls.tree.classList.add("is-dragging");
}

function onDragOver(ev) {
  if (!dragItems) return;
  const { target, el } = dropTargetOf(ev);
  clearDropMarks();
  if (!canDropInto(dragItems, target)) return;
  ev.preventDefault();
  ev.dataTransfer.dropEffect = "move";
  el.classList.add("is-dropTarget");
}

function onDragLeave(ev) {
  if (!libraryEls.wrap.contains(ev.relatedTarget)) clearDropMarks();
}

async function onDrop(ev) {
  if (!dragItems) return;
  ev.preventDefault();
  const { target } = dropTargetOf(ev);
  const items = dragItems;
  onDragEnd();
  if (!canDropInto(items, target)) return;
  for (const item of items) {
    if (!(await moveItem(item, target))) break;
  }
}

function onDragEnd() {
  dragItems = null;
  clearDropMarks();
  libraryEls.tree?.classList.remove("is-dragging");
  for (const node of libraryEls.tree ? $$(".is-dragging", libraryEls.tree) : []) node.classList.remove("is-dragging");
}

// -------------------------------------------------------------- selection

// One selection model for both tabs. Each tab lists items that carry a
// data-key (Saved: "r:", "f:" / "q:" tree items, History: "h:<id>"
// options) and ctl.selection holds the selected key of each tab. The
// selected item is aria-selected and in the Tab order (roving tabindex),
// and the preview pane shows it. A click or the arrows select; Enter (and a
// click on a phone) moves on to the preview, whose "Load"
// (Ctrl/Cmd+Enter) loads it.
const views = {
  saved: { items: () => treeItems(), preview: (key) => savedPreview(key) },
  history: { items: () => historyItems(), preview: (key) => historyPreview(key) },
};

const isPhone = () => util.isPhoneLayout();

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
  if (tab === "saved") formFollows(item.dataset.key);
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

// "Load" of the selection (a folder has none).
function loadSelection() {
  selectionPreview()?.actions?.find((a) => a.action === "load")?.run();
}

// The next step after a selection: its preview, focused on "Load"
// (or the first tool). On a phone the pane replaces the list
// (.is-previewing).
function enterPreview() {
  if (ctl.form && ctl.shown === "saved") {
    if (isPhone()) setPreviewStep(true);
    ctl.form.focus();
    return;
  }
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
// facts, the highlighted SQL, then its foot: "Load" alone.
const PREVIEW_EMPTY = { saved: "Select a query to preview it here.", history: "Select a run to preview it here." };
let paneModel = null;

// The tab's list shows no item (its own empty state or a loader). Saved always
// has its folder to show, except for a search that finds nothing.
function listIsEmpty(tab) {
  const list = tab === "history" ? historyEls.list : libraryEls.tree;
  if (!list || !list.isConnected) return false;
  if (tab === "saved") return !!ctl.search.trim() && !$(".qlNode", list);
  return !$("[role=option]", list);
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
    dom.queryLibraryMenu?.addEventListener("keydown", onDialogKeydown);
  }
  return pane;
}

function onPreviewClick(ev) {
  const entry = ev.target instanceof Element ? ev.target.closest("button[data-open-key]") : null;
  if (entry) {
    openEntry(entry.dataset.openKey);
    return;
  }
  const button = ev.target instanceof Element ? ev.target.closest("button[data-action]") : null;
  if (!button) return;
  if (button.dataset.action === "back") {
    leavePreview();
    return;
  }
  [...(paneModel?.tools || []), ...(paneModel?.actions || [])].find((a) => a.action === button.dataset.action)?.run(button);
}

function onPreviewKeydown(ev) {
  // The form has its own keys (Enter, Ctrl+Enter, and Escape on the dialog).
  if (ctl.form && ctl.shown === "saved") return;
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

function contentsText(counts) {
  return [counts.queries ? format.countLabel(counts.queries, "query", "queries") : "", counts.folders ? format.countLabel(counts.folders, "subfolder") : ""].filter(Boolean).join(MIDDOT) || "Empty";
}

// What a folder (folderId) or a storage (null) holds, one level down: its subfolders with their count of queries, then its
// queries with their description and last change. The pane lists them, and a click opens one.
function entriesOf(store, folderId) {
  const lib = store.library;
  const counts = queryCounts(lib);
  const out = [];
  for (const folder of childFolders(lib, folderId)) {
    out.push({ key: keyOf("folder", store.kind, folder.id), kind: "folder", name: folder.name, meta: queriesText(counts.get(folder.id) || 0) });
  }
  for (const query of childQueries(lib, folderId)) {
    out.push({ key: keyOf("query", store.kind, query.id), kind: "query", name: query.name, description: query.description, meta: query.updated_at_ms ? format.time(query.updated_at_ms, { precision: "min" }) : "" });
  }
  return out;
}

// A click in the pane's list: the item is highlighted in the tree (a folder also opens), as if it had been clicked there.
function openEntry(key) {
  const sel = parseKey(key);
  const store = sel ? storeOf(sel.store) : null;
  if (!store) return;
  if (sel.kind === "folder") expandPath(sel.store, sel.id);
  else if (sel.kind === "query") expandPath(sel.store, queryById(store.library, sel.id)?.folder_id);
  ctl.search = "";
  if (libraryEls.input) libraryEls.input.value = "";
  ctl.selection.saved = key;
  renderLibrary({ keepFocus: false });
  focusSelected();
}

function savedPreview(key) {
  if (!key) return null;
  const sel = parseKey(key);
  const store = sel ? storeOf(sel.store) : null;
  if (!store) return null;
  const lib = store.library;
  const canEdit = editableStore(store);
  if (sel.kind === "root") {
    const meta = h("span", { class: "qlPreview__meta" }, contentsText({ queries: lib.queries.length, folders: lib.folders.length }));
    if (isServerStore(store) && !canEdit && ctl.host && !store.fatal) meta.append(MIDDOT, "Read-only");
    return {
      title: rootLabel(store.kind),
      meta,
      description: store.hint,
      facts: ctl.host ? [["Host", ctl.host]] : [],
      error: store.fatal || (store.loadError ? `The library file could not be read (${store.loadError}): read-only.` : ""),
      entries: store.fatal ? null : entriesOf(store, null),
      entriesTitle: "In this library",
      entriesEmpty: canEdit ? "Nothing saved here yet. Save a query, or make a folder with New folder." : "Nothing is saved here.",
      tools: canEdit ? [{ label: "New folder", icon: "folderPlus", action: "new-subfolder", run: () => startNewFolder({ store: store.kind, parentId: null }) }] : [],
    };
  }
  if (sel.kind === "folder") {
    const folder = folderById(lib, sel.id);
    if (!folder) return null;
    const item = { kind: "folder", store: store.kind, id: folder.id };
    // A folder is renamed in its row.
    const row = treeItems().find((li) => li.dataset.key === key) || null;
    return {
      title: folder.name,
      meta: updatedMeta(folder.updated_at_ms),
      facts: [["Path", `${rootLabel(store.kind)} ${folderPathText(lib, folder.id)}`], ["Contents", contentsText(subtreeCounts(lib, folder.id))]],
      entries: entriesOf(store, folder.id),
      entriesTitle: "In this folder",
      entriesEmpty: canEdit ? "This folder is empty. Save a query into it, or make a subfolder." : "This folder is empty.",
      tools: canEdit ? [
        { label: "Rename", icon: "edit", action: "rename", run: () => { if (row) startRename(row); } },
        { label: "Move to\u2026", icon: "move", action: "move", run: () => moveDialog([item]) },
        { label: "New subfolder", icon: "folderPlus", action: "new-subfolder", run: () => startNewFolder({ store: store.kind, parentId: folder.id }) },
        { label: "Remove", icon: "remove", action: "delete", danger: true, run: () => deleteItems([item]) },
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
    facts: [],
    sql: query.sql,
    tools: canEdit ? [
      { label: "Edit", icon: "edit", action: "edit", run: () => beginEdit(store.kind, query) },
      { label: "Move to\u2026", icon: "move", action: "move", run: () => moveDialog([item]) },
      { label: "Remove", icon: "remove", action: "delete", danger: true, run: () => deleteItems([item]) },
    ] : [],
    actions: [
      { label: "Load", action: "load", primary: true, run: () => openInEditor(query, { store: store.kind, savedQuery: query }) },
    ],
  };
}

// A run that was not formatted when it ran (an older entry, a query typed unformatted) gets the formatter's text when
// it is looked at: selected in the list, loaded, or saved. The list does not change (it shows each query on one
// line), so nothing moves while the user reads. A script that the formatter rejects stays as typed.
const historyFormatting = new Map();
// Load does not wait longer than this for the formatter (a slow or unreachable server): the editor gets the text as typed.
const HISTORY_FORMAT_WAIT_MS = 1500;
function ensureHistoryFormatted(entry) {
  if (entry.formatted || !sqlMod?.formatText) return Promise.resolve(entry);
  let task = historyFormatting.get(entry.id);
  if (!task) {
    task = sqlMod.formatText(entry.host_id, entry.raw).then(async (text) => {
      if (text && await history.complete(entry.ran_at_ms, entry.raw, { sql_formatted: text, formatted: true }, entry.host_id)) {
        entry.sql = text;
        entry.formatted = true;
      }
    }).catch(() => {}).then(() => entry);
    historyFormatting.set(entry.id, task);
  }
  return task;
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
  // A query longer than the History keeps is stored cut: Load would put a shorter text in the editor.
  if (entry.truncated) facts.push(["Text", `Cut at ${format.count(history.LIMITS.sqlChars)} characters`]);
  const tools = [];
  if (anyEditable()) tools.push({ label: "Save to library\u2026", icon: "save", action: "save", run: () => beginSave({ sql: entry.sql, fromHistory: entry }) });
  if (!entry.formatted) {
    // The formatted text replaces the shown one once it arrives, unless the user has begun to read (scrolled the block).
    void ensureHistoryFormatted(entry).then(() => {
      if (!entry.formatted || ctl.shown !== "history" || ctl.selection.history !== key) return;
      const block = $(".qlSql .sqlBlock__body", previewPane());
      if (block && (block.scrollTop > 0 || block.scrollLeft > 0)) return;
      renderPreview();
    });
  }
  return {
    title: oneLine(entry.sql, 200) || "Query",
    titleClass: "qlPreview__title--sql",
    meta,
    facts,
    error: entry.status === "error" ? entry.error : "",
    sql: entry.sql,
    tools,
    actions: [
      { label: "Load", action: "load", primary: true, run: () => Promise.race([ensureHistoryFormatted(entry), new Promise((resolve) => setTimeout(resolve, HISTORY_FORMAT_WAIT_MS))]).then(() => openInEditor(entry)) },
    ],
  };
}

// Renders the selection of the tab shown. The focus stays on the same
// action (or the pane) when the pane had it.
function renderPreview() {
  const pane = previewPane();
  if (!pane) return;
  // Save and Edit: the form (built once) is the pane's content.
  if (ctl.form && ctl.shown === "saved") {
    paneModel = null;
    pane.setAttribute("aria-label", ctl.form.title);
    pane.parentElement?.classList.remove("is-empty");
    if (pane.firstElementChild !== ctl.form.el || pane.childElementCount !== 1) pane.replaceChildren(ctl.form.el);
    return;
  }
  pane.setAttribute("aria-label", "Preview");
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
  if (model.entries) content.appendChild(contentsList(model));
  pane.appendChild(content);
  if (model.actions && model.actions.length) {
    const foot = h("div", { class: "qlPreview__foot" });
    foot.setAttribute("role", "group");
    foot.setAttribute("aria-label", "Use this query");
    const mod = util.modifierKeyLabel();
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

// What a folder or a storage holds, as a list in the pane: each entry is a button that opens it in the tree.
const CONTENTS_SHOWN = 200;
function contentsList(model) {
  const wrap = h("section", { class: "qlContents" });
  wrap.setAttribute("aria-label", model.entriesTitle);
  wrap.appendChild(h("div", { class: "qlContents__label" }, model.entriesTitle));
  if (!model.entries.length) {
    wrap.appendChild(h("p", { class: "qlContents__empty" }, model.entriesEmpty));
    return wrap;
  }
  const list = h("ul", { class: "qlContents__list" });
  for (const entry of model.entries.slice(0, CONTENTS_SHOWN)) {
    const button = h("button", { class: `qlContents__item qlContents__item--${entry.kind}`, type: "button" });
    button.dataset.openKey = entry.key;
    const text = h("span", { class: "qlContents__text" }, h("span", { class: "qlContents__name" }, entry.name));
    if (entry.description) text.appendChild(h("span", { class: "qlContents__desc" }, oneLine(entry.description, 140)));
    button.append(icon(entry.kind === "folder" ? "folder" : "query"), text, h("span", { class: "qlContents__meta" }, entry.meta));
    list.appendChild(h("li", null, button));
  }
  wrap.appendChild(list);
  if (model.entries.length > CONTENTS_SHOWN) {
    wrap.appendChild(h("p", { class: "qlContents__more" }, `${format.count(model.entries.length - CONTENTS_SHOWN)} more: use the list on the left or the search.`));
  }
  return wrap;
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

  search.bind(input, (value) => {
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
  if (hs.error) list.appendChild(uiState.banner(h("div"), { message: hs.error, retry: () => void loadHistory(), inset: true }));
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
  if (hs.loading && !hs.entries.length) list.appendChild(uiState.block("loading", { label: `Loading the history${ELLIPSIS}`, compact: true }));
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
    const stale = storeList().filter((store) => isServerStore(store) && ctl.rendered.library && Date.now() - store.loadedAt > SERVER_RELOAD_AFTER_MS);
    if (stale.length) {
      await Promise.all(stale.map((store) => reloadStore(store)));
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

// Another tab changed the browser library.
window.addEventListener("storage", (ev) => {
  if (ev.key === LOCAL_KEY && ctl.rendered.library && ctl.stores.local) void reloadStore(ctl.stores.local).then(() => renderLibrary());
});
// Another tab ran a query: app_history.js says so (BroadcastChannel) and the list reloads.
window.addEventListener("chdash:query-history-changed", () => historyChanged());

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
  ctl.form = null;
  setPreviewStep(false);
  ctl.shown = "";
}

export const queryLibrary = {
  show,
  focus,
  hidden,
  openedId,
  openSaved,
  saveCurrent: () => beginSave(),
  historyChanged,
  // For tests and diagnostics.
  get mode() { return storeList().some(isServerStore) ? "server" : "local"; },
  get roots() { return storeList().map((store) => store.kind); },
  get writable() { return ctl.stores.server ? !!ctl.stores.server.writable : true; },
  get libraries() { return storeList().filter(isServerStore).map((store) => ({ kind: store.kind, label: store.label, writable: !!store.writable })); },
  get host() { return ctl.host; },
};
