# Explorer

Explorer is an inspection surface with the scope of the runner. It is not an administrative bypass over ClickHouse permissions.

## Security flow

Explorer has no application-level user authentication. Every request for a host shares the configured runner permissions of that host.

For every Explorer request, these steps apply:

1. The runner context discovers databases and tables. It verifies `SELECT` access, including column-scoped grants when whole-table `SELECT` is not available.
2. The resulting `AllowedObjectSet` is the visibility boundary.
3. The system context can enrich only objects that are already in that set.
4. The backend filters dependencies against the same set before it serializes their names.
5. Data preview and function discovery run with the runner context. They never run with the system context.

The caches of Explorer for ACL, catalog, graph and functions have the scope of the configured host and runner context. `refresh=1` invalidates the relevant caches. In this way, the user can observe changed ClickHouse grants or metadata.

The important invariant is this: `system_uri` is for enrichment only. It never authorizes an object. It never runs SQL that a panel caller supplies. If different callers need different ClickHouse ACLs, they must use distinct deployments or hosts that use different runners. Do this outside ChDash.

## Shell and navigation

The Explorer shell has one nav row (48 px, `#explorerTopBar`). The nav row has one underline tab row (`#explorerNavTabs`) with the view tabs `Catalog | Functions`. On the Catalog only, it also has a divider and its `Browse | Graph` tabs (`#explorerModeTabs`, `?mode=graph`). These are the second-level sections of docs/ui-foundations.md ("Tabs"), like the Search / Services / Service map of Observability after Traces / Logs / Metrics. Each of the two rows is an `ns.tabs` tablist (Left / Right / Home / End within it).

There is no breadcrumb. In the Catalog, the tree selection carries the location, and the card header names the object. On a narrow window, the row scrolls sideways with its edge cues, after the drawer button. It never wraps.

The **Catalog** is one view. It has the object tree on the left, and two modes of the same scope. The scope is the tree selection (nothing, a database or an object):

| Mode | Nothing selected | A database | An object | Container |
| --- | --- | --- | --- | --- |
| Browse | the databases overview (a treemap of the databases, then the overview table) | the database page (Tables by size, then its objects, then its disks) | the table card (Columns, Preview, Storage...) | `#explorerCatalogView` (`#explorerDetailPane`) |
| Graph | all databases | the database topology | the object's neighborhood | `#explorerGraphPane` |

A switch of the mode keeps the selection. These actions move the tree selection, so that the other mode follows:

- A pick in the tree.
- A node click in the graph.
- A rectangle of a storage treemap (the one of the databases overview, or the one of a database page).

The first row of the tree is **All databases (8)** (`#explorerTreeRoot`). It is a database row with the stack icon and the count of the databases that the tree shows, with its search and chips applied. It is a button that the user reaches with Tab. It opens the root. It is marked current (`aria-current="true"`, the selected row look) while nothing is selected.

In Graph, an **Up** button next to the modes selects the parent scope (`↑ chdash_ui`, `↑ All databases`). The **Open card** button of Graph switches to Browse on that object. Graph never fetches the card. Browse loads it when it shows it.

Storage is not a mode. It is a tab of the table card and the lower part of the database page. The database page has no tabs (see *Database inventory* and *Table card*). The catalog root draws the databases as a treemap above the databases overview and has no tabs.

One URL scheme covers the Catalog. Back / forward walk modes, scopes and card tabs:

| Address | Opens |
| --- | --- |
| `/explorer[/<db>[/<table>]][?tab=<tab>]` | Browse (the default mode); `tab` the table card's tab, omitted for the first one (Columns); a database page has no tabs |
| `/explorer[/<db>[/<table>]]?mode=graph&graph=lineage\|storage&depth=N` | Graph (`graph=storage` is the type labeled **Tiers**) |
| `/explorer/_functions[/<name>]` | Functions (`#explorerFunctionsPane`) |

The former addresses stay as aliases. The Explorer rewrites them to the form above:

- `?view=browse` and `?view=graph` (the former Browse / Graph views).
- `?mode=storage` (the former Storage mode).
- `/explorer/_system[?database=<db>[&table=<t>]]` (the former Storage view).

The last two open the Storage tab of the table card, the database page scrolled to its storage, and the databases overview at the root. These aliases also stay:

- The former database card tabs (`/explorer/<db>?tab=storage|objects`: the database page, scrolled to its storage for the first).
- The card tab as a path segment (`/explorer/<db>/<table>/<tab>`).
- The former card tab slugs (`overview`, `schema`, `data`).
- `/explorer/functions` and `/explorer/databases`.

`docs/ui-foundations.md` ("Routes") describes the scheme of every page. The Explorer writes its address through `ns.router` while its workspace shows.

`ns.explorer.setView(view)` switches views programmatically. It also accepts a mode (`"browse"`, `"graph"`). `"storage"` opens Browse on the storage of the selection (the Storage tab of the table card, or the database page scrolled to it). The modes that `explorer.browse` / `explorer.graph` disable are hidden. A disabled mode falls back to the first available one.

The health of the selected server is not an Explorer view. This health includes its tiles, cluster, performance history, background activity, top queries and disks. It is the **System** page (`/system[/<section>]`, see [System](system.md)). The Explorer loads none of its modules. The former Monitoring tab (`/explorer/_monitoring[/<section>]`) and the former Server operations view (`/explorer/_operations`) answer a redirect to the matching System address. With `system.enabled = false`, they open the Catalog.

The object tree shows one line for each object. A line has these parts:

- A type icon (table, Distributed, Buffer, Memory, view, materialized view, dictionary).
- The name.
- A health dot for warning and error tables.
- A size on the right, as a plain muted figure. It shows bytes only. `RAM` follows what Memory, Buffer and dictionaries hold in memory. Views and a Buffer with no measurable memory show nothing. The shares are in the databases overview and in the database page.

A database row shows its bytes. Its object count is in its tooltip. The tree cuts a long name in the middle, on its last `_`, `.` or `-` when there is one. In this way, the end of the name stays readable (`chdash_rich…_scratch2`). The whole name is in the title. Engine, rows and size are in the row tooltip.

