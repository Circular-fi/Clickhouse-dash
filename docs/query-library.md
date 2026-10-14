# Query library and history

The Query page keeps saved queries (in folders; a query has a name, a description and its SQL; a folder has a name and a place). It also keeps the history of the queries that it ran. Saved queries are in storages. All of them are top folders of one tree:

- **Local browser storage** is the localStorage of this browser. It is always there.
- **Shared server storage** is one JSON file on the ChDash server. Every user of the panel shares it. The page shows it when the optional `query_library` block is enabled. The server can have several of these files, each with its own name and its own read-only switch (see *Several libraries on the server*).

The history is always in the browser (IndexedDB). The browser never sends it to the server, and nobody shares it.

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
| `enabled` | `false` | `false`: the block is ignored. When no block is enabled, every `/api/query-library` route answers 404, and Saved shows the *Local browser storage* only. |
| `name` | `default` for the first library | The name of the library: its id in the API (`?library=`) and what the Query page shows. Any text of 1 to 128 bytes, spaces and accents included, with no control character and no space at either end. Only the first library may leave it out. Each name is different. |
| `file` | none | Required when enabled. The parent directory must exist. The dashboard creates the file on the first write. |
| `writable` | `false` | `false`: read-only library. Folder/query create, edit, move and delete, and import answer 403 `read_only`. |
| `max_file_bytes` | 8 MiB | Size cap of the file (64 KiB..1 GiB). A write that exceeds it answers 413 and nothing changes. |
| `max_query_bytes` | 256 KiB | SQL size cap of one saved query (1 KiB..`max_file_bytes`). Larger SQL answers 413. |

### Several libraries on the server

Repeat the `query_library` block: each enabled block is one more library, with its own name, file and `writable`. The page shows each of them as a top folder named after the library, in the order of the file, above *Local browser storage*. Use it to keep a shared library that everyone can change next to a read-only one that holds approved queries (a file that you maintain by hand or by a deployment).

```hcl
query_library {              # the first one is the default library of the API
  enabled  = true
  name     = "team"
  file     = "/var/lib/chdash/team.json"
  writable = true
}

query_library {
  enabled  = true
  name     = "runbooks"
  file     = "/var/lib/chdash/runbooks.json"
  writable = false
}
```

- A single block works as before: the same file, the same routes. A single library that keeps the name `default` shows as *Shared server storage*.
- Only the first library may leave out its `name` (it is then `default`). Names are different, and a file is never shared by two libraries (the start fails otherwise). A block with `enabled = false` is ignored.
- Each library has its own revision, its own limits (`max_file_bytes`, `max_query_bytes`) and its own load error. A library whose file cannot be read is read-only; the others are not affected.
- A read-only library shows a *Read-only* badge. Its queries can be opened, searched and exported (the folder menu saves a JSON file). Nothing in it can be changed, moved or removed, and nothing can be moved into it.
- Moving a query or a folder between two libraries works as between the browser and the server: the item is created in the target, then removed from the source. Both libraries must be writable.
- The routes are the same for every library; `?library=<name>` picks one (reads and writes). Without it, the first library answers.

A `history {}` block in `query_library` (`history.store`, `history.max_entries`, from earlier releases) is refused at startup. The message asks the user to delete it. A library file that an earlier release wrote keeps its `history` array. The dashboard drops this array on load:

- A writable library rewrites the file without the array. The log gives the count.
- A read-only library leaves the file as it is.

`/api/version` reports `features.query_library = {"enabled", "writable", "libraries"}`. `libraries` lists each library in the order of the file: `[{"name", "writable"}]`; the first is the default one. `writable` of a library is the effective state: it is false when `writable = false`, and also while the file has a load error. The `writable` of `query_library` itself is the one of the first library. With the feature disabled, it reports `{"enabled": false, "writable": false, "libraries": []}`.

## In the Query page

The book button of the Query toolbar opens the query library. It is between Format and the cog of the run settings. The library opens in the same modal dialog as *Run with profiling*. The dialog has the same size, close button, backdrop and tab style. It is full-screen on a phone. Its two tabs, **Saved** and **History**, are in the header of the dialog, where the profiling dialog has its title.

If History has no run, or a search has no match, the dialog shows one empty state. The empty state is centered across the dialog, without the preview pane. Saved with nothing saved has no screen of its own. It shows the usual tree of its storages (*Local browser storage*, and *Shared server storage* when enabled). Each storage shows *Empty*.

