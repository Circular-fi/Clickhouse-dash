# Query library and history

The Query page keeps saved queries (in folders, with descriptions and tags). It also keeps the history of the queries that it ran. Saved queries are in two root folders that the user can browse side by side:

- **Local browser storage** is the localStorage of this browser. It is always there.
- **Shared server storage** is one JSON file on the ChDash server. Every user of the panel shares it. The page shows it when the optional `query_library` block is enabled.

The history is always in the browser (`localStorage`). The browser never sends it to the server, and nobody shares it.

**Saved queries and history are per host.** Every folder, saved query and history entry belongs to one ClickHouse host. The host is the `name` of a `clickhouse.host` block, and its identifier is `host_id`. The library shows only the folders, queries and history of the host that the user selects in the header. It follows a host switch at once. A run is recorded in the history of the host where it ran. In server mode, every read names its host (`?host_id=`) and every write has the stamp of that host. Nothing moves from one host to another.

```hcl
query_library {
  enabled  = true
  file     = "/var/lib/chdash/query_library.json"
  writable = true

  max_file_bytes  = 8388608
  max_query_bytes = 262144
}
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | `false`: every `/api/query-library` route answers 404. Saved shows the *Local browser storage* root only. |
| `file` | none | Required when enabled. The parent directory must exist. The dashboard creates the file on the first write. |
| `writable` | `false` | `false`: read-only library. Folder/query create, edit, move and delete, and import answer 403 `read_only`. |
| `max_file_bytes` | 8 MiB | Size cap of the file (64 KiB..1 GiB). A write that exceeds it answers 413 and nothing changes. |
| `max_query_bytes` | 256 KiB | SQL size cap of one saved query (1 KiB..`max_file_bytes`). Larger SQL answers 413. |

A `history {}` block in `query_library` (`history.store`, `history.max_entries`, from earlier releases) is refused at startup. The message asks the user to delete it. A library file that an earlier release wrote keeps its `history` array. The dashboard drops this array on load:

- A writable library rewrites the file without the array. The log gives the count.
- A read-only library leaves the file as it is.

`/api/version` reports `features.query_library = {"enabled", "writable"}`. `writable` is the effective state. It is false when `writable = false`. It is also false while the file has a load error. With the feature disabled, it reports `{"enabled": false, "writable": false}`.

## In the Query page

The book button of the Query toolbar opens the query library. It is between Format and the cog of the run settings. The library opens in the same modal dialog as *Run with profiling*. The dialog has the same size, close button, backdrop and tab style. It is full-screen on a phone. Its two tabs, **Saved** and **History**, are in the header of the dialog, where the profiling dialog has its title.

If History has no run, or a search has no match, the dialog shows one empty state. The empty state is centred across the dialog, without the preview pane. Saved with nothing saved has no screen of its own. It shows the usual tree of its roots (*Local browser storage*, and *Shared server storage* when enabled). Each root shows *Empty*.

Both tabs work in the same way and have the same layout:

- A search is on top of the list. Saved adds *New folder* and *Save the editor query* at the right end of it.
- The list is below the search.
- A foot line shows the count and the host.

The list on the left only selects an item (with a click or the arrow keys). The pane on the right shows the selected item with **every action it has**. The list has no item menu. There is no ... button and no right-click menu.

The pane has a head and a foot:

- The head is one line. It shows the title, then its meta, then the tools of the item as icon buttons. The meta is the *Updated ...* of a saved query or a folder, or the time and the status of a run. Each tool has its label as `aria-label` and as tooltip. The tools are at the right end.
- The foot holds one action, **Load in editor**, at the bottom right. You can also press Ctrl/Cmd+Enter in the list or in the pane. The action puts the SQL in the editor and closes the dialog. A click never loads a query by itself.

The highlighted SQL has its own copy button. It also has the line-number gutter of the editor when *Line numbers* is on in the editor options (`chdash.editor.line_numbers.enabled`). Its lines then scroll sideways. They do not wrap.

On a phone, the list and the preview are two steps. Tap an item to see its preview and its actions. A back button returns to the list. A twisty or an icon of a folder opens it, and the name of the folder opens its preview. The meta goes under the title there. On a touch screen, the icon tools are 40 px square.

- **Saved**: shows the two roots of the current host. They are *Shared server storage* (when the server library is enabled) and then *Local browser storage*. Each root is a folder tree (nested folders, and saved queries with a description and tags) with its count of queries. A root opens and closes like a folder, and the dashboard remembers the state.
  - The search covers both roots. It searches names, descriptions, tags and SQL. Each result names its root and its folder.
  - The preview of a query shows its name and last update, its description, its tags and the highlighted SQL. It has no folder line, because the tree shows the folder. Its tools are *Edit*, *Move to...* and *Remove*.
  - The preview of a folder shows its path and its contents. Its tools are *Rename*, *Move to...*, *New subfolder* and *Remove*.
  - The preview of a root says where the root is stored. Its tool is *New folder*.
  - Queries and folders also move by drag and drop (onto a folder or onto a root).
  - A confirm dialog opens over the library before it removes a query or a folder (with everything in it).
- **Moving between the roots** (Move to..., drag and drop, or a folder change in Edit or Save) copies the item into the target root. Then it removes the item from its source.
  - A query is created in the target.
  - A folder with everything in it is created in the browser at once. On the server, it is created with one all-or-nothing `POST /api/query-library/import` in copy mode (below).
  - The dashboard refuses a name that the target folder already holds. It does this before anything changes.
  - If the copy is in but the source cannot remove its item, the dashboard tells the user. The item is then in both roots.
- **History**: shows the runs of the current host, grouped by day. Each run has the status (ok / error / cancelled), the elapsed time and the rows. There is a search.
  - The preview of a run has the SQL as its title, with its time and status beside it. Then it shows the elapsed time, the rows, the server error of a failed run and the SQL.
  - Its tools are *Save to library...* and *Remove from History*.
  - There is no *Clear history*. The user removes the runs one by one.
- The folder pickers (Save, Edit, Move, New folder) list each root as a group. Each folder is written in the same way as in the preview: `/` for its top level, then `/Operations`, `/Operations/Merges`. The group of a read-only root is disabled.
- A switch of the host in the header shows the roots and the History of that host at once. This is also true while the dialog is open.

Ctrl/Cmd+S saves the editor into one of the roots (the server root by default when it is writable). It can also update the saved query that the editor holds.

The library is fully keyboard driven. The focus moves into the dialog and stays there. These keys work:

- Arrows, Home / End and type-ahead select an item in the list.
- Left / Right collapse and expand folders and roots.
- Enter moves to the preview (its *Load in editor* button, or the first tool of a folder).
- Ctrl/Cmd+Enter loads the query.
- F2 edits a query or renames a folder.
- Delete removes the item after the confirm. In History, it removes the run.
- Ctrl/Cmd+M moves the item.
- `/` goes to the search.
- Escape (or a click on the backdrop) closes the dialog. The focus returns to the book button.

| Root | Where | Editing |
| --- | --- | --- |
| *Local browser storage* | `localStorage["chdash.queryLibrary.v2"]` (each folder and query carries its `host_id`) | always |
| *Shared server storage* (`enabled = true`) | the server file through `/api/query-library?host_id=` | when `writable = true` |
| *Shared server storage*, `writable = false` | the same, with a *Read-only* badge on the root | none: no tools on its items, no drag, its picker group disabled; the browser root stays editable |

The History is `localStorage["chdash.queryHistory.v1"]` (each entry carries its `host_id`). This does not depend on what the server library does.

On the server, every change of a folder or a query sends `If-Match: <revision>`. After a 409 conflict, the library reloads and retries once. Then it tells the user. The former one-time *Import my browser queries* offer is gone, because both roots are browsable and a move copies between them. The dashboard removes its stored state (`chdash.queryLibrary.importOffer.v1`).

### Entries without a host

Entries without a host do not exist any more. The dashboard drops them.

- **Server, writable file**: the dashboard removes the folders and saved queries without a `host_id` when it loads the file (at startup, or after an external edit). It rewrites the file atomically as version 2 (see [File format](#file-format)). A query or folder that was inside a removed folder moves to the top level of its own host. The log says what the dashboard dropped (counts only, never SQL).
- **Server, read-only (`writable = false`)**: the dashboard ignores the same entries in memory. It never rewrites the file.
- **Server, malformed file**: this is a load error as before (read-only, served empty or from the last good copy). The dashboard never rewrites the file.
- **Browser**: on the first load, the dashboard removes the folders and queries without a host from `chdash.queryLibrary.v2`. It removes the history entries without a host from `chdash.queryHistory.v1`. The dashboard no longer reads or imports the old flat list `chdash.savedQueries.v1` (its entries have no folder and often no host).

The page address follows the editor. It is `?saved=<id>` while the editor holds a library query without change. Otherwise, it is `?sql=<text>` of the last run (up to 4,000 characters). When the user opens the link in a new tab, the link fills the editor.

## Storage

- One process owns the file. The library is kept in memory behind a mutex. Every request first compares the stat of the file (device, inode, size, mtime) with the last stat that it saw. The backend reloads an external change before it serves the request or applies a mutation. The revision moves forward. Editors that hold the old revision then get a 409.
- Writes are atomic. The backend writes the new document to a temporary file in the same directory (`.<name>.tmp-<pid>-<random>`, created with `O_EXCL`, `O_NOFOLLOW`, mode 0600). It does fsync on the file, renames it over the file, and does fsync on the directory. A failed write leaves the previous file untouched. It removes the temporary file and answers 500 `storage_error`.
- The backend never overwrites a file that has one of these faults:
  - It is not valid JSON.
  - It has an unsupported `version`.
  - It is over `max_file_bytes`.
  - It is structurally inconsistent (duplicate ids, unknown parents or folders, a parent cycle, wrong types).

  The backend logs the error once. It serves the library read-only (empty at startup, or the last good copy) with `load_error` set. Mutations answer 403 `read_only`. The backend reloads the file as soon as it changes on disk.
- The feature never runs SQL. It stores the saved SQL and returns it verbatim. No request value ever reaches the filesystem. The only path is the configured `file`. Request ids are only looked up in memory. Logs never contain SQL.

## Security

ChDash has no end-user authentication (see the authorization model in [`configuration.md`](configuration.md)). Everyone who can reach the panel can read the library. When `writable = true`, they can also edit it. The library is persistent. For this reason, the mutating routes also refuse the requests that a third-party page can make through the browser of a user:

- `Sec-Fetch-Site` must be absent, `same-origin` or `none` (403 `cross_site_request` otherwise).
- Without `Sec-Fetch-Site`, an `Origin` header must match the `Host` or the `X-Forwarded-Host` of the request (403 `cross_site_request`).
- A request body must have `Content-Type: application/json` (415 `unsupported_media_type`). A cross-origin page cannot do this without a CORS preflight, and ChDash never grants it.

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
  ]
}
```

