// The query library and History are the two tabs of the dialog.
// The book button of the Query toolbar opens this dialog.
// The dialog is the shared modal dialog of app_ui_dialog.js. app_ui.js builds it. This module adds the preview pane.
//
// app_ui.js loads this module when the dialog opens for the first time. Ctrl+S also loads it.
// app_ui.js then drives the module through ns.queryLibrary.
// Save and Edit use a form in the preview pane (createPaneForm).
// Move, Remove and the other prompts are ns.dialog dialogs. They are stacked over the library.
//
// Saved queries, folders and History belong to each host.
// The dialog shows only the data of the selected host. It follows a host switch (chdash:host-changed).
// Saved holds root folders. Storages with the same adapter interface are shown side by side:
//   - One root for each library of the server. The first library has the kind "server".
//     The other libraries have the kind "server~<name>".
//     features.query_library.libraries gives the name and the writable flag of each library. The root shows the name.
//     A single library that keeps the name "default" shows "Shared server storage".
//
//     The REST API of features.query_library is used (/api/query-library?host_id=&library=, through api.request).
//     The root is shown only when the feature is enabled.
//     The root is read-only when the server says writable = false. Such a root has no edit tools and takes no drop.
//     Every folder or query change sends If-Match: <revision>.
//     A 409 conflict reloads the library. The change is retried once before the user receives a message.
//   - "Local browser storage" (local): this browser. It uses the localStorage key chdash.queryLibrary.v2.
//     The key holds every folder and query, with its host_id.
//     This root is always editable. The first read purges the entries that have no host.
// The save, move and folder pickers offer both roots. A move from one root to the other copies the item into the target.
// Then the move removes the item from its source.
// History belongs to this browser. It is stored in IndexedDB (ns.history). It never belongs to the server.
// Both adapters resolve every change with the host's whole new library. The view never guesses what the server did.
//
// The list on the left only selects an item.
// Each action of the selected item is an icon button in the head of the preview pane, on the right.
// The foot of the pane holds one action: "Load".
// Save and Edit replace the preview with their form. The form stays until the user saves or cancels it.
// History is the record of what ran in this browser. It cannot be edited. Entries are never removed.

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
// The read keeps the server limit of 16 KiB.
// The read never cuts a description that an import or another client wrote. A rename would otherwise save it cut.
// The 4000 above is the limit of the form.
const READ_DESCRIPTION_CHARS = 16384;
const MAX_SQL_CHARS = 256 * 1024;
const PROMPT_SQL_CHARS = 4000;
const PANE_SQL_CHARS = 20000;
const SERVER_RELOAD_AFTER_MS = 30000;
const HOST_WAIT_MS = 5000;
// The list reloads use util.latest keys.
const LIBRARY_REQUEST = "queryLibrary:library";
const HISTORY_REQUEST = "queryLibrary:history";
const ELLIPSIS = "\u2026";
const MIDDOT = " \u00b7 ";

// The roots of Saved appear in this order.
// Each query library of the server has one root. The first is "server". The others are "server~<name>".
// /api/version lists them in features.query_library.libraries. The "local" root comes last.
const LOCAL_STORE = "local";
const DEFAULT_SERVER_LABEL = "Shared server storage";
const LOCAL_LABEL = "Local browser storage";
const SERVER_HINT = "Shared by everyone using this ClickHouse Dash server, in its query library file.";
const LOCAL_HINT = "Only this browser sees these queries (its localStorage).";

// ---------------------------------------------------------------- helpers

const fold = (value) => String(value == null ? "" : value).trim().toLocaleLowerCase();
const newId = (prefix) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const byName = (a, b) => String(a.name).localeCompare(String(b.name), "en", { numeric: true, sensitivity: "base" });

// This table gives the names of the library drawings in the sprite (ns.icon).
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

// ns.format shows instants and counts (docs/ui-foundations.md).
// An instant is browser-local, in 24 h form: "Sep 12 16:29:57". Under a day heading it is "16:29:57".
// A count reads "1,234 queries".

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

// False when the browser refused the write (quota, private mode).
// The library is the user data. The metadata catalogue is a cache.
// When the browser refuses a write, the cache is dropped first. Then the write is tried once more.
function writeJson(key, value) {
  const pref = storage.pref(key, null, { json: true });
  if (pref.set(value)) return true;
  storage.freeMetaSpace();
  return pref.set(value);
}

// This is the host whose library is shown. It is the host selected in the header.
const currentHost = () => String(state.selectedHostId || "");

// This is the editor line-number setting. app_autocomplete.js keeps the root class in step with it.
// The SQL preview shows the gutter when the setting is on.
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

// The browser reads a library of the server in pages (docs/query-library.md, "REST API").
// A part of the library is loaded, not the whole library. Each item has its minimal data: a name, a place and a date.
// For a folder, the data holds the counts under it. An item never has its SQL.
// `partial` marks such a library.
// `loaded` holds the folders whose children are in. The empty string is the top level.
// `next` is the offset of the next window of a level that is larger than a page.
// `levelTotal` is how many items that level holds.
// `details` holds the queries that were opened. Their SQL and description are kept there.
// `found` holds the queries that a search returned. They may not be loaded in their folder.
// `failed` holds the folders that could not be read. The browser library is always whole.
const PAGE_SIZE = 100;
const isPartial = (lib) => lib?.partial === true;
function emptyPartialLibrary() {
  return {
    revision: 0, folders: [], queries: [], partial: true, totals: { folders: 0, queries: 0 },
    loaded: new Set(), next: new Map(), levelTotal: new Map(), details: new Map(), found: new Map(), failed: new Set(),
  };
}
// Read means the children of the folder were asked for: all of them, or a first window of a level that is larger than a page.
const isRead = (lib, parentId) => !isPartial(lib) || lib.loaded.has(parentId || "") || lib.next.has(parentId || "");
const hasMore = (lib, parentId) => isPartial(lib) && lib.next.has(parentId || "");
// The SQL and the description of a query. In a whole library, the query holds its own.
// In a partial library, the opened query holds them. The value is null until the read is done.
const queryDetail = (lib, query) => (!query ? null : !isPartial(lib) ? query : lib.details.get(query.id) || null);
const libraryQueryTotal = (lib) => (isPartial(lib) ? lib.totals.queries : lib.queries.length);
const libraryFolderTotal = (lib) => (isPartial(lib) ? lib.totals.folders : lib.folders.length);

// The merge puts one answer of GET /api/query-library into a partial library.
// The answer holds the children of `parentId`.
function mergePage(lib, data, parentId) {
  const host = typeof data?.host_id === "string" ? data.host_id : "";
  const count = (value) => Math.max(0, Number(value) || 0);
  for (const f of Array.isArray(data?.folders) ? data.folders : []) {
    if (!f || typeof f.id !== "string" || typeof f.name !== "string") continue;
    const item = {
      id: f.id, host_id: host, parent_id: typeof f.parent_id === "string" && f.parent_id ? f.parent_id : null, name: f.name,
      created_at_ms: 0, updated_at_ms: Number(f.updated_at_ms) || 0,
      query_count: count(f.query_count), child_count: count(f.child_count), subfolder_count: count(f.subfolder_count),
    };
    const at = lib.folders.findIndex((x) => x.id === item.id);
    if (at >= 0) lib.folders[at] = item;
    else lib.folders.push(item);
    if (f.loaded === true) lib.loaded.add(item.id);
    else lib.loaded.delete(item.id);
  }
  for (const q of Array.isArray(data?.queries) ? data.queries : []) {
    if (!q || typeof q.id !== "string" || typeof q.name !== "string") continue;
    const item = {
      id: q.id, host_id: host, folder_id: typeof q.folder_id === "string" && q.folder_id ? q.folder_id : null, name: q.name,
      created_at_ms: 0, updated_at_ms: Number(q.updated_at_ms) || 0,
    };
    const at = lib.queries.findIndex((x) => x.id === item.id);
    if (at >= 0) lib.queries[at] = item;
    else lib.queries.push(item);
  }
  const key = parentId || "";
  if (data?.next_cursor != null) {
    lib.next.set(key, Number(data.next_cursor));
    lib.levelTotal.set(key, count(data.level_total));
  } else {
    lib.next.delete(key);
    lib.levelTotal.delete(key);
    lib.loaded.add(key);
  }
  lib.failed.delete(key);
  lib.revision = Number(data?.revision) || 0;
  if (data?.totals) lib.totals = { folders: count(data.totals.folders), queries: count(data.totals.queries) };
  return lib;
}

// Every folder and query belongs to one host. An entry without a host_id is dropped (docs/query-library.md, "Entries without a host").
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
  // If the parent does not exist, belongs to another host, or forms a cycle, the folder goes to the top level of its host.
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

// This is the part of a library that belongs to one host.
function scopeToHost(lib, host) {
  return {
    revision: lib.revision,
    folders: lib.folders.filter((f) => f.host_id === host),
    queries: lib.queries.filter((q) => q.host_id === host),
  };
}

