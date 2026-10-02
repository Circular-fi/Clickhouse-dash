# Query library and history

The Query page keeps saved queries (in folders, with descriptions and tags) and the history of the queries it ran. By default both live in the browser (localStorage). The optional `query_library` block moves them to one JSON file on the ChDash server, so every user of the panel shares the same library.

**Saved queries and history are per host.** Every folder, saved query and history entry belongs to one ClickHouse host (`host_id`, the `name` of a `clickhouse.host` block). The library shows the folders, queries and history of the host selected in the header only, and follows a host switch at once; a run is recorded in the history of the host it ran on. In server mode every read names its host (`?host_id=`), every write is stamped with it, and nothing moves from one host to another.

```hcl
query_library {
  enabled  = true
  file     = "/var/lib/chdash/query_library.json"
  writable = true

  history {
    store       = "server" # server | browser
    max_entries = 500
  }

  max_file_bytes  = 8388608
  max_query_bytes = 262144
}
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | `false`: every `/api/query-library` route answers 404; the browser keeps its localStorage library and history. |
| `file` | none | Required when enabled. The parent directory must exist; the file is created on the first write. |
| `writable` | `false` | `false`: read-only library. Folder/query create, edit, move and delete, import and history deletion answer 403 `read_only`. Recording history is still allowed (it is not library editing). |
| `history.store` | `"server"` | `"server"`: history ring buffer in the file. `"browser"`: history stays in localStorage and the `/api/query-library/history` routes are absent (404). |
| `history.max_entries` | `500` | Ring buffer size (1..100000); the oldest entry is dropped first. |
| `max_file_bytes` | 8 MiB | Size cap of the file (64 KiB..1 GiB). When a write would exceed it, the oldest history entries are dropped first; if the library alone still does not fit, the write answers 413 and nothing changes. |
| `max_query_bytes` | 256 KiB | SQL size cap of one saved query or history entry (1 KiB..`max_file_bytes`); larger SQL answers 413. |

`/api/version` reports `features.query_library = {"enabled", "writable", "history_store"}`. `writable` is the effective state: it is false when `writable = false` and while the file has a load error. With the feature disabled it reports `{"enabled": false, "writable": false, "history_store": "browser"}`.

## In the Query page

The book button of the Query toolbar (between Format and the run settings cog) opens the query library in the same modal dialog as *Run with profiling* (same size, close button, backdrop and tab style; full-screen on a phone). Its two tabs, **Saved** and **History**, stand in the dialog header where the profiling dialog has its title.

Both tabs work the same way: a click (or the arrow keys) selects an item, and the pane on the right shows it. A click never loads a query by itself; the pane's **Load in editor** button (bottom right, or Ctrl/Cmd+Enter in the list or the pane) puts the SQL in the editor and closes the dialog. On a phone the list and the preview are two steps: tap an item to see its preview, with a back button, then *Load in editor*.

- **Saved**: a folder tree (nested folders, saved queries with a description and tags), searched across names, descriptions, tags and SQL. The preview shows the name, description, folder, tags, host, last update and the highlighted SQL, with *Run* and *Load in editor*. The item menu (its ... button, a right-click or Shift+F10) also has *Append to editor* (adds the query as another statement and turns multiquery on), *Copy SQL*, *Edit...*, *Move to...* and *Delete*. Folders and queries are created, renamed or edited (name, description, folder, tags, SQL from the editor), moved (drag and drop, or *Move to...*) and deleted; deleting a query, or a non-empty folder and everything in it, asks first (a confirm stacked over the library).
- **History**: the runs grouped by day, with status (ok / error / cancelled), elapsed time, rows and host; search and *Clear*. The preview shows the status, time, elapsed time, rows, host, the server error of a failed run and the SQL, with *Save to library...*, *Run* (load and run) and *Load in editor*.

Ctrl/Cmd+S saves the editor to the library (or updates the saved query the editor holds). The library is fully keyboard driven: the focus moves into the dialog and stays there; arrows, Home / End and type-ahead select in the list, Left / Right collapse and expand folders, Enter moves to the preview (its *Load in editor* button), Ctrl/Cmd+Enter loads, F2 edits, Delete removes, Shift+F10 opens the item menu, `/` goes to the search; Escape (or a click on the backdrop) closes it and the focus returns to the book button.

| Mode | Library | History |
| --- | --- | --- |
| `enabled = false` | this browser, `localStorage["chdash.queryLibrary.v2"]` (each folder and query carries its `host_id`); always editable | `localStorage["chdash.queryHistory.v1"]` (each entry carries its `host_id`) |
| `enabled = true` | the server file through `/api/query-library?host_id=` | per `history.store` |
| `writable = false` | shown with a *Read-only library* badge; every create / edit / move / delete control is hidden | no Clear, no per-entry removal |

In server mode every folder / query change sends `If-Match: <revision>`; on a 409 conflict the library reloads and retries once, then tells the user. When the server library is editable and the browser has queries of its own for the current host, the library offers once to *Import my browser queries* (`POST /api/query-library/import` with that `host_id`, after a confirm).

### Entries without a host

Entries without a host do not exist any more: they are dropped.

- **Server, writable file**: when the file is loaded (at startup, or after an external edit), folders, saved queries and history entries without a `host_id` are removed, and the file is rewritten atomically as version 2 (see [File format](#file-format)). A query or folder that was inside a removed folder moves to the top level of its own host. The log says what was dropped (counts only, never SQL).
- **Server, read-only (`writable = false`)**: the same entries are ignored in memory; the file is never rewritten.
- **Server, malformed file**: a load error as before (read-only, served empty or from the last good copy); the file is never rewritten.
- **Browser**: on the first load, folders and queries without a host are removed from `chdash.queryLibrary.v2` and history entries without a host from `chdash.queryHistory.v1`. The old flat list `chdash.savedQueries.v1` is no longer read or imported (its entries have no folder and often no host).

The page address follows the editor: `?saved=<id>` while it holds a library query unchanged, else `?sql=<text>` of the last run (up to 4,000 characters). Opened in a new tab, the link fills the editor.

## Storage

- One process owns the file: the library is kept in memory behind a mutex, and every request first compares the file's stat (device, inode, size, mtime) with the last one seen. An external change is reloaded before the request is served or a mutation is applied, and the revision moves forward so editors holding the old revision get a 409.
- Writes are atomic: the new document is written to a temporary file in the same directory (`.<name>.tmp-<pid>-<random>`, created with `O_EXCL`, `O_NOFOLLOW`, mode 0600), fsynced, renamed over the file, and the directory is fsynced. A failed write leaves the previous file untouched, removes the temporary file and answers 500 `storage_error`.
- A file that is not valid JSON, has an unsupported `version`, or is structurally inconsistent (duplicate ids, unknown parents or folders, a parent cycle, wrong types, over `max_file_bytes`) is never overwritten. The error is logged once, the library is served read-only (empty at startup, or the last good copy) with `load_error` set, mutations and history appends answer 403 `read_only`, and the file is reloaded as soon as it changes on disk.
- The feature never executes SQL: saved and historical SQL is stored and returned verbatim. No request value ever reaches the filesystem: the only path is the configured `file`, and request ids are only looked up in memory. Logs never contain SQL.

## Security

ChDash has no end-user authentication (see the authorization model in [`configuration.md`](configuration.md)): everyone who can reach the panel can read and, when `writable = true`, edit the library. Because the library is persistent, mutating routes additionally refuse requests that a third-party page could make through a user's browser:

- `Sec-Fetch-Site` must be absent, `same-origin` or `none` (403 `cross_site_request` otherwise);
- without `Sec-Fetch-Site`, an `Origin` header must match the request's `Host` or `X-Forwarded-Host` (403 `cross_site_request`);
- a request body must be sent as `Content-Type: application/json` (415 `unsupported_media_type`), which a cross-origin page cannot do without a CORS preflight that ChDash never grants.

Responses carry `Cache-Control: no-store`.

## File format

```json
{
  "version": 2,
  "revision": 42,
  "updated_at_ms": 1790000000000,
  "folders": [
    {"id": "f_3c1d...", "host_id": "local", "parent_id": null, "name": "Operations", "description": "", "created_at_ms": 1790000000000, "updated_at_ms": 1790000000000}
  ],
  "queries": [
    {"id": "q_9a0b...", "folder_id": "f_3c1d...", "name": "Active parts", "description": "", "sql": "SELECT ...", "host_id": "local", "tags": ["parts"], "created_at_ms": 1790000000000, "updated_at_ms": 1790000000000}
  ],
  "history": [
    {"id": "h_77e2...", "sql": "SELECT 1", "host_id": "local", "ran_at_ms": 1790000000000, "elapsed_ms": 12.5, "rows": 1, "status": "ok", "error": null}
  ]
}
```

- `version` is `2`; a version `1` file is migrated on load (below), any other version is a load error. `revision` is the library revision (see below). `history` is stored oldest first.
- `host_id` is required on every folder, query and history entry. A folder lives in a folder of its own host, and a query in a folder of its own host; anything else is a load error. Host ids that are no longer configured are kept (the host may come back) but cannot be read until it is.
- **Migration from version 1.** Version 1 had no `host_id` on folders, and `host_id` was optional on queries and history entries. On load every entry without a `host_id` is dropped (so every version-1 folder), a query or folder whose folder was dropped moves to the top level of its host, and a writable library rewrites the file as version 2 at once (atomically; the revision is kept). A read-only library serves the migrated library from memory and leaves the file as it is. The same applies to a version-2 file holding entries without a host.
- Ids are generated by the server (`f_`, `q_`, `h_` + 16 hex digits); a hand-written file may use any unique string of at most 128 bytes.
- `parent_id` / `folder_id` are `null` for the top level of the host. Folders nest at most 8 levels deep. Names are 1..256 bytes, trimmed, without control characters, and unique among siblings, case-insensitively (ASCII): among the subfolders of one folder (or of the host's top level), and among the queries of one folder.
- `description` is at most 16 KiB. `tags` holds at most 32 distinct (case-insensitive) tags of 1..64 bytes. `status` is `ok`, `error` or `cancelled`; `error` is at most 4 KiB (longer messages are truncated).
- Unknown fields are ignored and not preserved by the next write.

To pre-seed a read-only library, write such a file by hand (for example from an exported writable library) and point a `writable = false` deployment at it.

## REST API

All bodies are JSON. `If-Match: <revision>` is accepted on every mutating request (`42`, `"42"`, `W/"42"` and `*` are understood); on a mismatch the request answers 409 `{"error": "conflict", "revision": <current>}` so the UI can reload. Mutation responses carry the new `revision`.

`host_id` is required where the table names it, and must name a configured host: missing, it answers 400 `reason: "required"`; unknown, 400 `reason: "unknown_host"` (both with `field: "host_id"`). Requests by id (`PATCH`, `DELETE .../<id>`) act on the entity's own host. A move into a folder of another host, or a `host_id` in a PATCH that is not the entity's, answers 400 `reason: "host_mismatch"` and changes nothing.

The library revision is one for the whole file (every host): it changes with every folder or query change and with an external edit of the file. History appends and deletions do not change it, so running queries never invalidates an editor's `If-Match`.

| Route | Writable only | Result |
| --- | --- | --- |
| `GET /api/query-library?host_id=` | | `{host_id, revision, updated_at_ms, writable, history_store, load_error, limits, folders, queries}`: the folders and queries of that host (queries include `sql`; no history). `load_error` is `null` or the reason the file could not be loaded. `limits` holds `max_query_bytes`, `max_file_bytes`, `history_max_entries`, `max_folder_depth`, `max_name_bytes`, `max_description_bytes`. |
| `GET /api/query-library/history?host_id=&limit=&before_ms=&before_id=&q=` | | `{entries, has_more}`: the runs of that host, newest first (`ran_at_ms` descending). `limit` 1..1000 (default 100); `before_ms` returns entries with `ran_at_ms < before_ms`; the optional `before_id` (with `before_ms` = that entry's `ran_at_ms`) also returns older entries of the same millisecond; `q` is a case-insensitive substring of the SQL. History store `server` only. |
| `POST /api/query-library/history` `{sql, host_id, ran_at_ms, elapsed_ms, rows, status, error}` | no | 201 `{id, revision}`. `sql` and `host_id` (the host the query ran on) are required; `ran_at_ms` defaults to now, `status` to `ok` (`canceled` is accepted as `cancelled`). History store `server` only. |
| `DELETE /api/query-library/history?host_id=` | yes | Clears the history of that host: `{ok, deleted, revision}`. |
| `DELETE /api/query-library/history/<id>` | yes | `{ok, id, revision}`. |
| `POST /api/query-library/folders` `{host_id, parent_id, name, description}` | yes | 201: the folder plus `revision`. `parent_id` is a folder of the same host. |
| `PATCH /api/query-library/folders/<id>` `{name?, description?, parent_id?}` | yes | The folder plus `revision`. Setting `parent_id` moves the folder (`null` = the top level of its host); moving a folder into itself or one of its subfolders answers 400 `reason: "cycle"`, a move that would nest deeper than 8 levels 400 `reason: "depth"`, and into a folder of another host 400 `reason: "host_mismatch"`. |
| `DELETE /api/query-library/folders/<id>?recursive=1` | yes | `{ok, id, deleted_folders, deleted_queries, revision}`. Without `recursive=1` a folder holding subfolders or queries answers 409 `{"error": "not_empty", "folders": <subfolders>, "queries": <direct queries>}`. |
| `POST /api/query-library/queries` `{host_id, folder_id, name, description, sql, tags?}` | yes | 201: the query plus `revision`. `folder_id` is a folder of the same host. |
| `PATCH /api/query-library/queries/<id>` `{name?, description?, sql?, folder_id?, tags?}` | yes | The query plus `revision`; `folder_id` moves it, within its host (400 `reason: "host_mismatch"` otherwise). |
| `DELETE /api/query-library/queries/<id>` | yes | `{ok, id, revision}`. |
| `POST /api/query-library/import` `{host_id, folders, queries}` | yes | `{ok, imported_folders, merged_folders, imported_queries, skipped_queries, folder_ids, revision}`. |

A PATCH that changes nothing does not write the file and keeps the revision.

### Import

`POST /api/query-library/import` is meant to be called once per host, to move the browser's localStorage library of the current host into the server library. Everything imported belongs to the request's `host_id` (the current host): a `host_id` on an imported query is ignored. `folders` entries are `{id, parent_id, name, description}` where `id` / `parent_id` are the browser's ids; `queries` entries are `{folder_id, name, description, sql, tags, created_at_ms?, updated_at_ms?}` where `folder_id` refers to an imported folder id (or an existing server folder id of the same host; anything else means the top level).

- Folders are imported parents first. A folder whose name (case-insensitive) already exists under the same parent of the same host is merged into the existing one (`merged_folders`). A parent cycle in the payload answers 400 `reason: "cycle"`.
- Queries are de-duplicated by name + SQL against the host's library and within the payload (`skipped_queries`); a ` (n)` suffix added by an earlier import does not count, so importing the same payload twice is a no-op. A query whose name is already used by a different query of the target folder is renamed `name (2)`, `name (3)`, ...
- `folder_ids` maps each imported folder id to its server id.
- The import is all-or-nothing: a validation error anywhere answers 400 (or 413) with the offending `field` (for example `queries[3].sql`) and nothing is written. When nothing is new, the file is not written and the revision does not change.

### Errors

Errors are JSON objects carrying `error` (and the same value in `error_code`, like the other ChDash APIs) plus `message`:

| Status | `error` | Extra fields |
| --- | --- | --- |
| 400 | `validation` | `field` (`host_id`, `name`, `parent_id`, `folder_id`, `sql`, `tags[2]`, `queries[3].name`, `If-Match`, `limit`, `body`, ...) and `reason` (`required`, `type`, `too_long`, `invalid`, `duplicate`, `not_found`, `unknown_host`, `host_mismatch`, `cycle`, `depth`, `invalid_json`, `range`) |
| 403 | `read_only` | `load_error` when the file failed to load |
| 403 | `cross_site_request` | |
| 404 | `not_found` | Unknown id; also every route when the feature is disabled (empty body) |
| 409 | `conflict` | `revision` |
| 409 | `not_empty` | `folders`, `queries`, `revision` |
| 413 | `too_large` | `field` (`sql`, `file`, `folders`, `queries`) |
| 415 | `unsupported_media_type` | |
| 500 | `storage_error` | The file could not be written; nothing changed |

## Tests

- `tests/native/query_library_test.cpp`: store unit tests (atomic write, tree rules, If-Match, history, read-only, malformed file and reload, import, size cap, per-host reads and writes, `host_mismatch`, the version 1 to 2 migration on a writable and a read-only file). Build the `chdash_query_library_test` target with `-DCHDASH_BUILD_QUERY_LIBRARY_TESTS=ON`; `tests/harness/test_query_library_contract.py` runs it when `QUERY_LIBRARY_TEST_BINARY` points at it.
- `tests/backend-functional/test_query_library.py`: HTTP tests against dedicated instances; see "Query library" in [`tests/README.md`](../tests/README.md).
- `tests/frontend/specs/query-library.spec.js`: the Query page library dialog (the shared modal of the profiling dialog: shell, geometry, focus, Escape and backdrop, stacked confirms) in browser mode (migration, folders, save / edit / move, search, preview, keyboard, History), in server mode against a mocked API (If-Match and conflict retry, read-only, import, server History), on a phone and in both themes. Its last test runs against a real writable instance when `QUERY_LIBRARY_BASE_URL` names one (as the Playwright container reaches it).
