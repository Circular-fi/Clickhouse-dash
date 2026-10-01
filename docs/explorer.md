# Explorer

Explorer is a runner-scoped inspection surface. It is not an administrative bypass over ClickHouse permissions.

## Security flow

Explorer has no application-level user authentication. Every request for a host shares that host's configured runner permissions.

For every Explorer request:

1. the runner context discovers databases/tables and verifies `SELECT` access, including column-scoped grants when whole-table `SELECT` is not available;
2. the resulting `AllowedObjectSet` is the visibility boundary;
3. the system context may enrich only objects already present in that set;
4. dependencies are filtered against the same set before their names are serialized;
5. data preview and function discovery run with the runner context, never the system context.

Explorer ACL/catalog/graph/function caches are scoped by configured host/runner context. `refresh=1` invalidates the relevant caches so changed ClickHouse grants or metadata can be observed.

The important invariant is that `system_uri` is enrichment-only: it never authorizes an object and never executes SQL supplied by a panel caller. If different callers require different ClickHouse ACLs, they must use distinct runner-backed deployments/hosts outside ChDash.

## List catalog

`GET /api/explorer/catalog?host_id=<id>` returns only readable objects. Optional
`database=<name>` filters the response after authorization.

The catalog uses bulk reads of `system.tables`, `system.parts`,
`system.query_log`, `system.part_log`, `system.replicas`, and `system.disks`.
Catalog collection is fail-closed: if required technical metadata cannot be read,
the API returns an explicit Explorer error instead of silently replacing metrics
with empty/zero values. `INFORMATION_SCHEMA`/`information_schema` are excluded at
the runner ACL boundary and at the technical metadata boundary because they are
compatibility namespaces rather than user Explorer objects.

The current List metrics are explicitly labeled `local-replica`. ChDash does
not multiply local part bytes by replica counts or claim that a `Distributed`
table stores the underlying data itself.

Client ingress and persisted writes remain separate:

- **Client ingress** comes from finished writes in `system.query_log`.
- **Physical writes** come from new parts in `system.part_log`.

MV output and Buffer forwarding are not folded into a single ambiguous rate.

## Database inventory

The **Databases** Explorer section is backed by the same authorized catalog. Each
database summary contains the number of visible tables, visible rows, visible
local bytes, and the local disks actually used by those visible tables. Disk rows
include `hostName()`, disk name/path, bytes attributable to the database, and the
server-reported free/total capacity.

This inventory deliberately reports the current technical metadata host; it does
not invent remote disk capacity for cluster replicas that were not queried. A
`Distributed` table's shard/replica membership is represented in Storage topology
through `system.clusters`, while remote disk accounting remains explicitly out of
scope until a safe cluster-wide metadata query is configured. Clicking a table in
a database card opens that table's normal Explorer route.

## Storage

The **Storage** Explorer section (route `/explorer/_system`, next to Tables and
Functions) is one ncdu-style view of where the bytes are, with a breadcrumb
`server / database / table`:

| Scope | URL | Rows of the list | Treemap rectangles |
| --- | --- | --- | --- |
| server | `/explorer/_system` | databases | databases, with their tables nested under a header band |
| database | `/explorer/_system?database=<db>` | storing tables (+ one "N smaller tables" row beyond the 128 bound) | tables |
| table | `/explorer/_system?database=<db>&table=<t>` | partitions | partitions |

The sorted list is the main surface: name, size, a share bar (normalized to the
largest row) with the percentage of the scope, rows, and parts (tables per
database at server scope, as `storing / objects`). Every header sorts; size is
the default. Clicking a database or table row, or its treemap rectangle, zooms
into it; the breadcrumb, Back and a reload keep and restore the scope. A table
row also has an *open* button, and the table scope an **Open table** button,
which leave for the table card. `/explorer/system` keeps addressing the
ClickHouse `system` database, so the section uses the reserved `_system`
segment. The *System databases* option is shared with the Tables sidebar
(*Include system database*) and decides whether `system` is part of the server
scope; opening `?database=system` includes it.

The treemap is secondary: it sits under the list with a bounded height
(`clamp(150px, 26vh, 240px)`) and is drawn only when at least three rectangles
of >= 1% of the scope remain after grouping (`TREEMAP_MIN_ITEMS`). A server
where one database holds 99.9% of the bytes therefore shows the list only,
instead of one full-height block. Partitions of the table scope come from the
table detail endpoint (most recent 1000 partitions).