const folderById = (lib, id) => (id ? lib.folders.find((f) => f.id === id) || null : null);
const queryById = (lib, id) => lib.queries.find((q) => q.id === id) || lib.found?.get(id) || null;
const childFolders = (lib, parentId) => lib.folders.filter((f) => f.parent_id === (parentId || null)).sort(byName);
const childQueries = (lib, folderId) => lib.queries.filter((q) => q.folder_id === (folderId || null)).sort(byName);

// The level of a folder. A top-level folder has level 1.
function folderDepth(lib, id) {
  let depth = 0;
  let cur = folderById(lib, id);
  while (cur && depth <= MAX_DEPTH + 1) {
    depth += 1;
    cur = folderById(lib, cur.parent_id);
  }
  return depth;
}

// The number of levels that a folder takes with its subfolders. A leaf folder takes 1 level.
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

// This is how the pickers and the preview write a folder path. "/" is the top level of a root.
// Then come paths such as "/Operations" and "/Operations/Merges".
const folderPathText = (lib, id) => `/${folderPath(lib, id).join("/")}`;

// The map holds the queries under every folder, subfolders included. It maps folder id to count.
// The top level counts the whole library.
// One pass builds the map for a library. The map is kept while the library object stays the same.
const queryCountCache = new WeakMap();
function queryCounts(lib) {
  // A partial library does not hold every query. Each folder gives the count of queries under it.
  if (isPartial(lib)) return new Map(lib.folders.map((f) => [f.id, f.query_count || 0]));
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
  // A partial library gives the folders directly under it. It also gives the queries under it, as the server counts them.
  if (isPartial(lib)) {
    const folder = folderById(lib, id);
    return { folders: folder?.subfolder_count || 0, queries: folder?.query_count || 0 };
  }
  let folders = 0;
  let queries = childQueries(lib, id).length;
  for (const child of childFolders(lib, id)) {
    const sub = subtreeCounts(lib, child.id);
    folders += 1 + sub.folders;
    queries += sub.queries;
  }
  return { folders, queries };
}

// This makes a copy of a folder and everything in it. The copy lists the parent folders first.
// The folder itself has no parent. Then come the queries.
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

// The key chdash.queryLibrary.v2 holds the folders and queries of every host. Each entry has its host_id.
// An entry without a host is purged from the key the first time it is read.
// The import of entries without a host is not done. The old flat list chdash.savedQueries.v1 is no longer read.
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
  // Each change reads the stored library again. Another tab may have changed it.
  // The change applies one validated edit to the part of the current host.
  // It stores the whole library with the next revision.
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
    // A folder is copied in from the other root (subtreeOf) under parent_id.
    // The copy gets new ids. Nothing is merged or renamed. The promise resolves with the id of the copy.
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

// This is the browser History (ns.history). app_history.js stores it in IndexedDB.
// app_run.js writes the runs. It lists the runs of the current host.
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

