# Query library and history

The Query page stores saved queries in folders. A query has a name, a description and its SQL. A folder has a name and a place. The page also stores the history of the queries that it ran. Saved queries are in storages. All storages are top folders of one tree:

- **Local browser storage** is the localStorage of this browser. It is always present.
- **Shared server storage** is one JSON file on the ChDash server. All users of the panel share it. The page shows it when the optional `query_library` block is enabled. The server can have several of these files. Each file has its own name and its own read-only switch (see *Several libraries on the server*).

The history is always in the browser (IndexedDB). The browser never sends it to the server. Nobody shares it.

**Saved queries and history are per host.** Each folder, saved query and history entry belongs to one ClickHouse host. The host is the `name` of a `clickhouse.host` block. Its identifier is `host_id`.

The library shows only the folders, queries and history of the host that the user selects in the header. It follows a host switch at once. A run is recorded in the history of the host where it ran. In server mode, every read names its host (`?host_id=`), and every write carries the stamp of that host. Nothing moves from one host to another.

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
| `enabled` | `false` | `false`: the block is ignored. If no block is enabled, every `/api/query-library` route answers 404. Saved shows only the *Local browser storage*. |
| `name` | `default` for the first library | The name of the library. It is the id in the API (`?library=`) and the name that the Query page shows. The text can be 1 to 128 bytes long. Spaces and accents are valid. The text has no control character and no space at either end. Only the first library may omit it. Each name is different. |
| `file` | none | Required when enabled. The parent directory must exist. The dashboard creates the file at the first write. |
| `writable` | `false` | `false`: the library is read-only. Create, edit, move and delete of a folder or a query, and import, answer 403 `read_only`. |
| `max_file_bytes` | 8 MiB | Size limit of the file (64 KiB..1 GiB). A write that exceeds the limit answers 413. Nothing changes. |
| `max_query_bytes` | 256 KiB | Size limit of the SQL of one saved query (1 KiB..`max_file_bytes`). Larger SQL answers 413. |

### Several libraries on the server

Repeat the `query_library` block. Each enabled block is one more library. Each library has its own name, file and `writable`. The page shows each library as a top folder, named after the library. The top folders are in the order of the file, above *Local browser storage*.

Use this setup to keep a shared library that all users can change, next to a read-only library that holds approved queries. The file of the read-only library is maintained by hand or by a deployment.

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

- A single block works as before. It uses the same file and the same routes. A single library that keeps the name `default` shows as *Shared server storage*.
- Only the first library may omit its `name`. Then its name is `default`. Each name is different. Two libraries never share one file. The start fails if they do. A block with `enabled = false` is ignored.
- Each library has its own revision, its own limits (`max_file_bytes`, `max_query_bytes`) and its own load error. A library whose file cannot be read is read-only. The other libraries are not affected.
- A read-only library shows a *Read-only* badge. You can open, search and export its queries. The folder menu saves a JSON file. Nobody can change, move or remove an item in it. Nobody can move an item into it.
- A move of a query or a folder between two libraries works like a move between the browser and the server. The item is created in the target. Then the item is removed from the source. Both libraries must be writable.
- The routes are the same for every library. Use `?library=<name>` to select one library, for reads and writes. Without this parameter, the first library answers.

The program refuses a `history {}` block in `query_library` at startup. The block is from earlier releases. It has the keys `history.store` and `history.max_entries`. The message asks the user to delete the block. A library file that an earlier release wrote keeps its `history` array. The dashboard removes this array when it loads the file:

- A writable library writes the file again, without the array. The log gives the count.
- A read-only library leaves the file as it is.

`/api/version` reports `features.query_library = {"enabled", "writable", "libraries"}`. `libraries` lists each library in the order of the file: `[{"name", "writable"}]`. The first library is the default one.

The `writable` value of a library is its effective state. It is false when `writable = false`. It is also false while the file has a load error. The `writable` of `query_library` is the `writable` of the first library. With the feature disabled, `/api/version` reports `{"enabled": false, "writable": false, "libraries": []}`.

## In the Query page

The book button of the Query toolbar opens the query library. It is between Format and the cog of the run settings. The library opens in the same modal dialog as *Run with profiling*. The dialog has the same size, close button, backdrop and tab style. On a phone, the dialog is full-screen. The two tabs, **Saved** and **History**, are in the dialog header, where the profiling dialog has its title.