The database page (click a database in the sidebar) embeds a compact variant
above its object list: the same bounded treemap band when at least three tables
hold >= 1% of the database, otherwise a single share strip (each table >= 1%
plus one Others segment, with a one-line legend), and a **Storage view** link to
the database scope of the Storage section.

Byte accounting is the same local on-disk accounting as the database header and
sidebar summaries (`metric_scope = local-replica`): `bytes_on_disk` of active
parts for MergeTree families and `system.tables.total_bytes` for Log-family and
other disk engines. Memory, Buffer and Dictionary objects report resident RAM
(`isResidentMemorySummary`); drawing RAM as disk area would make the views
disagree with the database total, so resident bytes are excluded from the
areas and reported separately (footnote, database page header). Views and other
objects without bytes are not drawn.

Grouping and layout follow the S3-Browser folder treemap:

- the threshold is `ceil(1%)` of the displayed root and is applied with that
  absolute value at every level; smaller siblings are merged into one
  **Others** node (name, exact size and member count are always kept);
- a level with a single real child is contracted into that child and a sole
  Others child is dropped (the parent already carries the totals);
- squarified layout, Others as a proportional bottom strip that is only grown to
  the height its label needs, a header band per database for nested levels,
  at most 1000 rectangles and 5 levels, hover highlight and a tooltip with size,
  rows/engine and share of the root;
- a tall narrow database (for example `system` next to a 47 GB database) still
  opens as a branch with its tables (width >= 36 px when at least 160 px tall);
- labels are fitted per rectangle (full, compact, tiny); a sliver keeps a
  rotated label when it is at least 12 x 48 px, a one-line label when it is at
  least 60 x 13 px, and otherwise an edge mark (`is-sliver`) so a 1% table never
  reads as part of its neighbour. Labels use the text face, not monospace.

Grouping runs in the browser: the displayed root depends on view options (system
databases on/off, scope), and the database page reuses the per-database catalog
that the sidebar already loaded, so one implementation
(`app_explorer_treemap.js`) serves both. Tables are coloured by engine family
(legend under the map); databases use a pale per-database tint.

The view is `app_explorer_storage.js`: `ns.explorerStorage.show(container,
{ scope, includeSystem, onScopeChange, onIncludeSystemChange, onOpenTable })`
mounts it in any container (the Explorer shell passes its URL/visibility
callbacks), and `renderCompact(container, { root, residentBytes, name, onOpen,
onShowStorage })` draws the database-page variant.

`GET /api/explorer/storage?host_id=<id>[&refresh=1]` backs the section.
Object names come exclusively from runner-context discovery
(`discover_visible_databases` / `discover_visible_objects`, the same boundary as
the lazy sidebar). The system context then contributes counters only for those
names, through one aggregated `system.parts` query (`active`, `GROUP BY
database, table`, `database IN (<visible databases>)`) and one `system.tables`
query for engine identity and non-MergeTree totals. Both are metadata reads: the
multi-billion-row OTEL fixture costs the same as a small table, and no `SYSTEM
FLUSH` is issued. The response is cached with the Explorer StaleCache TTL
(`explorer.cache_ttl_ms`); `refresh=1` (and a global catalog refresh) invalidates
it.

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

`tables` lists only storing tables, largest first, bounded to 128 per database.
The bound is lossless for every treemap the UI can draw: at most 100 siblings can
each hold 1% of their parent, and everything smaller is grouped into Others. The
remainder is still reported exactly through `omitted_*`, so `bytes` always equals
listed + omitted bytes.

## Server operations

The **Operations** Explorer section (route `/explorer/_operations`,
`app_explorer_ops.js`, `ns.explorerOps.show(container, { onOpenTable })`) shows
what the selected server is doing in the background, in the spirit of
clickhouse-monitoring:

- **Replicas**: health of every replicated table (read-only, expired Keeper
  session, delay, queue with inserts/merges, last queue update and its exception,
  `active / total` replicas);
- **Mutations**: pending mutations only, failing ones first with the failed
  part, error code name and reason;
- **Replication queue**: one row per table (entries, executing, postponed, max
  tries, oldest entry, entry types, last exception or postpone reason);
- **Merges**: running merges and mutation merges (partition, progress, elapsed,
  source size, parts, memory);
- **Distributed send queues**: pending files/bytes per shard directory, errors,
  blocked state, broken files and the last exception;
- **Keeper**: connection(s) of `system.zookeeper_connection` (host, session,
  uptime, timeout, API version), requests in flight, watches, exceptions, and
  the latency: average wait per transaction since start, replaced by the
  average over the last refresh interval once two snapshots exist.