// library: the name of the server library that this adapter reads and writes (?library=).
// An empty string means the default library.
// keepOpen() returns the ids of the folders that the page shows open. A reload brings these folders back with their children.
function createServerAdapter(library = "", { keepOpen = () => [] } = {}) {
  let revision = null;
  // This is the library that the adapter loaded last. A change starts from this library.
  // change() compares it after a conflict.
  let known = null;

  // Requests go through api.request (app_api.js). The library revision is sent as If-Match.
  // The server accepts writes from this page only. A write is a same-origin request with a JSON content type.
  // The server refuses other content types with 415.
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

  // One page holds the children of a folder. For the top level, no folder is given.
  // A page has at most PAGE_SIZE items, each with its minimal data. cursor is the offset in a level that is larger than a page.
  const readPage = (parentId, cursor, signal) => {
    const query = new URLSearchParams({ host_id: requireHost(), limit: String(PAGE_SIZE) });
    if (parentId) query.set("parent_id", parentId);
    if (cursor) query.set("cursor", String(cursor));
    return request("GET", `?${query}`, undefined, { ifMatch: false, signal });
  };

  // This reads the top level and the folders that were open. A change reloads the library.
  // A folder that was open stays open.
  async function load({ signal } = {}) {
    const data = await readPage(null, 0, signal);
    revision = Number.isFinite(Number(data.revision)) ? Number(data.revision) : null;
    const lib = mergePage(emptyPartialLibrary(), data, null);
    // Read the parents first. A folder that was open inside another folder is read when that folder is in the library.
    let wanted = new Set(keepOpen());
    for (let pass = 0; pass <= MAX_DEPTH && wanted.size; pass += 1) {
      const now = [...wanted].filter((id) => lib.folders.some((f) => f.id === id) && !lib.loaded.has(id));
      if (!now.length) break;
      await Promise.all(now.map(async (id) => {
        try {
          mergePage(lib, await readPage(id, 0, signal), id);
        } catch (err) {
          if (util.isAbort(err)) throw err;
          lib.failed.add(id);
        }
      }));
      wanted = new Set([...wanted].filter((id) => !now.includes(id)));
    }
    known = lib;
    return {
      library: lib,
      writable: data.writable === true && !data.load_error,
      loadError: data.load_error ? String(data.load_error) : "",
    };
  }

  // This reads the children of a folder, from `cursor`. For the top level, no folder is given.
  // The children are merged into the library that was loaded last.
  async function loadChildren(parentId, { cursor = 0, signal } = {}) {
    const lib = known;
    if (!lib) return null;
    const data = await readPage(parentId, cursor, signal);
    if (lib === known) mergePage(lib, data, parentId);
    return lib;
  }

  // This reads one query in full.
  async function getQuery(id, { signal } = {}) {
    const data = await request("GET", `/queries/${enc(id)}?host_id=${enc(requireHost())}`, undefined, { ifMatch: false, signal });
    return {
      id: String(data.id), host_id: hostOf(data), folder_id: typeof data.folder_id === "string" && data.folder_id ? data.folder_id : null,
      name: String(data.name), description: cleanText(data.description, READ_DESCRIPTION_CHARS), sql: String(data.sql),
      created_at_ms: Number(data.created_at_ms) || 0, updated_at_ms: Number(data.updated_at_ms) || 0,
      ancestors: Array.isArray(data.ancestors) ? data.ancestors.map(String) : [], path: typeof data.path === "string" ? data.path : "/",
    };
  }

  // This returns the queries that hold every word of `text`. The search covers names, descriptions, SQL and folder paths.
  // It returns at most 100 queries, each with its path.
  async function searchQueries(text, { signal } = {}) {
    const data = await request("GET", `/search?host_id=${enc(requireHost())}&q=${enc(text)}`, undefined, { ifMatch: false, signal });
    return {
      total: Number(data.total) || 0,
      truncated: data.truncated === true,
      results: (Array.isArray(data.results) ? data.results : []).filter((r) => r && typeof r.id === "string").map((r) => ({
        id: r.id, host_id: requireHost(), folder_id: typeof r.folder_id === "string" && r.folder_id ? r.folder_id : null, name: String(r.name),
        created_at_ms: 0, updated_at_ms: Number(r.updated_at_ms) || 0, path: typeof r.path === "string" ? r.path : "/",
      })),
    };
  }

  // This returns a folder and everything under it, with the SQL. Another storage takes this copy.
  async function exportTree(folderId, { signal } = {}) {
    const data = await request("GET", `/export?host_id=${enc(requireHost())}&folder_id=${enc(folderId)}`, undefined, { ifMatch: false, signal });
    return subtreeOf(normalizeLibrary(data), folderId);
  }

  // The item of a change may be changed in the meantime. Its updated_at_ms then moves.
  // In this case, the retry after a conflict does not replay the change.
  // The replay would overwrite the edit of another person. If-Match exists to stop this overwrite.
  const stamp = (library, entity) => {
    if (!library || !entity) return null;
    const list = entity.kind === "folder" ? library.folders : library.queries;
    const found = list.find((item) => item.id === entity.id);
    return found ? found.updated_at_ms : null;
  };

  // This makes one change. On a 409 conflict, reload the library (new revision).
  // Then retry once, unless the item changed.
  // idOf takes the id of the new item out of the answer.
  // entity: { kind, id } of the item that an update or a delete names.
  // The change itself is the answer. When the change went through but the reload failed, the result says `stale`.
  // The caller then shows no error. It reads the library again. The result never says "the change failed".
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
    loadChildren,
    getQuery,
    searchQueries,
    exportTree,
    createFolder: (input) => change("POST", "/folders", { host_id: requireHost(), parent_id: input.parent_id || null, name: input.name }),
    updateFolder: (id, patch) => change("PATCH", `/folders/${enc(id)}`, patch, undefined, { kind: "folder", id }),
    deleteFolder: (id, { recursive = false } = {}) => change("DELETE", `/folders/${enc(id)}${recursive ? "?recursive=1" : ""}`, undefined, undefined, { kind: "folder", id }),
    createQuery: (input) => change("POST", "/queries", { ...input, host_id: requireHost() }),
    updateQuery: (id, patch) => change("PATCH", `/queries/${enc(id)}`, patch, undefined, { kind: "query", id }),
    deleteQuery: (id) => change("DELETE", `/queries/${enc(id)}`, undefined, undefined, { kind: "query", id }),
    // A folder is copied in from the browser root. The copy is one all-or-nothing import in copy mode.
    // Nothing is merged, skipped or renamed. The import goes under parent_id.
    // The promise resolves with the id of the copy.
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

// One root has an adapter, the library of the current host, and a state.
// The label and the hint are the texts that the tree and the preview show for it.
function newStore(kind, adapter, writable, { label, hint }) {
  return { kind, adapter, writable, label, hint, library: adapter.kind === "server" ? emptyPartialLibrary() : emptyLibrary(), loadError: "", fatal: "", loadedAt: 0 };
}

// These are the ids of the open folders of one root. The keys of ctl.expanded have the form "<root>:<folder id>".
const openFolders = (kind) => [...ctl.expanded].filter((key) => key.startsWith(`${kind}:`)).map((key) => key.slice(kind.length + 1));

// Every root, except the browser root, is a library of the server.
const isServerStore = (store) => store.kind !== LOCAL_STORE;
const rootLabel = (kind) => ctl.stores[kind]?.label || (kind === LOCAL_STORE ? LOCAL_LABEL : DEFAULT_SERVER_LABEL);

const uiPrefs = readJson(UI_KEY, {});
const ctl = {
  started: null,
  // This maps the roots by kind. "local" is always present.
  // Each library of the server has a root when features.query_library is on.
  // The order is the order in the tree.
  stores: {},
  order: [],
  history: null,
  // This is the host to which the shown library and History belong.
  host: "",
  // This holds the open folders ("<store>:<folder id>") and the closed roots ("<store>").
  expanded: new Set(Array.isArray(uiPrefs.expanded) ? uiPrefs.expanded.filter((x) => typeof x === "string" && x.includes(":")) : []),
  closedRoots: new Set(Array.isArray(uiPrefs.closedRoots) ? uiPrefs.closedRoots.filter((x) => typeof x === "string") : []),
  // This holds the folders that the folder picker chose last ("<store>:<folder id>").
  // The newest folder comes first.
  recent: Array.isArray(uiPrefs.recentFolders) ? uiPrefs.recentFolders.filter((x) => typeof x === "string" && x.includes(":")).slice(0, 8) : [],
  // The name that the user types in a row. It has the form { mode, ... }.
  editing: null,
  // The Save or Edit form shown in the pane instead of the preview (createPaneForm).
  // The value is null when no form is shown.
  form: null,
  // This is the highlighted item of each tab, by its data-key. The preview shows it.
  selection: { saved: "", history: "" },
  search: "",
  // This is the saved query that the editor holds: { store, id, sql }.
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
// This sets where a new folder or query goes by default. It is the first library of the server that can take it.
// Otherwise, it is this browser root.
const defaultStore = () => storeList().find((store) => isServerStore(store) && editableStore(store))?.kind || LOCAL_STORE;

// ---- what a library of the server loads when it is asked for

// This holds the reads in flight, by what they read. A render asks for what it shows.
// The same read is made once.
const reading = new Map();
const wanted = new Set();

// This renders the whole library. It also renders the pane when the pane shows a read item.
function shown() {
  if (ctl.rendered.library) renderLibrary({ keepFocus: true });
  else if (ctl.shown === "saved") renderPreview();
}

// This reads the children of a folder (null: the top level) of a library of the server. Each read happens once.
// It also reads the next window of a level that is larger than a page. The promise resolves when the children are in.
// A failure is kept. The tree shows the failure and offers a retry.
function ensureChildren(storeKind, parentId, { more = false } = {}) {
  const store = storeOf(storeKind);
  const lib = store?.library;
  if (!store || !isPartial(lib)) return Promise.resolve(false);
  if (!more && isRead(lib, parentId)) return Promise.resolve(false);
  const key = `children:${storeKind}:${parentId || ""}`;
  if (reading.has(key)) return reading.get(key);
  const cursor = more ? lib.next.get(parentId || "") || 0 : 0;
  const job = store.adapter.loadChildren(parentId, { cursor })
    .catch((err) => {
      if (util.isAbort(err)) return null;
      lib.failed.add(parentId || "");
      return null;
    })
    .then(() => {
      reading.delete(key);
      shown();
      return true;
    });
  reading.set(key, job);
  return job;
}

// This reads the SQL and the description of a query of a library of the server.
// The read happens when the query is opened. The answer is kept with the library.
function ensureDetail(storeKind, id) {
  const store = storeOf(storeKind);
  const lib = store?.library;
  if (!store || !isPartial(lib)) return Promise.resolve(null);
  if (lib.details.has(id)) return Promise.resolve(lib.details.get(id));
  const key = `detail:${storeKind}:${id}`;
  if (reading.has(key)) return reading.get(key);
  const job = store.adapter.getQuery(id)
    .then((detail) => {
      lib.details.set(id, detail);
      return detail;
    })
    .catch(() => null)
    .then((detail) => {
      reading.delete(key);
      if (ctl.shown === "saved" && ctl.selection.saved === keyOf("query", storeKind, id)) renderPreview();
      return detail;
    });
  reading.set(key, job);
  return job;
}

// This returns the query with its SQL and description, for any storage.
// In a whole library, it returns the query itself. In a library of the server, it returns the query that was read.
// It returns null, and shows a toast, when the query cannot be read.
async function fullQuery(storeKind, query) {
  const store = storeOf(storeKind);
  if (!store || !query) return null;
  if (!isPartial(store.library)) return query;
  const detail = await ensureDetail(storeKind, query.id);
  if (!detail) toast("The query could not be read.", "error");
  return detail;
}

// This returns a folder with everything under it, and the SQL. The copy goes to another storage or to an export.
async function fullSubtree(storeKind, folderId) {
  const store = storeOf(storeKind);
  if (!store) return { folders: [], queries: [] };
  if (!isPartial(store.library)) return subtreeOf(store.library, folderId);
  return store.adapter.exportTree(folderId);
}

function saveUiPrefs() {
  writeJson(UI_KEY, { expanded: [...ctl.expanded].slice(-400), closedRoots: [...ctl.closedRoots], recentFolders: ctl.recent });
}

// /api/version picks the roots. Without an answer in 4 s, only the browser root is used.
function waitForFeatures() {
  return Promise.race([featuresMod.ready, new Promise((resolve) => setTimeout(resolve, 4000))]);
}

// The library belongs to a host. At page load, a ?saved= link can come before the hosts are known.
// The first selection then waits for the hosts. It waits 5 s at most.
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
        // Older servers list no libraries. For them, the list holds one library: the default.
        const libraries = Array.isArray(features.libraries) && features.libraries.length
          ? features.libraries
          : [{ name: "", writable: features.writable === true }];
        libraries.forEach((library, index) => {
          // The kind goes into keys that split on ":", and into attributes. The name is encoded, because a name may hold any text.
          const kind = index === 0 ? "server" : `server~${encodeURIComponent(library.name)}`;
          // The tree shows the name. A single library that was never named keeps the old name "Shared server storage".
          const label = libraries.length === 1 && (!library.name || library.name === "default") ? DEFAULT_SERVER_LABEL : String(library.name);
          ctl.stores[kind] = newStore(kind, createServerAdapter(index === 0 && !library.name ? "" : String(library.name), { keepOpen: () => openFolders(kind) }), library.writable === true, { label, hint: SERVER_HINT });
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

// This reads the library of one root for the current host. A reload replaces the read in flight (util.latest).
// Only the answer for the host shown now is used.
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

// This returns both roots of the current host.
async function reloadLibrary() {
  ctl.host = currentHost();
  await Promise.all(storeList().map((store) => reloadStore(store)));
  if (ctl.rendered.library) renderLibrary();
}

// The user selects another host. Its library and History replace the shown ones.
// The selection, the preview and the opened query are those of the old host.
function onHostChanged() {
  if (!ctl.started || currentHost() === ctl.host) return;
  ctl.selection = { saved: "", history: "" };
  ctl.opened = null;
  ctl.editing = null;
  ctl.form = null;
  searched.clear();
  searchToken += 1;
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

// This is the answer to a change: the new library of the root, and the writable value of the server.
function takeResult(store, result) {
  // The change went through, but the library could not be read after it. The shown library is read again.
  if (result.stale) {
    void reloadStore(store).then(() => renderLibrary({ keepFocus: true }));
    return;
  }
  store.library = result.library;
  if (result.loadError !== undefined) store.loadError = result.loadError || "";
  if (isServerStore(store) && result.writable !== undefined) store.writable = result.writable === true;
  store.loadedAt = Date.now();
}

// This runs one change of a root through its adapter. Then it renders the new library again.
// It tells the user what failed, for example after a conflict retry or a read-only answer.
// The message appears in the dialog that asked for the change (inDialog). Otherwise, it appears in a toast.
// Validation errors always return to the caller.
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
    // The host changed while the change was on its way. Its answer is the library of the old host.
    // This library must not replace the library that the new host is loading.
    // The change itself was made on the host it was asked for.
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

// This is a place in the library: a root and a folder of that root. Null means the top of the root.
const locValue = (loc) => `${loc.store}:${loc.folderId || ""}`;
function parseLoc(value) {
  const text = String(value || "");
  const at = text.indexOf(":");
  const store = at > 0 ? text.slice(0, at) : "";
  return storeOf(store) ? { store, folderId: text.slice(at + 1) || null } : null;
}
const whereText = (loc) => `${rootLabel(loc.store)} ${folderPathText(storeOf(loc.store)?.library || emptyLibrary(), loc.folderId)}`;

// This moves a query or a folder from one root to the other.
// It copies the item into the target. A copy to the server is one all-or-nothing request.
// Then it removes the item from the source. The patch value changes the query on the way (Edit, Save).
async function moveAcross(item, target, { inDialog = false, patch = null } = {}) {
  const source = storeOf(item.store);
  const dest = storeOf(target.store);
  if (!editableStore(source) || !editableStore(dest)) {
    const message = `${rootLabel(editableStore(dest) ? item.store : target.store)} is read-only.`;
    if (inDialog) throw new LibraryError("read_only", message);
    toast(message, "error");
    return false;
  }
  // A second move, made while the first move runs, copies the item twice. Its removal then fails.
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
      const listed = queryById(srcLib, item.id);
      if (!listed) throw new LibraryError("not_found", "That query no longer exists.");
      // The query of the server is read in full, with its SQL, before it goes to another storage.
      const query = isPartial(srcLib) ? await ensureDetail(item.store, listed.id) : listed;
      if (!query) throw new LibraryError("server", "The query could not be read.");
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
      copied = await dest.adapter.copyTree({ parent_id: folderId, ...(await fullSubtree(item.store, folder.id)) });
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
  // The copy is in. Now the source item is removed.
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

// Opening a query closes the dialog. The editor takes the focus.
function closePanel() {
  queryUi.closeQueryLibrary({ restoreFocus: false });
}

// "Load": the editor takes the SQL. A saved query then becomes the opened query, marked in the tree.
// The dialog closes.
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

// In the top dialog, the page under a modal dialog is inert and hidden from assistive technology.
// The data-dialog-float attribute moves the toast to the next dialog down.
// This happens when that dialog closes.
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

// This is a form prompt. It uses the shared ns.dialog (app_ui_dialog.js), stacked over the library.
// The promise resolves with the submitted value. It resolves with null when the user dismisses the prompt.
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

// The picker chooses where a query goes. It sets the Folder of the Save and Edit form, and the target of Move to.
// It follows the same pattern as Google Drive ("Move to"), Nextcloud ("Choose target folder") and Dropbox ("Save to").
// The choice shows as a path, for example: Team queries > Reports > Daily.
// The picker opens on a tree of the storages and their folders. The user browses the tree with twisties and arrow keys.
// The places chosen last come first. A box filters the folders by name when there are many folders.
// A storage that cannot be written is shown locked. The user cannot choose it.
// In Move to, the tree is always open (inline).
//
//   const picker = createFolderPicker({ name, selected, exclude, inline, labelId });
//   picker.el            the control. A "change" event bubbles from it when the user picks a place.
//   picker.value         "<store>:<folder id>". "<store>:" is the top of a storage. The value is "" when nothing can be chosen.
//   picker.set(loc)      chooses a place. No event is sent. It returns false when the place cannot be chosen.
//   picker.refresh()     builds the tree again with the same choice. It returns true when the tree differed.
//   picker.focus() / picker.hasFocus()
// `exclude` takes { store, id } or a list. It holds the folders that are moved.
// These folders cannot go into themselves or deeper than MAX_DEPTH.
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
          // lazy: a folder of the server whose subfolders are not read yet. The subfolders are read when the folder opens.
          const lazy = isPartial(lib) && !isRead(lib, folder.id) && (folder.subfolder_count || 0) > 0;
          const node = { key: `${store.kind}:${folder.id}`, store, folderId: folder.id, label: folder.name, depth, parent, children: [], lazy, locked: false, disabled: !writable || (moved.length > 0 && folderDepth(lib, folder.id) + height > MAX_DEPTH), root: false };
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
  const signatureOf = () => [...nodes.values()].map((n) => `${n.key}|${n.label}|${n.depth}|${n.disabled ? 1 : 0}|${n.lazy ? 1 : 0}`).join("\n");
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
    return icon(expanded.has(node.key) && (node.children.length || node.lazy) ? "folderOpen" : "folder");
  };
  const pathText = (node) => chain(node).map((n) => n.label).join(" / ");
  // "/" is the top of a storage. "/Reports/Daily" is a folder path.
  // The data attributes hold these values, for tests and tools.
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
      if (index) triggerCrumbs.appendChild(h("span", { class: "qlPicker__sep", "aria-hidden": "true" }));
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
    // The Move to dialog puts the focus on the chosen place when it opens.
    if (inline && node.key === value && section === "tree") li.setAttribute("autofocus", "");
    li.setAttribute("aria-level", String(flat ? 1 : node.depth));
    li.setAttribute("aria-selected", String(node.key === value));
    if (node.disabled) li.setAttribute("aria-disabled", "true");
    if (!flat && (node.children.length || node.lazy)) li.setAttribute("aria-expanded", String(expanded.has(node.key)));
    li.style.setProperty("--depth", String(flat ? 0 : node.depth - 1));
    const row = h("div", { class: "qlPicker__row" });
    const twisty = h("span", { class: "qlPicker__twisty" });
    twisty.setAttribute("aria-hidden", "true");
    if (!flat && (node.children.length || node.lazy)) twisty.dataset.twisty = "";
    else twisty.classList.add("qlPicker__twisty--none");
    row.append(twisty, iconFor(node), h("span", { class: `qlPicker__name${node.root ? " qlPicker__name--root" : ""}` }, node.label));
    if (flat && node.parent) row.appendChild(h("span", { class: "qlPicker__path" }, chain(node.parent).map((n) => n.label).join(" / ")));
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
    // The list has one tab stop: the chosen place. If no place is chosen, the first row is the tab stop.
    // The arrow keys move the tab stop.
    const stop = itemFor(value) || items()[0];
    if (stop) stop.tabIndex = 0;
  };
  const items = () => Array.from($$('[role="treeitem"]', panel));
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
    if (!node || (!node.children.length && !node.lazy)) return;
    const opening = open === undefined ? !expanded.has(key) : open;
    if (opening) expanded.add(key);
    else expanded.delete(key);
    render();
    itemFor(key)?.focus({ preventScroll: true });
    // The subfolders of a folder of the server are read the first time the folder opens.
    if (opening && node.lazy) void ensureChildren(node.store.kind, node.folderId).then(() => refreshPicker());
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
        if ((node.children.length || node.lazy) && expanded.has(node.key)) toggle(node.key, false);
        else if (node.parent) move(itemFor(node.parent.key));
        break;
      case "Enter":
      case " ":
        ev.preventDefault();
        ev.stopPropagation();
        if (current.getAttribute("aria-disabled") !== "true") choose(node.key);
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
      }
    });
  }
  // Escape closes the picker only. The form and the dialog stay open. In the filter, Escape clears the text first.
  el.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape" || inline || !isOpen) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.target === filterInput && filter) {
      filter = "";
      filterInput.value = "";
      render();
      return;
    }
    setOpen(false);
    trigger.focus({ preventScroll: true });
  });

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

  const refreshPicker = () => api.refresh();
  const api = {
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
  return api;
}