If History has no run, or if a search has no match, the dialog shows one empty state. The empty state is centered across the dialog. It has no preview pane. If Saved has no saved query, the dialog has no separate screen. It shows the usual tree of its storages (*Local browser storage*, and *Shared server storage* when enabled). Each storage shows *Empty*.

Both tabs have the same layout:

- The search is on top of the list. In Saved, the *New folder* icon button is at the right of the search.
- The list is below the search.
- The foot line is below the list. In Saved, it shows the count of queries and the host. The foot line has no save action. Use the floppy **Save** button of the editor instead.

Select an item in the list. Use a click or the arrow keys. The pane on the right shows the selected item. The head of the pane is one line. It shows the title, then the meta, then the tools of the item as icon buttons. The meta is the *Updated ...* of a saved query or a folder, or the time and the status of a run.

Each tool has its label as `aria-label` and as tooltip. The foot of the pane holds one action, **Load**, at the bottom right. While the pane shows the save form, the foot holds the buttons of the form instead (see *Save*). Press Ctrl/Cmd+Enter in the list or in the pane. The action puts the SQL in the editor and closes the dialog. A click never loads a query by itself.

The highlighted SQL has its own copy button. It also has the line-number gutter of the editor, when *Line numbers* is on in the editor options (`chdash.editor.line_numbers.enabled`). Its lines scroll sideways. They do not wrap.

On a phone, the list and the preview are two steps. Tap a row to see its pane. The back button returns to the list. A tap on a twisty or a folder icon opens the folder. A tap on the name of the folder shows its pane, and the meta goes under the title there. On a touch screen, the icon tools are 40 px square.

- **Saved**: shows a tree, like the Explorer. The top folders of the tree are *Shared server storage* (when the server library is enabled) and *Local browser storage*, in this order. If the server library is off, only the browser storage appears. Each storage and each folder shows its count of queries. The count has the queries in its subfolders too, even when the folder is closed. An empty folder says *Empty*. A folder holds nested folders and saved queries; a saved query has a description, and a folder has no description.
  - Every folder opens and closes in place. The chevron (the twisty) opens and closes the folder. A click on the row selects the folder, and it opens the folder when the folder is closed.
  - A click on an open folder that has the blue frame closes it, as the chevron does. A click on an open folder that is not selected only selects it.
  - With the keyboard, Right opens a folder, Left closes it, and Enter or Space opens or closes it. On a phone, a tap on the icon also does this. The dashboard remembers the open state.
  - The search covers both storages. It searches names, descriptions and SQL. Each result names its storage and its folder.
  - The preview of a query shows its name, its last update, its description and the highlighted SQL. It has no folder line, because the tree shows the folder.
  - The preview of a folder shows its path and its contents, which are the queries and subfolders under it. Then it lists what is directly in the folder. The subfolders come first, each with its count of queries. The queries come next, with their description and last change. A click on an entry opens it in the tree. An empty folder says so.
  - The preview of a storage says where the storage is kept. Then it lists the top level in the same way (*In this library*).
  - The *New folder* icon button creates a folder inside the highlighted folder or storage. The user types the name of the new folder in a row. Press Enter to create the folder. Press Escape to cancel it. The row refuses a duplicate name.
  - Rename a folder in its row: press F2, or choose *Rename*.
  - Each row has a "..." menu. The menu shows on hover, on focus and on the highlighted row. A right click or Shift+F10 also opens it. The menu has these items:
    - Load, or Open/Close for a folder (Enter).
    - Edit..., or Rename for a folder (F2). Edit shows the same form as Save, in the right pane. No window opens over the dialog. The form changes the name, the description and the folder of a query. It shows the SQL, but it does not change the SQL.
      - To replace the SQL, load the query. Change the SQL in the editor. Press Ctrl/Cmd+S (*Update*).
    - Move to... (Ctrl/Cmd+M).
    - Export as JSON (a folder only, also in a read-only storage). This item saves the folder, and everything in it, as a file. The file name is the name of the folder. The file has the body of `POST /api/query-library/import` (`host_id`, `folders`, `queries`). A copy-mode import can read the file again.
    - Remove (Delete).

    The menu of a search result also has Show in folder.
  - You can also move queries and folders by drag and drop. Drop the item onto a folder, onto a storage row, or between the two storages.
  - The library opens one confirm dialog before it removes an item. The dialog also appears for a folder with everything in it.