- `version` is `2`. The dashboard migrates a version `1` file on load (below). Any other version is a load error. `revision` is the library revision (see below). Earlier releases kept the history in a `history` array. The dashboard ignores this array, and the next write drops it.
- `host_id` is required on every folder and query. A folder lives in a folder of its own host, and a query lives in a folder of its own host. Anything else is a load error. The dashboard keeps host ids that are no longer configured, because the host can come back. But nobody can read them until the host is back.
- **Migration from version 1.** Version 1 had no `host_id` on folders, and `host_id` was optional on queries. On load, the dashboard drops every entry without a `host_id` (so every version-1 folder). A query or folder whose folder was dropped moves to the top level of its host. A writable library rewrites the file as version 2 at once (atomically, and the revision is kept). A read-only library serves the migrated library from memory and leaves the file as it is. The same applies to a version-2 file that holds entries without a host.
- The server generates the ids (`f_`, `q_` + 16 hex digits). A file that you write by hand can use any unique string of at most 128 bytes.
- `parent_id` / `folder_id` are `null` for the top level of the host. Folders nest at most 8 levels deep. A name has 1..256 bytes, is trimmed, and has no control characters. A name is unique among siblings, case-insensitively (ASCII). The siblings are the subfolders of one folder (or of the top level of the host), and the queries of one folder.
- `description` is at most 16 KiB. `tags` holds at most 32 distinct (case-insensitive) tags of 1..64 bytes.
- The dashboard ignores unknown fields. The next write does not preserve them.