An address can name a database or a table that the host does not show. It opens a **Database not found** / **Table not found** page (*All databases*, *Refresh*, and the database for a table). It never adds a row to the tree. On a phone, the tree is a drawer that opens from its toggle. It never opens on its own over the page.

With nothing selected, Browse shows the **databases overview**. It lists every database that the tree lists (the System chip adds the system ones). For each database, it shows the objects, rows, size on disk and share of the listed databases, from the database summaries of the catalog. A name opens the database page. The search has these effects:

- It filters by `database.name engine`.
- It highlights the matches.
- It drops the loaded databases without a match.
- It shows the matching branches open.

The chips under the search filter the object types: Tables, Views, MV, Dict and System (system databases). The chip of the type of the selected object stays pressed and locked. The System chip does the same for a system object. In this way, a filter never hides a selection. The non-storing projection of the graph follows the chips (Views or MV on = non-storing objects included). The filters persist in `chdash.explorer.typeFilters.v1` and `chdash.explorer.includeSystem`.

The tree and the Functions list have no head bar (no title, count or fold toggle). They never fold to a rail. Their head is the search with its refresh icon button at the right end of the same line, then the chips.

On narrow screens (820 px and below), the tree is a drawer. It opens with the Objects button of the navigation bar, in every Catalog mode. It opens under the nav row, so that the modes stay in reach. A pick of an object (or of a root row) closes it. Escape or a press outside closes it too. The Functions list is also a drawer. The same button opens it (then named Functions).

The Functions list pane mirrors the tree pane. It has the same width, a search box with the refresh button, and chips under it (Functions, Aggregate, Table, UDF). Only one kind is active at a time. A press on the pressed chip lists every function. Its first row is **All functions (1,949)** (`#explorerFunctionRoot`, the function icon and the count of the functions listed). It returns to the Functions overview (the categories and the popular functions). It is current while no function is selected, like All databases.

### Number formats and shared tokens

Every Explorer number goes through the helpers at the top of `app_explorer.js`. They are also exposed as `ns.explorerFormat` for the other Explorer modules:

- `fmtInt`: `120,064` (en-US grouping, as `util.formatInt` elsewhere in the app).
- `fmtCompactInt`: `120.1K`, `3.2M`, `1.5B`.
- `fmtBytes` / `fmtStorageBytes`: `0 B`, `205 B`, `1.7 KB`, `10.3 MB`. From KB up, they use one decimal and base 1024. The precision is the same in the tree, treemaps and tables.
- `fmtRate`, `fmtPercent`. A missing value is always `—` (`MISSING`).

`src/static/css/00-tokens.css` defines the Explorer tokens (`--explorer-table-font` 13px, `--explorer-table-head-font` 12px, `--explorer-section-title-size` 13.5px / `--explorer-section-title-weight` 600, `--explorer-mono`). It also defines the shared in-cell bar: `class="explorerBar"` with `style="--bar-pct: 42%"` (callers normalize to the column maximum), plus `explorerBar--cell` on result-table cells. The bar uses `--explorer-bar-color` at `--explorer-bar-alpha` (35%) in both themes.

## List catalog

`GET /api/explorer/catalog?host_id=<id>` returns only readable objects. The optional `database=<name>` filters the response after authorization.

The catalog uses bulk reads of `system.tables`, `system.parts`, `system.query_log`, `system.part_log`, `system.replicas` and `system.disks`. The collection of the catalog is fail-closed. If the API cannot read required technical metadata, it returns an explicit Explorer error. It does not silently replace metrics with empty or zero values. `INFORMATION_SCHEMA`/`information_schema` are excluded at the runner ACL boundary and at the technical metadata boundary. They are compatibility namespaces, not user Explorer objects.

The lazy catalog for each database (`database=<name>`) also returns `disks`. These are the local disks where the active parts of the database are. Each disk has `name`, `host_name`, `path`, `type`, the `bytes` of the database on it, `free_space` and `total_space`. They come from one `system.parts` `GROUP BY disk_name` of that database and from `system.disks`. The database page lists them under its objects.

The current List metrics have the explicit label `local-replica`. ChDash does not multiply local part bytes by replica counts. It does not claim that a `Distributed` table stores the underlying data itself.

Client ingress and persisted writes stay separate:

- **Client ingress** comes from finished writes in `system.query_log`.
- **Physical writes** come from new parts in `system.part_log`.

MV output and Buffer forwarding are not folded into a single ambiguous rate.

## Database inventory

The **Databases** Explorer section uses the same authorized catalog. Each database summary contains these items:

- The number of visible tables.
- The visible rows.
- The visible local bytes.
- The local disks that these visible tables actually use.

Disk rows include `hostName()`, the disk name and path, and the bytes that belong to the database. They also include the capacity (free and total) that the server reports.

This inventory reports the current technical metadata host on purpose. It does not invent remote disk capacity for cluster replicas that the backend did not query. Storage topology represents the shard and replica membership of a `Distributed` table through `system.clusters`. The remote disk accounting is explicitly out of scope until somebody configures a safe metadata query for the whole cluster. A click on a table in a database page opens the normal Explorer route of that table.

The database page (Catalog, a database selected) shows `N objects · size`. Then it shows an **Objects** table (Name, Engine, Rows, Size, Compressed, Ratio, % database, Parts, Modified). Then it shows its storage. The table has these properties:

- It lists the objects that the type chips let through.
- It uses the shared number formats (grouped rows, one-decimal bytes, `—` for absent values).
- It draws in-cell bars on Rows, Size, Compressed and % database. Each bar is normalized to its column maximum.
- The Ratio tooltip has the uncompressed bytes.
- Long names and engines are clipped with a tooltip. In this way, the table fits a 1280 px window without horizontal scrolling.
- Modified shows minutes (the full timestamp is the tooltip).

A database without objects shows one empty state (no tabs).

The database page has no tabs (user, 2026-10-04). It shows the object table above and its storage (*Storage*) after it. It shows the storage when something of the database is stored on disk or in RAM. No figure repeats:

