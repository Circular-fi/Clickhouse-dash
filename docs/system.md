# System

The **System** page shows the health of the selected server. It uses the system tables of the server. It shows what the server does now, its history, its top queries and its disks. The page is about the server. It is not about a database or a table. For this reason, it is a page of its own beside Query, Explorer and Observability (the page switcher of the header). It is not an Explorer view. Every read is a fixed, bounded, read-only SELECT on system tables. Only allowlisted values of a request can reach the SQL.

## Routes and page

The sections are three pages of their own: `system.html`, `queries.html` and `disks.html`. One controller starts them (`app_system.js`). A row of links in one nav row under the header goes from page to page. The links look like the underlined tabs, and the current page is marked. Under the nav row, each section has the filter bar of Observability (`ns.filterBar`, docs/ui-foundations.md, "Filter bar"). The filter bar has these parts:

- The time range is first on the left (the same picker).
- The filters of the section follow. They are the same "Label · Value" pickers.
- A refresh icon button is at the right end, in the slot of the Search button of Observability.

A change of a filter or of the range applies at once. The button reloads the section. The height, the padding, the gaps and the wrap rules are the same as on Traces, Logs and Metrics. At 600 px and below, the filter bar folds into one summary line ("Last 1 hour · 2 filters"). The summary line unfolds it, and the refresh button folds it again.

| Section | Address | What it shows |
| --- | --- | --- |
| Overview | `/system[?from=&to=]` | server tiles, the databases, the cluster (topology, Keeper, replication), the performance history (`from` / `to`: its time range), the background activity, one page top to bottom |
| Queries | `/system/queries[?from=&to=&sort=&kind=&errors=&user=&database=&table=&hide=0]` | the top query shapes of a window |
| (a query shape) | `/system/queries/<hash>[?from=&to=&runs=&<the list's parameters>]` | one shape's timeline and runs, a page of its own (below), not a section: no section tabs |
| Disks | `/system/disks[?from=&to=]` | each disk's fill, its growth and time until full, the bytes of each database on it, the storage policies |

The browser follows the link of a section. Back / Forward walk the history of the browser, from page to page. Inside a page, they walk from one query string to the next. Each section keeps its own parameters. The page of another section does not receive them. The server answers an unknown section (`/system/whatever`) with a `302` to Overview and keeps the query string. The configuration can turn off a section (Queries with `system.top_queries = false`). That section has no link, and its address is a `302` to Overview in the same way. Each page loads only the module and the stylesheet of its own section (`style.system.css`, `style.queries.css`, `style.disks.css`).

The former addresses of Explorer answer with a redirect to the System page (`server.cpp` `redirect_to_system`). The redirect has these properties:

- It is a `302`.
- It has `Cache-Control: no-store`.
- It has a `Location` that is relative to the request. In this way, a prefix of a reverse proxy is kept.
- It keeps the query string as it came.

