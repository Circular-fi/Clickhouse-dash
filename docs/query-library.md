# Query library and history

The Query page keeps saved queries (in folders, with descriptions and tags) and the history of the queries it ran. By default both live in the browser (localStorage). The optional `query_library` block moves them to one JSON file on the ChDash server, so every user of the panel shares the same library.

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

The book button of the Query toolbar (between Format and the run settings cog) opens the query library panel, with two tabs:

- **Saved**: a folder tree (nested folders, saved queries with a description and tags), searched across names, descriptions, tags and SQL. Hovering a query shows its description and highlighted SQL. A click opens it in the editor; Ctrl/Cmd+click (or *Add as a new statement*) appends it as another statement, turning multiquery on. Folders and queries are created, renamed or edited (name, description, folder, tags, SQL from the editor), moved (drag and drop, or *Move to...*) and deleted; deleting a non-empty folder asks first and deletes everything in it.
- **History**: the runs grouped by day, with status (ok / error / cancelled), elapsed time, rows and host; search, run again, *Save to library* and *Clear*.

Ctrl/Cmd+S saves the editor to the library (or updates the saved query the editor holds). The panel is fully keyboard driven: arrows, Home / End and type-ahead in the tree, Left / Right to collapse and expand, Enter to open, F2 to edit, Delete, Shift+F10 for the item menu, `/` for the search, Escape to close.

| Mode | Library | History |
| --- | --- | --- |
| `enabled = false` | this browser, `localStorage["chdash.queryLibrary.v2"]` (created once from the flat `chdash.savedQueries.v1` list, which is left as it was); always editable | `localStorage["chdash.queryHistory.v1"]` |
| `enabled = true` | the server file through `/api/query-library` | per `history.store` |
| `writable = false` | shown with a *Read-only library* badge; every create / edit / move / delete control is hidden | no Clear, no per-entry removal |