// This is the highlighted SQL, clipped. A prompt shows the start. The pane shows more.
// It uses the shared read-only SQL block (sqlBlock).
// The pane block has a copy button. When the editor shows line numbers, the block also has their gutter.
// Its lines scroll and do not wrap. Thus each number stays on its line.
function sqlPreview(sql, max = PROMPT_SQL_CHARS, { pane = false } = {}) {
  const text = String(sql || "");
  const clipped = text.length > max ? `${text.slice(0, max)}\n${ELLIPSIS}` : text;
  const gutter = pane && lineNumbersOn();
  return sqlBlock({ sql: clipped, wrap: !gutter, gutter, copy: pane, label: "Query", className: "qlSql" });
}

// This is the place of a Saved row: a root, a folder, or the folder of a query.
function locOfKey(key) {
  const sel = parseKey(key);
  if (!sel || !storeOf(sel.store)) return null;
  const lib = storeOf(sel.store).library;
  if (sel.kind === "root") return { store: sel.store, folderId: null };
  if (sel.kind === "folder" && folderById(lib, sel.id)) return { store: sel.store, folderId: sel.id };
  if (sel.kind === "query") return { store: sel.store, folderId: queryById(lib, sel.id)?.folder_id || null };
  return null;
}

// This is the selected place in Saved. It is the default target. It is the selected root or folder.
// For a selected query, it is the folder of the query.
const selectedLoc = () => locOfKey(ctl.selection.saved);