To pre-seed a read-only library, write such a file by hand (for example from an exported writable library). Then point a `writable = false` deployment at it.

## REST API

All bodies are JSON. Every mutating request accepts `If-Match: <revision>` (`42`, `"42"`, `W/"42"` and `*` are understood). On a mismatch, the request answers 409 `{"error": "conflict", "revision": <current>}`, so that the UI can reload. Mutation responses carry the new `revision`.

`host_id` is required where the table names it. It must name a configured host. If it is missing, the request answers 400 `reason: "required"`. If it is unknown, the request answers 400 `reason: "unknown_host"` (both with `field: "host_id"`). Requests by id (`PATCH`, `DELETE .../<id>`) act on the own host of the entity. A move into a folder of another host answers 400 `reason: "host_mismatch"` and changes nothing. A `host_id` in a PATCH that is not the host of the entity answers in the same way.

The library revision is one for the whole file (every host). It changes with every change of a folder or a query, and with an external edit of the file. Running queries never changes it.

| Route | Writable only | Result |
| --- | --- | --- |
| `GET /api/query-library?host_id=` | | `{host_id, revision, updated_at_ms, writable, load_error, limits, folders, queries}`: the folders and queries of that host (queries include `sql`). `load_error` is `null` or the reason the file could not be loaded. `limits` holds `max_query_bytes`, `max_file_bytes`, `max_folder_depth`, `max_name_bytes`, `max_description_bytes`. |
| `POST /api/query-library/folders` `{host_id, parent_id, name, description}` | yes | 201: the folder plus `revision`. `parent_id` is a folder of the same host. |
| `PATCH /api/query-library/folders/<id>` `{name?, description?, parent_id?}` | yes | The folder plus `revision`. Setting `parent_id` moves the folder (`null` = the top level of its host). A move of a folder into itself or into one of its subfolders answers 400 `reason: "cycle"`. A move that nests deeper than 8 levels answers 400 `reason: "depth"`. A move into a folder of another host answers 400 `reason: "host_mismatch"`. |
| `DELETE /api/query-library/folders/<id>?recursive=1` | yes | `{ok, id, deleted_folders, deleted_queries, revision}`. Without `recursive=1`, a folder that holds subfolders or queries answers 409 `{"error": "not_empty", "folders": <subfolders>, "queries": <direct queries>}`. |
| `POST /api/query-library/queries` `{host_id, folder_id, name, description, sql, tags?}` | yes | 201: the query plus `revision`. `folder_id` is a folder of the same host. |
| `PATCH /api/query-library/queries/<id>` `{name?, description?, sql?, folder_id?, tags?}` | yes | The query plus `revision`. `folder_id` moves it, within its host (400 `reason: "host_mismatch"` otherwise). |
| `DELETE /api/query-library/queries/<id>` | yes | `{ok, id, revision}`. |
| `POST /api/query-library/import` `{host_id, folders, queries, copy?}` | yes | `{ok, imported_folders, merged_folders, imported_queries, skipped_queries, folder_ids, revision}`. |