- The header counts the objects and the bytes.
- The Objects head has no count.
- The **Tables by size** head counts only the tables with data (the RAM total is in the footnote).

The former `?tab=storage` address opens the page with its storage scrolled into view. The Explorer writes it back as `/explorer/<db>`.

The catalog root (**All databases**) draws the size band of the visible databases (the component of the System Overview, `ns.explorerTreemap.band`, `app_explorer_treemap.js`; docs/ui-foundations.md, "Size bands"). The band is always a treemap (`#explorerDatabasesTreemap`, `strip: "never"`). The database rectangles use the on-disk bytes. Those under 1% are grouped into Others, on its chip and in the legend. This is true for any distribution. The band has the height of the size band. A rectangle opens that database. The band sits above the overview table. Both are under one **Databases** head without a count (the header has it).

## Storage

The place of the bytes is part of the pages. It is not a view of its own (the former Storage mode of the Catalog).

**Size views, one order**: a size band and the table that it sizes can sit together. A size band is a treemap capped at `--sizemap-h`, 180 px, or the share strip where the rules of the band say so. In this case, the band comes first, then the table. This applies to these pages:

- All databases (the databases treemap, then the overview table).
- The database page (Tables by size, then Objects).
- The Columns tab (Column sizes, then the columns).
- The Storage tab (the partitions map, then the partitions).

The System pages follow the same order (the databases treemap of the Overview, and the strip of each disk above its databases).

| Page | Storage |
| --- | --- |
| database (`/explorer/<db>`, above its objects) | a treemap of its tables (or a share strip), the accounting footnote; the disks it uses, under the objects |
| table (`/explorer/<db>/<t>?tab=storage`) | composition, disks, partitions (treemap + share list), parts, skipping indexes, projections (*Table card*) |

The database page draws its tables as a treemap (`#explorerDatabaseTreemap`, `--sizemap-h` high, 180 px) when two conditions are true. At least three tables hold >= 1% of the database (`TREEMAP_MIN_ITEMS`). And none holds more than 85% of it. Otherwise, it draws one share strip (`#explorerDatabaseStorageStrip`: each table >= 1% plus one Others segment, with a one-line legend). In this way, a database where one table holds 99.9% of the bytes reads as such. It does not read as one full block. A rectangle or a strip segment opens that table on its own Storage tab.

Under the treemap, the Objects table lists every object with its size, share and parts. For this reason, the storage has no second list of the same rows. Then the **Disks** table follows (`#explorerDatabaseDisks`: disk, path, type, the size of the database on it, free space and capacity). It comes from the `disks` of each database of the catalog. The partitions treemap of the table tab (`#explorerPartitionTreemap`) and the column size map of the Columns tab (`#explorerColumnTreemap`) are the same band. They have the same height and follow the same rule (nothing drawn under three cells of >= 1%).

The byte accounting is the same local on-disk accounting as the summaries of the database header and of the sidebar (`metric_scope = local-replica`):

- `bytes_on_disk` of active parts for MergeTree families.
- `system.tables.total_bytes` for Log-family and other disk engines.

Memory, Buffer and Dictionary objects report resident RAM (`isResidentMemorySummary`). If the page drew RAM as disk area, the views would disagree with the database total. For this reason, the areas exclude resident bytes. The page reports them separately (footnote, section head). The page does not draw views and other objects without bytes.

Grouping and layout follow the S3-Browser folder treemap:

- The threshold is `ceil(1%)` of the displayed root. The treemap applies it with that absolute value at every level. It merges smaller siblings into one **Others** node (name, exact size and member count, in the own word of the members: tables, partitions or columns). It always keeps the members.
- A level with a single real child is contracted into that child. A sole Others child is dropped (the parent already carries the totals).
- The layout is squarified. Others is a proportional bottom strip. It grows only to the height that its label needs. The treemap has at most 1000 rectangles and 5 levels. A hover highlights a rectangle. The tooltip shows size, rows/engine (type for a column) and share of the root.
- The labels are fitted for each rectangle (full, compact, tiny). A sliver keeps a rotated label when it is at least 12 x 48 px. It keeps a one-line label when it is at least 60 x 13 px. Otherwise, it gets an edge mark (`is-sliver`). In this way, a 1% table never reads as part of its neighbor. Labels use the text face, not monospace.

The grouping runs in the browser on data that the card already holds (the catalog of each database that the sidebar loaded, the table detail). For this reason, one implementation (`app_explorer_treemap.js`) serves every drawing. Databases, tables and partitions have one accent tint (no color from a name). Columns take the hue of their type family (numbers, dates and times, strings, arrays / maps / tuples / JSON, other types). The legend under the map names the families. Others is hatched, its label is on a solid chip, and it is an item of the legend.

`app_explorer_storage.js` draws them:

- `ns.explorerStorage.renderDatabase(container, { root, residentBytes, name, disks, onOpen })` draws the database tab.
- `renderTreemap(container, { tree, name, id, stripId, ariaLabel, className, scopeLabel, measure, unit, resident, onOpen, minItems, fallback })` draws a size band (`ns.explorerTreemap.band`) with its legend and footnote. It returns `null` in one case: fewer than `minItems` (three) rectangles of >= 1% would show, and `fallback` is `"none"`. Its `setTree(tree, { measure })` redraws it for another measure.

`GET /api/explorer/storage?host_id=<id>[&refresh=1]` (the server-wide distribution of the former Storage view) stays an API endpoint. The UI no longer calls it.

Object names come only from runner-context discovery (`discover_visible_databases` / `discover_visible_objects`, the same boundary as the lazy sidebar). The system context then contributes counters only for those names. It uses these two queries:

- One aggregated `system.parts` query (`active`, `GROUP BY database, table`, `database IN (<visible databases>)`).
- One `system.tables` query for the engine identity and the non-MergeTree totals.

Both are metadata reads. The multi-billion-row OTEL fixture costs the same as a small table. The backend issues no `SYSTEM FLUSH`. The Explorer StaleCache TTL (`explorer.cache_ttl_ms`) caches the response. `refresh=1` (and a global catalog refresh) invalidates it.

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