| Former address | Redirects to |
| --- | --- |
| `/explorer/_monitoring` (the Monitoring tab) | `/system` |
| `/explorer/_monitoring/queries`, `/explorer/_monitoring/disks` | `/system/queries`, `/system/disks` |
| `/explorer/_monitoring/performance` | `/system#performance` |
| `/explorer/_monitoring/activity`, `/explorer/_operations` (v2.14.0's Server operations) | `/system#activity` |

`#performance` and `#activity` scroll the Overview to that part when the page opens on it. The page keeps the part at the top while the parts above it fill in, until the reader scrolls. With `system.enabled = false`, there is no redirect. These addresses open the Explorer Catalog.

The shell is `src/static/system.html` (header partial `src/shell/header.html`, generated regions from `tools/page_shells.py` `SHELLS`). Its sheet is `style.system.css` (`tools/build_page_css.py` `PAGES`, source `src/static/css/20-features/system.css`). The bootstrap `app_system.js` handles the routes, Back / Forward, the host change and *Open in Query*. It starts the modules of `pages.system` in `src/static/modules.json`. The highlighter is the lazy group `highlight`:

| Module | Holds |
| --- | --- |
| `app_system_view.js` | `ns.systemView`: the section registry, each section's filter bar (`ns.filterBar`, `app_ui_filterbar.js`), the shared kit (section bar, issue block, cards, parts) |
| `app_system_overview.js` | Overview: tiles, Databases, Cluster, and the parts below |
| `app_system_perf.js` | the Overview's Performance part (`ns.systemPerf`) |
| `app_system_activity.js` | the Overview's Activity part (`ns.systemActivity`) |
| `app_system_queries.js` | Queries |
| `app_system_disks.js` | Disks |

Each section registers itself (`ns.systemView.register({ id, label, order, available, create })`). A section that is not registered or not available has no link. The panel of each section (`.systemPage__panel`) is its own scroller.

Every figure is **the own figure of this server**. The system tables are local to each node. For this reason, `query_log` holds the queries that the node received or ran, and the metrics are the metrics of that node. Each replica that is configured as a ChDash host gets its own page (the host picker of the header names it). It needs no extra grant. The `clusterAllReplicas` views across a cluster are opt-in (`system.cluster_fanout`). They need `GRANT REMOTE ON *.*` for the system account. The topology always comes from the local `system.clusters`.

Configuration: the `system { }` block (see [configuration.md](configuration.md#evolution-blocks)). The `explorer.operations { enabled, keeper }` of v2.14.0 still works. `system.enabled = false` removes these items: the entry of the page switcher, the page, every `/api/system/...` route (the `/api/explorer/ops/...` aliases included) and the redirects. `/api/version` reports `features.system` (`enabled`, `activity`, `keeper`, `top_queries`, `cluster_fanout`, `default_lookback_minutes`, `max_lookback_days`, `query_log_max_lookback_hours`, `disk_growth_days`).

## Reads, budgets and degradation

Every endpoint runs fixed queries. The request provides no SQL, no column, no filter and no limit. A parameter outside the allowlist of the endpoint is a 400 `unknown_parameter`. Every SELECT ends with this clause: `SETTINGS readonly = 2, max_execution_time = N, timeout_overflow_mode = 'throw', max_rows_to_read = R, read_overflow_mode = 'throw', max_result_rows = L, result_overflow_mode = 'throw', log_comment = 'chdash-system'`.

- A cap stops the read with an error. The answer is never silently partial.
- The own load of ChDash stays visible (and can be excluded) in `system.query_log`.
- The settings are set for each query. For this reason, neither account can have a `readonly = 1` profile.

The runner bounds the objects. A read of `system.replicas`, `system.parts` and the activity tables is restricted to `database IN (<databases the runner can SHOW>)` inside ClickHouse. The page then keeps each row only when the runner can SHOW that object. The page does not list or count a database or table that is hidden from the runner.

The page detects once for each host what a server exposes, and keeps the result for 10 minutes. It detects these items:

- The optional system logs (`query_log`, `metric_log`, `asynchronous_metric_log`, `part_log`, `zookeeper_connection`, reported in `logs`).
- The columns that older versions do not have. The page leaves them out and shows them as `—`.

A panel that cannot be read degrades on its own. It is listed in `unavailable_panels` (`panel`, `table`, `reason`, `message`, `hint`). It is never a page error. The reasons are:

- `disabled`: the table does not exist (ClickHouse codes 60, 81).
- `not_granted`: ClickHouse code 497. `hint` is the statement to run, `GRANT SELECT ON system.<table> TO <system user>`. The page shows it with a copy button.
- `unsupported`: a column that this version does not have (16, 47).
- `window_too_large`: the time budget or the read cap (159, 158).
- `readonly_account`: 164. A `readonly = 1` profile cannot set the limits.
- `failed`.

## Overview

**Overview** (`app_system_overview.js`) shows the selected server on one scrolling page, top to bottom. The parts are the server tiles, **Databases**, **Cluster**, **Performance** and **Activity**. Each part degrades on its own. If an answer or a panel fails, only that part says why. The page shows no figure twice.

- **Server tiles**: they show these items:
  - Uptime.
  - CPU (`OSUserTimeNormalized` + `OSSystemTimeNormalized`, the share of all cores).
  - Resident memory of the total (`CGroupMemoryTotal` when the container has a limit, else `OSMemoryTotal`).
  - Load average.
  - Running queries, merges and mutations.
  - Client connections.
  - MergeTree parts with their size, and the most parts in one partition (warning from 300, error from 1,000: `parts_to_delay_insert`).
  - Delayed inserts.

  A tile for a metric that the server does not have shows `—`.
- **Databases**: the size band of the databases that the runner can see, by bytes on disk. It is the band of the Explorer (`ns.explorerTreemap.band`). It is always the treemap (`#systemDatabaseMap`, `strip: "never"`), for any distribution. The data come from the `usage` rows of `/api/system/disks`, summed by database, for every disk.
  - The heading counts the databases (`N databases · size on disk`).
  - A database under 1% of the total is grouped into Others. The footnote says what the bytes are.
  - A click on a database opens its Explorer card (`/explorer/catalog/<db>`). The map is static when the Explorer is off.
  - The part shows "No data on disk" when no visible database has active parts.
  - If the `usage` panel is not readable, it says why in its place.
- **Cluster**: three cards in two balanced columns. Topology and the Replication summary under it are in one column. Keeper (the tallest) is beside them.
  - **Topology**: for each cluster of `system.clusters`, one row for each shard and replica (host, address, `errors_count`, `slowdowns_count`, `estimated_recovery_time`). The card marks this server. A cluster of one local replica (the built-in `default`) is this server alone. When every cluster is like this, the card says "Single server, no multi-replica cluster". The card has at most 1,000 rows.
  - **Keeper**: one card for the session and for an embedded Keeper. It shows these items:
    - A badge (Connected / Session expired).
    - Each connection of `system.zookeeper_connection` (host and port, connected since in the tooltip) with its session uptime and timeout.
    - The latency. It is the average over the last refresh interval once two snapshots exist. Before that, it is the average wait for each transaction since start.
    - The requests in flight, and the transaction rate (transactions since start before a second snapshot).
    - Watches.
    - Exceptions since start.
    - For a Keeper that is embedded in this server: its role, znodes, Keeper latency (average and max) and followers in sync (`Keeper*` asynchronous metrics).

    The card says "No Keeper configured" when there is no connection, no session and no embedded Keeper. The card is hidden with `system.keeper = false`.
  - **Replication**: the replicated tables that the runner can see. It shows their status, the read-only and expired sessions, the largest delay and the queue. It uses the alert thresholds of Altinity (`future_parts > 20`, `parts_to_check > 10`, `queue_size > 20`, `inserts_in_queue > 10`, delay over 5 minutes). It is hidden when there are no replicated tables. These tables are the Replicas of the Activity, further down.
- **Performance** and **Activity**: below.

There is **no live refresh** (no Auto-refresh toggle, no timer). The Overview reads its parts on load and on show, on a range change, on a host change and with the refresh button. The refresh button reloads every part. On show, the charts read again when their relative range was read 30 s ago or more. The databases read again when their last read is older than 60 s. If a browser stored the former Auto-refresh choice (`chdash.system.autoRefresh`), the dashboard removes it.

`GET /api/system/overview?host_id=<id>[&refresh=1]` runs fixed queries through the system context. The queries read these items:

- `version()`, `timezone()`, `hostName()` and `uptime()`.
- The allowlisted names of `system.asynchronous_metrics` and `system.metrics`.
- `system.clusters` (`LIMIT 1001`).
- The in-memory columns of `system.replicas`, restricted to the databases of the runner (`LIMIT 10001`). The route counts a row only when the runner can SHOW that table.

`log_max_index`, `log_pointer`, `total_replicas` and `active_replicas` cost one Keeper request for each table. The route does not read them. The backend caches the snapshot for each host for `min(explorer.cache_ttl_ms, 5 s)` (at least 1 s). For this reason, any number of open pages costs one read for each interval. `refresh=1` bypasses the cache. The Keeper card adds `/api/system/keeper` (*Activity* below).

### Performance

**Performance** (`app_system_perf.js`) charts the history of the server over a time range. The range picker is the time range picker of Observability (`ns.timeRange`, the same quick ranges, calendar and browser-local 24 h times). It is first in the filter bar of the Overview, where Queries and Disks have their own (the refresh button is at the other end). The default range is 1 hour (`system.default_lookback_minutes`). The maximum is `system.max_lookback_days` (30). The range is in the address of the Overview as `from` / `to` (`now-6h`, `2026-10-03 14:00:00`). It is absent for the default.

The part has ten charts on the shared chart engine (`ns.chartCore`, canvas). Each chart is in a chart card. There are two cards in a row (one under 900 px). These rules apply to the charts:

- The charts share a crosshair.
- A drag over any chart sets the range of all of them. The page pushes the range to the address, and Back returns to the previous range.
- Each chart has one unit, also on its axis (CPU in cores, Merges & mutations in tasks running). A figure in another unit is in the summary of the card and in the tooltip at the cursor.
- A chart at 0 over the whole range (no replication delay) shows its title and one line. The line is "Max delay 0 s over the whole range". The chart is at the end of the grid.
- A chart that is alone on its row takes the row.
- A hidden series keeps its legend swatch in full color. Its name is struck through.

| Chart | Series | Source | Without it |
| --- | --- | --- | --- |
| Queries/s | SELECT, INSERT, other (stacked), failed; the error share of the range as a badge (neutral under 1 %, warning to 5 %, danger from 5 %) | `metric_log` | finished and failed initial queries per second from `query_log` |
| Query latency | p50, p95, p99 of the initial queries (one hue) | `query_log` | the average (`metric_log`), labeled "average", also past `query_log_max_lookback_hours` |
| CPU | ClickHouse's CPU and I/O wait (`metric_log`), the machine's user and system time (`OSUserTime`, `OSSystemTime`), in cores; the core count; the 1-minute load at the cursor | both | either alone |
| Memory | tracked (average and peak), merges and mutations (`metric_log`), resident (`asynchronous_metric_log`); OS memory available at the cursor | both | either alone |
| Merges & mutations | running merges and mutations; rows merged per second in the summary | `metric_log` | "Needs system.metric_log" |
| Inserts | rows inserted per second, a marker on each bucket with delayed or rejected inserts; bytes per second in the summary | `metric_log` | same |
| Parts | MergeTree parts and the most in one partition (`asynchronous_metric_log`), active and outdated (`metric_log`) | both | either alone |
| Background pools | tasks of the merges and mutations, fetches, moves, schedule and common pools; pool sizes (hidden at first) | `metric_log` | "Needs system.metric_log" |
| Reads | rows selected per second; bytes per second in the summary | `metric_log` | same |
| Replication | the largest replica delay; the queue in the summary | `asynchronous_metric_log` | hidden on a server without replicated tables |

Assume that `metric_log` and `asynchronous_metric_log` are not available. Then the part says "History needs system.metric_log or system.asynchronous_metric_log (server configuration): the current values are the tiles at the top". It shows only the `query_log` charts. It does not repeat the tiles. The part lists a log that it cannot read above the charts, with its reason. When a grant is missing, it also shows the GRANT to run.

`GET /api/system/series?host_id=<id>[&from_ms=&to_ms=][&refresh=1]` takes whole milliseconds and nothing else. The default window applies when they are absent. A `to_ms` in the future ends now. These rules apply to the parameters:

- `panel` can be only `performance` (the default) or `disk_growth` (*Disks*). Anything else is a 400 `invalid_panel`.
- `scope` can be only `server` (`invalid_scope` otherwise). `cluster` is a 400 `cluster_fanout_disabled` unless `system.cluster_fanout` is set. Then it is a 501 `cluster_scope_unsupported`: it is not implemented yet.
- Any other parameter is a 400 `unknown_parameter`. In this way, no request text reaches the SQL.
- `from_ms >= to_ms` is a 400 `invalid_range`.
- A window over `max_lookback_days` is a 400 `range_too_large`.

The server picks the step. The steps are 10 s, 30 s, 1 min, 5 min, 15 min, 30 min, 1 h, 3 h, 6 h and 1 d. The server uses the smallest step that gives at most 300 buckets (1 h: 30 s, 24 h: 5 min, 7 d: 1 h, 30 d: 3 h). It aligns the window to the step. For this reason, every request of one aligned window shares a cache entry of 15 s (one read in flight for each window). The server runs three SELECTs through the system context. Each SELECT uses one pass:

- `system.metric_log`: the allowlisted columns that this server has (detected with the other capabilities).
  - `ProfileEvent_*` are deltas for each sample. A rate is their sum over the seconds that the bucket covers (for the bucket still in progress: up to its last sample).
  - `CurrentMetric_*` are gauges (average, or maximum for a peak).
  - The server reads a `metric_log` in the transposed layout (no `ProfileEvent_*` column) as no `metric_log` (`unsupported`).
- `system.asynchronous_metric_log`: `metric IN (<allowlist>)` first (the key of the table). The value is the average for each bucket (maximum for the load, the parts for each partition and the replica delay).
- `system.query_log`: the key, `type`, `is_initial_query` and `query_duration_ms` only (`quantilesTDigest`). The server skips it (`out_of_range`, not an error) when the window is wider than `query_log_max_lookback_hours`.

Each SELECT has the System `SETTINGS` (10 s, 50 M rows read, or `query_log_max_rows` for `query_log`, and a result cap of the bucket count). The answer has these fields:

- `timestamps` (bucket starts, ms).
- `series` (name to one value or `null` for each bucket).
- `sources` (`status`, `message`, `hint`, `rows_read`, `elapsed_ms`, `missing` columns for each log).
- `unavailable_panels`.
- `step_seconds`.
- The aligned `from_ms` / `to_ms`.
- The `requested` window.
- `limits`.
- `replicated_tables`.

On the local test stack (14 days of logs), a cold read takes about 0.1 s for any range.

### Activity

**Activity** (`app_system_activity.js`) shows what the selected server does in the background, in the spirit of clickhouse-monitoring:

- **Replicas**: the health of every replicated table (read-only, expired Keeper session, delay, queue with inserts/merges, last queue update and its exception, `active / total` replicas).
- **Mutations**: pending mutations only. The failing mutations are first, with the failed part, the error code name and the reason.
- **Replication queue**: one row for each table (entries, executing, postponed, max tries, oldest entry, entry types, last exception or postpone reason).
- **Merges**: running merges and mutation merges (partition, progress, elapsed, source size, parts, memory).
- **Distributed send queues**: pending files and bytes for each shard directory, errors, blocked state, broken files and the last exception.

The kinds with a problem come first. Then the kinds with rows follow. The part folds the empty kinds into one quiet line "No pending mutations · No merges running ...". It reports a system table that the server does not expose as not readable, not as empty. A table name opens its Explorer card. The Keeper session is the Keeper card of the Cluster. It is not a list of its own. The part is absent with `system.activity = false`.

`GET /api/system/activity?host_id=<id>[&refresh=1]` runs five fixed queries through the system context:

- `system.merges`.
- `system.mutations WHERE NOT is_done`.
- `system.replication_queue` aggregated `GROUP BY database, table`.
- `system.replicas`.
- `system.distribution_queue`.

Each query is restricted to `database IN (<databases the runner can SHOW>)` inside ClickHouse. The route then keeps every row only when the runner can SHOW that object (runner-context `discover_visible_objects`, resolved lazily for the databases that actually appear). An object that is hidden from the runner never reaches the browser. Its rows never use the bound.

Each kind reads at most 201 rows and returns 200 (`row_limit`). The answer lists a full kind in `truncated_sections` and an unreadable kind in `unavailable_sections`. The `system.replicas` read selects only in-memory columns. `log_max_index`, `log_pointer`, `total_replicas`, `active_replicas`, `zookeeper_exception` and `replica_is_active` cost one Keeper request for each table. The route does not select them. The replica counts come from the same cache of 60 s for each server as the catalog (see [Explorer](explorer.md#replication-metadata-and-keeper-load)).

`GET /api/system/keeper?host_id=<id>[&refresh=1]` reads these items:

- `system.zookeeper_connection` (at most 16 rows).
- The allowlisted `system.metrics`: `ZooKeeperSession`, `ZooKeeperSessionExpired`, `ZooKeeperRequest`, `ZooKeeperWatch`, `ZooKeeperConnectionLossStartedTimestampSeconds`, `KeeperAliveConnections`, `KeeperOutstandingRequests`.
- `system.events` (`ZooKeeper*` transaction, wait, exception, byte and per-operation counters).
- `average_wait_ms = ZooKeeperWaitMicroseconds / ZooKeeperTransactions`.

The route names no object. The paths of `system.zookeeper` are not browsable on purpose:

- A read of a path is one Keeper request for each node.
- A `LIMIT` cannot bound it before ClickHouse issues those requests.
- The paths themselves (`/clickhouse/tables/<shard>/<table>/...`) name objects that the runner possibly cannot see. These objects are outside the `AllowedObjectSet` boundary.

The backend caches both answers for each host for `min(explorer.cache_ttl_ms, 5 s)` (at least 1 s). `refresh=1` bypasses the cache. The routes are present while `system.activity` and `system.keeper` are set, respectively. The `/api/explorer/ops/activity` and `/api/explorer/ops/keeper` of v2.14.0 stay as aliases of the same handlers.

## Queries

**Queries** (`app_system_queries.js`) ranks the query shapes that this server ran over a window. It follows the Query Insights of ClickHouse Cloud. A shape is a `normalized_query_hash` (the text with its literals replaced). The filter bar holds these items, from left to right:

- The window: the time range picker (1 hour by default, at most `system.query_log_max_lookback_hours`, 168).
- **Kind** (All, SELECT, INSERT, Other).
- **Errors**. The values are All, With errors and Without errors. With errors: the shapes with at least one failed run. Without errors: the shapes whose every run finished. A shape is kept or left out whole.
- **User** (All, then the users of the window, the most active first with their query counts, at most 50).
- **Database** and **Table**. The values are All, then the databases and the tables that the queries of the window involved and that the runner can see. The tables are written `database.table`, as query_log names them. The most involved are first, with their run counts, at most 50 each. These rules apply:
  - The tables are narrowed to the chosen database.
  - A table of another database is dropped when the database changes.
  - A shape is kept whole when one of its runs involved it.
- **Order by**. It is an order, not a filter. For this reason, the summary on a phone does not count it. From 1,279 px down, the pickers from Database on take the second row of the bar.
- **Hide ChDash**, a toggle chip (pressed by default).
- The refresh button.

There is no Auto-refresh. The page of a shape hides the filters. A log or a grant that the runner lacks also hides them. The range and the button stay. Under the bar, the page shows the tiles of the window and the top 50. The tiles are queries, shapes, total time, errors and their share, and bytes read. They count all the filtered shapes. The Shapes tile says "the top 50 listed" when there are more.

| Column | |
| --- | --- |
| # / Query | the rank; the normalized SQL in mono through `ui.sqlBlock` (the highlighter escapes it), two lines, all of it on hover |
| Kind, Calls, Errors | `query_kind` as SQL writes it (SELECT, INSERT: the filter's casing); runs; failed runs as a badge with their share (neutral under 1 %, warning to 5 %, danger from 5 %) |
| Total time, Avg, p95, Max | durations; Total time carries an in-cell bar |
| Read rows, Read, Memory | rows and bytes read, the largest memory use of a run |
| Users, Tables | up to 5 users and 8 tables |

**Order by** picks the measure that the server uses to rank the shapes of the window, largest first. The measures are Calls, Total time (the default), Avg, p95, Max, Errors, Read rows, Read bytes and Memory (the largest memory use of a run). The headers of the same columns sort too. Order by and the headers are one setting. A click on a header moves the picker, and a pick moves the arrow of the header. Either one reads the top 50 again by that measure.

These rules apply to the display:

- Measures are in sans with tabular figures. SQL, hashes and query ids are in mono. Times are 24 h browser-local.
- Under 1,280 px, Max, Read rows and Tables go.
- Under 900 px, Kind, Errors, Avg, p95, Read, Memory and Users go. The kind, the users and the errors move under the query.
- On a phone, the query and its total time remain, and the calls are under the query. The filters wrap onto as many lines as they need (390 and 360 px).
- The address keeps `from` / `to`, `sort`, `kind`, `errors`, `user`, `database`, `table` and `hide=0` when they differ from the defaults. Back and Forward restore them.
- The filters are the filters of the list. The page of a shape shows every run of the shape in the window.

A row (or Enter on it) opens the **shape** as a page of its own (`/system/queries/<hash>`, `shape.html`, started by `app_shape_page.js`). The page has the page header. It has none of the System section tabs (Overview, Queries, Disks) and not the list. It has only the time range and the refresh button of the filter bar. These rules apply to the navigation:

- To open a shape is a page navigation. Its address keeps the parameters of the list (sort, kind, errors, user, database, table, `hide=0`).
- The back arrow (the one of the trace page) returns to the exact list entry from which the user opened the shape. The browser restores that page as it was left, or reads it again. For a shape that the user opened by its address, the back arrow returns to the list of those parameters.
- The former address `/system/queries?q=<hash>` answers a `302` to `queries/<hash>`. The `302` is relative to the request, so a prefix of a reverse proxy is kept. It keeps the other parameters as they came.
- With `system.top_queries = false`, there is no page of a shape, and the route is the route of the System page.

The page has these parts:

- The title is the normalized first line. The hash is in the tooltip of the title and in its copy button.
- The tiles: calls, errors, total and average time, p95 and max, bytes and rows read, the largest memory use, CPU time as a duration.
- The normalized SQL, **formatted** by the formatter of the Query page (`/api/format` of the **Format** button). The `?` and `?..` of normalizeQuery are not SQL. For this reason, they go to the formatter as numeric literals and come back after. The aligned `AS` column is kept. The page shows the text as logged until the formatter answers. It also shows it as logged when the formatter cannot parse it. The copy button of the block copies the formatted text.
- Three charts on the shared engine: runs finished and failed per bucket, p50 and p95 duration, and CPU time with the rows read and the memory at the cursor. The crosshair is shared, and a drag narrows the window. A sparse series marks its points, with room above the largest.
- Its 20 **Slowest**, **Latest** or **Most memory** runs (`runs=`): time, duration, status (the exception code and message), rows and bytes read, result rows, memory, CPU, user and query id.

Two actions put SQL in the editor of the Query page. Both actions work in this way:

- They write the text into the session draft of the Query page (`sessionStorage` `chdash.editor.draft.v2`, this browser tab only).
- They navigate this tab to `/query`. The Query page opens with an empty editor and loads the draft into it.
- They replace the draft that the tab held before.
- Nothing runs. The query runs only when the user presses **Run** there. It runs with the runner account, like any query that the user types.

- **Open example in Query** puts the full text of the **latest run** of the shape in the window in the editor. It is the real statement with its literals, not the normalized `?` form.
  - The text is `system.query_log.query` of the most recent finished or failed initial run by `event_time_microseconds`. The filters are the same as on the page of the shape: Hide ChDash, and never the own reads of the System page.
  - The page first sends the text to `/api/format` (the formatter of the Query page). When the formatter cannot parse it (an `INSERT` with inline data, for example), the text goes in as logged.
  - The button is disabled when the shape has no example. It is also disabled when the text is longer than 256K characters (the text was cut).
- **Open history in Query** puts a ready-made `SELECT` over `system.query_log` in the editor. It lists the runs of this shape, so that the user can filter or extend it. The text is as written (not formatted):

  ```sql
  -- The runs of query shape <hash> (System > Queries).
  -- The last 1h on this server's clock.
  SELECT
      event_time, query_id, user, type, query_duration_ms, read_rows,
      formatReadableSize(read_bytes) AS read, result_rows,
      formatReadableSize(memory_usage) AS memory, exception_code, query
  FROM system.query_log
  WHERE event_date >= toDate(now() - INTERVAL 1 HOUR)
    AND event_time >= now() - INTERVAL 1 HOUR
    AND normalized_query_hash = <hash>
    AND type IN ('QueryFinish', 'ExceptionWhileProcessing', 'ExceptionBeforeStart')
    AND is_initial_query
  ORDER BY event_time DESC
  LIMIT 100
  ```

  The window follows the picker. A relative range that ends now (`now-15m`, `now-1h`, `now-7d`, `now-2w`) is written as `now() - INTERVAL n UNIT`. When the user runs it later, it reads the last n units at that time. Any other range (absolute, or zoomed by a drag on a chart) is written as the instants `toDateTime(<start>)` .. `event_time < toDateTime(<end>)`. The comment has the range in the time zone of the user. Unlike the page of the shape, it lists up to 100 runs, newest first. It does not leave out the queries of the system account (Hide ChDash) or the own reads of the System page.

`GET /api/system/queries?host_id=<id>[&from_ms=&to_ms=][&sort=][&kind=][&errors=all|with|without][&user=][&database=][&table=][&hide_chdash=1|0][&refresh=1]` and `GET /api/system/queries/<hash>?host_id=<id>[&from_ms=&to_ms=][&order=duration|latest|memory][&hide_chdash=][&refresh=1]` (routes present while `system.top_queries`) read `system.query_log` with the **runner** account. The ClickHouse grants decide. The runner can already read the same rows in the Query page. These rules apply to the parameters:

- `sort` is one of `total_time | calls | avg | p95 | max | errors | read_rows | read_bytes | max_memory`. Each value is a fixed `ORDER BY … DESC`.
- `kind` is one of `all | Select | Insert | other`.
- `errors` is one of `all | with | without` (each a fixed `HAVING` on the failed runs of the shape).
- `user` is one user name (1 to 256 bytes, no control character). It is absent or empty for every user.
- `database` is one database name.
- `table` is one `database.table` (1 to 512 bytes, no control character). A table has a dot and something on both sides. Either name can hold dots.
- The hash is the decimal digits of a UInt64.
- Anything else is a 400 (`invalid_sort`, `invalid_kind`, `invalid_errors`, `invalid_user`, `invalid_database`, `invalid_table`, `invalid_order`, `invalid_hash`, `invalid_hide_chdash`, `unknown_parameter`).

The SQL stays fixed:

- The backend never writes the user into the SQL. It binds the user as a ClickHouse query parameter (`AND user = {chdash_user:String}`). The value is sent apart from the text. For this reason, quotes and backslashes are plain characters.
- The database and the table work in the same way, in the `HAVING` of the shapes (`countIf(has(databases, {chdash_database:String})) > 0`, `countIf(has(tables, {chdash_table:String})) > 0`). A shape is kept whole when one of its runs involved them.

The answer has these fields:

- It echoes `errors`, `user`, `database` and `table`.
- `users`: `{name, calls}` of the users of the window under the same filters, most active first (`limits.user_limit`, 50).
- `databases` / `tables`: the same, from the `databases` / `tables` arrays of query_log (how many runs involved each). The backend keeps the first 200 of the read when the runner can see them (the SHOW boundary of the System pages, `discover_visible_*`). The answer has 50 at most for each (`limits.object_limit`).

A window wider than `query_log_max_lookback_hours` is a 400 `range_too_large`. Every row that the backend counts is a finished or failed initial query (`type IN ('QueryFinish', 'ExceptionWhileProcessing', 'ExceptionBeforeStart') AND is_initial_query`). It is never one of the own reads of the System page (`log_comment != 'chdash-system'`). `hide_chdash` (the default) also leaves out the user of the system account. The reads of ChDash on the runner side (health checks, the Catalog) share the user of the runner and stay listed.

There are two phases, because the text costs several times more than the numbers:

1. The backend reads the narrow columns, grouped by `normalized_query_hash`. It filters them by the errors `HAVING`, orders them by the sort, and uses `LIMIT 50`. The same read gives more items. These are the totals of the window over every shape, its users with their query counts, and its databases and tables with their run counts. They are window functions after the `GROUP BY`: `sumMap(sumMap([user], [1])) OVER ()`, no second read. The read uses `max_rows_to_group_by = 1000000, group_by_overflow_mode = 'any'` (past a million shapes, a new shape is not counted).
2. The backend reads the text of those 50 only: `PREWHERE normalized_query_hash IN (…)`, the `query` of the latest run (4,096 characters), its `normalizeQuery` and its query id.

The answer for a shape is three reads `PREWHERE normalized_query_hash = <hash>`:

- The timeline (the Performance steps, at most 300 buckets). The CPU time comes from `ProfileEvents` and is read only here. The read also gives the figures of the window.
- The 20 runs.
- The text of the latest run (256K characters).

Each SELECT has the System `SETTINGS` with `query_log_max_rows` (50 M) as its read cap, and 15 s (phase 1) or 10 s. The backend caches the answers for 60 s. The cache key has these parts: the minute-aligned window, sort, kind, errors, Hide ChDash, user, database and table. There is one read in flight for each key. `refresh=1` bypasses the cache. The answers carry `phases` (or `reads`: `status`, `rows_read`, `bytes_read`, `elapsed_ms`).

The degraded states are `status`, and `unavailable_panels` in the shape above:

- `disabled`: "system.query_log is disabled on this server", with the `<query_log>` server setting and `log_queries = 1`.
- `not_granted`: the GRANT of the runner, `GRANT SELECT ON system.query_log TO <runner user>`, with a copy button.
- `window_too_large`: a read past the cap or the time budget. The answer suggests a span from the rows that the last hour logged (`suggested_span_ms`). **Narrow to the last …** applies it.
- `readonly_account`.
- `unsupported`.

A window past the lookback offers **Show the last …** (the lookback: 7 days by default). If phase 2 fails, the shapes stay, named by their hash.

The measurement used the local test stack (`query_log` of 7.7 M rows over 7 days):

- Phase 1 reads the window once (36 k rows for 1 h, 1.1 M for 24 h, 7.7 M for 7 d: 2.5 MB, 71 MB, 508 MB). It takes about 0.01, 0.04 and 0.13 s.
- Phase 2 reads the hash column of the window and the text of the matching granules (15 MB, 383 MB, 2.6 GB). It takes 0.01, 0.04 and 0.2 s.
- The three reads of a shape take 0.03, 0.09 and 0.35 s.

## Disks

**Disks** (`app_system_disks.js`) answers these questions: which disk, how full, how fast it grows and which databases fill it. It does not do again the database storage of the Explorer (no treemap, no partitions). A database opens its Explorer page, scrolled to its storage (`/explorer/<db>?tab=storage`, which the Explorer writes back as `/explorer/<db>`).

- **Tiles**: the disks and storage policies, the fullest disk, and the bytes of the active parts of the databases that the runner can see (ClickHouse data).
- **A card for each filesystem**: the disks that report the same capacity and free space (to the MiB: the default disk and the disks under its path) share one card, on its own row.
  - The card shows these items once: the fill of the filesystem, the free space, the unreserved space and the forecast (the soonest full). The unreserved space is the free space less what any of the disks reserved. Then the card shows the ClickHouse data, the path and the policies of each disk.
  - The cards share the row (`auto-fit`, at least 340 px each).
  - A card shows its fill as a bar on its own track beside the percentage. The tone is **neutral under 80 %, warning from 80 % to 90 %, danger from 90 %**. The border of the card takes the tone too.
  - A card also shows these items:
    - Used of total.
    - Free (`free_space`, what ClickHouse can still write, `keep_free_space` excluded).
    - Unreserved (`unreserved_space`: free space that merges, mutations and fetches in progress do not reserve).
    - Keep free (`keep_free_space`).
    - **Until full**.
    - The ClickHouse data on it (bytes, parts, databases).
    - The path and the cache path (mono, wrapped, never cut).
    - The policies and volumes that it belongs to.
    - Badges for its type, object storage, remote, encrypted, read-only and broken.
  - A disk without a capacity (object storage, `total_space = 0`) says "Capacity not reported". It shows the bytes of its active parts instead.
- **Growth** (charts on the shared engine, shared crosshair, a drag narrows the window):
  - **Disk used** for each disk. Disks on one filesystem report the same bytes and draw one line, named after all of them. The axis follows the data, so that a slow growth of a large disk is readable.
  - **MergeTree data** (`TotalBytesOfMergeTreeTables`).
  - **Written and moved**: the bytes of the new parts that the databases visible to the runner wrote. It also shows the bytes of the parts that TTL or the storage policy moved (`part_log`; hidden without it).
- **Bytes by database**: for each disk, the share strip of its top 8 databases and Others (the strip of the size band, one color rule: a segment opens that database) over a table of the same rows. The table has these columns: the database (a link to its storage in the Explorer), its size, its share of the disk and its parts. The share is a bar on its own track.
- **Storage policies**: the policy, its volumes in priority order, their disks, type, `max_data_part_size`, `move_factor` and `prefer_not_to_merge`. A server with only the `default` policy and one volume gets one line.

The window is the time range picker at the start of the filter bar. The refresh button is at its other end. The default window is the last `system.disk_growth_days` (7). The maximum is `max_lookback_days`. The address has `from` / `to` when the window differs. There is no Auto-refresh.

**Until full** is the free space over the least-squares slope of the used bytes of the disk across the buckets of the window. The page never extrapolates from too little history, or from a flat or falling trend:

- Too little history is fewer than 6 buckets, or less than 6 hours between the first and the last. The page shows "Not enough history", with what the window holds.
- A flat or falling trend is a trend that adds less than 1/10,000 of the capacity, or 1 MiB, over the window. The page shows "Not growing".

A forecast reads as a warning under 30 days and as danger under 7.

`GET /api/system/disks?host_id=<id>[&refresh=1]` (any other parameter is a 400 `unknown_parameter`) runs through the system context. The backend caches it for 60 s for each host. The Databases of the Overview read the same answer. The route reads these items:

- `system.disks` (`ORDER BY name LIMIT 201`): name, path, `free_space`, `total_space`. It also reads the columns that this server has of this list: `unreserved_space`, `keep_free_space`, `type`, `object_storage_type`, `cache_path`, `is_read_only`, `is_broken`, `is_encrypted`, `is_remote`. The route detects them with the other capabilities. Absent columns are `null`.
- `system.storage_policies` (`ORDER BY policy_name, volume_priority LIMIT 501`), the optional columns detected in the same way.
- `system.parts`: `WHERE active AND database IN (<databases the runner can SHOW>) GROUP BY disk_name, database`.
  - The read returns bytes, rows, parts and compact parts, largest first, `LIMIT 1001`.
  - It adds the totals of each disk over every visible database as window functions. In this way, a cut list still knows its Others.
  - The route checks each row again against the databases of the runner. The route does not list or count a database that the runner cannot see.

The answer has these fields:

- `disks`, with `used_space` (`null` without a capacity) and `policies` (the policy and the volume of each membership).
- `policies` (each with its `volumes`).
- `usage` (`rows`, and `disks`: bytes, parts and databases for each disk).
- `logs`.
- `limits`.
- `unavailable_panels` (`disks`, `policies`, `usage`: a missing grant says which GRANT to run).

The growth is `GET /api/system/series?host_id=<id>&panel=disk_growth[&from_ms=&to_ms=][&refresh=1]`. The window is validated and stepped as for Performance (7 days: 1 h buckets). The backend caches it for 5 minutes for each aligned window. The route reads these items:

1. `system.disks` (names, free space and capacity).
2. `system.asynchronous_metric_log` once: the largest `DiskUsed_<disk>` sample of each bucket, with the disk names quoted from `system.disks`, and `TotalBytesOfMergeTreeTables`.
3. `system.part_log`: `sumIf(size_in_bytes, event_type = 'NewPart')`, the same for `MovePart`, and the move count for each bucket. It uses `database IN (<runner-visible databases>)`, summed over them (no database is named).

**ClickHouse 26.8** adds a `key` column. It logs the metric of each disk as `metric = 'DiskUsed'` with the disk in `key`. This does not apply when `asynchronous_metrics_key_values_mode` is `legacy_names` or `both`. When the column exists, the predicate is `(metric = 'TotalBytesOfMergeTreeTables' OR metric IN ('DiskUsed_<d>', …) OR (metric = 'DiskUsed' AND key IN ('<d>', …)))`. The disk is `if(metric = 'DiskUsed', key, substring(metric, 10))`. For this reason, either form, or both, read the same (`disk_metric_form`: `names` or `key`).

The answer has these fields:

- `timestamps`.
- `disks`: `name`, `free_space`, `total_space`, `used` for each bucket, and `trend`. `trend` has `status` (growing, not_growing, not_enough_history or no_capacity), `points`, `span_seconds`, `slope_bytes_per_day` and `days_until_full`.
- `series` (`merge_tree_bytes`, `written_bytes`, `moved_bytes`, `moves`).
- `sources`.
- `unavailable_panels`.

Without `asynchronous_metric_log`, the charts give way to "Growth needs system.asynchronous_metric_log", and the cards say what they need. A source that cannot be read shows its reason and GRANT. Every SELECT has the System `SETTINGS` (5 s or 10 s, 100 k, 10 M or 50 M rows read, a result cap). On the local test stack, `/disks` answers in about 15 ms. A week of growth answers in about 45 ms (1.7 M `asynchronous_metric_log` rows and 1.1 M `part_log` rows read).
