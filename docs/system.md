# System

The **System** page shows the selected server's health from its system
tables: what it is doing now, its history, its top queries and its disks. It
is the server, not a database or a table, so it is a page of its own beside
Query, Explorer and Observability (the header's page switcher), not an
Explorer view. Every read is a fixed, bounded, read-only system-table SELECT;
nothing a request carries reaches the SQL but allowlisted values.

## Routes and page

Its sections are underlined tabs (tier 2, `ns.tabs`) in one nav row under the
header, the section's controls on the right of the same row:

| Section | Address | What it shows |
| --- | --- | --- |
| Overview | `/system[?from=&to=]` | server tiles, the databases, the cluster (topology, Keeper, replication), the performance history (`from` / `to`: its time range), the background activity, one page top to bottom |
| Queries | `/system/queries[?from=&to=&sort=&kind=&hide=0&q=<hash>&runs=]` | the top query shapes of a window, and one shape's timeline and runs |
| Disks | `/system/disks[?from=&to=]` | each disk's fill, its growth and time until full, the bytes of each database on it, the storage policies |

A section tab is a history entry (Back / Forward switch back); each section
keeps its own parameters, another section's address drops them and the
section's tab brings back its own. An unknown section (`/system/whatever`)
opens Overview and replaces the address. A section the configuration turns
off (Queries with `system.top_queries = false`) has no tab, and its address
falls back to Overview the same way.

The Explorer's former addresses answer a redirect here (`server.cpp`
`redirect_to_system`): `302`, `Cache-Control: no-store`, a `Location`
relative to the request (so a reverse-proxy prefix is kept) and the query
string kept as it came:

| Former address | Redirects to |
| --- | --- |
| `/explorer/_monitoring` (the Monitoring tab) | `/system` |
| `/explorer/_monitoring/queries`, `/explorer/_monitoring/disks` | `/system/queries`, `/system/disks` |
| `/explorer/_monitoring/performance` | `/system#performance` |
| `/explorer/_monitoring/activity`, `/explorer/_operations` (v2.14.0's Server operations) | `/system#activity` |

`#performance` and `#activity` scroll the Overview to that part (kept at the top while the parts above it fill in, until the reader scrolls), when the
page opens on it. With `system.enabled = false` there is no redirect: these
addresses open the Explorer Catalog.

The shell is `src/static/system.html` (header partial
`src/shell/header.html`, generated regions from `tools/page_shells.py`
`SHELLS`), its sheet `style.system.css` (`tools/build_page_css.py` `PAGES`,
source `src/static/css/20-features/system.css`). The bootstrap
`app_system.js` (routes, Back / Forward, the host change, *Open in Query*)
starts the modules of `pages.system` in `src/static/modules.json`, the
highlighter as the lazy group `highlight`:

| Module | Holds |
| --- | --- |
| `app_system_view.js` | `ns.systemView`: the section registry, the tab row, the shared kit (section bar, range picker, issue block, cards, parts) |
| `app_system_overview.js` | Overview: tiles, Databases, Cluster, and the parts below |
| `app_system_perf.js` | the Overview's Performance part (`ns.systemPerf`) |
| `app_system_activity.js` | the Overview's Activity part (`ns.systemActivity`) |
| `app_system_queries.js` | Queries |
| `app_system_disks.js` | Disks |

Each section registers itself (`ns.systemView.register({ id, label, order,
available, create })`); one that is not registered or not available has no
tab. Each section's panel (`.systemPage__panel`) is its own scroller.

Every figure is **this server's own**: system tables are local to each node,
so `query_log` holds the queries that node received or ran and the metrics are
that node's. Each replica configured as a ChDash host gets its own page (the
header's host picker names it), with no extra grant. The `clusterAllReplicas`
views across a cluster are opt-in (`system.cluster_fanout`) and need `GRANT
REMOTE ON *.*` for the system account. Topology always comes from the local
`system.clusters`.

Configuration: the `system { }` block (see
[configuration.md](configuration.md#evolution-blocks)); v2.14.0's
`explorer.operations { enabled, keeper }` still works. `system.enabled = false`
removes the page switcher's entry, the page, every `/api/system/...` route
(the `/api/explorer/ops/...` aliases included) and the redirects.
`/api/version` reports `features.system` (`enabled`, `activity`, `keeper`,
`top_queries`, `cluster_fanout`, `default_lookback_minutes`,
`max_lookback_days`, `query_log_max_lookback_hours`, `disk_growth_days`).

## Reads, budgets and degradation

Every endpoint runs fixed queries: no SQL, column, filter or limit is taken
from the request, and a parameter outside the endpoint's allowlist is a 400
`unknown_parameter`. Every SELECT ends with `SETTINGS readonly = 2,
max_execution_time = N, timeout_overflow_mode = 'throw', max_rows_to_read = R,
read_overflow_mode = 'throw', max_result_rows = L, result_overflow_mode =
'throw', log_comment = 'chdash-system'`: a cap stops the read with an error
rather than a silently partial answer, and our own load stays visible (and
excludable) in `system.query_log`. Because the settings are set per query,
neither account may have a `readonly = 1` profile.

Objects are bounded by the runner: a read of `system.replicas`,
`system.parts` and the activity tables is restricted to `database IN
(<databases the runner can SHOW>)` inside ClickHouse, and each row is then
kept only when the runner can SHOW that object. A database or table hidden
from the runner is neither listed nor counted.

What a server exposes is detected once per host and kept 10 minutes: the
optional system logs (`query_log`, `metric_log`, `asynchronous_metric_log`,
`part_log`, `zookeeper_connection`, reported in `logs`) and the columns older
versions lack (left out, shown as `—`).

A panel that cannot be read degrades on its own and is listed in
`unavailable_panels` (`panel`, `table`, `reason`, `message`, `hint`), never as a
page error. Reasons: `disabled` (the table does not exist: ClickHouse codes 60,
81), `not_granted` (497; `hint` is the statement to run, `GRANT SELECT ON
system.<table> TO <system user>`, which the page shows with a copy button),
`unsupported` (a column this version lacks: 16, 47), `window_too_large` (the
time budget or read cap: 159, 158), `readonly_account` (164: a `readonly = 1`
profile cannot set the limits) and `failed`.

## Overview

**Overview** (`app_system_overview.js`) is the selected server on one
scrolling page, top to bottom: the server tiles, **Databases**, **Cluster**,
**Performance** and **Activity**. Each part degrades on its own: an answer or a
panel that fails says why in place of that part only. No figure is shown
twice.

- **Server tiles**: uptime, CPU (`OSUserTimeNormalized` +
  `OSSystemTimeNormalized`, the share of all cores), resident memory of the
  total (`CGroupMemoryTotal` when the container has a limit, else
  `OSMemoryTotal`), load average, running queries / merges / mutations, client
  connections, MergeTree parts with their size and the most parts in one
  partition (warning from 300, error from 1,000: `parts_to_delay_insert`), and
  delayed inserts. A metric the server does not have shows `—`.
- **Databases**: a treemap of the databases the runner can see by bytes on
  disk (`app_explorer_treemap.js`, the Explorer's), from the `usage` rows of
  `/api/system/disks` summed by database, every disk. The heading counts
  them (`N databases · size on disk`); a database under 1% of the total is
  grouped into Others, and the footnote says what the bytes are. Clicking a
  database opens its Explorer card (`/explorer/<db>`; the map is static when
  the Explorer is off). "No data on disk" when no visible database has active
  parts; an unreadable `usage` panel says why in its place.
- **Cluster**: three cards.
  - **Topology**: per cluster of `system.clusters`, one row per shard and
    replica (host, address, `errors_count`, `slowdowns_count`,
    `estimated_recovery_time`), this server marked. A cluster of one local
    replica (the built-in `default`) is this server alone: when every cluster
    is, the card says "Single server, no multi-replica cluster". At most 1,000
    rows.
  - **Keeper**: one card for the session and an embedded Keeper. A badge
    (Connected / Session expired); each connection of
    `system.zookeeper_connection` (host and port, connected since in the
    tooltip) with its session uptime and timeout; the latency, the average
    over the last refresh interval once two snapshots exist, else the average
    wait per transaction since start; requests in flight and the transaction
    rate (transactions since start before a second snapshot); watches;
    exceptions since start. For a Keeper embedded in this server, its role,
    znodes, Keeper latency (average and max) and followers in sync (`Keeper*`
    asynchronous metrics). "No Keeper configured" when there is no
    connection, no session and no embedded Keeper; the card is hidden with
    `system.keeper = false`.
  - **Replication**: the replicated tables the runner can see, their status,
    read-only and expired sessions, the largest delay and the queue, with
    Altinity's alert thresholds (`future_parts > 20`, `parts_to_check > 10`,
    `queue_size > 20`, `inserts_in_queue > 10`, delay over 5 minutes);
    hidden without replicated tables. **Show the tables** scrolls to the
    Activity's Replicas.
- **Performance** and **Activity**: below.

**Auto-refresh** is one choice for the whole Overview, in the tab row beside
the refresh button, remembered per browser (`chdash.system.autoRefresh`, off
by default): the tiles, the cluster cards and the activity every 5 s, the
charts every 30 s and only for relative ranges of 6 hours or less. Nothing
loads while the section or the browser tab is hidden; back on the tab, it
catches up at once. The databases read again on the refresh button and a host
change (and on show, when the last read is older than 60 s). The refresh
button reloads every part.

`GET /api/system/overview?host_id=<id>[&refresh=1]` runs fixed queries through
the system context: `version()`, `timezone()`, `hostName()` and `uptime()`,
allowlisted `system.asynchronous_metrics` and `system.metrics` names,
`system.clusters` (`LIMIT 1001`) and the in-memory columns of
`system.replicas` restricted to the runner's databases (`LIMIT 10001`), each
row counted only when the runner can SHOW that table. `log_max_index`,
`log_pointer`, `total_replicas` and `active_replicas` cost a Keeper request per
table and are not read. The snapshot is cached per host for
`min(explorer.cache_ttl_ms, 5 s)` (at least 1 s), so any number of
auto-refreshing pages costs one read per interval; `refresh=1` bypasses it.
The Keeper card adds `/api/system/keeper` (*Activity* below).

### Performance

**Performance** (`app_system_perf.js`) charts the server's history over a time
range: the Observability time range picker (`ns.timeRange`, the same quick
ranges, calendar and browser-local 24 h times) on the part's heading, 1 hour
by default (`system.default_lookback_minutes`), at most
`system.max_lookback_days` (30). The range is in the Overview's address as
`from` / `to` (`now-6h`, `2026-10-03 14:00:00`), absent for the default.
Ten charts on the shared chart engine (`ns.chartCore`, canvas), each in a chart
card, two a row (one under 900 px): they share a crosshair, and a drag over
any of them sets the range of all of them (pushed to the address: Back
returns to the previous range). Each chart has one unit; a figure in another
unit is in the card's summary and in the tooltip at the cursor.

| Chart | Series | Source | Without it |
| --- | --- | --- | --- |
| Queries/s | SELECT, INSERT, other (stacked), failed; the error share of the range as a badge (neutral under 1 %, warning to 5 %, danger from 5 %) | `metric_log` | finished and failed initial queries per second from `query_log` |
| Query latency | p50, p95, p99 of the initial queries (one hue) | `query_log` | the average (`metric_log`), labelled "average", also past `query_log_max_lookback_hours` |
| CPU | ClickHouse's CPU and I/O wait (`metric_log`), the machine's user and system time (`OSUserTime`, `OSSystemTime`), in cores; the core count; the 1-minute load at the cursor | both | either alone |
| Memory | tracked (average and peak), merges and mutations (`metric_log`), resident (`asynchronous_metric_log`); OS memory available at the cursor | both | either alone |
| Merges & mutations | running merges and mutations; rows merged per second in the summary | `metric_log` | "Needs system.metric_log" |
| Inserts | rows inserted per second, a marker on each bucket with delayed or rejected inserts; bytes per second in the summary | `metric_log` | same |
| Parts | MergeTree parts and the most in one partition (`asynchronous_metric_log`), active and outdated (`metric_log`) | both | either alone |
| Background pools | tasks of the merges and mutations, fetches, moves, schedule and common pools; pool sizes (hidden at first) | `metric_log` | "Needs system.metric_log" |
| Reads | rows selected per second; bytes per second in the summary | `metric_log` | same |
| Replication | the largest replica delay; the queue in the summary | `asynchronous_metric_log` | hidden on a server without replicated tables |

Without `metric_log` and `asynchronous_metric_log` the part says "History
needs system.metric_log or system.asynchronous_metric_log (server
configuration): the current values are the tiles at the top" and shows only
the `query_log` charts; it does not repeat the tiles. A log that cannot be
read is listed above the charts with its reason and, when a grant is missing,
the GRANT to run. Auto-refresh is the Overview's (above).

`GET /api/system/series?host_id=<id>[&from_ms=&to_ms=][&refresh=1]`
takes whole milliseconds (the default window when absent; a `to_ms` in the
future ends now) and nothing else: `panel` may only be `performance` (the
default) or `disk_growth` (*Disks*; anything else is a 400
`invalid_panel`), `scope` only `server` (`invalid_scope` otherwise; `cluster` is a
400 `cluster_fanout_disabled` unless `system.cluster_fanout`, then a 501
`cluster_scope_unsupported`: not implemented yet), and any other parameter
is a 400 `unknown_parameter`, so no request text reaches the SQL. `from_ms >=
to_ms` is a 400 `invalid_range`, a window over `max_lookback_days` a 400
`range_too_large`. The server picks the step, the smallest of 10 s, 30 s,
1 min, 5 min, 15 min, 30 min, 1 h, 3 h, 6 h, 1 d giving at most 300 buckets
(1 h: 30 s, 24 h: 5 min, 7 d: 1 h, 30 d: 3 h), and aligns the window to it, so
every request of one aligned window shares a 15 s cache entry (one read in
flight per window). It runs three SELECTs through the system context, one pass
each:

- `system.metric_log`: the allowlisted columns this server has (detected with
  the other capabilities); `ProfileEvent_*` are per-sample deltas, so a rate is
  their sum over the seconds the bucket covers (the bucket still in progress:
  up to its last sample), `CurrentMetric_*` are gauges (average, or maximum for
  a peak). A `metric_log` in the transposed layout (no `ProfileEvent_*`
  column) is read as no `metric_log` (`unsupported`).
- `system.asynchronous_metric_log`: `metric IN (<allowlist>)` first (the
  table's key), average per bucket (maximum for the load, the parts per
  partition and the replica delay).
- `system.query_log`: the key, `type`, `is_initial_query` and
  `query_duration_ms` only (`quantilesTDigest`); skipped (`out_of_range`, not
  an error) when the window is wider than `query_log_max_lookback_hours`.

Each SELECT has the System `SETTINGS` (10 s, 50 M rows read, or
`query_log_max_rows` for `query_log`, and a result cap of the bucket count).
The answer has `timestamps` (bucket starts, ms), `series` (name to one value or
`null` per bucket), `sources` (`status`, `message`, `hint`, `rows_read`,
`elapsed_ms`, `missing` columns per log), `unavailable_panels`,
`step_seconds`, the aligned `from_ms` / `to_ms`, the `requested` window,
`limits` and `replicated_tables`. On the local test stack (14 days of logs) a
cold read takes about 0.1 s whatever the range.

### Activity

**Activity** (`app_system_activity.js`) shows what the selected server is
doing in the background, in the spirit of clickhouse-monitoring:

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
  blocked state, broken files and the last exception.

Kinds with a problem come first, then kinds with rows; empty kinds are folded
into one quiet "No pending mutations · No merges running ..." line, and a
system table the server does not expose is reported as not readable instead of
empty. A table name opens its Explorer card. The Keeper session is the
Cluster's Keeper card, not a list of its own. The part is absent with
`system.activity = false`.

`GET /api/system/activity?host_id=<id>[&refresh=1]` runs five fixed
queries through the system context: `system.merges`, `system.mutations WHERE
NOT is_done`, `system.replication_queue` aggregated `GROUP BY database, table`,
`system.replicas` and `system.distribution_queue`. Each query is restricted to
`database IN (<databases the runner can SHOW>)` inside ClickHouse, and every row
is then kept only when the runner can SHOW that object (runner-context
`discover_visible_objects`, resolved lazily for the databases that actually
appear): an object hidden from the runner never reaches the browser, and its
rows never consume the bound. Each kind reads at most 201 rows and returns
200 (`row_limit`); a full one is listed in `truncated_sections`, an
unreadable one in `unavailable_sections`. The `system.replicas` read selects
in-memory columns only; `log_max_index`, `log_pointer`, `total_replicas`,
`active_replicas`, `zookeeper_exception` and `replica_is_active` cost a Keeper
request per table and are not selected. The replica counts come from the same
per-server 60 s cache as the catalog (see
[Explorer](explorer.md#replication-metadata-and-keeper-load)).

`GET /api/system/keeper?host_id=<id>[&refresh=1]` reads
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

Both answers are cached per host for `min(explorer.cache_ttl_ms, 5 s)` (at
least 1 s); `refresh=1` bypasses the cache. The routes are present while
`system.activity` and `system.keeper` respectively; v2.14.0's
`/api/explorer/ops/activity` and `/api/explorer/ops/keeper` stay as aliases
of the same handlers.

## Queries

**Queries** (`app_system_queries.js`) ranks the query shapes this server ran
over a window, after ClickHouse Cloud's Query Insights: a shape is a
`normalized_query_hash` (the text with its literals replaced). The window is
the time range picker in the tab row, beside the refresh button (1 hour by
default, at most `system.query_log_max_lookback_hours`, 168); there is no
Auto-refresh. Under the tab row: the statement **Kind** (All, SELECT, INSERT,
Other) and **Hide ChDash** (on by default), then the window's tiles (queries,
shapes, total time, errors and their share, bytes read; the Shapes tile says
"the top 50 listed" when there are more) and the top 50:

| Column | |
| --- | --- |
| # / Query | the rank; the normalized SQL in mono through `ui.sqlBlock` (the highlighter escapes it), two lines, all of it on hover |
| Kind, Calls, Errors | `query_kind`; runs; failed runs as a badge with their share (neutral under 1 %, warning to 5 %, danger from 5 %) |
| Total time, Avg, p95, Max | durations; Total time carries an in-cell bar |
| Read rows, Read, Memory | rows and bytes read, the largest memory use of a run |
| Users, Tables | up to 5 users and 8 tables |

The headers of Calls, Errors, Total time, p95, Read and Memory sort the list
(on the server: the top 50 by that measure). Measures are sans with tabular
figures, SQL, hashes and query ids mono, times 24 h browser-local. Under
1,280 px Max, Read rows and Tables go, under 900 px Kind, Errors, Avg, p95,
Read, Memory and Users (the kind, the users and the errors move under the
query) and a row of sorts appears; on a phone the query and its total time
remain, the calls under the query. The address keeps `from` / `to`, `sort`,
`kind` and `hide=0` when they differ from the defaults.

A row (or Enter on it) opens the **shape** in place of the list (`?q=<hash>`,
pushed: Back returns to the list): its tiles (calls, errors, total and average
time, p95 and max, bytes and rows read, the largest memory use, CPU time),
three charts on the shared engine (runs finished and failed per bucket, p50
and p95 duration, CPU time with the rows read and memory at the cursor;
crosshair shared, a drag narrows the window) and its 20 **Slowest**,
**Latest** or **Most memory** runs (`runs=`): time, duration, status (the
exception code and message), rows and bytes read, result rows, memory, CPU,
user and query id. Two actions put SQL in the Query page's editor: they write
the Query page's session draft and navigate to `/query`, which reads it on
load; neither runs it:

- **Open example in Query**: the latest run's text, formatted by the server
  (as written when the formatter cannot parse it; disabled past 256K
  characters).
- **Open history in Query**: `SELECT event_time, query_id, user, type,
  query_duration_ms, … FROM system.query_log WHERE event_date >= … AND
  event_time >= … AND normalized_query_hash = <hash> AND type IN (…) AND
  is_initial_query ORDER BY event_time DESC LIMIT 100`, the window as
  `now() - INTERVAL 1 HOUR` for a relative range ending now, the instants
  otherwise.

`GET /api/system/queries?host_id=<id>[&from_ms=&to_ms=][&sort=][&kind=][&hide_chdash=1|0][&refresh=1]`
and `GET /api/system/queries/<hash>?host_id=<id>[&from_ms=&to_ms=][&order=duration|latest|memory][&hide_chdash=][&refresh=1]`
(routes present while `system.top_queries`) read `system.query_log` with the
**runner** account: ClickHouse grants decide, and the runner can already read
the same rows in the Query page. `sort` is one of `total_time | calls | p95 |
max_memory | read_bytes | errors` (each a fixed `ORDER BY`), `kind` one of
`all | Select | Insert | other`, the hash the decimal digits of a UInt64;
anything else is a 400 (`invalid_sort`, `invalid_kind`, `invalid_order`,
`invalid_hash`, `invalid_hide_chdash`, `unknown_parameter`). A window wider
than `query_log_max_lookback_hours` is a 400 `range_too_large`. Every row
counted is a finished or failed initial query (`type IN ('QueryFinish',
'ExceptionWhileProcessing', 'ExceptionBeforeStart') AND is_initial_query`) and
never one of the System page's own reads (`log_comment != 'chdash-system'`);
`hide_chdash` (the default) also leaves out the system account's user.
ChDash's runner-side reads (health checks, the Catalog) share the runner's
user and stay listed.

Two phases, because the text costs several times the numbers:

1. the narrow columns grouped by `normalized_query_hash`, ordered by the sort,
   `LIMIT 50`, with the window's totals over every shape (window functions
   after the `GROUP BY`) and `max_rows_to_group_by = 1000000,
   group_by_overflow_mode = 'any'` (past a million shapes a new one is not
   counted);
2. the text of those 50 only: `PREWHERE normalized_query_hash IN (…)`, the
   latest run's `query` (4,096 characters), its `normalizeQuery` and query id.

A shape's answer is three reads `PREWHERE normalized_query_hash = <hash>`: the
timeline (the Performance steps, at most 300 buckets; the CPU time from
`ProfileEvents`, read only here) with the window's figures, the 20 runs, and
the latest run's text (256K characters). Each SELECT has the System
`SETTINGS` with `query_log_max_rows` (50 M) as its read cap and 15 s (phase 1)
or 10 s. Answers are cached 60 s per minute-aligned window, sort, kind and
filter, one read in flight per key; `refresh=1` bypasses it. They carry
`phases` (or `reads`: `status`, `rows_read`, `bytes_read`, `elapsed_ms`).

Degraded states (`status`, and `unavailable_panels` in the shape above):
`disabled` ("system.query_log is disabled on this server", with the
`<query_log>` server setting and `log_queries = 1`), `not_granted` (the
runner's GRANT, `GRANT SELECT ON system.query_log TO <runner user>`, with a
copy button), `window_too_large` (a read past the cap or the time budget; the
answer suggests a span from the rows the last hour logged, `suggested_span_ms`,
and **Narrow to the last …** applies it), `readonly_account` and
`unsupported`. A window past the lookback offers **Show the last …** (the
lookback: 7 days by default). If phase 2 fails the shapes stay, named by
their hash.

On the local test stack (`query_log` of 7.7 M rows over 7 days), phase 1 reads
the window once (36 k rows for 1 h, 1.1 M for 24 h, 7.7 M for 7 d: 2.5 MB,
71 MB, 508 MB) in about 0.01, 0.04 and 0.13 s; phase 2 reads the hash column of
the window and the text of the matching granules (15 MB, 383 MB, 2.6 GB) in
0.01, 0.04 and 0.2 s. A shape's three reads take 0.03, 0.09 and 0.35 s.

## Disks

**Disks** (`app_system_disks.js`) answers which disk, how full, how fast it
grows and which databases fill it. It does not redo the Explorer's database
storage (no treemap, no partitions): a database opens its Explorer page,
scrolled to its storage (`/explorer/<db>?tab=storage`, which the Explorer
writes back as `/explorer/<db>`).

- **Tiles**: the disks and storage policies, the fullest disk, the bytes of
  the runner-visible databases' active parts (ClickHouse data).
- **A card per disk**: its fill as a bar on its own track beside the
  percentage, **neutral under 80 %, warning from 80 % to 90 %, danger from
  90 %** (the card's border takes the tone too); used of total; free
  (`free_space`, what ClickHouse may still write, `keep_free_space` excluded),
  unreserved (`unreserved_space`: free space not reserved by merges,
  mutations and fetches in progress), keep free (`keep_free_space`); **Until
  full**; the ClickHouse data on it (bytes, parts, databases); the path
  and cache path (mono, wrapped, never cut); the policies and volumes it
  belongs to; badges for its type, object storage, remote, encrypted,
  read-only and broken. A disk without a capacity (object storage,
  `total_space = 0`) says "Capacity not reported" and shows the bytes of
  its active parts instead.
- **Growth** (charts on the shared engine, crosshair shared, a drag narrows
  the window): **Disk used** per disk (disks on one filesystem report the
  same bytes and draw one line, named after all of them; the axis follows the
  data so a slow growth of a large disk reads), **MergeTree data**
  (`TotalBytesOfMergeTreeTables`) and **Written and moved**: the bytes of the
  new parts the runner-visible databases wrote and of the parts moved by TTL
  or the storage policy (`part_log`; hidden without it).
- **Bytes by database**: per disk, one stacked bar of its top 8 databases
  and Others (a segment opens that database) over a table of the same rows:
  the database (a link to its storage in the Explorer), its size, its share of the disk
  as a bar on its own track, its parts. A colour follows a database across
  the disks.
- **Storage policies**: policy, its volumes in priority order, their disks,
  type, `max_data_part_size`, `move_factor` and `prefer_not_to_merge`; a
  server with only the `default` policy and one volume gets one line.

The window is the time range picker in the tab row, beside the refresh button
(the last `system.disk_growth_days`, 7, by default; at most
`max_lookback_days`), in the address as `from` / `to` when it differs. There
is no Auto-refresh. **Until full** is the free space over the least-squares
slope of the disk's used bytes across the window's buckets. It is never
extrapolated from too little history (fewer than 6 buckets, or less than 6
hours between the first and the last: "Not enough history", with what the
window holds) nor from a flat or falling trend (the trend adds less than
1/10,000 of the capacity, or 1 MiB, over the window: "Not growing"). A
forecast reads as a warning under 30 days and as danger under 7.

`GET /api/system/disks?host_id=<id>[&refresh=1]` (any other parameter is a
400 `unknown_parameter`) runs through the system context, cached 60 s per
host; the Overview's Databases read the same answer:

- `system.disks` (`ORDER BY name LIMIT 201`): name, path, `free_space`,
  `total_space`, and the columns this server has of `unreserved_space`,
  `keep_free_space`, `type`, `object_storage_type`, `cache_path`,
  `is_read_only`, `is_broken`, `is_encrypted`, `is_remote` (detected with the
  other capabilities; absent ones are `null`);
- `system.storage_policies` (`ORDER BY policy_name, volume_priority LIMIT
  501`), the optional columns detected the same way;
- `system.parts`: `WHERE active AND database IN (<databases the runner can
  SHOW>) GROUP BY disk_name, database`, bytes, rows, parts and compact parts,
  largest first, `LIMIT 1001`, with each disk's totals over every visible
  database as window functions (so a cut list still knows its Others); each
  row is re-checked against the runner's databases. A database the runner
  cannot see is neither listed nor counted.

The answer has `disks` (with `used_space`, `null` without a capacity, and
`policies`: the policy and volume of each membership), `policies` (each with
its `volumes`), `usage` (`rows`, and `disks`: bytes, parts and databases per
disk), `logs`, `limits` and `unavailable_panels` (`disks`, `policies`,
`usage`: a missing grant says which GRANT to run).

The growth is `GET /api/system/series?host_id=<id>&panel=disk_growth[&from_ms=&to_ms=][&refresh=1]`:
the window validated and stepped as Performance's (7 days: 1 h buckets),
cached 5 minutes per aligned window. It reads `system.disks` (names, free
space and capacity), then `system.asynchronous_metric_log` once: the largest
`DiskUsed_<disk>` sample of each bucket, the disk names quoted from
`system.disks`, and `TotalBytesOfMergeTreeTables`. **ClickHouse 26.8** adds a
`key` column and logs the per-disk metric as `metric = 'DiskUsed'` with the
disk in `key` (unless `asynchronous_metrics_key_values_mode` is
`legacy_names` or `both`): when the column exists the predicate is
`(metric = 'TotalBytesOfMergeTreeTables' OR metric IN ('DiskUsed_<d>', …) OR
(metric = 'DiskUsed' AND key IN ('<d>', …)))` and the disk is
`if(metric = 'DiskUsed', key, substring(metric, 10))`, so either form, or
both, reads the same (`disk_metric_form`: `names` or `key`). Last,
`system.part_log`: `sumIf(size_in_bytes, event_type = 'NewPart')`, the same
for `MovePart` and the move count per bucket, `database IN (<runner-visible
databases>)`, summed over them (no database is named). The answer has
`timestamps`, `disks` (`name`, `free_space`, `total_space`, `used` per
bucket, `trend`: `status` growing, not_growing, not_enough_history or
no_capacity, `points`, `span_seconds`, `slope_bytes_per_day`,
`days_until_full`), `series` (`merge_tree_bytes`, `written_bytes`,
`moved_bytes`, `moves`), `sources` and `unavailable_panels`. Without
`asynchronous_metric_log` the charts give way to "Growth needs
system.asynchronous_metric_log" and the cards say what they need; a source
that cannot be read shows its reason and GRANT. Every SELECT has the
System `SETTINGS` (5 s or 10 s, 100 k, 10 M or 50 M rows read, a result
cap). On the local test stack `/disks` answers in about 15 ms and a week of
growth in about 45 ms (1.7 M `asynchronous_metric_log` rows and 1.1 M
`part_log` rows read).