`tables` lists only storing tables, largest first, bounded to 128 for each database. The bound loses nothing for every treemap that the UI can draw. At most 100 siblings can each hold 1% of their parent, and the treemap groups everything smaller into Others. The response still reports the remainder exactly through `omitted_*`. For this reason, `bytes` always equals the listed bytes plus the omitted bytes.

## Table detail

`GET /api/explorer/table?...` can return these items, when the corresponding system table is available:

- Columns from `system.columns`: type, `default_kind` / `default_expression`, `comment`, key membership (`is_in_partition_key`, `is_in_sorting_key`, `is_in_primary_key`, `is_in_sampling_key`), codec, and compressed and uncompressed bytes for each column.
- The table keys and the storage policy from `system.tables` (`sorting_key`, `primary_key`, `partition_key`, `sampling_key`, `storage_policy`, `metadata_modification_time`), and `table_ttl`. `table_ttl` is the top-level TTL clause of `create_table_query`. Column TTLs, inside the column list, are not part of it.
- The storage policy, and the local storage by disk and capacity for the disks that the table uses.
- Active and inactive parts, including the ClickHouse 26.7 `files` count.
- Partitions.
- Skipping indexes and projections.
- Mutations and active merges.
- The local replication state:
  - Replica counts.
  - Queue size and its split into inserts and merges.
  - Delay.
  - Log entries left to fetch.
  - Flags for leader, read-only and Keeper session.
  - `replicas` (every replica that is registered for the table and whether it is active, from `replica_is_active`).
  - The replication queue.
- The Distributed cluster members, which the backend resolves from the cluster argument of the engine and from `system.clusters`. Also the local `system.distribution_queue` backlog and error state, and `distributed: {cluster, database, table}` (the engine arguments, already part of `engine_full`).
- Structured dependencies that the security filter has processed. Each has `kind` (`materialized_view`, `view`, `buffer`, `distributed_route` or `dependency`) and the `engine` of the related object.
- DDL.

The additions read only the opened object (`database = ... AND table = ...`):

- `system.columns` gains five columns in the existing query.
- `replica_is_active` costs the same Keeper reads as `total_replicas` / `active_replicas`, which the detail already pays.
- The dependency engines come from one `system.tables` read. It is filtered on the dependency names that are already visible.
- If a server does not have one of the extra replica columns, the backend reads the base replica row instead.

Missing optional system metadata is represented through `unavailable_sections`. The page degrades. It does not fail globally.

The lazy catalog for each database (`/api/explorer/catalog?database=<name>`) marks replicated tables with `replicated: true` and their local `health`. The health is error for a read-only table or an expired Keeper session. It is warning for a queue above 1000 or a delay above 60 s. The catalog reads it from the in-memory `system.replicas` columns only. For this reason, the navigation refresh of 5 s never waits on Keeper. The tree draws it as a dot next to the name.

### Table card

The detail is a card (`app_explorer_detail.js`, created by `app_explorer.js` with its model and shared helpers). It has these parts:

- **Header**: the object name, then chips: engine, health (dot), rows, size (`on disk` or `RAM`) and parts. The header does not show a size of 0 B. A replicated table gets a banner right under the header (`Replicated · 2/2 replicas active · queue 0 · delay 0 s`, colored by state). The banner has a link to the Operations tab.
- **Tabs**, in this order and only when they have content: `Columns · Preview · Storage · Operations · Lineage · DDL`. The URL has `?tab=` (`?tab=lineage`; none for Columns). Storage (`?tab=storage`) merges the former Parts & disks tab and the table scope of the former Storage mode. Old routes keep working. A `/<tab>` path segment opens its tab. `/overview` and `/schema` open Columns. `/data` opens Preview. The address bar is rewritten to the new form.
- **About** panel beside the tab body. It is under the tab body, collapsed to its first tiles, when the pane is narrower than 960 px. The panel has tiles with a value and a context for these items:
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

  The panel shows every value whole. Long values (settings, paths, UUIDs, expressions, comments) wrap. Identifiers and paths wrap anywhere (`overflow-wrap: anywhere`). Nothing ends in an ellipsis. No tooltip repeats a value that the panel shows.
- **Keys** lists ORDER BY, PRIMARY KEY, PARTITION BY and SAMPLE BY. PRIMARY KEY is listed when it differs from the sorting key. Otherwise, ORDER BY says "also the primary key". It shows one element on each line after its 0-based position (`0 service`, `1 toStartOfHour(ts)`). The elements are the top-level items of the key. Commas inside function parentheses, brackets, braces, strings and quoted identifiers do not split. One pair of parentheses (or `tuple(...)`) around the whole key is the tuple itself (`keyElements`, `ns.explorerDetail.keyElements`).
- **Expressions** of the card are colored by the highlighter of the Query editor (`renderHighlightedCode`, `ns.highlight`). It uses the same `.tok-*` classes and theme colors. It has nothing of its own. The expressions are keys, DEFAULT / MATERIALIZED / ALIAS expressions, column TTL expressions, codecs, TTL rules, engine arguments and settings, skipping index and projection expressions, and mutation commands. Function names need the function list of the host (`ns.meta`). The expressions repaint when it arrives (`chdash:meta-changed`).

**Columns** is one shared result table. It has these columns:

- Name: the comment is below it, two lines at most, with the full text as tooltip.
- Type: the DEFAULT / MATERIALIZED / ALIAS expression is below it, then the column TTL.
- Key badges with the position of the column in the key, one on each line. The badges are `ORDER BY · 0`, `PK`, `PARTITION` and `SAMPLE`. `PK` shows when the primary key differs from the sorting key.
- Codec: only when a column declares its own. About states the default of the part once.
- Compressed and uncompressed bytes (`system.columns` `data_compressed_bytes` / `data_uncompressed_bytes`), each with a bar normalized to the largest column.
- The share of the bytes of the table on disk.

The compression ratio does not fit beside the two sizes at 1440 px. It is the tooltip of the uncompressed cell (About > Compression gives the ratio of the table). The byte columns are hidden for objects without bytes (Views, Distributed).