// This is the saved query that the editor holds. Ctrl+S updates this query: { store, query }.
async function openedQuery() {
  const store = ctl.opened ? storeOf(ctl.opened.store) : null;
  if (!store) return null;
  // A query of the server may not be in the loaded items. The app reads the query by its id.
  // The read includes the description and the SQL.
  const query = isPartial(store.library) ? await ensureDetail(store.kind, ctl.opened.id) : queryById(store.library, ctl.opened.id);
  return query ? { store: store.kind, query } : null;
}

// ------------------------------------------------------- the pane's form

// Save and Edit use one form in the right pane of the library. No prompt appears over the dialog.
// The pane shows the form in place of the preview while ctl.form holds it.
// The form is built once. The pane only attaches it again. Thus a render of the tree or the pane never loses the typed text.
// The Folder of the form follows the place that is selected in the tree.
// Escape drops the form, and the preview returns. A second Escape closes the dialog as usual.

// These are the server field names, used as the fields of the form.
const FORM_FIELD_OF = { name: "name", description: "description", folder_id: "folder_id", parent_id: "folder_id", target: "folder_id" };

function formField(name, label, control) {
  const wrap = h("div", { class: "uiField", dataset: { wrap: name } });
  control.id = `qlForm-${name}`;
  const error = h("div", { class: "uiField__error", id: `qlFormError-${name}`, role: "alert", hidden: true });
  wrap.append(h("label", { class: "uiField__label", for: control.id, id: `qlFormLabel-${name}` }, label), control, error);
  return wrap;
}