- **Move between the storages** (Move to..., drag and drop, or a folder change in Edit or Save) copies the item into the target storage. Then the dashboard removes the item from its source.
  - A query is created in the target.
  - A folder with everything in it is created in the browser at once. On the server, one all-or-nothing `POST /api/query-library/import` in copy mode creates it (see below).
  - The dashboard refuses a name that the target folder already holds. It does this before anything changes.
  - If the copy succeeds, but the source cannot remove its item, the dashboard tells the user. The item is then in both storages.
- **Save** is the floppy *Save query* button in the corner of the editor, between the copy button and the options cog. You can also press Ctrl+S, or choose *Save to library...* of a run. No window opens over the dialog. The library opens on **Saved**, or it stays on **Saved** when it is already open. The right pane shows the save form in place of the preview of the selection. The tree stays on the left and works as usual (search, open and close folders, the *New folder* button).
  - The form has a title: *Save to library*, or *Save "name"* when the editor holds a saved query. Its fields are **Name**, **Description** and **Folder**.
  - Under the fields is the SQL that will be saved. Its label is *SQL (from the editor)*, *from History*, or *formatting...*. The **Formatted** switch is left of the copy button of the SQL block. It is the same button as the one of a result's statement. The switch appears only when the formatter changes the text. A query that the formatter leaves as it is has one text to save.
  - The foot has **Cancel** and **Save**. When the editor holds a query that was opened from a writable storage, the foot has **Update** and **Save as new** instead. **Update** changes that query. **Save as new** creates another query.
  - The keyboard focus moves to Name. Press Enter in Name to save. Press Ctrl/Cmd+Enter to save from any field of the form.
  - The query is saved as the formatter writes it. The **Formatted** switch is left of the copy button of the SQL, and it is pressed by default. When the user releases the switch, the shown text is the text as typed, and the query is saved as typed. If the formatter does not accept the query, the switch is released and locked. The title of the switch gives the reason. The query is saved as typed in this case.
  - The SQL appears like the preview of a query. It has its line numbers, when the editor shows them, and a copy button.
  - The tree shows where the query will go. A dashed row shows the place. The row has the label *New query*, then the typed name. It is in the folder of the **Folder** field, at the place where its name sorts. The folder opens for the row. When an edited query moves, the row shows its new place.
  - The **Folder** field starts at the place that is selected in the tree. For a selected query, this is its folder. For a selected storage, this is the storage. When the form updates a query, the field starts at the folder of the opened query.
  - While the form is open, a click on a folder or a storage in the tree sets the Folder field. The arrow keys on the tree do the same. This way, the user picks the target in the tree.
  - The Folder list always offers every folder of both storages, as in the other pickers. A new folder that the *New folder* button creates while the form is open is added to the list and chosen. The form keeps what the user typed when the tree is drawn again.
  - **Folder** is a folder picker, as in the open-source drives (Nextcloud, Google Drive, Dropbox). The picker shows a path, for example *Team queries / Reports / Daily*. The last folder is in bold.
  - A click, or the Down arrow, opens a tree of the storages and their folders. A twisty opens a folder. Right and Left open and close the folder. They also go to the first child and to the parent.
  - Up, Down, Home and End move in the tree. Enter, or a click, chooses a folder and closes the tree. Escape closes only the tree. The form and the dialog stay open.
  - The places that were chosen last (at most three) come first, under *Recent*, with their path. With 8 folders or more, a *Filter folders* box finds a folder by any part of its path. Each result shows where the folder is. Enter chooses the first result.
  - A read-only storage is shown locked (*Read-only*), and you cannot choose it. *Move to...* uses the same tree, and this tree is always open.
  - An empty name, a name that is too long, or a name that the folder already uses shows a message under the field. A description that is too long, or a folder that cannot be used, shows its message under the field too. Each message has `role="alert"`, and the field has `aria-invalid`. The focus goes to the field.
  - Any other refusal shows its message above the buttons. Such a refusal is a conflict, a read-only storage or a failed request. The form stays open, and nothing is lost.
  - The guards of the library work as before. With no host, with a read-only library, or with an empty editor, no form opens, and a toast says why.
  - **Escape** cancels the form and shows the preview of the selection again. It does this wherever the focus is in the dialog. A second Escape closes the dialog. The focus goes to the selected row.
  - When the dialog closes, the form ends. A switch to another host also ends the form. A removed query also ends the form when the form is for Edit. A second click on the editor's *Save query* button, or a second Ctrl+S, with the same form open, only sets the focus on the form. If the user switches to **History**, the form stays. It returns when the user switches to **Saved**.
  - After a save, the toast says *Query saved.* (or *Query updated.*). The tree opens the folder of the query and selects the query. The pane shows the normal preview.
  - On a phone, the form is one step of the pane. The back button in its head returns to the list, and it keeps the form. The editor's *Save query* button brings the form back. A tap on a folder or a query in the list sets the Folder field, and it returns to the form. Cancel and Escape cancel the form and show the list.