Above the table (the size band first), **Column sizes** draws the top-level columns as a treemap (`#explorerColumnTreemap`, three columns of >= 1% at least). It uses compressed or uncompressed bytes (a `Compressed | Uncompressed` switch, kept for the session). The colors follow the type family.

Named Tuple leaf subcolumns are exposed as dot paths such as `sensor_packet.station.code`. This happens when ClickHouse provides `subcolumns.*` counters. They are behind a disclosure on the Tuple column. The page omits intermediate Tuple containers and size streams that exist only for the implementation. It accounts Array offset streams as one `[offsets]` child. In this way, the children add up to their parent.

**Storage** (MergeTree and Log families) starts with a single stacked composition bar. The bar always reconciles to the local `bytes_on_disk` footprint of the table when the required metadata is available. The bar is built in this way:

- Projection parts use their own `bytes_on_disk`.
- Skipping indexes use the explicit compressed bytes of the secondary index that `system.parts` exposes.
- Every remaining byte of the parent part is assigned to the Wide or Compact base footprint. The assignment uses the exact `bytes_on_disk` ratio of those active part formats.

This makes Wide + Compact + Projections + Indexes a disjoint 100% decomposition. It does not mix compressed data counters with an on-disk denominator. If any required counter is unavailable, the composition is rendered as `unknown`. It is not rendered as a partial bar.

Then collapsible sections come, those with data first:

- Disks.
- Partitions (the table scope of the former Storage mode). It shows a treemap when three partitions or more hold >= 1% of the table. Then it shows Partition, Size, Share bar, Rows and Parts, largest first. It shows the most recent 1000 partitions.
- Parts (Part, Partition, Disk, Rows, Bytes, Marks, Files, Level, Age, State).
- Skipping indexes.
- Projections.

Each piece of information appears once. Empty sections are listed on one muted line ("No projections").

**Operations** holds these sections:

- Replication (key / value list and replica list).
- Replication queue.
- Active merges.
- Mutations (pending first).
- Ingestion.
- For Distributed: Distribution queue and Cluster.

Ingestion is a 2 x 3 grid. It shows rows/s and bytes/s over 1 min, 5 min and 1 h. It shows them for the client (finished INSERTs in `system.query_log`) and for the persisted writes (new parts in `system.part_log`). It also shows the totals of 1 h. When every rate is zero, it is the line "No writes in the last 1 h". The tab is hidden when none of its sections has data.

**Lineage** lists upstream and downstream objects as wrapping chips. A chip has these parts:

- The object-type icon.
- The short name for objects of the same database (`db.table` otherwise, with the full name and the link kind in the tooltip).
- The link kind (MV, View, Buffer, or `on <cluster>` for a Distributed route).

Every table numbers its rows from 1. Missing values are one dash.

## Data preview

`POST /api/explorer/table/data` defaults to `LIMIT 100`. It clamps the request to 1–500 rows. The Preview tab offers 50 / 100 / 500 (the browser remembers the choice). It shows these items:

- "<n> rows (LIMIT <limit>)".
- The type of each column under its name.
- Compact rows.
- Short UTC timestamps (`2026-09-01 00:00:02`; a non-zero fraction is kept).

A single returned row is shown transposed (column, type, value). The backend first enumerates the columns that the runner can read. It selects only those columns. It never does an automatic `SELECT count()`. Row policies and ClickHouse-side restrictions therefore stay in effect.

The backend encodes preview values from native ClickHouse columns into JSON. It preserves the scalar and nested structure:

- SQL NULL stays null.
- Arrays and tuples are arrays.
- Maps with string keys are objects.
- Enums use their symbolic name.
- Decimals are emitted at their declared scale.

The backend reads Decimal32/64/128 with their actual physical integer width. This avoids the clickhouse-cpp ItemView width mismatches, such as `Requested size: 16 stored size: 8` for `Decimal(18,6)`.

**Open in Query** persists the generated SELECT in session storage before it moves from the Explorer HTML document to the Query document. This is required, because the Query textarea is not mounted on the Explorer page. The generated SELECT does not duplicate the Tuple subcolumns that the Browse storage breakdown uses. Only real top-level table columns are opened.

## Functions

`GET /api/explorer/functions?host_id=<id>` is a function browser with the scope of the runner. Function discovery is different from the technical enrichment of tables. It runs directly with the configured runner context. It never elevates to `system_uri`.

On the ClickHouse 26.7 target, ChDash prefers `system.documentation`. In this way, the function descriptions match the exact server version. It includes the documentation of scalar functions, aggregate functions and table functions. The backend queries `system.functions` as a supplement with the runner scope. The supplement is for user-defined functions. It is also the fallback when `system.documentation` is unavailable. The UI reports that fallback. It does not silently embed documentation from another ClickHouse version.

The function list groups functions by category. It has one line for each function. The line has the name. It has a kind badge (`aggregate`, `table`, `UDF`) only when the group does not already say the kind. Each category header shows the number of functions.

The category names come from `system.functions.categories`, with the kind as the fallback of the backend. The list folds spelling variants:

- "Aggregate Functions" and the "Aggregate Function" fallback become **Aggregate**.
- The table-function fallback becomes **Table functions**.
- Uncategorized plain functions join the own **Other** of ClickHouse.

While no function is selected, the detail pane shows an overview. It does not show a bare placeholder. The overview is centered in the pane (at most 820 px wide). It has these parts:

- The catalog size.
- The popular functions that are present on the server (one click opens them).
- The **Categories** grid. It shows every category with its count, the largest first (`#explorerFunctionCategories`). One click expands that group in the list and scrolls to it. On a phone, it opens the drawer of the list.

The page of a function keeps its header on the left edge of the pane. It centers its documentation under the header (at most 980 px wide). The detail header lists these items:

- The category.
- The kind, when it adds information.
- User-defined.
- The version that introduced the function.

The frontend supports a search by title or name only, a kind filter, a user-defined filter and a safe Markdown detail view. The search does not search the description text. The search order is deterministic:

1. The exact name.
2. The names that begin with the query.
3. The segment-prefix matches.
4. The remaining name substrings.