// In mode "save", the form uses rawText (the text of the editor or of the History run) and fromHistory.
// In mode "edit", the form uses sqlText. The form only shows this text.
// `submit(action, values)` makes the change. The action is "submit" or "new".
// It returns true when the change is done. The form is then closed.
// It returns false when the form stays open. The toast says why.
// It throws what the form shows, a LibraryError, under its field.
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
  // The title names the form for a screen reader. The title is not drawn.
  // The Folder, Name and SQL fields say what the form is.
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

  // The SQL: Save writes the text as the formatter does, unless the Formatted switch is released.
  // Then it writes the text as typed. A History run that was formatted already has its text.
  // The other runs wait for the formatter. A script that the formatter rejects is saved as typed.
  // Its switch is released and locked.
  const sqlBox = h("div", { class: "uiField qlForm__sql" });
  sqlBox.setAttribute("role", "group");
  const sqlLabel = h("span", { class: "uiField__label", id: "qlFormSqlLabel" });
  sqlBox.setAttribute("aria-labelledby", sqlLabel.id);
  const sqlHead = h("div", { class: "qlForm__sqlHead" }, sqlLabel);
  const sqlBody = h("div", { class: "qlForm__sqlBody" });
  sqlBox.append(sqlHead, sqlBody);
  let formattedSwitch = null;
  let asTyped = false; // the Formatted switch is released: the text is saved as typed
  let formattedText = fromHistory?.formatted ? String(fromHistory.sql || "") : null;
  let formatting = null;
  const chosen = () => (mode !== "save" ? sqlText : asTyped || !formattedText ? rawText : formattedText);
  // The formatter changed nothing, so there is one text to save. The Formatted switch offers no real choice.
  const sameText = () => !!formattedText && formattedText.trim() === rawText.trim();
  const drawSql = () => {
    if (mode === "save") {
      const source = fromHistory ? "from History" : "from the editor";
      const same = sameText();
      formattedSwitch.hidden = same;
      sqlLabel.textContent = `SQL (${source}${!same && formatting ? ", formatting\u2026" : ""})`;
    } else {
      sqlLabel.textContent = "SQL";
    }
    const block = sqlPreview(chosen(), PANE_SQL_CHARS, { pane: true });
    // The Formatted switch is in the block, left of the copy button. It is the same as in the statement of a result.
    if (formattedSwitch) block.appendChild(formattedSwitch);
    sqlBody.replaceChildren(block);
  };
  if (mode === "save") {
    // The Formatted switch of the results is in the block. drawSql puts it there.
    // Most saves want the formatted text.
    formattedSwitch = sqlBlock.formatSwitch({ rawName: "as typed", onChange: (on) => { asTyped = !on; drawSql(); } });
    formattedSwitch.id = "qlSaveFormatted";
    formattedSwitch.classList.add("sqlBlock__mode");
    if (!formattedText) {
      formattedSwitch.disabled = true;
      formatting = sqlMod.formatText(ctl.host, rawText).then(
        (text) => { formattedText = text || null; formattedSwitch.disabled = !formattedText; },
        () => {
          formattedText = null;
          asTyped = true;
          formattedSwitch.disabled = true;
          formattedSwitch.setAttribute("aria-pressed", "false");
          formattedSwitch.title = "The formatter does not accept this query: it is saved as typed.";
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

  // The folders of the tree changed. For example, a folder was made while the save ran.
  // The list is built again with the same choice.
  session.refreshFolders = () => {
    session.folder.refresh();
  };
  // The place that the user picks in the tree becomes the folder.
  // A root or a folder of a read-only storage is not offered.
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

// This shows where the query of the form will sit, in the tree. A dashed row appears in the folder of the Folder field.
// The folder opens for it. The row sits at the place where its name sorts.
// Edit shows the row only when the query moves. The row is for the eye only. It has aria-hidden.
// The Folder field gives the same information.
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

// The tree draws the place again, because the Folder changed. The focus stays where it is.
function showGhost(session) {
  if (ctl.form === session && ctl.shown === "saved") renderTree();
}

// The name is typed. The dashed row follows the typed name.
function syncGhostName() {
  const name = libraryEls.tree && $(".qlNode--ghost .qlRow__name", libraryEls.tree);
  if (name && ctl.form) name.textContent = ctl.form.draftName() || GHOST_NAME;
}

// This shows the form in the pane. It selects the Saved tab, attaches the form, and focuses the name field.
// On a phone, it shows the pane step.
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

// The form is shown again. It is the same form, and its name field has the focus.
function revealForm() {
  if (ctl.shown !== "saved") void queryUi.openQueryLibrary("saved", { focus: false }).then(() => revealForm());
  else {
    renderPreview();
    renderTree();
    if (isPhone()) setPreviewStep(true);
    if (ctl.form && !ctl.form.el.contains(document.activeElement)) ctl.form.focus();
  }
}

// The form is dropped. The preview of the selection returns, and the focus goes to the selected row.
// On a phone, the list returns.
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

// The tree changed. A query that vanished ends its Edit. The folder list follows the folders.
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

// Escape closes the form first, wherever the focus is in the dialog. A second Escape closes the dialog as usual.
function onDialogKeydown(ev) {
  if (ev.key !== "Escape" || ev.defaultPrevented || ev.isComposing || !ctl.form || ctl.shown !== "saved" || rowMenu) return;
  if (ev.target instanceof Element && ev.target.closest("dialog") !== dom.queryLibraryMenu) return;
  ev.preventDefault();
  ev.stopPropagation();
  cancelForm();
}

// The tree selection sets the Folder of the form. A click, the arrow keys, or a new folder can make the selection.
function formFollows(key) {
  ctl.form?.pickFolder(locOfKey(key));
}

// Save the editor text, or a History run, as a library query. The query can go in either root.
// When the editor holds a query that the user opened from an editable root, the form also offers an update.
// The form offers the choices "Update" and "Save as new".
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
  const held = sql == null ? await openedQuery() : null;
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
        // The opened query moves to the other root. It keeps its new content.
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
      // The tree opens the folder that the query went into. The query is highlighted. The pane shows it.
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

// After a change, the tree row of the query has the focus. On a phone, the preview shows the query.
function closeAfter() {
  if (isPhone()) enterPreview();
  else focusSelected();
}

// Edit changes the name, description and folder of a query. Its SQL is only shown. Edit uses the same form.
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
      // The change drew the tree while the query sat in a closed folder.
      // The query is selected again, now that the folder is open.
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

// This moves one or several items into one folder of either root.
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

// This moves a query or a folder within its root, or into the other root (moveAcross).
// From the Move dialog (inDialog), a failure is thrown to the dialog. From a drop, a failure shows a toast.
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

// This shows a yes or no question on the shared dialog. The focus starts on Cancel.
function confirmDialog({ title, message, confirmLabel = "Remove", danger = true }) {
  return dialog.confirm({ title, message, confirmLabel, danger, className: "qlDialog" });
}

// This removes the given items after one confirm. A folder goes with everything in it.
// If the removed folder is shown, or holds the shown folder, the view moves up to the parent of the removed folder.
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

// Saved is a tree, as in the Explorer. The storages are its top folders: "Shared server storage" first, then "Local browser storage".
// Every folder opens in place.
// The "..." menu of a row, and a right click, act on the row.
// Ticked rows change together. A folder or a query is named in place.
// The preview pane on the right shows the highlighted row.
const libraryEls = {};

// Item keys have these forms: "r:<store>" is a root, "f:<store>:<id>" is a folder, and "q:<store>:<id>" is a query.
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

// This opens every folder from the top of a root down to `folderId`, and opens the root.
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

// This is the head of the list of a tab, for Saved and History alike. It holds the search.
// The tools of the tab are at the right end.
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
  // The head has one tool: the new folder. The new folder goes inside the highlighted folder.
  // Without a highlighted folder, it goes in a root.
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

  // ns.search sets the one delay. Enter applies the field at once, before the handler below runs.
  // Escape also applies the field at once, when the field is filled.
  const searchField = search.bind(input, (value) => {
    ctl.search = value;
    ctl.editing = null;
    runSearch(value);
    renderTree();
  });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      searchField.flush();
      select("saved", treeItems()[0]);
    } else if (ev.key === "Enter") {
      // The preview shows the first query found.
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

// The foot shows the count of queries and the host. The editor has its own button to save its query, beside the copy button.
function renderFoot() {
  const total = storeList().reduce((n, store) => n + libraryQueryTotal(store.library), 0);
  const count = format.countLabel(total, "query", "queries");
  libraryEls.count.textContent = ctl.host ? `${count}${MIDDOT}${ctl.host}` : count;
  libraryEls.count.title = storeList().map((store) => `${rootLabel(store.kind)}: ${format.countLabel(libraryQueryTotal(store.library), "query", "queries")}`).join("\n");
}

// ---- search

// The server makes the search of its libraries. The search covers names, descriptions, SQL and paths of every query.
// It returns at most 100 answers. The page does not keep these answers.
// The answer of each storage is kept with the words that it answered.
const searched = new Map();
let searchToken = 0;
function runSearch(text) {
  const words = String(text || "").trim();
  searched.clear();
  const token = ++searchToken;
  if (!words || !ctl.host) return;
  for (const store of storeList()) {
    if (!isPartial(store.library)) continue;
    searched.set(store.kind, { words, loading: true, results: [], total: 0, truncated: false });
    store.adapter.searchQueries(words).then((answer) => {
      if (token !== searchToken) return;
      searched.set(store.kind, { words, loading: false, ...answer });
      store.library.found = new Map(answer.results.map((r) => [r.id, r]));
    }).catch(() => {
      if (token !== searchToken) return;
      searched.set(store.kind, { words, loading: false, results: [], total: 0, truncated: false, failed: true });
    }).then(() => {
      if (token === searchToken && ctl.rendered.library && ctl.search.trim()) renderTree();
    });
  }
}

function searchMatches() {
  const terms = fold(ctl.search).split(/\s+/).filter(Boolean);
  if (!terms.length) return null;
  const out = [];
  let loading = false;
  let truncated = false;
  let failed = false;
  for (const store of storeList()) {
    const lib = store.library;
    if (isPartial(lib)) {
      const answer = searched.get(store.kind);
      if (!answer || answer.loading) loading = true;
      if (answer?.truncated) truncated = true;
      if (answer?.failed) failed = true;
      for (const q of answer?.results || []) {
        out.push({ store: store.kind, q, path: `${rootLabel(store.kind)} ${q.path}`, score: terms.filter((t) => fold(q.name).includes(t)).length });
      }
      continue;
    }
    for (const q of lib.queries) {
      const path = `${rootLabel(store.kind)} ${folderPathText(lib, q.folder_id)}`;
      const hay = fold(`${q.name}\n${q.description}\n${q.sql}\n${folderPathText(lib, q.folder_id)}`);
      if (!terms.every((t) => hay.includes(t))) continue;
      const nameHits = terms.filter((t) => fold(q.name).includes(t)).length;
      out.push({ store: store.kind, q, path, score: nameHits });
    }
  }
  out.sort((a, b) => b.score - a.score || byName(a.q, b.q));
  return { terms, results: out, loading, truncated, failed };
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

// This is the start of a row, up to its icon. It holds the indentation and the twisty.
function rowLead(level, { twisty = false } = {}) {
  const row = h("div", { class: "qlRow" });
  row.style.setProperty("--qlDepth", String(level - 1));
  const mark = h("span", { class: "qlRow__twisty" });
  mark.setAttribute("aria-hidden", "true");
  if (!twisty) mark.classList.add("is-leaf");
  row.append(h("span", { class: "qlRow__indent", "aria-hidden": "true" }), mark);
  return row;
}

// This is the name that the user types in place. It is for a new folder, or for a renamed folder.
// Enter makes the change. Escape drops the name.
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

// This is the row of a new folder. It comes first in the folder that the new folder goes into.
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

// This makes a new folder in `parentId`. Null means the top of the root.
// The folder opens, and the user types the name in it.
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

// This makes a folder row or a query row. `level` is the depth of the row in the tree. A root has level 1.
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
    // When the row is in the tree, the name is selected. The user can type over it.
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

// This makes the children of a folder, or of a root (folderId null). Each child is one level deeper than its parent.
function appendFolderChildren(parentEl, storeKind, folderId, level) {
  const lib = storeOf(storeKind).library;
  if (ctl.editing?.mode === "new" && ctl.editing.store === storeKind && (ctl.editing.parentId || null) === (folderId || null)) parentEl.appendChild(newFolderRow(level));
  // A folder of the server is open but not read yet. It is requested after this render.
  // The tree says so in the meantime.
  if (!isRead(lib, folderId)) {
    if (lib.failed.has(folderId || "")) {
      parentEl.appendChild(actionRow("Could not be read.", "Retry", { retry: "", store: storeKind, parent: folderId || "" }, level));
    } else {
      wanted.add(`${storeKind}\u0000${folderId || ""}`);
      parentEl.appendChild(emptyFolderRow("Loading\u2026", level));
    }
    return;
  }
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
  // A level that is larger than a page reads its next window on demand.
  if (hasMore(lib, folderId)) {
    const left = Math.max(0, (lib.levelTotal.get(folderId || "") || 0) - childFolders(lib, folderId).length - childQueries(lib, folderId).length);
    parentEl.appendChild(actionRow(`${format.count(left)} more`, `Show ${format.count(Math.min(left || PAGE_SIZE, PAGE_SIZE))} more`, { more: "", store: storeKind, parent: folderId || "" }, level));
  }
}

// This is a row of the tree that shows a message and offers one action.
// The tree click handler knows the button by its data attribute.
function actionRow(text, label, data, level) {
  const li = h("li", { class: "qlTree__action" });
  li.setAttribute("role", "none");
  li.style.setProperty("--qlDepth", String(level));
  const button = h("button", { class: "qlActionButton", type: "button" }, label);
  for (const [name, value] of Object.entries(data)) button.dataset[name] = value;
  li.append(h("span", { class: "qlTree__actionText" }, text), button);
  return li;
}

function emptyFolderRow(text, level) {
  const empty = h("li", { class: "qlTree__empty" }, text);
  empty.setAttribute("role", "none");
  empty.style.setProperty("--qlDepth", String(level));
  return empty;
}

// This is a root: "Shared server storage" or "Local browser storage". It shows the count of queries.
// It shows a lock badge when the root is read-only. The root is open, unless it is closed.
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
  const n = libraryQueryTotal(store.library);
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
    if (matches.loading) tree.appendChild(emptyRow(matches.results.length ? "Searching the server\u2026" : "Searching\u2026"));
    else if (!matches.results.length) tree.appendChild(emptyRow(matches.failed ? "The search could not be made." : `No saved query matches \u201c${ctl.search.trim()}\u201d.`));
    if (matches.truncated) tree.appendChild(emptyRow("The server shows its first 100 answers: add a word to narrow the search."));
  } else if (ctl.host) {
    // No saved query gets a special screen. The roots show instead, and each root says that it is empty.
    for (const store of storeList()) tree.appendChild(rootRow(store));
  }
  restoreSelection("saved");
  // The focus stays in the tree. It goes to the highlighted row. Without one, it goes to the first row.
  if (hadFocus && !tree.contains(document.activeElement)) (selectedItem("saved") || treeItems()[0])?.focus({ preventScroll: false });
  // The render showed "Loading...". The read of these items is requested now.
  const asked = [...wanted];
  wanted.clear();
  for (const item of asked) {
    const [kind, id] = item.split("\u0000");
    void ensureChildren(kind, id || null);
  }
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

// This opens or closes a folder or a root.
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
  // The prompt opens after the menu closes. A prompt opened while the menu is a layer would close with the menu.
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
  // This exports a folder, with everything in it, as a JSON file.
  // A read-only storage can export too, because the export only reads.
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

// This is a folder and everything in it, as a JSON file. The body of POST /api/query-library/import takes (host_id, folders, queries).
// The file can be imported again.
async function exportFolder(item) {
  const lib = storeOf(item.store)?.library;
  const folder = lib ? folderById(lib, item.id) : null;
  if (!folder) return;
  let tree;
  try {
    tree = await fullSubtree(item.store, folder.id);
  } catch (err) {
    toast(util.errorText(err, "The folder could not be exported."), "error");
    return;
  }
  const payload = {
    host_id: ctl.host,
    folders: tree.folders.map((f) => ({ id: f.id, parent_id: f.parent_id, name: f.name })),
    queries: tree.queries.map((q) => ({ folder_id: q.folder_id, name: q.name, description: q.description || "", sql: q.sql, created_at_ms: q.created_at_ms, updated_at_ms: q.updated_at_ms })),
  };
  const name = `${folder.name.replace(/[\\/:*?"<>|\s]+/g, "_").replace(/^_+|_+$/g, "") || "folder"}.json`;
  copy.download(name, `${JSON.stringify(payload, null, 2)}\n`);
  toast(`Exported ${format.countLabel(payload.queries.length, "query", "queries")} to ${name}.`);
}

// This shows a search result in its folder. The search ends, and the folders above the result open.
async function revealQuery(item) {
  const store = storeOf(item.store);
  const query = store ? queryById(store.library, item.id) : null;
  if (!query) return;
  // A library of the server keeps the folders that were opened.
  // The folders above this query are read, from the top level down.
  if (isPartial(store.library)) {
    const detail = await ensureDetail(item.store, item.id);
    if (detail) {
      let parent = null;
      for (const folderId of detail.ancestors) {
        await ensureChildren(item.store, parent);
        parent = folderId;
      }
      await ensureChildren(item.store, parent);
    }
  }
  ctl.search = "";
  if (libraryEls.input) libraryEls.input.value = "";
  expandPath(item.store, query.folder_id);
  ctl.selection.saved = keyOf("query", item.store, item.id);
  renderLibrary({ keepFocus: false });
  focusSelected();
}

// ---- clicks and keys

async function loadItem(li) {
  const entity = entityOf(li);
  if (!entity || li.dataset.kind !== "query") return;
  const query = await fullQuery(li.dataset.store, entity);
  if (query) openInEditor(query, { store: li.dataset.store, savedQuery: query });
}

// A click highlights the row, and the preview shows on the right. A click on a folder or a root also opens or closes it.
// The box ticks the row. The "..." button opens its menu.
// On a phone, the twisty and the folder icon open or close a folder. The name of the folder opens its preview.
function onTreeClick(ev) {
  const target = ev.target instanceof Element ? ev.target : null;
  // "Show more" reads the next window of a level that is larger than a page. "Retry" reads a folder again.
  const action = target?.closest("[data-more], [data-retry]");
  if (action) {
    const lib = storeOf(action.dataset.store)?.library;
    if (lib && "retry" in action.dataset) lib.failed.delete(action.dataset.parent || "");
    void ensureChildren(action.dataset.store, action.dataset.parent || null, { more: "more" in action.dataset });
    if (lib && "retry" in action.dataset) renderTree({ keepFocus: true });
    return;
  }
  const li = itemOf(target);
  if (!li || target.closest(".qlRow--edit")) return;
  const menuButton = target.closest('[data-action="row-menu"]');
  if (menuButton) {
    select("saved", li, { focus: false });
    openRowMenu(li, { anchor: menuButton });
    return;
  }
  // Was this row selected before the press? The press focuses the row. The focus then selects the row.
  const wasSelected = treePress?.key === li.dataset.key ? treePress.wasSelected : ctl.selection.saved === li.dataset.key;
  treePress = null;
  if (isFolderLike(li)) {
    if (isPhone()) {
      // The twisty is small under a finger. The icon also opens and closes the folder. The name shows the pane.
      if (!target.closest(".qlRow__twisty, .qlRow > .qlIcon")) {
        select("saved", li);
        enterPreview();
        return;
      }
      toggleFolder(li);
      return;
    }
    // The chevron opens and closes the folder.
    // A click on the row selects a folder. It opens the folder when the folder is closed.
    // On a folder that is already selected (the blue frame) and open, the click closes it, as the chevron does.
    if (target.closest(".qlRow__twisty")) toggleFolder(li);
    else toggleFolder(li, !(wasSelected && li.getAttribute("aria-expanded") === "true"));
    return;
  }
  select("saved", li);
  if (isPhone()) enterPreview();
}

// A double click loads a query. The first click has already opened or closed a folder.
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

// A press on a row of the tree lasts until its click, context menu, drag or cancel ends it.
// The press focuses the row before the click. When the form is open, this focus sets the Folder and draws the tree again.
//
// The row under the pointer can then be gone before the click reaches it. A twisty then never opens.
// A folder tapped on a phone never returns to the form. While a press is active, the click that follows does what the focus does.
let treePressed = false;
// This holds the row under the last press. It also holds whether the row was selected then (see onTreeClick).
// The press itself selects the row.
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

// The focus and the highlight move together. Tab returns to the list.
function onTreeFocus(ev) {
  // A button of an action row ("Show more", "Retry") is not the row of the storage that holds it.
  // The focus selects nothing.
  // The tree does not scroll under the pointer between the press and the click.
  if (ev.target instanceof Element && ev.target.closest(".qlTree__action")) return;
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
  // Type-ahead selects the next visible item that starts with the typed letter.
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

// A folder is renamed in its row. A query uses its form in the pane.
// The form has the name, the description, the folder and the SQL.
function editItem(li) {
  const entity = entityOf(li);
  if (!entity) return;
  if (li.dataset.kind === "folder") startRename(li);
  else if (li.dataset.kind === "query") {
    void fullQuery(li.dataset.store, entity).then((query) => {
      if (query) return beginEdit(li.dataset.store, query);
      return null;
    });
  }
}

// ---------------------------------------------------------- drag and drop

let dragItems = null;

// This is a drop place: { store, folderId }.
// Within a root, a folder never goes into itself.
// To drop into the other root, both roots must be editable.
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

// This finds the drop place under the pointer. It is a folder or a root row, or the folder or root of a query.
// Otherwise, it is the top of the one root.
function dropTargetOf(ev) {
  const li = itemOf(ev.target);
  if (!li) {
    // The list background is the top of the one root, when only one root exists.
    const only = storeList().length === 1 ? storeList()[0].kind : "";
    return only ? { target: { store: only, folderId: null }, el: libraryEls.tree } : { target: null, el: null };
  }
  if (li.dataset.kind === "root") return { target: { store: li.dataset.store, folderId: null }, el: li };
  if (li.dataset.kind === "folder") return { target: { store: li.dataset.store, folderId: li.dataset.id }, el: li };
  // Over a query, the drop place is the folder of the query, or its root.
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
    // A query dropped on the editor inserts its SQL.
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

// Both tabs use one selection model. Each tab lists items that carry a data-key.
// The data-key is "r:" for a root, "f:" or "q:" for a tree item in Saved, and "h:<id>" for an option in History.
// ctl.selection holds the selected key of each tab.
//
// The selected item has aria-selected. It is in the Tab order, by roving tabindex.
// The preview pane shows the selected item. A click or the arrow keys select an item.
// Enter moves on to the preview. On a phone, a click does the same.
// The "Load" button in the preview loads the item. Ctrl/Cmd+Enter does the same.
const views = {
  saved: { items: () => treeItems(), preview: (key) => savedPreview(key) },
  history: { items: () => historyItems(), preview: (key) => historyPreview(key) },
};

const isPhone = () => util.isPhoneLayout();

function selectedItem(tab) {
  const key = ctl.selection[tab];
  return key ? views[tab].items().find((x) => x.dataset.key === key) || null : null;
}

// This marks the selection. The Tab stop is the selected item.
// If no item is selected, the Tab stop is the first item.
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

// After a render, the same key is selected again. This happens for a renamed query or a reloaded History.
// When the selected item is gone, the first item is selected. It returns the Tab stop.
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

// This is the "Load" action of the selection. A folder has no "Load" action.
function loadSelection() {
  selectionPreview()?.actions?.find((a) => a.action === "load")?.run();
}

// The next step after a selection shows the preview. The focus goes to "Load", or to the first tool.
// On a phone, the pane replaces the list. The class .is-previewing marks this state.
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

// This returns to the list. The selected item keeps the selection.
function leavePreview() {
  setPreviewStep(false);
  if (ctl.shown) (selectedItem(ctl.shown) || markSelection(ctl.shown))?.focus({ preventScroll: true });
}

function setPreviewStep(on) {
  dom.queryLibraryViewSaved?.parentElement?.classList.toggle("is-previewing", on);
}

// ---------------------------------------------------------- preview pane

// The right pane of the dialog is #queryLibraryPreview. It sits beside the views.
// It is one component for both tabs. It is the only place for the item actions.
// A tab describes its selected item in this form:
//   { title, status, meta: node, description, facts: [[label, text | node]],
//     error, sql, tools: [{ label, icon, action, run, danger }],
//     actions: [{ label, action, run, primary }] }
//
// The pane renders this description. Its head is on one line. The head holds the Back button of the phone step,
// the title, and the meta text. The meta text is "Updated ..." or the time and status of a run.
// The item tools are icon buttons at the right end of the head.
// Then the pane shows the facts and the highlighted SQL. The foot holds "Load" alone.
const PREVIEW_EMPTY = { saved: "Select a query to preview it here.", history: "Select a run to preview it here." };
let paneModel = null;

// The list of a tab can show no item. It then shows its own empty state, or a loader.
// Saved always has a folder to show. The exception is a search that finds nothing.
function listIsEmpty(tab) {
  const list = tab === "history" ? historyEls.list : libraryEls.tree;
  if (!list || !list.isConnected) return false;
  if (tab === "saved") return !!ctl.search.trim() && !$(".qlNode", list);
  return !$("[role=option]", list);
}

// The pane is added beside the views the first time the dialog shows them.
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
  const more = ev.target instanceof Element ? ev.target.closest("button[data-more]") : null;
  if (more) {
    void ensureChildren(more.dataset.store, more.dataset.parent || null, { more: true });
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
  // The form has its own keys: Enter, Ctrl+Enter, and Escape on the dialog.
  if (ctl.form && ctl.shown === "saved") return;
  if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey) && !ev.altKey) {
    ev.preventDefault();
    loadSelection();
  } else if (ev.key === "Escape" && dom.queryLibraryViewSaved?.parentElement?.classList.contains("is-previewing")) {
    // On the phone step, Escape returns to the list. It does not close the dialog.
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

// The text "Updated Oct 4 13:19:35" is right of the title.
function updatedMeta(ms) {
  if (!ms) return null;
  return h("span", { class: "qlPreview__meta" }, "Updated ", timeNode(ms));
}

function contentsText(counts) {
  return [counts.queries ? format.countLabel(counts.queries, "query", "queries") : "", counts.folders ? format.countLabel(counts.folders, "subfolder") : ""].filter(Boolean).join(MIDDOT) || "Empty";
}

// This shows what a folder (folderId) or a storage (null) holds, one level down.
// It lists the subfolders with their count of queries. Then it lists the queries with their description and last change.
// The pane lists them. A click opens one of them.
// A level that is larger than a page is read in the pane. The pane shows the entries that are in, and a button for the rest.
function entriesState(store, folderId) {
  const lib = store.library;
  if (!isPartial(lib)) return {};
  if (!isRead(lib, folderId)) {
    void ensureChildren(store.kind, folderId);
    return { entriesLoading: !lib.failed.has(folderId || "") };
  }
  if (!hasMore(lib, folderId)) return {};
  const left = Math.max(0, (lib.levelTotal.get(folderId || "") || 0) - childFolders(lib, folderId).length - childQueries(lib, folderId).length);
  return { entriesMore: { left, store: store.kind, parent: folderId || "" } };
}

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

// A click in the list of the pane highlights the item in the tree. A folder also opens.
// The result is the same as a click in the tree.
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
    const meta = h("span", { class: "qlPreview__meta" }, contentsText({ queries: libraryQueryTotal(lib), folders: libraryFolderTotal(lib) }));
    if (isServerStore(store) && !canEdit && ctl.host && !store.fatal) meta.append(MIDDOT, "Read-only");
    return {
      title: rootLabel(store.kind),
      meta,
      description: store.hint,
      facts: ctl.host ? [["Host", ctl.host]] : [],
      error: store.fatal || (store.loadError ? `The library file could not be read (${store.loadError}): read-only.` : ""),
      entries: store.fatal ? null : entriesOf(store, null),
      ...(store.fatal ? {} : entriesState(store, null)),
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
      ...entriesState(store, folder.id),
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
  const listed = queryById(lib, sel.id);
  if (!listed) return null;
  const item = { kind: "query", store: store.kind, id: listed.id };
  // The SQL and the description of a query of the server are read when the query is opened.
  // Until then, the pane says so.
  const query = queryDetail(lib, listed);
  if (!query) {
    void ensureDetail(store.kind, listed.id);
    return { title: listed.name, meta: updatedMeta(listed.updated_at_ms), facts: [], loading: true, tools: [], actions: [] };
  }
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

// A run that was not formatted when it ran gets the formatter text later. This happens for an older entry,
// or for a query typed without formatting. The run gets the text when the run is viewed: selected in the list, loaded, or saved.
// The list does not change, because it shows each query on one line. Nothing moves while the user reads.
// A script that the formatter rejects stays as typed.
const historyFormatting = new Map();
// Load does not wait longer than this limit for the formatter, which can be slow or unreachable.
// The editor then gets the text as typed.
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
  // The History stores a query longer than its limit cut. Load would then put a shorter text in the editor.
  if (entry.truncated) facts.push(["Text", `Cut at ${format.count(history.LIMITS.sqlChars)} characters`]);
  const tools = [];
  if (anyEditable()) tools.push({ label: "Save to library\u2026", icon: "save", action: "save", run: () => beginSave({ sql: entry.sql, fromHistory: entry }) });
  if (!entry.formatted) {
    // The formatted text replaces the shown text when it arrives. It does not replace the text
    // when the user has begun to read, for example by scrolling the block.
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

// This renders the selection of the tab shown.
// The focus stays on the same action, or on the pane, when the pane had the focus.
function renderPreview() {
  const pane = previewPane();
  if (!pane) return;
  // For Save and Edit, the pane content is the form. The form is built once.
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
  // A tab with nothing listed has one empty state across the dialog.
  // This applies to an empty library, an empty History, or a search without a match.
  // No second "select an item" pane appears beside it.
  pane.parentElement?.classList.toggle("is-empty", !model && listIsEmpty(ctl.shown));
  if (!model) {
    pane.appendChild(h("div", { class: "qlPreview__empty" }, PREVIEW_EMPTY[ctl.shown] || PREVIEW_EMPTY.saved));
    setPreviewStep(false);
    if (refocus !== null) leavePreview();
    return;
  }
  const content = h("div", { class: "qlPreview__content" });
  // The head is one line. It holds the Back button on a phone, the title, the meta text, and the tools.
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
  if (model.loading) content.appendChild(h("p", { class: "qlPreview__loading" }, "Loading the query\u2026"));
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

// This shows what a folder or a storage holds, as a list in the pane. Each entry is a button.
// The button opens the entry in the tree.
const CONTENTS_SHOWN = 200;
function contentsList(model) {
  const wrap = h("section", { class: "qlContents" });
  wrap.setAttribute("aria-label", model.entriesTitle);
  wrap.appendChild(h("div", { class: "qlContents__label" }, model.entriesTitle));
  if (!model.entries.length) {
    wrap.appendChild(h("p", { class: "qlContents__empty" }, model.entriesLoading ? "Loading\u2026" : model.entriesMore ? "" : model.entriesEmpty));
    if (!model.entriesMore) return wrap;
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
  if (model.entriesMore) {
    const more = h("button", { class: "qlActionButton qlContents__showMore", type: "button" }, `Show ${format.count(Math.min(model.entriesMore.left || PAGE_SIZE, PAGE_SIZE))} more (${format.count(model.entriesMore.left)} left)`);
    more.dataset.more = "";
    more.dataset.store = model.entriesMore.store;
    more.dataset.parent = model.entriesMore.parent;
    wrap.appendChild(more);
  }
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
  // The head is the same as in Saved. It holds the search and an empty slot for tools.
  const { head, input, actions } = listHead("Search the history");
  actions.hidden = true;
  const list = h("div", { class: "qhList" });
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Query history");
  // The foot shows the count and the storage place, as in Saved.
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

// This holds the runs of the current host. A reload replaces the read in flight (util.latest).
// Thus a host switch or a typed search never shows an older answer.
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
    // The entries are the same. This happens after a run that changed nothing shown.
    // Keep the rows, their focus, and their hover.
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

// A click selects the run and shows it in the preview. The preview shows the actions of the run.
// On a phone, the preview is the next step.
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
  // Each tab previews its own selection. On a phone, the dialog starts on the list.
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

// A burst of run-history changes reloads the list one time.
const reloadHistorySoon = util.debounce(() => loadHistory(), 150);
function historyChanged() {
  if (ctl.historyState.loaded) reloadHistorySoon();
}

// Another tab changed the browser library.
window.addEventListener("storage", (ev) => {
  if (ev.key === LOCAL_KEY && ctl.rendered.library && ctl.stores.local) void reloadStore(ctl.stores.local).then(() => renderLibrary());
});
// Another tab ran a query. app_history.js sends this message by BroadcastChannel. The list then reloads.
window.addEventListener("chdash:query-history-changed", () => historyChanged());

// This is the library query that the editor holds unchanged, by its id. It is used for ?saved=.
function openedId(sqlText) {
  if (!ctl.opened) return "";
  return String(sqlText ?? editorSql()).trim() === String(ctl.opened.sql).trim() ? ctl.opened.id : "";
}

// At startup, the ?saved=<id> link opens the saved query of the current host in the editor.
// The query can be in either root.
async function openSaved(id) {
  await start();
  for (const store of storeList()) {
    // The app asks a library of the server for the query by its id. The query may not be among the loaded queries.
    const query = isPartial(store.library) ? await ensureDetail(store.kind, String(id || "")) : queryById(store.library, String(id || ""));
    if (!query) continue;
    setEditorSql(query.sql);
    ctl.opened = { store: store.kind, id: query.id, sql: String(query.sql) };
    return true;
  }
  toast(`The linked saved query is not in the library of ${ctl.host || "this host"}.`, "error");
  return false;
}

// The dialog closed. No part of it remains on screen.
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