A PATCH that changes nothing does not write the file. It keeps the revision.

### Import

`POST /api/query-library/import` brings folders and queries of the library of the browser into the server library of the host of the request. The page uses it in copy mode to move a folder from the root of the browser into the root of the server. Everything that the request imports belongs to the `host_id` of the request (the current host). The dashboard ignores a `host_id` on an imported query.

- `folders` entries are `{id, parent_id, name, description}`. `id` and `parent_id` are the ids of the browser.
- `queries` entries are `{folder_id, name, description, sql, tags, created_at_ms?, updated_at_ms?}`. `folder_id` refers to an imported folder id, or to an existing server folder id of the same host. Anything else means the top level.

These rules apply to the import:

- The backend imports folders with the parents first. A folder whose name (case-insensitive) already exists under the same parent of the same host is merged into the existing folder (`merged_folders`). A parent cycle in the payload answers 400 `reason: "cycle"`.
- The backend de-duplicates queries by name + SQL against the library of the host and within the payload (`skipped_queries`). A ` (n)` suffix that an earlier import added does not count. For this reason, an import of the same payload twice does nothing. If a different query of the target folder already uses the name of a query, the backend renames it `name (2)`, `name (3)`, ...
- `folder_ids` maps each imported folder id to its server id.
- The import is all-or-nothing. A validation error anywhere answers 400 (or 413) with the `field` that caused it (for example `queries[3].sql`). Nothing is written. When nothing is new, the backend does not write the file, and the revision does not change.
- **Copy mode** (`"copy": true`, a boolean) is a copy, not a merge. A folder whose `parent_id` names an existing server folder of the host goes under it. The backend does not merge, de-duplicate or rename anything. A folder or query whose name its target already holds answers 400 `reason: "duplicate"`. Nothing is written. `folder_ids` maps the copied folders to their server ids.