The backend caches the function catalog (including descriptions) for each host for `explorer.function_cache_ttl_ms` (default one hour). The browser reuses the last catalog until an explicit refresh or a host change.

The frontend parses function Markdown into DOM nodes. It never injects server documentation as raw HTML. Inline backticks and fenced code blocks receive syntax-oriented coloring. Markdown links are disabled by default through `explorer.function_markdown_links = false`. In this case, the label stays text and the frontend discards the URL. If somebody explicitly enables the option, only documentation-relative targets that begin with `/` or `./` become clickable. Arbitrary external URLs stay plain text.

The backend resolves documented aliases such as **Alias of** `groupBitAnd` before it serializes the function catalog. The response includes the referenced documentation recursively. It has a visited-name cycle guard and a maximum depth of eight. For this reason, the browser does not need to do alias discovery itself.

## Graph topology model

`GET /api/explorer/graph?host_id=<id>` returns a normalized topology model. The backend does not ship all DDL to the browser. It does not ask JavaScript to infer the schema.

The stable model contains two layers:

- `logical`: ClickHouse tables, views, MVs, and Buffer/Distributed/stream engines.
- `physical`: shards, replicas, and disks that are attached to a logical object that is already authorized.

The same authorized backend model feeds two projections. They are separate on purpose:

- **Lineage** renders only logical objects and logical dependencies.
- **Storage topology** starts from the focused logical object. It walks only its physical descendants (shards, replicas, disks).

For this reason, physical nodes do not accumulate on top of a lineage neighborhood. These rules apply:

- Local replicated tables are represented as table → local replica → disk.
- The backend deduplicates a physical disk node within the returned database scope. In this way, multiple authorized tables and replicas can point to the same disk.
- Distributed tables use `system.clusters` to expose the shard → replica membership.
- The user can increase or decrease the neighborhood depth down to focus-only.

On top of that global depth, a focused Lineage request can carry expansions for each node. These are repeated `expand=up:<node id>` / `expand=down:<node id>` parameters (at most 64). The expansions work in this way:

- Each expansion adds one semantic hop in one direction from its anchor. The zero-cost rule for hidden View/MV/Buffer intermediates is the same as for the depth.
- The backend applies expansions to a fixed point.
- An anchor that is not shown expands nothing. For this reason, unknown or unauthorized ids are no-ops.
- Every logical node of a focused payload carries `hidden_upstream` / `hidden_downstream`. These are the number of semantic neighbors in that direction that are left outside the shipped scope. The browser draws its `+N` controls from them. It does not fetch the next ring.

Table TTL is represented as ordered metadata on the logical table (`ttl_rules`). It is not represented as backend topology edges. Storage mode projects that metadata onto the physical lifecycle. It does not draw a second TTL timeline beside the table. These rules apply:

- Each ClickHouse volume is rendered as one **storage tier** card that contains its member disk(s). For this reason, `Volume hot` and `Disk fixture_hot` are a single visual unit.
- In-place actions are attached to the tier where they happen.
- TTL timing is always shown as **base expression + offset**. It is not only an anonymous `+Nd`.

For example, `observed_at +30d` followed by `RECOMPRESS · ZSTD(3)` is rendered inside the `hot` tier. This makes two facts explicit. The first fact is which Date/DateTime expression is the TTL clock. The second fact is that the data is still on hot storage.

- A `MOVE` rule annotates the transition between tiers (`hot -- observed_at +60d / MOVE → VOLUME warm --> warm`).
- A `DELETE` rule continues from the current tier to an explicit `Expired / data deleted` terminal (`observed_at +365d / DELETE`).

This stays unambiguous when a table contains several Date/DateTime columns. It also stays unambiguous with several TTL rules that have different base expressions.

Storage mode uses a dedicated placement grammar. It does not use the generic lineage layout. These rules apply:

- The owning table and the first storage tier share the same top edge.
- All volumes of one policy are stacked vertically in priority order.
- An explicit TTL terminal is placed to the right of the tier from which data is deleted.
- The routes from table to first tier and from last tier to terminal are straight horizontal segments.
- The transitions between stacked volumes are straight vertical segments.
- A subtle directional marker animates these physical routes (unless the operating system requests reduced motion). This is a cue for the topology direction. It does not claim that a TTL move is actively running at that instant.
- TTL MOVE/DELETE label cards stay fully opaque, focused or unfocused. In this way, the lifecycle text never becomes unreadable over the route.

A **storage policy** is the named ClickHouse configuration that the `SETTINGS storage_policy = '…'` of the table selects. It defines the ordered volumes and disks that are available to that table. TTL rules then define when data is recompressed, moved between those volumes, or deleted. The graph renders the policy directly inside the owning table card. It does not draw it as a separate graph node.

`fixture_tiered` is the test policy that this repository ships in its frontend fixture. It contains a `hot` volume with `fixture_hot` and a `warm` volume with `fixture_warm`. It is not a built-in ClickHouse policy name. The table card also identifies the TTL base expression and the rule count. The parser accepts both ClickHouse interval forms that `create_table_query` commonly exposes, such as `INTERVAL 30 DAY` and `toIntervalDay(30)`.

In database-scoped **Storage** mode, the canvas contains only logical roots that actually own persistent physical placement. The Storage canvas omits entirely the View/MV/Buffer/Memory-style objects without a physical storage branch. They stay visible in the left object tree when non-storing objects are included. But while Storage mode is active, the View/MV/Buffer entries are gray and not clickable, and they keep the default cursor. The eligibility of the sidebar comes from the catalog object type. It does not come from the graph scope that is currently loaded. For this reason, a change of database cannot briefly gray persistent tables while the new topology loads.

Lineage layout uses a global row grid that every topological column shares. Barycentric crossing minimization first orders the nodes. Then a constrained row assignment keeps connected nodes on the same row when possible, and it allows empty slots. Orthogonal routing reuses those row lanes. Logical View dependencies prefer the lanes between node rows. In this way, dashed read dependencies do not weave through blue data-flow corridors. Ports stay at a stable top offset on each node. The up/down routes are vertically monotone. The exception is the same-row obstacle case, where a short detour is unavoidable.

Graph dependency types are distinct:

- `materialized_view` / `materialized_view_output`: incremental MV trigger and target flow.
- `refreshable_mv` / `refreshable_mv_output`: scheduled refresh input and output.
- `view`: logical read dependency.
- `buffer`: Buffer forwarding.
- `distributed_route`: Distributed routing to its local table definition.
- `dictionary_source`: the table that a dictionary loads from. It is read from `system.tables.loading_dependencies_*` (structured metadata, best effort). A server without those columns loses only these edges.
- `contains`: physical topology membership.

`system.tables.dependencies_database/dependencies_table` is preferred for MV relationships. The backend limits targeted parsing to engine arguments and to identifiers that follow `FROM`, `JOIN`, or `TO`. It does this where ClickHouse metadata does not directly provide the needed destination. The backend omits unknown SQL constructs. It does not guess. The backend checks both endpoints of every logical dependency against `AllowedObjectSet` before it adds the edge.

When non-storing objects are hidden, View/MV/Buffer chains are contracted before the neighborhood depth is calculated. Buffer has an additional semantic rule. Its explicit forwarding destination is the persistent representative of that hidden Buffer. Thus `Buffer → table1` plus `Buffer → MV → table2` projects to `table1 → table2`. Nested Buffers stop at their own forwarding target. In this way, the projection stays a readable chain. It does not become a transitive fan-out.

The backend reads `system.clusters` in bulk only for the cluster names that an already-authorized `Distributed` table references. Cluster members are topology metadata. The backend never treats them as authorization for another ClickHouse table.

The current physical model keeps byte and rate metrics at their stated `local-replica` scope on purpose. It expands Distributed shard and replica membership, local replica identity, and disks. It does not invent a physical total for the whole cluster. A later change can add accounting of deduplicated logical and physical data for the whole cluster, with explicit `clusterAllReplicas` semantics.

## Graph activity overlay

`GET /api/explorer/activity?host_id=<id>` is separate from the stable graph response on purpose. The frontend polls this endpoint according to `explorer.live_refresh_ms`. It overlays activity without a rebuild of the graph.

The overlay can contain these items:

- Read rates and client-write rates from `system.query_log`.
- Persisted part creation from `system.part_log`.
- Replication queue and delay from `system.replicas`.
- Refreshable MV state, timings and counters from `system.view_refreshes`.

Activity sources are best-effort. Missing or disabled system logs do not make the stable topology unavailable.

Only edge types that represent real data movement can animate. These rules apply:

- Buffer forwarding and ordinary Materialized View trigger/output edges use one normalized round marker. They use it when they are in the focused neighborhood of depth one, or when activity is observed.
- Refreshable MV edges animate only while ClickHouse reports an active refresh.
- A normal `View` is query-time lineage. It never receives a flow animation, because no data is transferred into the View at insert time.
- All animated Lineage and Storage routes use the same screen-space dot radius and the same velocity in pixels per second. The edge kind, zoom, direction and route length do not change them.

## Graph rendering

**Focus centring** (every kit graph: this graph, the Traces service map and the trace graph): a selection can open the side panel. The panel shrinks the visible part of the canvas. The `follow(id)` of the kit centers the selected card in `visibleArea()`. This is the safe area of a fit. It is also clear of the minimap, beside the panel on desktop, and above the bottom sheet on phones. The kit centers the card once the size of the panel has settled. It centers it again whenever that area changes: the panel grows as its content arrives, the panel closes, or the canvas resizes.

"Settled" is event driven. It uses a `ResizeObserver` on the canvas and the panel. It also uses the end of the running transitions or animations of the panel (`getAnimations()`). It never uses a timer. A pan, a zoom, a fit, a keyboard move or the panel of an edge ends the centring. A fit keeps its own rules (`fitView`, unchanged).

The graph uses a Canvas renderer. It does not use one DOM element for each object. The renderer is the shared graph kit (`app_graph_kit.js`, `ChDash.graphKit`). It also draws the Traces service map. In this way, both graphs look and behave the same. They share these elements:

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
- The Lineage / Storage topology mode when both are enabled (the sole mode is implicit otherwise).
- Wheel zoom (one factor and one zoom range for every kit graph).
- Pointer pan.
- Fit-to-screen.
- A logical-node selection that is synchronized with Browse and the browser route. A click selects the card. The kit then centers the card in the visible canvas (the `follow()` of the kit, below). It does this once the size of the panel has settled, and again when the panel closes. The visible canvas is beside the side panel, or above the bottom sheet on phones. It is clear of the toolbar, the legend / status line and the minimap.
- A hover that outlines the hovered card and highlights its edges, without dimming.
- Node focus and neighbor dimming.
- Keyboard: the canvas is focusable. Arrows move between cards (the first one lands on the selection). Enter selects. `+` / `-` zoom. `0` fits. Escape closes the panel (a live region names the card under the keyboard).
- Search-to-focus.
- A minimap. It shows as soon as any rendered graph card is partly outside the viewport, even a little. This happens, for example, with a Fit that opens at the readable scale on the focus.
- A side panel on a node click (summary, direct upstream/downstream objects, definition, columns, **Open card** to the Browse table card). It also opens on an edge click (see Graph object definitions).
- `+N` / `−` controls for each node and each direction on focused Lineage cards.
- Short edge labels on every Lineage edge (`MV`, `MV output`, `view`, `flush`, `route`, `dictionary`, `×N` between collapsed databases). The renderer places each label once for each routed layout. It uses the first spot along the route that covers no card, no `+N` control and no other label. A hover and a selection only restyle the labels. A label never jumps on top of another one. A label without any free spot is left out (`inspect().edgeLabelsDropped`).
- **Up** (the arrow-up icon, the first tool of the graph toolbar, Graph mode only): the parent scope, from a table to its database, from a database to all databases.
- Level-of-detail rendering, including database groups at very low zoom.

Readability rules:

- Fit (on open, the Fit tool, `0`; `kit.fitView`) works in the area that the toolbar, the legend and the status line leave free. The readable scale draws the smallest canvas font (12px in Lineage, 11px in Tiers) at 11 CSS pixels. These cases apply:
  - A graph that is readable as a whole opens whole.
  - A graph that is slightly too large opens at the readable scale. Its whole view would be at least `kit.FIT_READABLE_SHARE` (60 %) of the readable scale. The graph opens with the focused object in view (else the top-left of the graph) and as much of the rest as fits. The minimap gives the rest.
  - A much larger graph opens whole with compact cards, down to `kit.FIT_FLOOR` (0.25). Past that value, it opens at the readable scale on the focus.
- The level of detail follows the card on screen. It does not follow the zoom (`kit.isCompact`). Cards show every row while an ordinary card is at least 40 px tall on screen and its smallest text is at least 7.5 px. If either value is lower, every card is compact. A compact card shrinks to its title row around its edge ports (`kit.compactBox`, the title drawn larger, 8 to 12 px). It has no edge labels and no `+N` controls. No card is a title in an empty frame.
- Routes keep their own lanes. Two parallel segments of two edges that are closer than `LANE_GAP` (12 px at scale 1) cost the router more than a couple of crossings. The fans of a card step by that gap. In this way, dashed edges never double up into a closed frame.
- Cards carry the short name of the object as title and `database · engine` as subtitle. In this way, long database prefixes never truncate the distinctive part.
- Without a focus (all databases, or one database), Lineage collapses each database into one card with its object count. A click expands it in place. Its band header (`▾ db · N of M objects`) collapses it again. Objects without any dependency are hidden, and so are databases that consist only of them. This stays until the user checks **Show objects without dependencies**. Edges between collapsed databases are aggregated with their count. A single database is always shown expanded.
- Canvas colors come from the `--graph-*` tokens (`src/static/css/00-tokens.css`), defined for both themes. The JavaScript has no color literal. The shared `--accent` is a translucent tint in the light theme. The graph does not use it for canvas text, edges or the focus halo.
- On phones (width ≤ 720px), Fit opens on the focused object and its neighbors at `kit.PHONE_MIN_SCALE` (0.7) or more. The focus is always in view (the whole graph when it fits at that scale). The rest is a pan away. The toolbar wraps instead of being cut, and the side panel is a bottom sheet.

A change of the system/non-storing visibility projection always recomputes the canonical layout from scratch. Only the camera anchor is preserved. The graph does not re-inject old node coordinates into the new Sugiyama layout. For this reason, repeated ON/OFF/ON visibility toggles return to the same node ordering. They do not accumulate crossing edges from stale coordinates.

This keeps schemas with hundreds of objects out of the hot path of the DOM rendering.


### Graph edge semantics

Explorer uses three visual edge families:

- **Data flow** — insert-time movement, such as Buffer forwarding and ordinary Materialized View trigger/output paths. A single round marker moves at a constant screen-space speed while the path is active or selected.
- **Logical dependency** — query-time dependencies, such as ordinary Views, and the table that a dictionary loads from (dash-dot). These dashed edges do not animate. A selection of either endpoint adds a subtle blue halo to the dashes.
- **Routing / topology** — structural routing and containment, not row flow. For example, a `Distributed` engine route or the physical storage topology and containment.

Lineage edges are orthogonal routes (`kit.routeEdges`). Each edge has one output port on the right of a card and one input port on its left. The router routes it on the row grid of the layout, around the other cards. Each route has its own lane past a small fan zone.

The router searches a sparse grid for each edge, with typed arrays and reused buffers. On a database with 2k objects (852 cards, 550 edges), the routing takes about 1.5 s instead of 7 s. With objects without dependencies shown, it takes about 3.6 s instead of 44 s. The routes are the same.

The router finds conflicts (overlaps and crossings with the routes that are already placed) in this way:

- It looks them up in an index of segments for each line (vertical segments by x, the others by y). Each A* grid row and column is answered from what the index keeps of that line.
- It memoizes them for each grid link. It scores them only for links that could still improve their state.
- It scores the route set from the conflicting pairs only, in the order of the former pairwise loops. For this reason, the routes are bit-identical.

`kit.routeEdges` also takes a step budget (`maxSteps`, `searchSteps`; past it, cheap routes). It has a generator form (`kit.routeEdgesSteps`, run over frames by `kit.runSliced`). The Traces service map uses both. The Explorer keeps the unbounded router.

In **Storage** mode, ordinary non-storing objects stay excluded from the canvas. There is one deliberate exception: a `Buffer` is shown as a write-routing stage together with the persistent table that it flushes into. A selection of a Buffer therefore expands automatically to `Buffer → destination table → storage tiers`.

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
- Dictionary: the source table (from `loading_dependencies_*`), the `SOURCE` kind, `LAYOUT` and `LIFETIME`. The route never extracts the host, user, port and the masked password of `SOURCE(...)`.
- Distributed: cluster, local table, sharding key, and shard × replica counts.

The route goes through the same snapshot as `/api/explorer/graph`. This means runner ACL discovery, then system-context enrichment of only those objects. It answers from the cached graph:

- The request runs no SQL.
- An object outside `AllowedObjectSet` is `404 unknown_object`.
- The response reports a destination outside the set only as `target_visible: false`. It never reports it by name.

The texts are the own DDL of the object. The exposure is the same as in the Browse DDL tab. The panel of an edge shows the definition of the object that defines the edge. It is one of these objects:

- The MV, for trigger/output edges.
- The View that the edge feeds.
- The Buffer or Distributed table that forwards.
- The dictionary that loads.
- Every hidden object of a contracted edge.

## Replication metadata and Keeper load

`system.replicas` serves `queue_size`, `absolute_delay`, `is_readonly` and `is_session_expired` from memory. But `total_replicas` / `active_replicas` cost one Keeper request for each replicated table. The graph catalog is rebuilt every few seconds while the graph is open. For this reason, it reads only the in-memory columns on every build. The replica counts behind the `nR` badge and the "inactive replica" warning are cached for each server for 60 s. The backend reads them again only for new tables or expired entries, restricted to the shown databases. Problems of a local replica (read-only, expired Keeper session, queue, delay) appear immediately. A remote replica that goes down appears within 60 s. The table detail always reads fresh counts for the opened table.