- **History** shows the runs of the current host, grouped by day. Each run has its status (ok / error / cancelled), the elapsed time and the rows. A search is available.
  - The preview of a run has the SQL as its title. The time and the status are beside the title. Then the preview shows the elapsed time, the rows, the server error of a failed run, and the SQL.
  - Its tool is *Save to library...*.
  - The dashboard keeps each run formatted. The entry holds the text as typed in `sql_raw`. It holds the text of the formatter in `sql_formatted`, with `formatted: true`.
  - When the query was not formatted at run time, the dashboard asks the formatter in the background. It writes the answer into the entry.
  - The dashboard does the same for older entries, when the user views them. It formats an entry that has no formatted text when the user selects it, loads it or saves it. The preview then shows the formatted text, unless the user has already scrolled the preview.
  - The list shows each query on one line, and the list does not change. A script that the formatter does not accept stays as typed. The dashboard does not ask for it again while the page is open.
  - The user cannot edit or remove a run in History. There is no *Clear history* action. The browser keeps the 50 most recent runs of each host, and at most 2 MiB of SQL for each host. Older runs are removed. A busy host does not remove the runs of the other hosts. The same SQL on the same host is one entry, and it moves to the top.
  - The browser stores a text that is longer than 256K characters as a cut text. The entry has `truncated: true`. The preview says *Cut at 262,144 characters*. So the *Load* action does not hide that the text is shorter.
- The folder pickers (the Folder field of Save and Edit, and the Move dialog) list each storage as a group. Each folder has the path format of the preview: `/` for its top level, then `/Operations`, `/Operations/Merges`. The group of a read-only storage is disabled.
- When the user switches the host in the header, the storages and the History of that host appear at once. This also applies while the dialog is open.

Ctrl/Cmd+S opens the save form (see above) for the editor. The form saves into one of the storages. The server storage is the default when it is writable. The form can also update the saved query that the editor holds.

The library works fully with the keyboard. The focus moves into the dialog and stays there. Use these keys:

- Arrows, Home / End and type-ahead select a row in the list.
- Left / Right close and open folders and storages.
- Enter loads a query, or opens and closes a folder.
- Ctrl/Cmd+Enter loads the query.
- F2 edits a query or renames a folder.
- Delete removes the item after the confirm.
- Ctrl/Cmd+M moves the item.
- Space opens or closes a folder.
- `/` sets the focus on the search.
- Escape, or a click on the backdrop, closes the dialog. The focus moves to the book button.

| Storage | Where | Editing |
| --- | --- | --- |
| *Local browser storage* | `localStorage["chdash.queryLibrary.v2"]`. Each folder and query has its `host_id`. | always |
| *Shared server storage* (`enabled = true`) | the server file through `/api/query-library?host_id=` | when `writable = true` |
| *Shared server storage*, `writable = false` | the same, with a *Read-only* badge on the storage | none. The items have no change actions, and no drag. The picker group is disabled. The browser storage stays editable. |

The History is in the IndexedDB database `chdash`, in the store `queryHistory`. Each entry has its `host_id`. The History does not depend on the server library.

