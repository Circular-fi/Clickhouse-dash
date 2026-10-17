# Explorer

Explorer is an inspection surface with the scope of the runner. It is not an administrative bypass over ClickHouse permissions.

## Security flow

Explorer has no application-level user authentication. Every request for a host shares the configured runner permissions of that host.

For every Explorer request, these steps apply:

1. The runner context discovers databases and tables. It verifies `SELECT` access at table level. It uses `CHECK GRANT SELECT` on the table. When this check is not possible, it uses a zero-row `SELECT` instead. ClickHouse refuses that `SELECT` without a column grant. The backend checks the columns of a table only when a person opens the table (its card and its data preview).
2. The resulting `AllowedObjectSet` is the visibility boundary.
3. The system context can enrich only objects that are already in that set.
4. The backend filters dependencies against the same set before it serializes their names.
5. Data preview and function discovery run with the runner context. They never run with the system context.

The ACL cache has the scope of the runner identity. This scope is the digest of its URI (user, password, server and settings). Two hosts share the cache only when they connect in the same way. The derived MCP identity has its own cache. The caches of the catalog, the graph and the functions have the scope of the configured host.

The ACL is kept for `explorer.acl_cache_ttl_ms` (60 s by default). The Explorer, the System pages, the execution statistics, the analysis, the exports and MCP share it. Use `refresh=1` to invalidate the relevant caches, including the ACL of the runner. In this way, the user sees changed ClickHouse grants or metadata at once. Without a refresh, a change of the grants shows after the ACL TTL, at most twice the TTL. Refer to [Caches and privileges](configuration.md#caches-and-privileges).

**Only `ACCESS_DENIED` means "not readable".** ClickHouse decides with code 497. Another server error about one object (a parameterized view, a `Distributed` table without its cluster) omits that object, and the other objects are still checked. A connection error or a timeout is not an answer. The route answers 503. The backend does not store the failure beyond a back-off of 2 s. The menu is never empty because of a lost connection.

**The discovery has limits.** One discovery checks at most 4,000 objects in 20 s. To decide whether a database is readable, it probes at most 400 of its objects.

When a bound stops the discovery, the answer has `"acl_truncated": true`. The list omits an object that was not checked. A database that the bound did not reach stays in the database list. Its name is the one that `SHOW DATABASES` gives the runner. The backend checks its objects when a person opens the database.

**The names follow `SELECT`, not `SHOW`.** A runner can have `SHOW DATABASES` and `SHOW TABLES` on `*.*`, and `SELECT` on two databases. The sidebar lists a database when the runner reads all of it (`CHECK GRANT SELECT ON db.*`) or at least one of its tables. In a database, it lists the tables that the runner reads.

The table counts, the rows and the bytes of the first answer come from `system.tables` as the runner. This answer covers the databases of the tree and of the overview. It covers the tables that the runner may list (`SHOW TABLES`). This can be more than the tables that it may `SELECT`. The first answer does not check every table. Such a check costs one probe for each table of the server.

The list of an opened database has only the tables that the runner reads. The shares of a table card (Table / Database, Table / ClickHouse) use the same totals as the first answer. The numbers agree when the runner reads every table that it lists. `system` stays in the list. ClickHouse lets every user read `system.databases`, `system.tables` and `system.columns`.

**A missing grant degrades the answer.** If the system user may not read a system table that a section needs (`system.parts`, `system.disks`, `system.merges`...), the card and the graph still answer 200. Such an answer omits the figures of that section. The response names each such section in `unavailable_sections`.

For each section, the `unavailable` object gives `reason: "not_granted"`, the `user`, the `grant` and the `hint` (the `GRANT` statement). Any other error of a section is still an error. The access audit of the host (`docs/configuration.md`) reports the same result at start.

A runner with `SHOW` and `SELECT` on a few databases is a normal setup. `SHOW DICTIONARIES` reads `system.dictionaries`. The runner cannot read that table (`ACCESS_DENIED`). The Explorer then lists only the dictionaries that `SHOW TABLES` returns. It does not fail. Any other error of the listing is still an error.

The important rule is this: `system_uri` is for enrichment only. It never authorizes an object. It never runs SQL that a panel caller supplies. It never gives a DDL text: ClickHouse masks the secrets in `create_table_query`, `engine_full` and `as_select` for each user, so ChDash reads these three columns as the runner. The section "Secrets in the DDL texts" of `docs/configuration.md` gives the rules. If different callers need different ClickHouse ACLs, use distinct deployments or hosts with different runners. Do this outside ChDash.

## Shell and navigation

The Explorer shell has one nav row (40 px, `#explorerTopBar`). This row has one underline tab row (`#explorerNavTabs`), with the view tabs `Catalog | Functions`. On the Catalog only, the nav row also has a divider and the `Browse | Graph` tabs (`#explorerModeTabs`, `?mode=graph`). These are the second-level sections of docs/ui-foundations.md ("Tabs"), like the Search / Services / Service map of Observability after Traces / Logs / Metrics. Each of the two rows is a `tabs` tablist. Use Left, Right, Home and End to move within it.

The Explorer code has two controllers, one for each page. Modules sit under these controllers. Each module imports only what it uses. The pure modules have Node tests (`tests/frontend/model/explorer-model.test.cjs`, `explorer-detail-model.test.cjs`, `explorer-graph-model.test.cjs`).

| Module | Content |
| --- | --- |
| `app_explorer.js` | the controller of the Catalog: the mode on screen, the catalog of the host, the address, the start of the page |
| `app_explorer_functions_page.js` | the controller of the Functions page: its address, its load for the host, its search and kind chips. The page loads none of the Catalog |
| `app_explorer_store.js` | the model, the address, the parts that the entry gives, the error strip, and `actions` (what a module gives to the modules that cannot import it) |
| `app_explorer_summary.js`, `app_explorer_route.js` | pure: what a catalog entry is (engine families, sizes, kinds), and the addresses of the Explorer |
| `app_explorer_shell.js` | the view tabs, the Browse and Graph tabs, the side panels and their drawer on a phone |
| `app_explorer_tree.js`, `app_explorer_data.js` | the object tree and its type chips, and the reads of the catalog and of a table card |
| `app_explorer_database.js`, `app_explorer_table.js` | the databases overview and the page of a database, and the selection of a table |
| `app_explorer_functions.js`, `app_explorer_doc.js` | the Functions page and the documentation of a function |
| `app_explorer_detail.js` and `app_explorer_detail_*.js` | the table card (Catalog page only): the tabs and the body, and a module for the header, About, Columns, Storage, Operations, Preview and the shared cells. `app_explorer_detail_model.js` is pure: the SQL expressions of the card, the rows of Columns, the split of the storage, the tabs of an object, the sections of Operations and the preview SELECT |
| `app_explorer_graph.js` and `app_explorer_graph_*.js` | the graph (Catalog page only), in the layers below. Pure: `_model` (the request of a scope, the Lineage and Storage projections, the database groups, the neighborhood of a focus), `_text` (the labels), `_geometry` (the shapes of an edge), `_layout` (the positions of the cards). State: `_store` (the model, and `actions`: what a module gives to the modules below it), `_scene` (the caches, the visible set, the layout), `_viewport` (the camera). Canvas: `_nodes`, `_edges`, `_frame`, `_hit`. Then `_panel` (the chrome and the side panel) and `_focus` (the focus, the mode, the refresh). `app_explorer_graph.js` is the entry that the controller calls |
| `app_explorer_storage.js`, `app_explorer_treemap.js` | the size views and the treemap (Catalog page only) |

There is no breadcrumb. In the Catalog, the tree selection shows the location. The card header names the object. On a narrow window, the row scrolls sideways and shows edge cues. The row comes after the drawer button. It never wraps.

The **Catalog** is one view. It has the object tree on the left. It also has two modes for the same scope. The scope is the tree selection: nothing, a database or an object:

| Mode | Nothing selected | A database | An object | Container |
| --- | --- | --- | --- | --- |
| Browse | the databases overview (a treemap of the databases, then the overview table) | the database page (Tables by size, then its objects, then its disks) | the table card (Columns, Preview, Storage...) | `#explorerCatalogView` (`#explorerDetailPane`) |
| Graph | all databases | the database topology | the object's neighborhood | `#explorerGraphPane` |

A change of mode keeps the selection. These actions move the tree selection. The other mode then follows:

- A pick in the tree.
- A node click in the graph.
- A rectangle of a storage treemap (the one of the databases overview, or the one of a database page).

The first row of the tree is **All databases (8)** (`#explorerTreeRoot`). This database row has the stack icon. It shows the count of the databases that the tree shows, with the search and chips applied. The user reaches this button with Tab. It opens the root. While nothing is selected, the row has `aria-current="true"`, which gives it the selected row look.

In Graph, the **Up** button next to the modes selects the parent scope (`↑ chdash_ui`, `↑ All databases`). The **Open card** button of Graph switches to Browse for that object. Graph never fetches the card. Browse loads the card when it shows the card.

Storage is not a mode. It is a tab of the table card and the lower part of the database page. The database page has no tabs (see *Database inventory* and *Table card*). The catalog root draws the databases as a treemap above the databases overview. It has no tabs.

One URL scheme covers the Catalog. Back and forward move through modes, scopes and card tabs:

| Address | Opens |
| --- | --- |
| `/explorer/catalog[/<db>[/<table>]][?tab=<tab>]` | Browse (the default mode). `tab` names the tab of the table card. The first tab (Columns) has no `tab`. A database page has no tabs |
| `/explorer/catalog[/<db>[/<table>]]?mode=graph&graph=lineage\|storage&depth=N` | Graph (`graph=storage` is the type labeled **Tiers**) |
| `/explorer/functions[/<name>]` | Functions, a page of its own (`functions.html`, `#explorerFunctionsPane`) |

The Catalog and Functions use two fixed prefixes. A database named `functions`, `databases` or `catalog` is always at `/explorer/catalog/<name>`.

The server answers former addresses with a `302`. The `Location` header is relative. A reverse-proxy prefix therefore stays. The query string stays too:

- `/explorer` and `/explorer/databases` go to `/explorer/catalog`.
- `/explorer/<db>[/<table>[/<tab>]]` goes to `/explorer/catalog/<db>[/<table>[/<tab>]]`.
- `/explorer/_functions[/<name>]` goes to `/explorer/functions[/<name>]`.

The page reads other former addresses as aliases. It rewrites them to the form shown above:

- `?view=browse` and `?view=graph` (the former Browse / Graph views).
- `?mode=storage` (the former Storage mode).
- `/explorer/_system[?database=<db>[&table=<t>]]` (the former Storage view).

The last two aliases open one of three pages. They open the Storage tab of the table card, the database page scrolled to its storage, or the databases overview at the root. These aliases also work:

- The former database card tabs (`/explorer/catalog/<db>?tab=storage|objects`). The first one scrolls the database page to its storage.
- The card tab as a path segment (`/explorer/catalog/<db>/<table>/<tab>`).
- The former card tab slugs (`overview`, `schema`, `data`).

`docs/ui-foundations.md` ("Routes") describes the scheme of every page. The Explorer writes its address through `router` while its workspace is shown.

Use `explorer.setView(view)` to switch views in code. It also accepts a mode (`"browse"`, `"graph"`). `"storage"` opens Browse on the storage of the selection. This is the Storage tab of the table card, or the database page scrolled to it. Hidden modes are the ones that `explorer.browse` / `explorer.graph` disable. The first available mode replaces a disabled mode.

The health of the selected server is not an Explorer view. This health includes the tiles, the cluster, the performance history, the background activity, the top queries and the disks. It is the **System** page (`/system[/<section>]`, see [System](system.md)). The Explorer loads none of its modules. The former Monitoring tab (`/explorer/_monitoring[/<section>]`) and the former Server operations view (`/explorer/_operations`) redirect to the corresponding System address. With `system.enabled = false`, they open the Catalog (`/explorer/catalog`).

The object tree shows one line for each object. Each line has these parts:

- A type icon (table, Distributed, Buffer, Memory, view, materialized view, dictionary).
- The name.
- A health dot for warning and error tables.
- A size on the right, as a plain muted figure. It shows bytes only. `RAM` follows what Memory, Buffer and dictionaries hold in memory. Views and a Buffer with no measurable memory show nothing. The shares are in the databases overview and in the database page.

A database row shows its bytes. Its object count is in its tooltip. The tree cuts a long name in the middle, on its last `_`, `.` or `-` when such a character exists. In this way, the end of the name stays readable (`chdash_rich…_scratch2`). The whole name is in the title. The engine, the rows and the size are in the row tooltip.

An address can name a database or a table that the host does not show. It opens a **Database not found** / **Table not found** page. This page has *All databases*, *Refresh*, and the database for a table. It never adds a row to the tree. On a phone, the tree is a drawer that opens from its toggle. It never opens on its own over the page.

With nothing selected, Browse shows the **databases overview**. It lists every database that the tree lists. The System chip adds the system databases. For each database, it shows the objects, the rows, the size on disk and the share of the listed databases. These values come from the database summaries of the catalog. A name opens the database page. The search has these effects:

- It filters by `database.name engine`.
- It highlights the matches.
- It drops the loaded databases without a match.
- It shows the matching branches open.

The chips under the search filter the object types: Tables, Views, MV, Dict and System (system databases). The chip of the type of the selected object stays pressed and locked. The System chip does the same for a system object, so a filter never hides a selection. The non-storing projection of the graph follows the chips. When Views or MV is on, the graph includes non-storing objects. The filters persist in `chdash.explorer.typeFilters.v1` and `chdash.explorer.includeSystem`.

The tree and the Functions list have no head bar. A head bar has no title, count or fold toggle. They never fold to a rail. Their head is the search. The refresh icon button is at the right end of the same line. The chips follow the search.

On narrow screens (820 px and below), the tree is a drawer. The Objects button of the navigation bar opens it, in every Catalog mode. The drawer opens under the nav row, so the modes stay in reach. A pick of an object, or of a root row, closes it, and so does Escape or a press outside. The Functions list is also a drawer, and the same button opens it. The button is then named Functions.

The Functions list pane mirrors the tree pane, with the same width. It has a search box with the refresh button, and chips under it (Functions, Aggregate, Table, UDF). Only one kind is active at a time, and a press on the pressed chip lists every function. The first row is **All functions (1,949)** (`#explorerFunctionRoot`), with the function icon and the count of the functions listed. This row returns to the Functions overview, with the categories and the popular functions. It is current while no function is selected, like All databases.

### Number formats and shared tokens

Every Explorer number uses `format` (`app_format.js`, see [UI foundations](ui-foundations.md)). These are the `format` functions: `format.count` (`120,064`), `format.compact` (`120.1K`), `format.bytes` (`0 B`, `205 B`, `1.7 KB`, `10.3 MB`), `format.rate` and `format.percent`. The `format.bytes` values use one decimal from KB up and base 1024. A missing value is always `—` (`format.EMPTY`).

`src/static/css/00-tokens.css` defines the Explorer tokens (`--explorer-table-font` 13px, `--explorer-table-head-font` 12px, `--explorer-section-title-size` 13.5px / `--explorer-section-title-weight` 600, `--explorer-mono`). It also defines the shared in-cell bar. Use `class="explorerBar"` with `style="--bar-pct: 42%"`. Callers normalize the value to the column maximum. Add `explorerBar--cell` to result-table cells. The bar uses `--explorer-bar-color` at `--explorer-bar-alpha` (35%) in both themes.

## List catalog

`GET /api/explorer/catalog?host_id=<id>` returns only readable objects. The optional `database=<name>` filters the response after the authorization step.

The catalog uses bulk reads of `system.tables`, `system.parts`, `system.query_log`, `system.part_log`, `system.replicas` and `system.disks`. The collection of the catalog is fail-closed. If the API cannot read required technical metadata, it returns an explicit Explorer error. It does not silently replace metrics with empty or zero values. The runner ACL boundary and the technical metadata boundary exclude `INFORMATION_SCHEMA`/`information_schema`. They are compatibility namespaces, not user Explorer objects.

The lazy catalog for each database (`database=<name>`) also returns `disks`. These are the local disks that hold the active parts of the database. Each disk has `name`, `host_name`, `path`, `type`, the `bytes` of the database on it, `free_space` and `total_space`. The values come from one `system.parts` `GROUP BY disk_name` query of that database, and from `system.disks`. The database page lists them under its objects.

The current List metrics have the explicit label `local-replica`. ChDash does not multiply local part bytes by replica counts. It does not claim that a `Distributed` table stores the underlying data itself.

Client ingress and persisted writes stay separate:

- **Client ingress** comes from finished writes in `system.query_log`.
- **Physical writes** come from new parts in `system.part_log`.

MV output and Buffer forwarding are not combined into one ambiguous rate.

## Database inventory

The **Databases** section of the Explorer uses the same authorized catalog. Each database summary has these items:

- The number of visible tables.
- The visible rows.
- The visible local bytes.
- The local disks that these visible tables actually use.

Disk rows include `hostName()`, the disk name and path, and the bytes that belong to the database. They also include the capacity (free and total) that the server reports.

This inventory reports the current technical metadata host by design. It does not invent remote disk capacity for cluster replicas that the backend did not query. The storage topology shows the shard and replica membership of a `Distributed` table, taken from `system.clusters`. Remote disk accounting stays out of scope until a person configures a safe metadata query for the whole cluster. A click on a table in a database page opens the normal Explorer route of that table.

The database page (Catalog, with a database selected) shows `N objects · size`. Then it shows an **Objects** table with these columns: Name, Engine, Rows, Size, Compressed, Ratio, % database, Parts and Modified. After the table, it shows the storage. The table has these properties:

- It lists the objects that the type chips pass.
- It uses the shared number formats (grouped rows, one-decimal bytes, `—` for absent values).
- It draws in-cell bars on Rows, Size, Compressed and % database. Each bar scales to its column maximum.
- The Ratio tooltip has the uncompressed bytes.
- The table clips long names and engines, and a tooltip shows the full text. In this way, the table fits a 1280 px window without horizontal scrolling.
- Modified shows minutes (the full timestamp is the tooltip).

A database without objects shows one empty state (no tabs).

The database page has no tabs (user, 2026-10-04). It shows the object table above, and its storage (*Storage*) after it. It shows the storage when the database keeps some data on disk or in RAM. No figure repeats:

- The header counts the objects and the bytes.
- The Objects head has no count.
- The **Tables by size** head counts only the tables with data (the RAM total is in the footnote).

The former `?tab=storage` address opens the page with its storage scrolled into view. The Explorer writes the address again as `/explorer/catalog/<db>`.

The catalog root (**All databases**) draws the size band of the visible databases. This band is the component of the System Overview (`explorerTreemap.band`, `app_explorer_treemap.js`; docs/ui-foundations.md, "Size bands"). The band is always a treemap (`#explorerDatabasesTreemap`, `strip: "never"`). The database rectangles use the on-disk bytes. The treemap groups databases under 1% into Others, for any distribution. Others has its own chip and its own legend entry.

The band has the height of the size band. A rectangle opens that database. The band sits above the overview table. Both are under one **Databases** head without a count. The header has the count.

## Storage

The place of the bytes is part of the pages. It is not a view of its own. It was the former Storage mode of the Catalog.

**Size views, one order**: a size band and the table that it sizes can sit together. A size band is a treemap capped at `--sizemap-h`, 180 px. The share strip replaces it where the rules of the band say so. In this case, the band comes first, then the table. This applies to these pages:

- All databases (the databases treemap, then the overview table).
- The database page (Tables by size, then Objects).
- The Columns tab (Column sizes, then the columns).
- The Storage tab (the partitions map, then the partitions).

The System pages follow the same order (the databases treemap of the Overview, and the strip of each disk above its databases).

| Page | Storage |
| --- | --- |
| database (`/explorer/catalog/<db>`, above its objects) | a treemap of its tables (or a share strip), and the accounting footnote. The disks it uses are under the objects |
| table (`/explorer/catalog/<db>/<t>?tab=storage`) | composition, disks, partitions (treemap + share list), parts, skipping indexes, projections (*Table card*) |

The database page draws its tables as a treemap (`#explorerDatabaseTreemap`, `--sizemap-h` high, 180 px) when two conditions hold. At least three tables hold >= 1% of the database (`TREEMAP_MIN_ITEMS`), and no table holds more than 85% of it. Otherwise, the page draws one share strip (`#explorerDatabaseStorageStrip`). The strip has each table >= 1% and one Others segment, with a one-line legend. In this way, a database where one table holds 99.9% of the bytes shows that fact, not one full block. A rectangle or a strip segment opens that table on its own Storage tab.

Under the treemap, the Objects table lists every object with its size, share and parts. The storage therefore has no second list of the same rows. The **Disks** table follows (`#explorerDatabaseDisks`: disk, path, type, the size of the database on it, free space and capacity). Its data comes from the `disks` of each database of the catalog. The partitions treemap of the table tab (`#explorerPartitionTreemap`) and the column size map of the Columns tab (`#explorerColumnTreemap`) use the same band. They have the same height and the same rule: they draw nothing under three cells of >= 1%.

The byte accounting uses the same local on-disk method as the summaries of the database header and of the sidebar (`metric_scope = local-replica`):

- `bytes_on_disk` of active parts for MergeTree families.
- `system.tables.total_bytes` for Log-family and other disk engines.

Memory, Buffer and Dictionary objects report resident RAM (`isResidentMemorySummary`). If the page draws RAM as disk area, the views then disagree with the database total. For this reason, the areas exclude resident bytes. The page reports them separately, in the footnote and the section head. The page does not draw views or other objects without bytes.

Grouping and layout follow the S3-Browser folder treemap:

- The threshold is `ceil(1%)` of the displayed root. The treemap uses this absolute value at every level. It merges smaller siblings into one **Others** node. The node has a name, an exact size and a member count. The member count uses the own word of the members: tables, partitions or columns. The node always keeps the members.
- The treemap contracts a level with a single real child into that child. It drops a sole Others child, because the parent already has the totals.
- The layout uses the squarified algorithm. Others is a proportional bottom strip. It grows only to the height that its label needs. The treemap has at most 1000 rectangles and 5 levels. A hover highlights a rectangle. The tooltip shows the size, the rows and engine (or the type for a column), and the share of the root.
- The labels fit each rectangle (full, compact or tiny). A sliver keeps a rotated label when it is at least 12 x 48 px. It keeps a one-line label when it is at least 60 x 13 px. Otherwise, it gets an edge mark (`is-sliver`). In this way, a 1% table never looks like part of its neighbor. Labels use the text face, not monospace.

The browser runs the grouping on data that the card already holds. This data is the catalog of each database that the sidebar loaded, and the table detail. For this reason, one implementation (`app_explorer_treemap.js`) serves every drawing. Databases, tables and partitions have one accent tint, which does not depend on a name. Columns take the hue of their type family: numbers, dates and times, strings, arrays / maps / tuples / JSON, or other types. The legend under the map names the families and lists Others as a hatched item, with its label on a solid chip.

The module `app_explorer_storage.js` draws them:

- `explorerStorage.renderDatabase(container, { root, residentBytes, name, disks, onOpen })` draws the database tab.
- `renderTreemap(container, { tree, name, id, stripId, ariaLabel, className, scopeLabel, measure, unit, resident, onOpen, minItems, fallback })` draws a size band (`explorerTreemap.band`) with its legend and footnote. It returns `null` in one case: fewer than `minItems` (three) rectangles of >= 1% can show, and `fallback` is `"none"`. Its `setTree(tree, { measure })` redraws it for another measure.

`GET /api/explorer/storage?host_id=<id>[&refresh=1]` (the server-wide distribution of the former Storage view) stays an API endpoint. The UI no longer calls it.

Object names come only from the runner ACL (the AclService, the same boundary as the lazy sidebar). The system context then adds counters only for those names. It uses these two queries:

- One aggregated `system.parts` query (`active`, `GROUP BY database, table`, `database IN (<visible databases>)`).
- One `system.tables` query for the engine identity and the non-MergeTree totals.

Both queries only read metadata. The multi-billion-row OTEL fixture costs the same as a small table. The backend issues no `SYSTEM FLUSH`. The Explorer cache TTL (`explorer.cache_ttl_ms`) caches the response. `refresh=1`, and a global catalog refresh, invalidate the cache.

```json
{
  "version": 1, "metric_scope": "local-replica", "byte_metric": "bytes_on_disk",
  "table_limit_per_database": 128,
  "total_bytes": 0, "total_rows": 0, "resident_bytes": 0, "storing_tables": 0,
  "databases": [{
    "name": "chdash_ui", "system": false, "bytes": 0, "rows": 0, "resident_bytes": 0,
    "objects": 16, "storing_tables": 6,
    "omitted_tables": 0, "omitted_bytes": 0, "omitted_rows": 0,
    "tables": [{ "name": "weather_observations", "engine": "MergeTree", "bytes": 0, "rows": 0, "parts": 4 }]
  }]
}
```

`tables` lists only storing tables, largest first. The backend limits the list to 128 for each database. The bound loses nothing for any treemap that the UI can draw. At most 100 siblings can each hold 1% of their parent, so the treemap groups everything smaller into Others. The response still reports the remainder exactly through `omitted_*`. For this reason, `bytes` always equals the listed bytes plus the omitted bytes.

## Table detail

`GET /api/explorer/table?...` can return these items when the matching system table is available:

- Columns from `system.columns`: type, `default_kind` / `default_expression`, `comment`, key membership (`is_in_partition_key`, `is_in_sorting_key`, `is_in_primary_key`, `is_in_sampling_key`), codec, and compressed and uncompressed bytes for each column.
- The table keys and the storage policy from `system.tables` (`sorting_key`, `primary_key`, `partition_key`, `sampling_key`, `storage_policy`, `metadata_modification_time`), and `table_ttl`. `table_ttl` is the top-level TTL clause of `create_table_query`. Column TTLs are inside the column list. They are not part of `table_ttl`.
- The storage policy, and the local storage by disk and capacity for the disks that the table uses.
- Active and inactive parts, with the ClickHouse 26.7 `files` count.
- Partitions.
- Skipping indexes and projections.
- Mutations and active merges.
- The local replication state:
  - Replica counts.
  - Queue size and its split into inserts and merges.
  - Delay.
  - Log entries left to fetch.
  - Flags for leader, read-only and Keeper session.
  - `replicas` (every replica that the table has registered, and whether each one is active, from `replica_is_active`).
  - The replication queue.
- The Distributed cluster members. The backend resolves them from the cluster argument of the engine and from `system.clusters`. The detail also has the local `system.distribution_queue` backlog and error state. It also has `distributed: {cluster, database, table}`. These are the engine arguments, which are already part of `engine_full`.
- Structured dependencies that the security filter has processed. Each one has `kind` (`materialized_view`, `view`, `buffer`, `distributed_route` or `dependency`) and the `engine` of the related object.
- DDL.

The additions read only the opened object (`database = ... AND table = ...`):

- The existing `system.columns` query has five more columns.
- `replica_is_active` costs the same Keeper reads as `total_replicas` / `active_replicas`. The detail already pays those reads.
- The dependency engines come from one `system.tables` read. The backend filters that read on the dependency names that are already visible.
- If a server lacks one of the extra replica columns, the backend reads the base replica row instead.

If optional system metadata is not available, the response lists it in `unavailable_sections`. The page degrades. It does not fail globally.

The lazy catalog for each database (`/api/explorer/catalog?database=<name>`) marks replicated tables with `replicated: true` and their local `health`. The health is error for a read-only table or an expired Keeper session. It is warning for a queue above 1000 or a delay above 60 s. The catalog reads the health from the in-memory `system.replicas` columns only. For this reason, the navigation refresh of 5 s never waits on Keeper. The tree draws the health as a dot next to the name.

### Table card

The detail is a card (`app_explorer_detail.js` and its modules). It reads the store. It calls the controller through `actions`. It has these parts:

- **Header**: the object name, then chips: engine, health (dot), rows, size (`on disk` or `RAM`) and parts. The header does not show a size of 0 B. A replicated table has a banner right under the header (`Replicated · 2/2 replicas active · queue 0 · delay 0 s`, colored by state). The banner has a link to the Operations tab.
- **Tabs**, in this order. A tab appears only when it has content: `Columns · Preview · Storage · Operations · Lineage · DDL`. The URL has `?tab=` (`?tab=lineage`; no parameter for Columns). Storage (`?tab=storage`) merges the former Parts & disks tab and the table scope of the former Storage mode. Old routes still work. A `/<tab>` path segment opens its tab. `/overview` and `/schema` open Columns. `/data` opens Preview. The page rewrites the address bar to the new form.
- **About** panel beside the tab body. When the pane is narrower than 960 px, the panel sits under the tab body, collapsed to its first tiles. The panel has tiles with a value and a context for these items:
  - The engine (and its arguments, for example the Keeper path and the replica macro of a replicated table).
  - The engine settings (`SETTINGS` of `engine_full`, one for each line; `storage_policy` has its own tile).
  - The MV target or Buffer destination.
  - Size and rows.
  - Compression ratio.
  - Parts and partitions.
  - **Keys**.
  - TTL rules (`observed_at + 30 d → RECOMPRESS ZSTD(3)`).
  - The storage policy and disks.
  - The Keeper path and the replicas.
  - The Distributed local table and cluster.
  - The share of the database and of all databases.
  - The last modification.
  - The lineage counts.
  - "Idle", when there is no operation to show.

  The panel shows every value in full. Long values wrap. These values are settings, paths, UUIDs, expressions and comments. Identifiers and paths wrap anywhere (`overflow-wrap: anywhere`). No value ends in an ellipsis. No tooltip repeats a value that the panel shows.
- **Keys** lists ORDER BY, PRIMARY KEY, PARTITION BY and SAMPLE BY. The list shows PRIMARY KEY only when it differs from the sorting key. If it does not differ, ORDER BY says "also the primary key". Each element is on its own line. The line starts with the 0-based position of the element (`0 service`, `1 toStartOfHour(ts)`). The elements are the top-level items of the key. Commas inside function parentheses, brackets, braces, strings and quoted identifiers do not split an element. One pair of parentheses (or `tuple(...)`) around the whole key is the tuple itself (`keyElements`, `explorerDetail.keyElements`).
- **Expressions** of the card use the highlighter of the Query editor (`renderHighlightedCode`, `highlight`). This highlighter uses the same `.tok-*` classes and theme colors, and the card has no highlighter of its own. These expressions are keys, DEFAULT / MATERIALIZED / ALIAS expressions, column TTL expressions, codecs and TTL rules. They also include engine arguments and settings, skipping index and projection expressions, and mutation commands. Function names need the function list of the host (`meta`). The expressions repaint when that list arrives (`chdash:meta-changed`).

**Columns** is one shared result table. It has these columns:

- Name. The comment is below the name, with two lines at most. The full text is the tooltip.
- Type. The DEFAULT / MATERIALIZED / ALIAS expression is below the type. The column TTL comes after it.
- Key badges show the position of the column in the key. Each badge is on its own line. The badges are `ORDER BY · 0`, `PK`, `PARTITION` and `SAMPLE`. `PK` shows when the primary key differs from the sorting key.
- Codec: only when a column declares its own. About states the default codec of the part one time.
- Compressed and uncompressed bytes (`system.columns` `data_compressed_bytes` / `data_uncompressed_bytes`). Each value has a bar, normalized to the largest column.
- The share of the bytes of the table on disk.

The compression ratio does not fit beside the two sizes at 1440 px. It is the tooltip of the uncompressed cell. About > Compression gives the ratio of the table. The byte columns do not appear for objects without bytes (Views, Distributed).

The **Column sizes** treemap is above the table, and it comes first. It draws the top-level columns (`#explorerColumnTreemap`, three columns of >= 1% at least). It uses compressed or uncompressed bytes. A `Compressed | Uncompressed` switch selects them. The session keeps the switch. The colors follow the type family.

Named Tuple leaf subcolumns appear as dot paths, such as `sensor_packet.station.code`. This happens when ClickHouse gives `subcolumns.*` counters. A disclosure on the Tuple column holds these subcolumns. The page omits the intermediate Tuple containers and the size streams that exist only for the implementation. It counts Array offset streams as one `[offsets]` child. In this way, the children add up to their parent.

**Storage** (MergeTree and Log families) starts with one stacked composition bar. When the required metadata is available, the bar always matches the local `bytes_on_disk` footprint of the table. The backend builds the bar in this way:

- Projection parts use their own `bytes_on_disk`.
- Skipping indexes use the explicit compressed bytes of the secondary index that `system.parts` exposes.
- Each remaining byte of the parent part goes to the Wide or Compact base footprint. The assignment uses the exact `bytes_on_disk` ratio of those active part formats.

This makes Wide + Compact + Projections + Indexes a disjoint 100% decomposition. The bar does not mix compressed data counters with an on-disk denominator. If a required counter is unavailable, the composition shows `unknown`, not a partial bar.

Then come the collapsible sections. Sections with data come first:

- Disks.
- Partitions (the table scope of the former Storage mode). It shows a treemap when three partitions or more hold >= 1% of the table. It then shows Partition, Size, Share bar, Rows and Parts, largest first. It shows the most recent 1000 partitions.
- Parts (Part, Partition, Disk, Rows, Bytes, Marks, Files, Level, Age, State).
- Skipping indexes.
- Projections.

Each piece of information appears once. An empty section shows one muted line ("No projections").

**Operations** holds these sections:

- Replication (key / value list and replica list).
- Replication queue.
- Active merges.
- Mutations (pending first).
- Ingestion.
- For Distributed: Distribution queue and Cluster.

Ingestion is a 2 x 3 grid. It shows rows/s and bytes/s over 1 min, 5 min and 1 h. It shows these values for the client (finished INSERTs in `system.query_log`) and for the persisted writes (new parts in `system.part_log`). It also shows the totals of 1 h. When every rate is zero, the section shows one line: "No writes in the last 1 h". The tab does not appear when none of its sections has data.

**Lineage** lists upstream and downstream objects as chips that wrap. Each chip has these parts:

- The object-type icon.
- The short name for objects of the same database (`db.table` otherwise, with the full name and the link kind in the tooltip).
- The link kind (MV, View, Buffer, or `on <cluster>` for a Distributed route).

Every table numbers its rows from 1. A missing value is one dash.

## Data preview

`POST /api/explorer/table/data` defaults to `LIMIT 100`. It clamps the request to 1–500 rows. The read has a limit of 30 seconds and 64 MiB of result at most (`max_result_bytes` with `result_overflow_mode = 'break'`). A table with very large cells gives fewer rows.

A View, a Distributed table or a table function runs its whole source. For this reason, these bounds matter. Every other statement of the Explorer stops after 10 seconds (`docs/configuration.md`, "The bounds of the queries"). The Preview tab offers 50 / 100 / 500. The browser remembers the choice. The tab shows these items:

- "<n> rows (LIMIT <limit>)".
- The type of each column under its name.
- Compact rows.
- Short UTC timestamps (`2026-09-01 00:00:02`; a non-zero fraction is kept).

The Preview tab shows a single returned row transposed (column, type, value). The backend first lists the columns that the runner can read. It selects only those columns. It never runs an automatic `SELECT count()`. ClickHouse keeps the row policies and its own restrictions in effect.

The backend encodes preview values from native ClickHouse columns into JSON. It uses the encoder of the Query results ("Result values" in `docs/telemetry.md`). The encoder keeps the scalar and nested structure:

- SQL NULL stays null.
- Arrays and tuples are arrays.
- A Map is a list of `[key, value]` pairs in the stored order, whatever its key type. The preview table shows it as an object.
- Enums use their symbolic name.
- 64-bit and wider integers are strings of their digits.
- Decimals are strings at their declared scale (`"0.000000"` for `Decimal(18, 6)`).
- A `JSON` column that arrives as text stays that text. The page reads it without loss.

The backend reads Decimal32/64/128 with their actual physical integer width. This avoids the clickhouse-cpp ItemView width mismatches. One example is `Requested size: 16 stored size: 8` for `Decimal(18,6)`.

**Open in Query** saves the generated SELECT in session storage. It saves the SELECT before the page moves from the Explorer HTML document to the Query document. The Query textarea is not mounted on the Explorer page, so this step is required. The generated SELECT does not repeat the Tuple subcolumns that the Browse storage breakdown uses. Only real top-level table columns go into the query.

## Functions

`GET /api/explorer/functions?host_id=<id>` is a function browser with the scope of the runner. Function discovery is not the same as the technical enrichment of tables. It runs directly with the configured runner context. It never uses `system_uri`.

On the ClickHouse 26.7 target, ChDash prefers `system.documentation`. In this way, the function descriptions match the exact server version. This source has the documentation of scalar functions, aggregate functions and table functions.

The backend also queries `system.functions` with the runner scope. This supplement is for user-defined functions. It is also the fallback when `system.documentation` is unavailable. The UI reports that fallback. It does not silently embed documentation from another ClickHouse version.

The function list groups functions by category. It has one line for each function. Each line has the name. A kind badge (`aggregate`, `table`, `UDF`) appears only when the group does not already show the kind. Each category header shows the number of functions.

The category names come from `system.functions.categories`. The backend uses the kind as the fallback. The list folds spelling variants:

- "Aggregate Functions" and the "Aggregate Function" fallback become **Aggregate**.
- The table-function fallback becomes **Table functions**.
- Uncategorized plain functions join the own **Other** category of ClickHouse.

While no function is selected, the detail pane shows an overview. It never shows a bare placeholder. The overview sits in the center of the pane, at most 820 px wide. It has these parts:

- The catalog size.
- The popular functions that are present on the server (one click opens them).
- The **Categories** grid. It shows every category with its count, the largest first (`#explorerFunctionCategories`). One click expands that group in the list and scrolls to the group. On a phone, one click opens the drawer of the list.

The page of a function keeps its header on the left edge of the pane. Its documentation sits centered under the header, at most 980 px wide. The detail header lists these items:

- The category.
- The kind, when it adds information.
- User-defined.
- The version that introduced the function.

The frontend supports a search by title or name only. It also has a kind filter, a user-defined filter and a safe Markdown detail view. The search does not search the description text. The search order is deterministic:

1. The exact name.
2. The names that begin with the query.
3. The segment-prefix matches.
4. The remaining name substrings.

The backend caches the function catalog, with the descriptions, for each host. The cache lasts for `explorer.function_cache_ttl_ms` (default one hour). The browser reuses the last catalog until an explicit refresh or a host change.

The frontend parses function Markdown into DOM nodes and never injects server documentation as raw HTML. Inline backticks and fenced code blocks get syntax-oriented colors. The default is `explorer.function_markdown_links = false`, which disables Markdown links. In this case, the label stays text, and the frontend discards the URL. If a person explicitly enables the option, only documentation-relative targets that begin with `/` or `./` become clickable. Arbitrary external URLs stay plain text.

The backend resolves documented aliases, such as **Alias of** `groupBitAnd`, before it serializes the function catalog. The response includes the referenced documentation recursively. It has a visited-name cycle guard and a maximum depth of eight. For this reason, the browser does not need to find aliases by itself.

## Graph topology model

`GET /api/explorer/graph?host_id=<id>` returns a normalized topology model. The backend does not send all DDL to the browser. It does not ask JavaScript to infer the schema.

The stable model contains two layers:

- `logical`: ClickHouse tables, views, MVs, and Buffer/Distributed/stream engines.
- `physical`: shards, replicas, and disks. Each one belongs to a logical object that is already authorized.

The same authorized backend model feeds two projections. They are separate on purpose:

- **Lineage** renders only logical objects and logical dependencies.
- **Storage topology** starts from the focused logical object. It walks only its physical descendants (shards, replicas, disks).

For this reason, physical nodes do not accumulate on a lineage neighborhood. These rules apply:

- The model shows local replicated tables as table → local replica → disk.
- The backend deduplicates a physical disk node within the returned database scope. In this way, several authorized tables and replicas can refer to the same disk.
- Distributed tables use `system.clusters` to expose the shard → replica membership.
- The user can increase or decrease the neighborhood depth. The lowest depth is focus-only.

The graph is bounded. The backend makes the topology of a cluster once. This applies whatever the number of Distributed tables that name the cluster. The topology has a node for each shard (`physical:cluster:<cluster>:shard:<n>`) and for each replica (`...:replica:<n>`). It has edges from a shard to its replicas. Each of those tables has an edge to each shard.

The nodes of a cluster belong to no database (`database` is empty). The Storage mode of a database shows the nodes below its own tables. The graph holds at most 20,000 nodes and 40,000 edges. When the nodes of a cluster do not fit, or the shard edges of a table do not fit, the backend leaves that topology out. The table keeps its node, its `topology_badge` (`2S × 3R`) and its definition. The answer has `"truncated": true`.

A node id is `table:<database>.<table>`. When two objects have one id (`a.b` + `c` and `a` + `b.c`), the later one gets the suffix `#2`. The backend finds a node by the names of the object. It uses `database` and `table` on the definition route, and `focus_database` and `focus_table` on the graph route. It never cuts an id at a dot.

The backend builds the adjacency of the graph once for each snapshot (a refresh of the graph). It does not build it for each request. A request only walks the adjacency. A focused lineage costs the size of its scope. It also costs one more level, to show whether the scope has more.

In addition to the global depth, a focused Lineage request can carry expansions for each node. The request repeats the `expand=up:<node id>` / `expand=down:<node id>` parameters, at most 64 times. The expansions work in this way:

- Each expansion adds one semantic hop in one direction from its anchor. The zero-cost rule for hidden View/MV/Buffer intermediates is the same as for the depth.
- The backend applies expansions to a fixed point.
- An anchor that is not shown expands nothing. For this reason, unknown or unauthorized ids are no-ops.
- Every logical node of a focused payload carries `hidden_upstream` / `hidden_downstream`. These are the number of semantic neighbors in that direction that are left outside the sent scope. The browser draws its `+N` controls from them. It does not fetch the next ring.

Table TTL is ordered metadata on the logical table (`ttl_rules`), not backend topology edges. Storage mode projects that metadata onto the physical lifecycle. It does not draw a second TTL timeline beside the table. These rules apply:

- Each ClickHouse volume appears as one **storage tier** card that contains its member disk(s). For this reason, `Volume hot` and `Disk fixture_hot` are a single visual unit.
- In-place actions belong to the tier where they occur.
- The graph always shows TTL timing as **base expression + offset**. It is not only an anonymous `+Nd`.

For example, `observed_at +30d` followed by `RECOMPRESS · ZSTD(3)` appears inside the `hot` tier. This makes two facts clear. The first fact is which Date/DateTime expression is the TTL clock. The second fact is that the data is still on hot storage.

- A `MOVE` rule annotates the transition between tiers (`hot -- observed_at +60d / MOVE → VOLUME warm --> warm`).
- A `DELETE` rule continues from the current tier to an explicit `Expired / data deleted` terminal (`observed_at +365d / DELETE`).

The graph stays clear when a table has several Date/DateTime columns. It also stays clear with several TTL rules that have different base expressions.

Storage mode uses a dedicated placement grammar. It does not use the generic lineage layout. These rules apply:

- The owning table and the first storage tier share the same top edge.
- The graph stacks all volumes of one policy vertically, in priority order.
- An explicit TTL terminal sits to the right of the tier from which data is deleted.
- The routes from table to first tier and from last tier to terminal are straight horizontal segments.
- The transitions between stacked volumes are straight vertical segments.
- A subtle directional marker moves along these physical routes. It does not move when the operating system requests reduced motion. The marker is a cue for the topology direction. It does not show that a TTL move runs at that instant.
- TTL MOVE/DELETE label cards stay fully opaque, focused or unfocused. In this way, the lifecycle text never becomes unreadable over the route.

A **storage policy** is the named ClickHouse configuration that the `SETTINGS storage_policy = '…'` of the table selects. It defines the ordered volumes and disks for that table. TTL rules then set when ClickHouse recompresses the data, moves it between those volumes, or deletes it. The graph shows the policy inside the owning table card. It does not draw the policy as a separate graph node.

`fixture_tiered` is the test policy that this repository ships in its frontend fixture. It has a `hot` volume with `fixture_hot`, and a `warm` volume with `fixture_warm`. It is not a built-in ClickHouse policy name. The table card also shows the TTL base expression and the rule count. The parser accepts both ClickHouse interval forms that `create_table_query` often shows, such as `INTERVAL 30 DAY` and `toIntervalDay(30)`.

In database-scoped **Storage** mode, the canvas contains only logical roots that own persistent physical placement. The Storage canvas leaves out the View/MV/Buffer/Memory-style objects that have no physical storage branch. These objects stay visible in the left object tree when the tree includes non-storing objects.

While Storage mode is active, the View/MV/Buffer entries are gray and not clickable. They keep the default cursor. The eligibility in the sidebar comes from the catalog object type. It does not come from the graph scope that is currently loaded. For this reason, a change of database cannot make persistent tables gray for a short time while the new topology loads.

Lineage layout uses a global row grid that every topological column shares. Barycentric crossing minimization first orders the nodes. Then a constrained row assignment keeps connected nodes on the same row when possible. It permits empty slots. Orthogonal routing reuses those row lanes.

Logical View dependencies prefer the lanes between node rows. In this way, dashed read dependencies do not weave through blue data-flow corridors. Ports stay at a stable top offset on each node. The up/down routes are vertically monotone. The exception is the same-row obstacle case. In that case, the router cannot avoid a short detour.

The graph dependency types are distinct:

- `materialized_view` / `materialized_view_output`: incremental MV trigger and target flow.
- `refreshable_mv` / `refreshable_mv_output`: scheduled refresh input and output.
- `view`: logical read dependency.
- `buffer`: Buffer forwarding.
- `distributed_route`: Distributed routing to its local table definition.
- `dictionary_source`: the table that a dictionary loads from. It is read from `system.tables.loading_dependencies_*` (structured metadata, best effort). A server without those columns loses only these edges.
- `contains`: physical topology membership.

`system.tables.dependencies_database/dependencies_table` is the preferred source for MV relationships. The backend limits targeted parsing to engine arguments. It also limits parsing to identifiers that follow `FROM`, `JOIN`, or `TO`. It parses this way only where ClickHouse metadata does not give the needed destination directly. The backend omits unknown SQL constructs instead of guessing. Before it adds an edge, the backend checks both endpoints of every logical dependency against `AllowedObjectSet`.

When non-storing objects are hidden, the backend contracts View/MV/Buffer chains before it calculates the neighborhood depth. Buffer has an extra semantic rule. Its explicit forwarding destination is the persistent representative of that hidden Buffer. Thus `Buffer → table1` plus `Buffer → MV → table2` projects to `table1 → table2`. Nested Buffers stop at their own forwarding target, so the projection stays a readable chain and does not become a transitive fan-out.

The backend reads `system.clusters` in bulk. It reads only the cluster names that an already authorized `Distributed` table names. Cluster members are topology metadata. The backend never treats them as authorization for another ClickHouse table.

The current physical model keeps byte and rate metrics at their stated `local-replica` scope on purpose. It expands Distributed shard and replica membership, local replica identity, and disks. It does not invent a physical total for the whole cluster. A later change can add accounting of deduplicated logical and physical data for the whole cluster. It uses explicit `clusterAllReplicas` semantics.

## Graph activity overlay

`GET /api/explorer/activity?host_id=<id>` is separate from the stable graph response on purpose. The frontend polls this endpoint at the interval of `explorer.live_refresh_ms`. It shows the activity as an overlay, without a rebuild of the graph.

The overlay can contain these items:

- Read rates and client-write rates from `system.query_log`.
- Persisted part creation from `system.part_log`.
- Replication queue and delay from `system.replicas`.
- Refreshable MV state, timings and counters from `system.view_refreshes`.

Activity sources work on a best-effort basis. A system log that is not available, or that is disabled, does not make the stable topology unavailable.

Only edge types that show real data movement can animate. These rules apply:

- Buffer forwarding and ordinary Materialized View trigger/output edges use one normalized round marker. They show it when they are in the focused neighborhood of depth one, or when the backend observes activity.
- Refreshable MV edges animate only while ClickHouse reports an active refresh.
- A normal `View` is query-time lineage. It never receives a flow animation, because no data flows into the View at insert time.
- All animated Lineage and Storage routes use the same screen-space dot radius and the same velocity in pixels per second. The edge kind, zoom, direction and route length do not change them.

## Graph rendering

**Focus centring** (every kit graph: this graph, the Traces service map and the trace graph): a selection can open the side panel. The panel reduces the visible part of the canvas. The `follow(id)` of the kit centers the selected card in `visibleArea()`. This is the safe area of a fit, clear of the minimap. On desktop, it sits beside the panel, and on phones it sits above the bottom sheet.

The kit centers the card once the size of the panel has settled. It centers the card again whenever that area changes. This happens when the panel grows as its content arrives, when the panel closes, or when the canvas resizes.

"Settled" is event driven. It uses a `ResizeObserver` on the canvas and the panel. It also uses the end of the transitions or animations that run on the panel (`getAnimations()`). It never uses a timer. A pan, a zoom, a fit, a keyboard move or the panel of an edge ends the centring. A fit keeps its own rules (`fitView`, unchanged).

The graph uses a Canvas renderer. It does not use one DOM element for each object. The renderer is the shared graph kit (`app_graph_kit.js`, `ChDash.graphKit`). The same kit draws the Traces service map. In this way, both graphs look and behave the same way. They share these elements:

- A dot grid on `--graph-bg`.
- Rectangular cards.
- Orthogonal edges with a dash pattern for each kind.
- Edge labels that are always visible.
- `−` / fit / `+` icon tools.
- A legend and a status line at the bottom left.
- A minimap at the bottom right.
- A side panel shell.
- Keyboard access.

The canvas is the only view, also on phones. The layout is deterministic and DAG-oriented (`kit.layered`). It has a cycle fallback for schemas whose dependency graph is not acyclic. The UI supports these items:

- All logical objects that the runner can see, with search and focus. There is no database dropdown.
- The Lineage / Storage topology mode appears when both modes are enabled. Otherwise, the graph has one implicit mode.
- Wheel zoom (one factor and one zoom range for every kit graph).
- Pointer pan.
- Fit-to-screen.
- A logical-node selection that stays in step with Browse and the browser route. A click selects the card. Then the kit centers the card in the visible canvas (the `follow()` of the kit, below). It does this once the size of the panel has settled. It does it again when the panel closes. The visible canvas is beside the side panel, or above the bottom sheet on phones. It is clear of the toolbar, the legend / status line and the minimap.
- A hover that outlines the hovered card and highlights its edges, without dimming.
- Node focus and neighbor dimming.
- Keyboard: the canvas is focusable. Arrows move between cards (the first one lands on the selection). Enter selects. `+` / `-` zoom. `0` fits. Escape closes the panel (a live region names the card under the keyboard).
- Search-to-focus.
- A minimap. It shows as soon as any rendered graph card is partly outside the viewport, even a little. For example, this happens with a Fit that opens at the readable scale on the focus.
- A side panel on a node click. It shows the summary, the direct upstream and downstream objects, the definition, the columns, and an **Open card** button to the Browse table card. It also opens on an edge click (see Graph object definitions).
- `+N` / `−` controls for each node and each direction on focused Lineage cards.
- Short edge labels on every Lineage edge (`MV`, `MV output`, `view`, `flush`, `route`, `dictionary`, `×N` between collapsed databases). The renderer places each label once for each routed layout. It uses the first spot along the route that covers no card, no `+N` control and no other label. A hover and a selection only change the style of the labels. A label never moves on top of another label. The renderer leaves out a label without any free spot (`inspect().edgeLabelsDropped`).
- **Up** (the arrow-up icon, the first tool of the graph toolbar, Graph mode only): it selects the parent scope. The parent of a table is its database, and the parent of a database is all databases.
- Level-of-detail rendering, with database groups at very low zoom.

Readability rules:

- Fit (on open, the Fit tool, `0`; `kit.fitView`) works in the area that the toolbar, the legend and the status line leave free. The readable scale draws the smallest canvas font (12px in Lineage, 11px in Tiers) at 11 CSS pixels. These cases apply:
  - A graph that is readable as a whole opens whole.
  - A graph that is only a little too large opens at the readable scale. In that case, its whole view is at least `kit.FIT_READABLE_SHARE` (90 %) of the readable scale, so only a few pixels are clipped. The graph opens with the focused object in view. If there is no focus, it opens at the top-left of the graph. It shows as much of the rest as fits. The minimap shows the rest.
  - A larger graph opens whole, with a slightly smaller text. The text size decreases down to `kit.FIT_FLOOR` (0.25). A graph never opens with a column cut at its edge. Such a cut reads as the end of the graph. Past the floor, the graph opens at the readable scale on the focus.
- The level of detail follows the card on screen. It does not follow the zoom (`kit.isCompact`). Cards show every row while an ordinary card is at least 40 px tall on screen and its smallest text is at least 7.5 px. If either value is lower, every card is compact. A compact card shrinks around its edge ports to the room of its title (`kit.compactBox`, the title drawn larger, 8 to 12 px). The title takes two lines. A long name wraps after its last `_`, `.` or `-` (`weather_alert_` / `target_mv`). It does not end in an ellipsis. A compact card has no edge labels and no `+N` controls. No card is a bare title in an empty frame.
- Routes keep their own lanes. Two parallel segments of two edges that are closer than `LANE_GAP` (12 px at scale 1) cost the router more than a couple of crossings. The fans of a card change in steps of that gap. In this way, dashed edges never double up into a closed frame.
- Cards carry the short name of the object as title and `database · engine` as subtitle. In this way, long database prefixes never truncate the distinctive part.
- Without a focus (all databases, or one database), Lineage collapses each database into one card with its object count. A click expands it in place. Its band header (`▾ db · N of M objects`) collapses it again.

  The graph hides objects without any dependency, and it hides databases that consist only of them. This stays until the user checks **Show objects without dependencies**. The graph aggregates edges between collapsed databases with their count. It always shows a single database expanded.
- Canvas colors come from the `--graph-*` tokens (`src/static/css/00-tokens.css`). They cover both themes. The JavaScript has no color literal. The shared `--accent` is a translucent tint in the light theme. The graph does not use `--accent` for canvas text, edges or the focus halo.
- On phones (width ≤ 760px), Fit opens on the focused object and its neighbors. The scale is `kit.PHONE_MIN_SCALE` (0.7) or more. The focus is always in view. When the whole graph fits at that scale, the whole graph is in view. The rest is a pan away. The toolbar wraps. It is not cut. The side panel is a bottom sheet.

A change of the system or non-storing visibility projection always builds the canonical layout again, from scratch. The graph keeps only the camera anchor. The graph does not put old node coordinates into the new Sugiyama layout. For this reason, repeated ON/OFF/ON visibility toggles return to the same node ordering. They do not add crossing edges that come from stale coordinates.

This keeps schemas with hundreds of objects out of the hot path of DOM rendering.

### Graph edge semantics

Explorer uses three visual edge families:

- **Data flow** — insert-time movement, such as Buffer forwarding and ordinary Materialized View trigger/output paths. A single round marker moves at a constant screen-space speed while the path is active or selected.
- **Logical dependency** — query-time dependencies, such as ordinary Views, and the table that a dictionary loads from (dash-dot). These dashed edges do not animate. A selection of either endpoint adds a subtle blue halo to the dashes.
- **Routing / topology** — structural routing and containment, not row flow. For example, a `Distributed` engine route or the physical storage topology and containment.

Lineage edges are orthogonal routes (`kit.routeEdges`). Each edge has one output port on the right of a card and one input port on its left. The router places the route on the row grid of the layout. The route goes around the other cards. Each route has its own lane past a small fan zone.

The router searches a sparse grid for each edge, with typed arrays and reused buffers. On a database with 2k objects (852 cards, 550 edges), the routing takes about 1.5 s instead of 7 s. When the graph shows objects without dependencies, it takes about 3.6 s instead of 44 s. The routes are the same.

The router finds conflicts in this way. A conflict is an overlap or a crossing with the routes that are already placed:

- It searches them in an index of segments for each line. The index keys vertical segments by x and the others by y. Each A* grid row and column gets its answer from what the index keeps for that line.
- It caches the results for each grid link. It scores them only for links that can still improve their state.
- It scores the route set from the conflicting pairs only. It uses the order of the former pairwise loops. For this reason, the routes are bit-identical.

`kit.routeEdges` also takes a step budget (`maxSteps`, `searchSteps`). Past this budget, the router uses cheap routes. It has a generator form (`kit.routeEdgesSteps`). Frames run it through `kit.runSliced`. The Traces service map uses both. The Explorer keeps the unbounded router.

In **Storage** mode, ordinary non-storing objects stay excluded from the canvas. There is one deliberate exception: the graph shows a `Buffer` as a write-routing stage together with the persistent table that it flushes into. A selection of a Buffer therefore expands automatically to `Buffer → destination table → storage tiers`.

## Graph object definitions

`GET /api/explorer/graph/definition?host_id=<id>&database=<db>&table=<name>` explains one logical graph object for the side panel:

```json
{
  "id": "table:chdash_ui.weather_daily_summary_mv", "kind": "materialized_view",
  "select_sql": "SELECT …", "select_sql_truncated": false,
  "target_visible": true, "target": { "database": "chdash_ui", "table": "weather_daily_summary" },
  "dictionary": null,
  "distributed": null
}
```

- Views and (refreshable) MVs: their `AS SELECT` text (capped at 32 KB) and, for MVs, the `TO` table.
- Buffer: the flush destination (the thresholds are already on the graph node).
- Dictionary: the source table (from `loading_dependencies_*`), the `SOURCE` kind, `LAYOUT` and `LIFETIME`. The route never extracts the host, user, port and masked password of `SOURCE(...)`.
- Distributed: cluster, local table, sharding key, and shard × replica counts.

The route uses the same snapshot as `/api/explorer/graph`. This means runner ACL discovery comes first. Then comes system-context enrichment, for those objects only. The route answers from the cached graph:

- The request runs no SQL.
- An object outside `AllowedObjectSet` is `404 unknown_object`.
- The response reports a destination outside the set only as `target_visible: false`. It never reports it by name.

The texts are the DDL of the object itself. The exposure is the same as in the Browse DDL tab. The side panel of an edge shows the definition of the object that defines the edge. That object is one of these objects:

- The MV, for trigger/output edges.
- The View that the edge feeds.
- The Buffer or Distributed table that forwards.
- The dictionary that loads.
- Every hidden object of a contracted edge.

## Replication metadata and Keeper load

`system.replicas` serves `queue_size`, `absolute_delay`, `is_readonly` and `is_session_expired` from memory. But `total_replicas` / `active_replicas` cost one Keeper request for each replicated table. The backend rebuilds the graph catalog every few seconds while the graph is open. For this reason, it reads only the in-memory columns on every build.

The backend caches the replica counts behind the `nR` badge and the "inactive replica" warning for each server for 60 s. The backend reads them again only for new tables or expired entries. The backend limits this read to the shown databases. Problems of a local replica (read-only, expired Keeper session, queue, delay) appear at once. A remote replica that goes down appears within 60 s. The table detail always reads fresh counts for the opened table.