Both tabs have the same layout:

- A search is on top of the list. In Saved, the *New folder* icon button is at the right of the search.
- The list is below the search.
- A foot line is below the list. In Saved, it holds the count of queries and the host. Saving is not here: it is the floppy **Save** button of the editor.

The list on the left selects an item (with a click or the arrow keys). The pane on the right shows the selected item. The head of the pane is one line. It shows the title, then its meta, then the tools of the item as icon buttons. The meta is the *Updated ...* of a saved query or a folder, or the time and the status of a run. Each tool has its label as `aria-label` and as tooltip. The foot of the pane holds one action, **Load**, at the bottom right (while the pane shows the save form, it holds the form's buttons instead: see *Save*). You can also press Ctrl/Cmd+Enter in the list or in the pane. The action puts the SQL in the editor and closes the dialog. A click never loads a query by itself.

The highlighted SQL has its own copy button. It also has the line-number gutter of the editor when *Line numbers* is on in the editor options (`chdash.editor.line_numbers.enabled`). Its lines then scroll sideways. They do not wrap.

On a phone, the list and the preview are two steps. Tap a row to see its pane. A back button returns to the list. A twisty or an icon of a folder opens the folder, and the name of the folder shows its pane. The meta goes under the title there. On a touch screen, the icon tools are 40 px square.

- **Saved**: shows a tree, like the Explorer. These are the top folders of the tree: *Shared server storage* (when the server library is enabled), then *Local browser storage*. If the server library is off, only the browser storage shows. Each storage and each folder shows its count of queries (the queries under a folder, subfolders included), also while it is closed; an empty folder says *Empty*. A folder holds nested folders and saved queries. A saved query has a description. A folder has no description.
  - Every folder opens and closes in place. The chevron (the twisty) opens and closes it. A click on the row selects the folder and opens it when it is closed. A click on a folder that is already selected (the blue frame) and open closes it, as the chevron does; a click on an open folder that is not selected only selects it. With the keyboard, Right opens, Left closes, and Enter and Space open or close the folder. On a phone, a tap on the icon also does. The dashboard remembers the open state.
  - The search covers both storages. It searches names, descriptions and SQL. Each result names its storage and its folder.
  - The preview of a query shows its name and last update, its description and the highlighted SQL. It has no folder line, because the tree shows the folder.
  - The preview of a folder shows its path and its contents (the queries and subfolders under it), then lists what is directly in it: its subfolders first, each with its count of queries, then its queries with their description and last change. A click on an entry opens it in the tree. An empty folder says so.
  - The preview of a storage says where the storage is stored, then lists its top level the same way (*In this library*).
  - The *New folder* icon button creates the folder inside the highlighted folder or storage. The user types the name of the new folder in a row. Enter creates the folder. Escape drops it. The row refuses a duplicate name.
  - The user renames a folder in its row (F2, Rename).
  - Each row has a "..." menu. It shows on hover, on focus and on the highlighted row. A right click and Shift+F10 also open it. The menu has these items:
    - Load, or Open/Close for a folder (Enter).
    - Edit..., or Rename for a folder (F2). Edit shows the same form as Save in the right pane (no window over the dialog). It changes the name, the description and the folder of a query. It shows the SQL but does not change it: to replace the SQL, load the query, change it in the editor and press Ctrl/Cmd+S (*Update*).
    - Move to... (Ctrl/Cmd+M).
    - Export as JSON (a folder only, also in a read-only storage). It saves the folder and everything in it as a file named after the folder. The file has the body of `POST /api/query-library/import` (`host_id`, `folders`, `queries`). A copy-mode import can read it again.
    - Remove (Delete).

    The menu of a search result also has Show in folder.
  - Queries and folders also move by drag and drop (onto a folder or onto a storage row, and between the two storages).
  - One confirm dialog opens over the library before it removes an item (with everything in a folder).
- **Moving between the storages** (Move to..., drag and drop, or a folder change in Edit or Save) copies the item into the target storage. Then it removes the item from its source.
  - A query is created in the target.
  - A folder with everything in it is created in the browser at once. On the server, it is created with one all-or-nothing `POST /api/query-library/import` in copy mode (below).
  - The dashboard refuses a name that the target folder already holds. It does this before anything changes.
  - If the copy is in but the source cannot remove its item, the dashboard tells the user. The item is then in both storages.
- **Save** (the floppy *Save query* button in the corner of the editor, between the copy button and the options cog; Ctrl+S; or *Save to library...* of a run) opens no window over the dialog. The library opens (or stays open) on **Saved**, and the right pane shows the save form in place of the preview of the selection. The tree stays on the left and works as usual (search, open and close folders, the *New folder* button).
  - The form is labelled by its title (*Save to library*, or *Save "name"* when the editor holds a saved query). Its fields are **Name**, **Description** and **Folder**. Under them is the SQL that will be saved, with its label (*SQL (from the editor)*, *from History*, *formatting...*) and the **Formatted** switch, the same button as the one of a result's statement, left of the copy button of the SQL block (it is shown only when the formatter changes the text; a query that it leaves as it is has one text to save). The foot has **Cancel** and **Save**. When the editor holds a query that was opened from a storage that can be written, the foot has **Update** and **Save as new** instead (Update changes that query, Save as new creates another one). The keyboard focus moves to Name. Enter in Name saves. Ctrl/Cmd+Enter saves from any field of the form.
  - The query is saved as the formatter writes it. The **Formatted** switch, left of the copy button of the SQL, is pressed by default. When the user releases it, the text shown is the text as typed and the query is saved as typed. If the formatter does not accept the query, the switch is released and locked (its title says why) and the query is saved as typed.
  - The SQL is drawn like the preview of a query: with its line numbers (when the editor shows them) and a copy button.
  - The tree shows where the query will go: a dashed row (*New query*, then the typed name) in the folder of the **Folder** field, at the place its name sorts to. The folder opens for it. When an edited query moves, the row shows its new place.
  - **Folder** starts at the place that is selected in the tree (the folder of a selected query, the storage for a selected storage), or at the folder of the opened query when the form updates it. While the form is open, a click on a folder or a storage in the tree (or the arrow keys on it) sets the Folder field, so the user picks the target in the tree. The Folder list always offers every folder of both storages, as in the other pickers. A new folder made with the *New folder* button while the form is open is added to the list and chosen. The form keeps what the user typed when the tree is drawn again.
  - **Folder** is a folder picker, as in the open-source drives (Nextcloud, Google Drive, Dropbox). It reads as a path (*Team queries / Reports / Daily*, the last folder in bold). A click, or the Down arrow, opens a tree of the storages and their folders. A twisty opens a folder (Right and Left open and close it, and go to the first child and to the parent). Up, Down, Home and End move, and Enter or a click chooses and closes the tree. Escape closes only the tree; the form and the dialog stay. The places that were chosen last (at most three) come first under *Recent*, with their path. With 8 folders or more, a *Filter folders* box finds a folder by any part of its path and shows each result with where it is (Enter chooses the first). A read-only storage is shown locked (*Read-only*) and cannot be chosen. *Move to...* uses the same tree, always open.
  - A name that is empty, too long or already used in the folder, a description that is too long and a folder that cannot be used show their message under the field (`role="alert"`, the field has `aria-invalid`), and the focus goes to the field. Any other refusal (a conflict, a read-only storage, a failed request) shows its message above the buttons. The form stays open and nothing is lost. The guards of the library are the same as before: with no host, with a library that is read-only, and with an empty editor, no form opens and a toast says why.
  - **Escape** drops the form and shows the preview of the selection again, wherever the focus is in the dialog. A second Escape closes the dialog. The focus goes to the selected row. Closing the dialog, another host and a removed query (for Edit) also end the form. A second click on the editor's *Save query* button or Ctrl+S with the same form open only focuses it. If the user switches to **History**, the form stays and comes back with **Saved**.
  - After a save, the toast says *Query saved.* (or *Query updated.*), the tree opens the folder of the query and selects it, and the pane shows its normal preview.
  - On a phone, the form is the step of the pane. The back button of its head returns to the list and keeps the form (the editor's *Save query* brings it back). A tap on a folder or a query of the list sets the Folder and returns to the form. Cancel and Escape drop the form and show the list.
- **History**: shows the runs of the current host, grouped by day. Each run has the status (ok / error / cancelled), the elapsed time and the rows. There is a search.
  - The preview of a run has the SQL as its title, with its time and status beside it. Then it shows the elapsed time, the rows, the server error of a failed run and the SQL.
  - Its tool is *Save to library...*.
  - A run is kept formatted. The entry holds the text as typed (`sql_raw`) and the text of the formatter (`sql_formatted`, with `formatted: true`). When the query was not formatted at run time, the dashboard asks the formatter in the background and writes the answer into the entry. The same happens for older entries, when they are looked at: the dashboard formats an entry that has no formatted text when the user selects it (the preview then shows the formatted text, unless the user has already scrolled it), loads it or saves it. The list shows each query on one line and does not change. A script that the formatter does not accept stays as typed, and the dashboard does not ask for it again while the page lives.
  - The user cannot edit or remove a run in History. There is no *Clear history*. The browser keeps the 50 most recent runs of each host (and at most 2 MiB of SQL for each host), and older runs fall off. A busy host does not push out the runs of the others. The same SQL on the same host is one entry: it moves to the top.
  - A text longer than 256K characters is stored cut. The entry has `truncated: true`, and the preview says *Cut at 262,144 characters*, so that *Load* does not hide that the text is shorter.
- The folder pickers (the Folder field of Save and Edit, and the Move dialog) list each storage as a group. Each folder is written in the same way as in the preview: `/` for its top level, then `/Operations`, `/Operations/Merges`. The group of a read-only storage is disabled.
- A switch of the host in the header shows the storages and the History of that host at once. This is also true while the dialog is open.

Ctrl/Cmd+S opens the save form (above) for the editor. It saves into one of the storages (the server storage by default when it is writable). It can also update the saved query that the editor holds.

The library is fully keyboard driven. The focus moves into the dialog and stays there. These keys work:

- Arrows, Home / End and type-ahead select a row in the list.
- Left / Right close and open folders and storages.
- Enter loads a query, or opens and closes a folder.
- Ctrl/Cmd+Enter loads the query.
- F2 edits a query or renames a folder.
- Delete removes the item after the confirm.
- Ctrl/Cmd+M moves the item.
- Space opens or closes a folder.
- `/` goes to the search.
- Escape (or a click on the backdrop) closes the dialog. The focus returns to the book button.

| Storage | Where | Editing |
| --- | --- | --- |
| *Local browser storage* | `localStorage["chdash.queryLibrary.v2"]` (each folder and query carries its `host_id`) | always |
| *Shared server storage* (`enabled = true`) | the server file through `/api/query-library?host_id=` | when `writable = true` |
| *Shared server storage*, `writable = false` | the same, with a *Read-only* badge on the storage | none: no change actions on its items, no drag, its picker group disabled; the browser storage stays editable |

The History is the IndexedDB database `chdash`, store `queryHistory` (each entry carries its `host_id`). This does not depend on what the server library does.

- A run writes its own record: one write when it starts, and one for its outcome (and one when the formatter answers). The dashboard never reads and writes the whole list for a run. It reads the list of a host once for each page, and again when another tab has written (a `BroadcastChannel` tells it).
- A write that the browser refuses (the quota is full) shows a warning at the bottom of the page: *History could not be saved: the browser storage is full*. A click closes it. The run itself is not affected. When the browser has no IndexedDB (or blocks it), the runs stay in the page for this session, and the dashboard says so once.
- The older list, `localStorage["chdash.queryHistory.v1"]`, moves into the database the first time a page loads, and the dashboard removes the key. The entries without a host do not move.
- The metadata catalogue (`chdash.meta.v1.<host>.<type>`) is a cache in localStorage. It keeps at most two hosts (the least recently used one loses its keys), and it stores the empty fields and the false flags of its items in a compact form. When the browser refuses a write of the *Local browser storage*, the dashboard removes this cache first and tries again.

On the server, every change of a folder or a query sends `If-Match: <revision>`. After a 409 conflict, the library reloads and retries once. Then it tells the user. The former one-time *Import my browser queries* offer is gone, because both storages are browsable and a move copies between them. The dashboard removes its stored state (`chdash.queryLibrary.importOffer.v1`).

### Entries without a host

Entries without a host do not exist any more. The dashboard drops them.

- **Server, writable file**: the dashboard removes the folders and saved queries without a `host_id` when it loads the file (at startup, or after an external edit). It rewrites the file atomically as version 2 (see [File format](#file-format)). A query or folder that was inside a removed folder moves to the top level of its own host. The log says what the dashboard dropped (counts only, never SQL).
- **Server, read-only (`writable = false`)**: the dashboard ignores the same entries in memory. It never rewrites the file.
- **Server, malformed file**: this is a load error as before (read-only, served empty or from the last good copy). The dashboard never rewrites the file.
- **Browser**: on the first load, the dashboard removes the folders and queries without a host from `chdash.queryLibrary.v2`. It does not move the history entries without a host from `chdash.queryHistory.v1` into the database. The dashboard no longer reads or imports the old flat list `chdash.savedQueries.v1` (its entries have no folder and often no host).

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

ChDash has no end-user authentication (see the authorization model in [`configuration.md`](configuration.md)). Everyone who can reach the panel can read the library. When `writable = true`, they can also edit it. The library is persistent. For this reason, the mutating routes refuse the requests that a third-party page can make through the browser of a user. This is the guard of every write of ChDash ([operations.md](operations.md#the-guard-of-the-writes)):

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
    {"id": "f_3c1d...", "host_id": "local", "parent_id": null, "name": "Operations", "created_at_ms": 1790000000000, "updated_at_ms": 1790000000000}
  ],
  "queries": [
    {"id": "q_9a0b...", "folder_id": "f_3c1d...", "name": "Active parts", "description": "", "sql": "SELECT ...", "host_id": "local", "created_at_ms": 1790000000000, "updated_at_ms": 1790000000000}
  ]
}
```

- `version` is `2`. The dashboard migrates a version `1` file on load (below). Any other version is a load error. `revision` is the library revision (see below). Earlier releases kept the history in a `history` array. The dashboard ignores this array, and the next write drops it.
- `host_id` is required on every folder and query. A folder lives in a folder of its own host, and a query lives in a folder of its own host. Anything else is a load error. The dashboard keeps host ids that are no longer configured, because the host can come back. But nobody can read them until the host is back.
- **Migration from version 1.** Version 1 had no `host_id` on folders, and `host_id` was optional on queries. On load, the dashboard drops every entry without a `host_id` (so every version-1 folder). A query or folder whose folder was dropped moves to the top level of its host. A writable library rewrites the file as version 2 at once (atomically, and the revision is kept). A read-only library serves the migrated library from memory and leaves the file as it is. The same applies to a version-2 file that holds entries without a host.
- The server generates the ids (`f_`, `q_` + 16 hex digits). A file that you write by hand can use any unique string of at most 128 bytes.
- `parent_id` / `folder_id` are `null` for the top level of the host. Folders nest at most 8 levels deep. A name has 1..256 bytes, is trimmed, and has no control characters. A name is unique among siblings, case-insensitively (ASCII). The siblings are the subfolders of one folder (or of the top level of the host), and the queries of one folder.
- The `description` of a query is at most 16 KiB. A folder has a name and a place only. A file of an earlier release can still hold folder `description` fields or query `tags`. The dashboard reads the file and ignores these fields. The next write drops them. A request that still sends them is not refused: the dashboard ignores them.
- The dashboard ignores unknown fields. The next write does not preserve them.

To pre-seed a read-only library, write such a file by hand (for example from an exported writable library). Then point a `writable = false` deployment at it.

## REST API

All bodies are JSON. Every mutating request accepts `If-Match: <revision>` (`42`, `"42"`, `W/"42"` and `*` are understood). On a mismatch, the request answers 409 `{"error_code": "conflict", "revision": <current>, ...}`, so that the UI can reload. Mutation responses carry the new `revision`.

Every route takes `?library=<name>` (the `name` of a `query_library` block) to pick the library. Without it the first one answers. A name that no library has answers 404 `unknown_library`.

`host_id` is required where the table names it. It must name a configured host. If it is missing, the request answers 400 `reason: "required"`. If it is unknown, the request answers 400 `reason: "unknown_host"` (both with `field: "host_id"`). Requests by id (`PATCH`, `DELETE .../<id>`) act on the own host of the entity. A move into a folder of another host answers 400 `reason: "host_mismatch"` and changes nothing. A `host_id` in a PATCH that is not the host of the entity answers in the same way.

The library revision is one for the whole file (every host). It changes with every change of a folder or a query, and with an external edit of the file. Running queries never changes it.

| Route | Writable only | Result |
| --- | --- | --- |
| `GET /api/query-library?host_id=` | | One **page** of the tree, never more than 100 items (`limit` can lower it): `{host_id, revision, updated_at_ms, writable, load_error, limits, parent_id, depth, complete, next_cursor, level_total, totals, folders, queries}`. See *Reads in pages* below. |
| `GET /api/query-library/queries/<id>?host_id=` | | One query, whole: `{id, folder_id, name, description, sql, host_id, created_at_ms, updated_at_ms, revision, ancestors, path}` (`ancestors`: the ids of the folders above it, from the top level). 404 `not_found` for a query of another host. |
| `GET /api/query-library/search?host_id=&q=` | | The queries whose name, description, SQL or folder path hold every word of `q` (without the case), at most 100: `{host_id, revision, total, truncated, results: [{id, folder_id, name, updated_at_ms, path}]}`. |
| `GET /api/query-library/export?host_id=[&folder_id=]` | | The whole library of the host (or one folder with everything under it) with the SQL: `{..., folders, queries}` as the library file holds them. It is what a backup reads and what a move to another storage copies. |
| `POST /api/query-library/folders` `{host_id, parent_id, name}` | yes | 201: the folder plus `revision`. `parent_id` is a folder of the same host. |
| `PATCH /api/query-library/folders/<id>` `{name?, parent_id?}` | yes | The folder plus `revision`. Setting `parent_id` moves the folder (`null` = the top level of its host). A move of a folder into itself or into one of its subfolders answers 400 `reason: "cycle"`. A move that nests deeper than 8 levels answers 400 `reason: "depth"`. A move into a folder of another host answers 400 `reason: "host_mismatch"`. |
| `DELETE /api/query-library/folders/<id>?recursive=1` | yes | `{ok, id, deleted_folders, deleted_queries, revision}`. Without `recursive=1`, a folder that holds subfolders or queries answers 409 `{"error_code": "not_empty", "folders": <subfolders>, "queries": <direct queries>, ...}`. |
| `POST /api/query-library/queries` `{host_id, folder_id, name, description, sql}` | yes | 201: the query plus `revision`. `folder_id` is a folder of the same host. |
| `PATCH /api/query-library/queries/<id>` `{name?, description?, sql?, folder_id?}` | yes | The query plus `revision`. `folder_id` moves it, within its host (400 `reason: "host_mismatch"` otherwise). |
| `DELETE /api/query-library/queries/<id>` | yes | `{ok, id, revision}`. |
| `POST /api/query-library/import` `{host_id, folders, queries, copy?}` | yes | `{ok, imported_folders, merged_folders, imported_queries, skipped_queries, folder_ids, revision}`. |

A PATCH that changes nothing does not write the file. It keeps the revision.

### Reads in pages

The Query page does not load the library: a library can hold thousands of queries, and most of them are never opened. `GET /api/query-library` answers one page, and the SQL of a query is read when the query is opened.

- **The first level** is the children of `parent_id` (a folder; without it, the top level of the host): the folders first, then the queries, each by name. A folder has `query_count` (the queries under it, subfolders included), `child_count` (its direct children), `subfolder_count`, and `loaded`; a query has `id`, `folder_id`, `name` and `updated_at_ms`. **No SQL and no description** are in a page.
- **Levels deeper** are added while the page stays within 100 items: a library of 100 items or fewer comes whole in one answer. With 104 items the deepest levels are left out until the number fits: the page keeps the levels that fit, and a folder whose children are not in the page has `loaded: false`. `depth` is how many levels came below the first one, and `complete` is true when nothing is left to read.
- **A first level larger than a page** comes in windows: the answer holds the first 100 items and `next_cursor`; the next call is the same with `cursor=<next_cursor>`, until `next_cursor` is `null`. `level_total` is the size of the level.
- `totals` is the whole library of the host (`folders`, `queries`) and the queries under the parent (`parent_queries`), so that the page shows the counts before anything is read.
- A folder with `loaded: false` is read with `GET /api/query-library?parent_id=<its id>`, the same way (its children, as many levels as fit, windows when it is large).

The Query page reads a folder when it is opened (the counts are already on the row), reads the next window on *Show more*, reads one query when it is selected or loaded (`GET /queries/<id>`), and asks the server to search. A change (create, edit, move, remove) reloads the top level and the folders that are open.

### Import

`POST /api/query-library/import` brings folders and queries of the library of the browser into the server library of the host of the request. The page uses it in copy mode to move a folder from the storage of the browser into the storage of the server. Everything that the request imports belongs to the `host_id` of the request (the current host). The dashboard ignores a `host_id` on an imported query.

- `folders` entries are `{id, parent_id, name}`. `id` and `parent_id` are the ids of the browser.
- `queries` entries are `{folder_id, name, description, sql, created_at_ms?, updated_at_ms?}`. `folder_id` refers to an imported folder id, or to an existing server folder id of the same host. Anything else means the top level.

These rules apply to the import:

- The backend imports folders with the parents first. A folder whose name (case-insensitive) already exists under the same parent of the same host is merged into the existing folder (`merged_folders`). A parent cycle in the payload answers 400 `reason: "cycle"`.
- The backend de-duplicates queries by name + SQL against the library of the host and within the payload (`skipped_queries`). A ` (n)` suffix that an earlier import added does not count. For this reason, an import of the same payload twice does nothing. If a different query of the target folder already uses the name of a query, the backend renames it `name (2)`, `name (3)`, ...
- `folder_ids` maps each imported folder id to its server id.
- The import is all-or-nothing. A validation error anywhere answers 400 (or 413) with the `field` that caused it (for example `queries[3].sql`). Nothing is written. When nothing is new, the backend does not write the file, and the revision does not change.
- **Copy mode** (`"copy": true`, a boolean) is a copy, not a merge. A folder whose `parent_id` names an existing server folder of the host goes under it. The backend does not merge, de-duplicate or rename anything. A folder or query whose name its target already holds answers 400 `reason: "duplicate"`. Nothing is written. `folder_ids` maps the copied folders to their server ids.

### Errors

Errors have the body of every ChDash error (`error_code`, `message`, `retryable`; [operations.md](operations.md#errors)) and these codes:

| Status | `error_code` | Extra fields |
| --- | --- | --- |
| 400 | `validation` | `field` (`host_id`, `name`, `parent_id`, `folder_id`, `sql`, `queries[3].name`, `If-Match`, `limit`, `body`, ...) and `reason` (`required`, `type`, `too_long`, `invalid`, `duplicate`, `not_found`, `unknown_host`, `host_mismatch`, `cycle`, `depth`, `invalid_json`, `range`) |
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

  Build the `chdash_query_library_test` target with `-DCHDASH_BUILD_QUERY_LIBRARY_TESTS=ON`. `tests/harness/test_native_unit_tests.py` runs it when `QUERY_LIBRARY_TEST_BINARY` points at it.
- `tests/backend-functional/test_query_library.py`: HTTP tests against dedicated instances. Refer to "Query library" in [`tests/README.md`](../tests/README.md).
- `tests/frontend/specs/query-library.spec.js`: tests of the library dialog of the Query page. The dialog uses the shared modal of the profiling dialog: shell, geometry, focus, Escape and backdrop, and the confirms and prompts (Move, Remove) stacked over it. The spec runs on a phone and in both themes. It has these parts:
  - It tests the browser storage alone. It covers these items:
    - The purge of entries without a host.
    - Folders named and renamed in their row, moved and removed.
    - Save / edit / move. Save and Edit are the form of the right pane: no stacked dialog, the Folder that follows the tree, Escape in two steps, the errors under the fields, update and *Save as new*, a read-only storage, the phone.
    - `/` paths in the pickers.
    - Search and Show in folder.
    - The menu of a row and the right click.
    - The one line of the head and the icon tools.
    - No Folder line.
    - The line-number gutter on and off.
    - The editor's floppy *Save query* button (beside the copy button, disabled while the editor is empty), and the *Load* action alone in the pane.
    - The keyboard.
    - History without *Clear history* and without any removal.
    - A host switch.
  - It tests both storages against a mocked API. It covers these items:
    - The two storages and their pickers.
    - Moves across them in both directions.
    - host_id on every request.
    - A host switch.
    - `host_mismatch`.
    - If-Match and conflict retry.
    - A read-only server storage.
    - The History that stays in the browser with no request about it.
  - Its live test runs against a real writable instance when `QUERY_LIBRARY_BASE_URL` names one (as the Playwright container reaches it). It covers both roots.