- A run writes its own record. It writes once when it starts, and once for its outcome. It writes once more when the formatter answers. The dashboard never reads and writes the whole list for a run. It reads the list of a host once for each page. It reads the list again when another tab has written. A `BroadcastChannel` tells it.
- The browser can refuse a write when the quota is full. In that case, a warning appears at the bottom of the page: *History could not be saved: the browser storage is full*. A click closes the warning. The run itself is not affected. If the browser has no IndexedDB, or blocks it, the runs stay in the page for this session. The dashboard says so once.
- The older list in `localStorage["chdash.queryHistory.v1"]` moves into the database the first time a page loads. Then the dashboard removes the key. The entries without a host do not move.
- The metadata catalogue (`chdash.meta.v1.<host>.<type>`) is a cache in localStorage. It keeps at most two hosts. The least recently used host loses its keys. It stores the empty fields and the false flags of its items in a compact form. When the browser refuses a write to the *Local browser storage*, the dashboard removes this cache first and tries again.
- On the server, every change of a folder or a query sends `If-Match: <revision>`. After a 409 conflict, the library reloads and retries once. Then the library tells the user. The former one-time *Import my browser queries* offer is gone. Both storages are browsable, and a move copies between them. The dashboard removes its stored state (`chdash.queryLibrary.importOffer.v1`).

### Entries without a host

Entries without a host are no longer valid. The dashboard removes them.