Sections with a problem come first, then sections with rows; empty sections are
folded into one "No pending mutations · No merges running ..." line, and a
system table the server does not expose is reported as not readable instead of
empty. A refresh button and an **Auto-refresh (5 s)** option (remembered per
browser, paused while the section or the browser tab is hidden) keep it live.

`GET /api/explorer/ops/activity?host_id=<id>[&refresh=1]` runs five fixed
queries through the system context: `system.merges`, `system.mutations WHERE
NOT is_done`, `system.replication_queue` aggregated `GROUP BY database, table`,
`system.replicas` and `system.distribution_queue`. Each query is restricted to
`database IN (<databases the runner can SHOW>)` inside ClickHouse, and every row
is then kept only when the runner can SHOW that object (runner-context
`discover_visible_objects`, resolved lazily for the databases that actually
appear): an object hidden from the runner never reaches the browser, and its
rows never consume the bound. Each section reads at most 201 rows and returns
200 (`row_limit`); a full section is listed in `truncated_sections`, an
unreadable one in `unavailable_sections`. The `system.replicas` read selects
in-memory columns only; `log_max_index`, `log_pointer`, `total_replicas`,
`active_replicas`, `zookeeper_exception` and `replica_is_active` cost a Keeper
request per table and are not selected. The replica counts come from the same
per-server 60 s cache as the catalog (see "Replication metadata and Keeper
load").

`GET /api/explorer/ops/keeper?host_id=<id>[&refresh=1]` reads
`system.zookeeper_connection` (at most 16 rows) and allowlisted
`system.metrics` (`ZooKeeperSession`, `ZooKeeperSessionExpired`,
`ZooKeeperRequest`, `ZooKeeperWatch`,
`ZooKeeperConnectionLossStartedTimestampSeconds`, `KeeperAliveConnections`,
`KeeperOutstandingRequests`) and `system.events` (`ZooKeeper*` transaction,
wait, exception, byte and per-operation counters), plus
`average_wait_ms = ZooKeeperWaitMicroseconds / ZooKeeperTransactions`. It names
no object. `system.zookeeper` paths are deliberately not browsable: a path read
is one Keeper request per node, cannot be bounded by a `LIMIT` before ClickHouse
issues those requests, and the paths themselves (`/clickhouse/tables/<shard>/
<table>/...`) name objects the runner may not see, outside the
`AllowedObjectSet` boundary.

Both responses are cached per host for `min(explorer.cache_ttl_ms, 5 s)` (at
least 1 s), so any number of auto-refreshing pages costs one read per interval;
`refresh=1` bypasses the cache. No SQL, filter or limit is taken from the
request. The section and routes are gated by `explorer.operations { enabled,
keeper }` (see configuration.md).

## Table detail

`GET /api/explorer/table?...` can return, when the corresponding system table is
available:

- columns, compression metadata, and per-column compressed-byte weight;
- storage policy plus local storage by disk and capacity for disks used by that table;
- active/inactive parts, including the ClickHouse 26.7 `files` count;
- partitions;
- skipping indexes and projections;
- mutations and active merges;
- local replication state and replication queue;
- Distributed cluster members resolved from the engine's cluster argument and
  `system.clusters`, plus the local `system.distribution_queue` backlog/error state;
- security-filtered structured dependencies;
- DDL.

Missing optional system metadata is represented through
`unavailable_sections`; the page degrades rather than failing globally.

The Browse **Overview** keeps storage accounting intentionally dense rather than
using dashboard-style key/value cards. For MergeTree tables it starts with a
single stacked composition bar that always reconciles to the table's local
`bytes_on_disk` footprint when the required metadata is available. Projection
parts use their own `bytes_on_disk`; skipping indexes use the explicit secondary
index compressed bytes exposed by `system.parts`; every remaining parent-part
byte is assigned to the Wide or Compact base footprint using the exact
`bytes_on_disk` ratio of those active part formats. This makes Wide + Compact +
Projections + Indexes a disjoint 100% decomposition instead of mixing compressed
data counters with an on-disk denominator. If any required counter is
unavailable, the composition is rendered as `unknown` rather than as a partial
bar.

Columns, skipping indexes and projections are shown in three separate sortable
tables. Column rows contain name, codec, compressed bytes, uncompressed bytes and
compressed share. Named Tuple leaf subcolumns are exposed as dot paths such as
`<sensor_packet.station.code>` when ClickHouse provides `subcolumns.*` counters;
intermediate Tuple containers and implementation-only size streams are omitted.
The Overview also shows the table's local on-disk share of its database and of
the full authorized ClickHouse catalog using compact percentage bars.

## Data preview

`POST /api/explorer/table/data` defaults to `LIMIT 100` and clamps the request to
1–500 rows. The backend first enumerates columns readable by the runner and
selects only those columns. It never performs an automatic `SELECT count()`.
Row policies and ClickHouse-side restrictions therefore remain in effect.

Preview values are encoded from native ClickHouse columns into JSON while
preserving scalar and nested structure: SQL NULL remains null, arrays/tuples are
arrays, string-key maps are objects, enums use their symbolic name, and decimals
are emitted at their declared scale. Decimal32/64/128 are read using their actual
physical integer width; this avoids clickhouse-cpp ItemView width mismatches such
as `Requested size: 16 stored size: 8` for `Decimal(18,6)`.

**Open in Query** persists the generated SELECT in session storage before moving
from the Explorer HTML document to the Query document. This is required because
the Query textarea is not mounted on the Explorer page. Tuple subcolumns used by
the Browse storage breakdown are not duplicated in the generated SELECT; only
real top-level table columns are opened.

## Functions

`GET /api/explorer/functions?host_id=<id>` is a runner-scoped function browser.
Unlike technical table enrichment, function discovery is executed directly with
the configured runner context; it never elevates to `system_uri`.

On the ClickHouse 26.7 target, ChDash prefers `system.documentation`, so the
function descriptions match the exact server version. It includes scalar,
aggregate, and table-function documentation. `system.functions` is queried as a
runner-scoped supplement for user-defined functions and as a fallback when
`system.documentation` is unavailable. The UI reports that fallback instead of
silently embedding documentation from another ClickHouse version.

The function list groups functions by category, one line per function (the
name, plus a kind badge only when the group does not already say it:
`aggregate`, `table`, `UDF`), with the number of functions on each category
header. Category names come from `system.functions.categories` with the kind as
the backend fallback, and spelling variants are folded: "Aggregate Functions"
and the "Aggregate Function" fallback become **Aggregate**, the table-function
fallback becomes **Table functions**, and uncategorized plain functions join
ClickHouse's own **Other**. While no function is selected, the detail pane shows
an overview instead of a bare placeholder: the catalog size, popular functions
present on the server (one click opens them) and every category with its count
(one click expands that group in the list). The detail header lists the
category, the kind when it adds information, User-defined, and the version that
introduced the function.

The frontend supports title/name-only function search, kind filtering,
user-defined filtering, and a safe Markdown detail view. Description text is not
searched. Search ordering is deterministic: exact name first, then names beginning
with the query, then segment-prefix matches, then remaining name substrings. The
backend function catalog (including descriptions) is cached per host for
`explorer.function_cache_ttl_ms` (default one hour), and the browser reuses the
last catalog until an explicit refresh/host change.

Function Markdown is parsed into DOM nodes; server documentation is never injected
as raw HTML. Inline backticks and fenced code blocks receive syntax-oriented
coloring. Markdown links are disabled by default through
`explorer.function_markdown_links = false`, in which case the label remains text
and the URL is discarded. If the option is explicitly enabled, only documentation
relative targets beginning with `/` or `./` are made clickable; arbitrary external
URLs remain plain text.

Documented aliases such as **Alias of** `groupBitAnd` are resolved by the backend
before the function catalog is serialized. The response includes the referenced
documentation recursively with a visited-name cycle guard and a maximum depth of
eight, so the browser does not need to perform alias discovery itself.

## Graph topology model

`GET /api/explorer/graph?host_id=<id>` returns a normalized topology model. The
backend does not ship all DDL to the browser and ask JavaScript to infer the
schema.

The stable model contains two layers:

- `logical`: ClickHouse tables, views, MVs, Buffer/Distributed/stream engines;
- `physical`: shards, replicas, and disks attached to an already-authorized
  logical object.

The same authorized backend model feeds two deliberately separate projections:

- **Lineage** renders only logical objects and logical dependencies;
- **Storage topology** starts from the focused logical object and walks only its
  physical descendants (shards, replicas, disks).

Physical nodes are therefore not accumulated on top of a lineage neighborhood.
Local replicated tables are represented as table → local replica → disk; a physical
disk node is deduplicated within the returned database scope so multiple authorized
tables/replicas can point to the same disk. Distributed tables use
`system.clusters` to expose shard → replica membership. The neighborhood depth
can be increased or decreased down to focus-only.

Table TTL is represented as ordered metadata on the logical table (`ttl_rules`),
not as backend topology edges. Storage mode projects that metadata onto the
physical lifecycle instead of drawing a second TTL timeline beside the table.
Each ClickHouse volume is rendered as one **storage tier** card containing its
member disk(s), so `Volume hot` and `Disk fixture_hot` are a single visual unit.
In-place actions are attached to the tier where they happen. TTL timing is
always shown as **base expression + offset**, not only as an anonymous `+Nd`.
For example `observed_at +30d` followed by `RECOMPRESS · ZSTD(3)` is rendered
inside the `hot` tier, making it explicit both which Date/DateTime expression is
the TTL clock and that the data is still on hot storage. A `MOVE` rule annotates
the transition between tiers (`hot -- observed_at +60d / MOVE → VOLUME warm -->
warm`), and a `DELETE` rule continues from the current tier to an explicit
`Expired / data deleted` terminal (`observed_at +365d / DELETE`). This remains
unambiguous when a table contains several Date/DateTime columns or even several
TTL rules with different base expressions.

Storage mode uses a dedicated placement grammar rather than the generic lineage
layout. The owning table and the first storage tier share the same top edge, all
volumes of one policy are stacked vertically in priority order, and an explicit
TTL terminal is placed to the right of the tier from which data is deleted.
Table → first-tier and last-tier → terminal routes are straight horizontal
segments; transitions between stacked volumes are straight vertical segments.
A subtle directional marker animates these physical routes (unless the operating
system requests reduced motion); this is a topology direction cue, not a claim
that a TTL move is actively running at that instant. TTL MOVE/DELETE label cards
remain fully opaque while focused or unfocused so lifecycle text never becomes
unreadable over the route.

A **storage policy** is the named ClickHouse configuration selected by the table's
`SETTINGS storage_policy = '…'`. It defines the ordered volumes/disks available to
that table; TTL rules then define when data is recompressed, moved between those
volumes, or deleted. The policy is rendered directly inside the owning table card
and is not drawn as a separate graph node. `fixture_tiered` is specifically the
test policy shipped in this repository's frontend fixture: it contains a `hot`
volume backed by `fixture_hot` and a `warm` volume backed by `fixture_warm`. It is
not a built-in ClickHouse policy name. The table card also identifies the TTL base
expression and rule count. The parser accepts both ClickHouse interval forms
commonly exposed by `create_table_query`, such as `INTERVAL 30 DAY` and
`toIntervalDay(30)`.

In database-scoped **Storage** mode the canvas contains only logical roots that
actually own persistent physical placement. View/MV/Buffer/Memory-style objects
without a physical storage branch are omitted from the Storage canvas entirely.
They remain visible in the left object tree when non-storing objects are included,
but View/MV/Buffer entries are grey, non-clickable and keep the default cursor
while Storage mode is active. Sidebar eligibility is derived from catalog object
type rather than the currently loaded graph scope, so changing databases cannot
transiently grey persistent tables while the new topology is loading.

Lineage layout uses a global row grid shared by every topological column.
Barycentric crossing minimization first orders nodes, then a constrained row
assignment keeps connected nodes on the same row when possible while allowing
empty slots. Orthogonal routing reuses those row lanes; logical View dependencies
prefer the lanes between node rows so dashed read dependencies do not weave
through blue data-flow corridors. Ports remain at a stable top offset on each
node, and up/down routes are vertically monotone except for the same-row obstacle
case where a short detour is unavoidable.

Graph dependency types are distinct:

- `materialized_view` / `materialized_view_output`: incremental MV trigger and
  target flow;
- `refreshable_mv` / `refreshable_mv_output`: scheduled refresh input/output;
- `view`: logical read dependency;
- `buffer`: Buffer forwarding;
- `distributed_route`: Distributed routing to its local table definition;
- `contains`: physical topology membership.

`system.tables.dependencies_database/dependencies_table` is preferred for MV
relationships. Targeted parsing is limited to engine arguments and identifiers
following `FROM`, `JOIN`, or `TO` where ClickHouse metadata does not directly
provide the needed destination. Unknown SQL constructs are omitted rather than
guessed. Both endpoints of every logical dependency are checked against
`AllowedObjectSet` before the edge is added.

When non-storing objects are hidden, View/MV/Buffer chains are contracted before
neighborhood depth is calculated. Buffer has an additional semantic rule: its
explicit forwarding destination is the persistent representative of that hidden
Buffer. Thus `Buffer → table1` plus `Buffer → MV → table2` projects to
`table1 → table2`. Nested Buffers stop at their own forwarding target so the
projection remains a readable chain rather than a transitive fan-out.

`system.clusters` is read in bulk only for cluster names referenced by an
already-authorized `Distributed` table. Cluster members are topology metadata;
they are never treated as authorization for another ClickHouse table.

The current physical model deliberately keeps byte/rate metrics at their stated
`local-replica` scope. It expands Distributed shard/replica membership, local
replica identity, and disks without inventing a cluster-wide physical total.
Cluster-wide deduplicated logical/physical accounting can be layered on later
with explicit `clusterAllReplicas` semantics.

## Graph activity overlay

`GET /api/explorer/activity?host_id=<id>` is intentionally separate from the
stable graph response. The frontend polls this endpoint according to
`explorer.live_refresh_ms` and overlays activity without rebuilding the graph.

The overlay can contain:

- read/client-write rates from `system.query_log`;
- persisted part creation from `system.part_log`;
- replication queue/delay from `system.replicas`;
- Refreshable MV state/timings/counters from `system.view_refreshes`.

Activity sources are best-effort. Missing/disabled system logs do not make the
stable topology unavailable.

Only edge types that represent real data movement are animation-capable. Buffer
forwarding and ordinary Materialized View trigger/output edges use one normalized
round marker when they are in the focused depth-one neighborhood or when activity
is observed. Refreshable MV edges animate only while ClickHouse reports an active
refresh. A normal `View` is query-time lineage and never receives a flow animation:
no data is transferred into the View at insert time. All animated Lineage and
Storage routes use the same screen-space dot radius and the same pixels-per-second
velocity, independent of edge kind, zoom, direction or route length.

## Graph rendering

The graph uses a Canvas renderer rather than one DOM element per object. The
layout is deterministic and DAG-oriented, with a cycle fallback for schemas
whose dependency graph is not acyclic. The UI supports:

- all runner-visible logical objects, with search/focus rather than a database dropdown;
- Lineage / Storage topology mode when both are enabled (the sole mode is implicit otherwise);
- wheel zoom;
- pointer pan;
- fit-to-screen;
- logical-node selection synchronized with Browse and the browser route;
- node focus and neighbor dimming;
- search-to-focus;
- minimap, shown as soon as any rendered graph card is even partially outside the viewport;
- click from a logical node into the Browse table detail;
- level-of-detail rendering, including database groups at very low zoom.

Changing the system/non-storing visibility projection always recomputes the
canonical layout from scratch. Only the camera anchor is preserved; old node
coordinates are not re-injected into the new Sugiyama layout. Repeated
ON/OFF/ON visibility toggles therefore return to the same node ordering instead
of accumulating crossing edges from stale coordinates.

This keeps schemas with hundreds of objects out of the DOM rendering hot path.


### Graph edge semantics

Explorer uses three visual edge families:

- **Data flow** — insert-time movement such as Buffer forwarding and ordinary Materialized View trigger/output paths. A single round marker moves at a constant screen-space speed while the path is active/selected.
- **Logical dependency** — query-time dependencies such as ordinary Views. These dashed edges do not animate. Selecting either endpoint adds a subtle blue halo to the dashes.
- **Routing / topology** — structural routing/containment rather than row flow, for example a `Distributed` engine route or physical storage topology/containment.

Lineage routing avoids drawing an edge through an unrelated node card: when the normal Bezier would intersect another card, the renderer selects a clear orthogonal detour.

In **Storage** mode, ordinary non-storing objects remain excluded from the canvas, with one deliberate exception: a `Buffer` is shown as a write-routing stage together with the persistent table it flushes into. Selecting a Buffer therefore expands automatically to `Buffer → destination table → storage tiers`.

## Replication metadata and Keeper load

`system.replicas` serves `queue_size`, `absolute_delay`, `is_readonly` and `is_session_expired` from memory, but `total_replicas` / `active_replicas` cost one Keeper request per replicated table. The graph catalog (rebuilt every few seconds while the graph is open) therefore reads only the in-memory columns on every build; the replica counts behind the `nR` badge and the "inactive replica" warning are cached per server for 60 s and re-read only for new tables or expired entries, restricted to the shown databases. Local-replica problems (read-only, expired Keeper session, queue, delay) appear immediately; a remote replica going down appears within 60 s. Table detail always reads fresh counts for the opened table.