In server mode every folder / query change sends `If-Match: <revision>`; on a 409 conflict the panel reloads the library and retries once, then tells the user. When the server library is editable and the browser has queries of its own, the panel offers once to *Import my browser queries* (`POST /api/query-library/import`).

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
  "version": 1,
  "revision": 42,
  "updated_at_ms": 1790000000000,
  "folders": [
    {"id": "f_3c1d...", "parent_id": null, "name": "Operations", "description": "", "created_at_ms": 1790000000000, "updated_at_ms": 1790000000000}
  ],
  "queries": [
    {"id": "q_9a0b...", "folder_id": "f_3c1d...", "name": "Active parts", "description": "", "sql": "SELECT ...", "host_id": null, "tags": ["parts"], "created_at_ms": 1790000000000, "updated_at_ms": 1790000000000}
  ],
  "history": [
    {"id": "h_77e2...", "sql": "SELECT 1", "host_id": "local", "ran_at_ms": 1790000000000, "elapsed_ms": 12.5, "rows": 1, "status": "ok", "error": null}
  ]
}
```

- `version` must be `1`. `revision` is the library revision (see below). `history` is stored oldest first.
- Ids are generated by the server (`f_`, `q_`, `h_` + 16 hex digits); a hand-written file may use any unique string of at most 128 bytes.
- `parent_id` / `folder_id` are `null` for the root. Folders nest at most 8 levels deep. Names are 1..256 bytes, trimmed, without control characters, and unique among siblings, case-insensitively (ASCII): among the subfolders of one folder, and among the queries of one folder.
- `description` is at most 16 KiB. `tags` holds at most 32 distinct (case-insensitive) tags of 1..64 bytes. `status` is `ok`, `error` or `cancelled`; `error` is at most 4 KiB (longer messages are truncated).
- Unknown fields are ignored and not preserved by the next write.

To pre-seed a read-only library, write such a file by hand (for example from an exported writable library) and point a `writable = false` deployment at it.

## REST API

All bodies are JSON. `If-Match: <revision>` is accepted on every mutating request (`42`, `"42"`, `W/"42"` and `*` are understood); on a mismatch the request answers 409 `{"error": "conflict", "revision": <current>}` so the UI can reload. Mutation responses carry the new `revision`.

The library revision changes with every folder or query change and with an external edit of the file. History appends and deletions do not change it, so running queries never invalidates an editor's `If-Match`.

| Route | Writable only | Result |
| --- | --- | --- |
| `GET /api/query-library` | | `{revision, updated_at_ms, writable, history_store, load_error, limits, folders, queries}` (queries include `sql`; no history). `load_error` is `null` or the reason the file could not be loaded. `limits` holds `max_query_bytes`, `max_file_bytes`, `history_max_entries`, `max_folder_depth`, `max_name_bytes`, `max_description_bytes`. |
| `GET /api/query-library/history?limit=&before_ms=&before_id=&q=` | | `{entries, has_more}`, newest first (`ran_at_ms` descending). `limit` 1..1000 (default 100); `before_ms` returns entries with `ran_at_ms < before_ms`; the optional `before_id` (with `before_ms` = that entry's `ran_at_ms`) also returns older entries of the same millisecond; `q` is a case-insensitive substring of the SQL. History store `server` only. |
| `POST /api/query-library/history` `{sql, host_id, ran_at_ms, elapsed_ms, rows, status, error}` | no | 201 `{id, revision}`. Only `sql` is required; `ran_at_ms` defaults to now, `status` to `ok` (`canceled` is accepted as `cancelled`). History store `server` only. |
| `DELETE /api/query-library/history` | yes | Clears the history: `{ok, deleted, revision}`. |
| `DELETE /api/query-library/history/<id>` | yes | `{ok, id, revision}`. |
| `POST /api/query-library/folders` `{parent_id, name, description}` | yes | 201: the folder plus `revision`. |
| `PATCH /api/query-library/folders/<id>` `{name?, description?, parent_id?}` | yes | The folder plus `revision`. Setting `parent_id` moves the folder (`null` = root); moving a folder into itself or one of its subfolders answers 400 `reason: "cycle"`, and a move that would nest deeper than 8 levels 400 `reason: "depth"`. |
| `DELETE /api/query-library/folders/<id>?recursive=1` | yes | `{ok, id, deleted_folders, deleted_queries, revision}`. Without `recursive=1` a folder holding subfolders or queries answers 409 `{"error": "not_empty", "folders": <subfolders>, "queries": <direct queries>}`. |
| `POST /api/query-library/queries` `{folder_id, name, description, sql, host_id?, tags?}` | yes | 201: the query plus `revision`. |
| `PATCH /api/query-library/queries/<id>` `{name?, description?, sql?, folder_id?, host_id?, tags?}` | yes | The query plus `revision`; `folder_id` moves it. |
| `DELETE /api/query-library/queries/<id>` | yes | `{ok, id, revision}`. |
| `POST /api/query-library/import` `{folders, queries}` | yes | `{ok, imported_folders, merged_folders, imported_queries, skipped_queries, folder_ids, revision}`. |

A PATCH that changes nothing does not write the file and keeps the revision.

### Import

`POST /api/query-library/import` is meant to be called once, to move the browser's localStorage library into the server library. `folders` entries are `{id, parent_id, name, description}` where `id` / `parent_id` are the browser's ids; `queries` entries are `{folder_id, name, description, sql, host_id, tags, created_at_ms?, updated_at_ms?}` where `folder_id` refers to an imported folder id (or an existing server folder id; anything else means the root).

- Folders are imported parents first. A folder whose name (case-insensitive) already exists under the same parent is merged into the existing one (`merged_folders`). A parent cycle in the payload answers 400 `reason: "cycle"`.
- Queries are de-duplicated by name + SQL against the whole library and within the payload (`skipped_queries`); a ` (n)` suffix added by an earlier import does not count, so importing the same payload twice is a no-op. A query whose name is already used by a different query of the target folder is renamed `name (2)`, `name (3)`, ...
- `folder_ids` maps each imported folder id to its server id.
- The import is all-or-nothing: a validation error anywhere answers 400 (or 413) with the offending `field` (for example `queries[3].sql`) and nothing is written. When nothing is new, the file is not written and the revision does not change.

### Errors

Errors are JSON objects carrying `error` (and the same value in `error_code`, like the other ChDash APIs) plus `message`:

| Status | `error` | Extra fields |
| --- | --- | --- |
| 400 | `validation` | `field` (`name`, `parent_id`, `sql`, `tags[2]`, `queries[3].name`, `If-Match`, `limit`, `body`, ...) and `reason` (`required`, `type`, `too_long`, `invalid`, `duplicate`, `not_found`, `cycle`, `depth`, `invalid_json`, `range`) |
| 403 | `read_only` | `load_error` when the file failed to load |
| 403 | `cross_site_request` | |
| 404 | `not_found` | Unknown id; also every route when the feature is disabled (empty body) |
| 409 | `conflict` | `revision` |
| 409 | `not_empty` | `folders`, `queries`, `revision` |
| 413 | `too_large` | `field` (`sql`, `file`, `folders`, `queries`) |
| 415 | `unsupported_media_type` | |
| 500 | `storage_error` | The file could not be written; nothing changed |

## Tests

- `tests/native/query_library_test.cpp`: store unit tests (atomic write, tree rules, If-Match, history, read-only, malformed file and reload, import, size cap). Build the `chdash_query_library_test` target with `-DCHDASH_BUILD_QUERY_LIBRARY_TESTS=ON`; `tests/harness/test_query_library_contract.py` runs it when `QUERY_LIBRARY_TEST_BINARY` points at it.
- `tests/backend-functional/test_query_library.py`: HTTP tests against dedicated instances; see "Query library" in [`tests/README.md`](../tests/README.md).
- `tests/frontend/specs/query-library.spec.js`: the Query page panel in browser mode (migration, folders, save / edit / move, search, preview, keyboard, History), in server mode against a mocked API (If-Match and conflict retry, read-only, import, server History), on a phone and in both themes. Its last test runs against a real writable instance when `QUERY_LIBRARY_BASE_URL` names one (as the Playwright container reaches it).