- **Server, writable file**: the dashboard removes the folders and saved queries without a `host_id` when it loads the file. This happens at startup, or after an external edit. It rewrites the file atomically as version 2 (see [File format](#file-format)). A query or folder that was inside a removed folder moves to the top level of its own host. The log says what the dashboard removed. It gives counts only, never SQL.
- **Server, read-only (`writable = false`)**: the dashboard ignores the same entries in memory. It never rewrites the file.
- **Server, malformed file**: this is a load error, as before. The library is read-only. It is served empty, or from the last good copy. The dashboard never rewrites the file.
- **Browser**: on the first load, the dashboard removes the folders and queries without a host from `chdash.queryLibrary.v2`. It does not move the history entries without a host from `chdash.queryHistory.v1` into the database. The dashboard no longer reads or imports the old flat list `chdash.savedQueries.v1`. Its entries have no folder, and often no host.

The page address follows the editor. The address is `?saved=<id>` while the editor holds a library query that has no change. Otherwise, the address is `?sql=<text>` of the last run (up to 4,000 characters). When the user opens the link in a new tab, the link fills the editor.

## Storage

- One process owns the file. The library is kept in memory behind a mutex. Each request first compares the stat of the file (device, inode, size, mtime) with the last stat that the backend saw. The backend reloads an external change before it serves the request or applies a mutation. The revision moves forward. Editors that hold the old revision then get a 409.
- Writes are atomic. The backend writes the new document to a temporary file in the same directory. The name of the temporary file is `.<name>.tmp-<pid>-<random>`. The backend creates it with `O_EXCL`, `O_NOFOLLOW` and mode 0600.
- The backend runs fsync on the file. It renames the temporary file over the file. It runs fsync on the directory. A failed write leaves the previous file untouched. The backend removes the temporary file and answers 500 `storage_error`.
- The backend never overwrites a file that has one of these faults:
  - It is not valid JSON.
  - It has an unsupported `version`.
  - It is larger than `max_file_bytes`.
  - Its structure is inconsistent (duplicate ids, unknown parents or folders, a parent cycle, wrong types).

  The backend logs the error once. It serves the library as read-only, empty at startup or as the last good copy, with `load_error` set. Mutations answer 403 `read_only`. The backend reloads the file as soon as the file changes on disk.
- The feature never runs SQL. It stores the saved SQL and returns it verbatim. No request value ever reaches the filesystem. The only path is the configured `file`. Request ids are only looked up in memory. Log entries never contain SQL.

## Security

ChDash has no end-user authentication (see the authorization model in [`configuration.md`](configuration.md)). Everyone who can reach the panel can read the library. When `writable = true`, they can also edit it. The library is persistent. So the routes that change data refuse the requests that a third-party page can make through the browser of a user. This is the guard of every write of ChDash ([operations.md](operations.md#the-guard-of-the-writes)):

- `Sec-Fetch-Site` must be absent, `same-origin` or `none`. Other values answer 403 `cross_site_request`.
- Without `Sec-Fetch-Site`, the `Origin` header must match the `Host` or the `X-Forwarded-Host` of the request. If it does not match, the answer is 403 `cross_site_request`.
- A request body must have `Content-Type: application/json`. Otherwise, the answer is 415 `unsupported_media_type`. A cross-origin page cannot send this type without a CORS preflight. ChDash never grants that preflight.

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

- `version` is `2`. The dashboard migrates a version `1` file when it loads the file (see below). Any other version is a load error. `revision` is the library revision (see below). Earlier releases kept the history in a `history` array. The dashboard ignores this array, and the next write removes it.
- `host_id` is required on every folder and query. A folder is in a folder of its own host, and a query is in a folder of its own host. Anything else is a load error. The dashboard keeps host ids that are no longer configured, because the host can come back. Nobody can read these entries until the host is back.
- **Migration from version 1.** Version 1 had no `host_id` on folders, and the `host_id` was optional on queries. When the dashboard loads the file, it removes every entry without a `host_id`, so every version-1 folder is removed. A query or folder whose folder was removed moves to the top level of its host. A writable library rewrites the file as version 2 at once, atomically, and it keeps the revision. A read-only library serves the migrated library from memory, and it leaves the file as it is. The same rule applies to a version-2 file that holds entries without a host.
- The server generates the ids (`f_`, `q_` + 16 hex digits). If you write the file by hand, you can use any unique string of at most 128 bytes.
- `parent_id` / `folder_id` are `null` for the top level of the host. Folders nest at most 8 levels deep. A name has 1..256 bytes, is trimmed, and has no control character. A name is unique among siblings, case-insensitively (ASCII). The siblings are the subfolders of one folder, or the top level of the host, and the queries of one folder.
- The `description` of a query is at most 16 KiB. A folder has a name and a place only. A file of an earlier release can still hold folder `description` fields or query `tags`. The dashboard reads the file and ignores these fields. The next write removes them. The dashboard does not refuse a request that still sends them, and it ignores them.
- The dashboard ignores unknown fields. The next write does not keep them.

To pre-seed a read-only library, write such a file by hand. You can start from an exported writable library. Then configure a `writable = false` deployment to use the file.

## REST API

All bodies are JSON. Every request that changes data accepts `If-Match: <revision>`. The values `42`, `"42"`, `W/"42"` and `*` are valid. If the revision does not match, the request answers 409 `{"error_code": "conflict", "revision": <current>, ...}`. The UI can then reload. Mutation responses carry the new `revision`.

Every route takes `?library=<name>` to select a library. The `name` is the name of a `query_library` block. Without this parameter, the first library answers. A name that no library has answers 404 `unknown_library`.

`host_id` is required where the table names it. It must name a configured host. If it is missing, the request answers 400 `reason: "required"`. If it is unknown, the request answers 400 `reason: "unknown_host"`. Both cases use `field: "host_id"`.

Requests by id (`PATCH`, `DELETE .../<id>`) act on the host of the entity. A move into a folder of another host answers 400 `reason: "host_mismatch"`, and it changes nothing. A `host_id` in a PATCH that is not the host of the entity gets the same answer.

The library revision is one number for the whole file, for every host. It changes with every change of a folder or a query. It also changes with an external edit of the file. A query run does not change it.

| Route | Writable only | Result |
| --- | --- | --- |
| `GET /api/query-library?host_id=` | | One **page** of the tree. A page holds 100 items at most, and `limit` can lower this number. The result is `{host_id, revision, updated_at_ms, writable, load_error, limits, parent_id, depth, complete, next_cursor, level_total, totals, folders, queries}`. See *Reads in pages* below. |
| `GET /api/query-library/queries/<id>?host_id=` | | One query, with all its fields: `{id, folder_id, name, description, sql, host_id, created_at_ms, updated_at_ms, revision, ancestors, path}` (`ancestors`: the ids of the folders above it, from the top level). A query of another host answers 404 `not_found`. |
| `GET /api/query-library/search?host_id=&q=` | | The queries whose name, description, SQL or folder path hold every word of `q`. The search ignores the case. It returns at most 100 results: `{host_id, revision, total, truncated, results: [{id, folder_id, name, updated_at_ms, path}]}`. |
| `GET /api/query-library/export?host_id=[&folder_id=]` | | The whole library of the host, with the SQL. The optional `folder_id` limits the export to one folder and everything under it. The result is `{..., folders, queries}`, as the library file holds them. A backup reads this route. A move to another storage copies it. |
| `POST /api/query-library/folders` `{host_id, parent_id, name}` | yes | 201: the folder and `revision`. `parent_id` must be a folder of the same host. |
| `PATCH /api/query-library/folders/<id>` `{name?, parent_id?}` | yes | The folder and `revision`. To move the folder, set `parent_id`. `null` means the top level of its host. A move of a folder into itself, or into one of its subfolders, answers 400 `reason: "cycle"`. A move that nests deeper than 8 levels answers 400 `reason: "depth"`. A move into a folder of another host answers 400 `reason: "host_mismatch"`. |
| `DELETE /api/query-library/folders/<id>?recursive=1` | yes | `{ok, id, deleted_folders, deleted_queries, revision}`. Without `recursive=1`, a folder that has subfolders or queries answers 409 `{"error_code": "not_empty", "folders": <subfolders>, "queries": <direct queries>, ...}`. |
| `POST /api/query-library/queries` `{host_id, folder_id, name, description, sql}` | yes | 201: the query and `revision`. `folder_id` must be a folder of the same host. |
| `PATCH /api/query-library/queries/<id>` `{name?, description?, sql?, folder_id?}` | yes | The query and `revision`. `folder_id` moves the query within its host. Otherwise, the answer is 400 `reason: "host_mismatch"`. |
| `DELETE /api/query-library/queries/<id>` | yes | `{ok, id, revision}`. |
| `POST /api/query-library/import` `{host_id, folders, queries, copy?}` | yes | `{ok, imported_folders, merged_folders, imported_queries, skipped_queries, folder_ids, revision}`. |

A PATCH that changes nothing does not write the file. The revision stays the same.

### Reads in pages

The Query page does not load the whole library. A library can hold thousands of queries, and most of them are never opened. `GET /api/query-library` answers with one page. The SQL of a query is read when the query is opened.

- **The first level** holds the children of `parent_id`, which is a folder. Without `parent_id`, the first level is the top level of the host. The folders come first, then the queries, each sorted by name. A folder has `query_count` (the queries under it, subfolders included), `child_count` (its direct children), `subfolder_count`, and `loaded`. A query has `id`, `folder_id`, `name` and `updated_at_ms`. A page has **no SQL and no description**.
- **Levels deeper** are added while the page stays within 100 items. A library of 100 items or fewer comes whole in one answer. With 104 items, the page omits the deepest levels until the number fits, so it keeps the levels that fit. A folder whose children are not in the page has `loaded: false`. `depth` is the number of levels below the first one. `complete` is true when nothing is left to read.
- **A first level larger than a page** comes in windows. The answer holds the first 100 items and `next_cursor`. The next call is the same, with `cursor=<next_cursor>`. Repeat the call until `next_cursor` is `null`. `level_total` is the size of the level.
- `totals` is the whole library of the host (`folders`, `queries`). It also holds the queries under the parent (`parent_queries`). The page shows the counts before anything is read.
- To read a folder with `loaded: false`, send `GET /api/query-library?parent_id=<its id>`. The request works in the same way. It returns the children, as many levels as fit. Windows apply when the level is large.

The Query page reads a folder when the folder is opened. The counts are already on the row. It reads the next window on *Show more*. It reads one query when the query is selected or loaded (`GET /queries/<id>`). It asks the server to search. A change (create, edit, move or remove) reloads the top level and the open folders.

### Import

`POST /api/query-library/import` brings folders and queries from the browser library into the server library of the request host. The page uses this route in copy mode, which moves a folder from the browser storage to the server storage. Everything that the request imports belongs to the `host_id` of the request, which is the current host. The dashboard ignores a `host_id` on an imported query.

- `folders` entries are `{id, parent_id, name}`. `id` and `parent_id` are the ids of the browser.
- `queries` entries are `{folder_id, name, description, sql, created_at_ms?, updated_at_ms?}`. `folder_id` refers to an imported folder id, or to an existing server folder id of the same host. Anything else means the top level.

These rules apply to the import:

- The backend imports folders with the parents first. If a folder name (case-insensitive) already exists under the same parent of the same host, the import merges the folder into the existing folder (`merged_folders`). A parent cycle in the payload answers 400 `reason: "cycle"`.
- The backend skips duplicate queries. A query is a duplicate when its name and SQL match a query in the library of the host or in the payload (`skipped_queries`). A ` (n)` suffix that an earlier import added does not count. For this reason, an import of the same payload twice does nothing. If a different query in the target folder already uses the name, the backend renames the new query `name (2)`, `name (3)`, ...
- `folder_ids` maps each imported folder id to its server id.
- The import is all-or-nothing. A validation error anywhere answers 400 (or 413) with the `field` that caused it (for example `queries[3].sql`). Nothing is written. If nothing is new, the backend does not write the file, and the revision does not change.
- **Copy mode** (`"copy": true`, a boolean) is a copy, not a merge. A folder whose `parent_id` names an existing server folder of the host goes under that folder. The backend does not merge, skip or rename anything. A folder or query whose name its target already holds answers 400 `reason: "duplicate"`. Nothing is written. `folder_ids` maps the copied folders to their server ids.

### Errors

Errors have the body of every ChDash error (`error_code`, `message`, `retryable`; [operations.md](operations.md#errors)). They use these codes:

| Status | `error_code` | Extra fields |
| --- | --- | --- |
| 400 | `validation` | `field` (`host_id`, `name`, `parent_id`, `folder_id`, `sql`, `queries[3].name`, `If-Match`, `limit`, `body`, ...) and `reason` (`required`, `type`, `too_long`, `invalid`, `duplicate`, `not_found`, `unknown_host`, `host_mismatch`, `cycle`, `depth`, `invalid_json`, `range`) |
| 403 | `read_only` | `load_error` when the file failed to load |
| 403 | `cross_site_request` | |
| 404 | `not_found` | Unknown id. Every route answers 404 when the feature is disabled, with an empty body. |
| 409 | `conflict` | `revision` |
| 409 | `not_empty` | `folders`, `queries`, `revision` |
| 413 | `too_large` | `field` (`sql`, `file`, `folders`, `queries`) |
| 415 | `unsupported_media_type` | |
| 500 | `storage_error` | The file cannot be written. Nothing changes. |

## Tests

- `tests/native/query_library_test.cpp`: unit tests of the store. They cover these cases:
  - Atomic write.
  - Tree rules.
  - If-Match.
  - Read-only.
  - Malformed file and reload.
  - Import.
  - Size limit.
  - Reads and writes for each host.
  - `host_mismatch`.
  - The migration from version 1 to 2 on a writable file and on a read-only file.

  Build the `chdash_query_library_test` target with `-DCHDASH_BUILD_QUERY_LIBRARY_TESTS=ON`. The script `tests/harness/test_native_unit_tests.py` runs it when `QUERY_LIBRARY_TEST_BINARY` gives the path of the binary.
- `tests/backend-functional/test_query_library.py`: HTTP tests against dedicated instances. See "Query library" in [`tests/README.md`](../tests/README.md).
- `tests/frontend/specs/query-library.spec.js`: tests of the library dialog of the Query page. The dialog uses the shared modal of the profiling dialog. The shared modal covers the shell, geometry, focus, Escape and backdrop. It also covers the confirms and prompts (Move, Remove) that appear over the dialog. The spec runs on a phone and in both themes. It has these parts:
  - It tests the browser storage alone. It covers these items:
    - The purge of entries without a host.
    - Folders: name, rename, move and remove them in their row.
    - Save, edit and move. Save and Edit use the form of the right pane. The test checks these points:
      - No stacked dialog.
      - The Folder field follows the tree.
      - Escape in two steps.
      - The errors under the fields.
      - *Update* and *Save as new*.
      - A read-only storage.
      - The phone.
    - `/` paths in the pickers.
    - Search and Show in folder.
    - The menu of a row and the right click.
    - The one line of the head and the icon tools.
    - No Folder line.
    - The line-number gutter, on and off.
    - The floppy *Save query* button of the editor, beside the copy button. The button is disabled while the editor is empty. The *Load* action is alone in the pane.
    - The keyboard.
    - History with no *Clear history* and no removal.
    - A host switch.
  - It tests both storages against a mocked API. It covers these items:
    - The two storages and their pickers.
    - Moves across them in both directions.
    - `host_id` on every request.
    - A host switch.
    - `host_mismatch`.
    - If-Match and conflict retry.
    - A read-only server storage.
    - The History stays in the browser, with no request about it.
  - The live test runs against a real writable instance, when `QUERY_LIBRARY_BASE_URL` names one (as the Playwright container reaches it). The test covers both roots.