### Errors

Errors are JSON objects that carry `error` (and the same value in `error_code`, like the other ChDash APIs) and `message`:

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

- `tests/native/query_library_test.cpp`: unit tests of the store. They cover these cases:
  - Atomic write.
  - Tree rules.
  - If-Match.
  - Read-only.
  - Malformed file and reload.
  - Import.
  - Size cap.
  - Reads and writes for each host.
  - `host_mismatch`.
  - The migration from version 1 to 2 on a writable file and on a read-only file.

  Build the `chdash_query_library_test` target with `-DCHDASH_BUILD_QUERY_LIBRARY_TESTS=ON`. `tests/harness/test_query_library_contract.py` runs it when `QUERY_LIBRARY_TEST_BINARY` points at it.
- `tests/backend-functional/test_query_library.py`: HTTP tests against dedicated instances. Refer to "Query library" in [`tests/README.md`](../tests/README.md).
- `tests/frontend/specs/query-library.spec.js`: tests of the library dialog of the Query page. The dialog uses the shared modal of the profiling dialog: shell, geometry, focus, Escape and backdrop, and stacked confirms. The spec runs on a phone and in both themes. It has these parts:
  - It tests the browser root alone. It covers these items:
    - The purge of entries without a host.
    - Folders.
    - Save / edit / move.
    - `/` paths in the pickers.
    - Search.
    - Every action from the preview pane, and none on the list.
    - The one line of the head and the icon tools.
    - No Folder line.
    - The line-number gutter on and off.
    - The *Load in editor* action alone in the foot.
    - The keyboard.
    - History without *Clear history*.
    - A host switch.
  - It tests both roots against a mocked API. It covers these items:
    - The two roots and their pickers.
    - Moves across them in both directions.
    - host_id on every request.
    - A host switch.
    - `host_mismatch`.
    - If-Match and conflict retry.
    - A read-only server root.
    - The History that stays in the browser with no request about it.
  - Its live test runs against a real writable instance when `QUERY_LIBRARY_BASE_URL` names one (as the Playwright container reaches it). It covers both roots.
