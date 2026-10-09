# MCP integration

ChDash has a built-in MCP server. An AI client reads ClickHouse data through ChDash. The client can be Claude Desktop, Claude Code, an IDE or your own agent. No external MCP server is necessary. The client uses an access key. Each key has its own rights: one host, tools and data.

MCP is off by default. Add an `mcp {}` block to the configuration to turn it on.

## How it works

- The endpoint is `POST /mcp`. It uses the MCP "Streamable HTTP" transport. Each request gets one JSON answer. There is no stream and no session.
- The client sends `Authorization: Bearer <key>`. ChDash finds the key and checks its rights on every call. `mcp.auth_header` can change the header name (see the table of the `mcp` block).
- MCP has its own ClickHouse user. Each host has an `mcp_uri` for it. The schema, read and SQL tools use only that user. The API tools use it as the runner and keep the system user of the host for what the pages read with it (figures, the System page, the OpenTelemetry tables). ChDash never uses `runner_uri` for MCP. A host without `mcp_uri` is invisible to MCP.
- Each query runs with `readonly=1`. The SQL cannot change data and cannot change its own limits.
- Each query has caps on rows, bytes, time and memory. A result has `truncated: true` when a cap cut it.
- The real security boundary is the ClickHouse user. The key only narrows what that user can do.

The page **MCP integration** (`/mcp-integration`) manages the keys. It shows only when MCP is on. Refer to [Security limits](#security-limits) before you give a key to someone.

## Quick start

1. Make the ClickHouse user (refer to [The ClickHouse MCP user](#the-clickhouse-mcp-user)).
2. Add `mcp_uri` to a host, and an `mcp {}` block:

```hcl
mcp {
  enabled      = true
  storage_file = "/var/lib/chdash/mcp_keys.json"

  key {
    name      = "ci-bot"
    secret    = "replace-with-a-long-random-secret"
    hosts     = ["prod"]
    tools     = ["list_databases", "list_tables", "describe_table", "query_table"]
    databases = ["otel", "analytics.events"]
  }
}

clickhouse {
  host {
    name       = "prod"
    runner_uri = "clickhouse://chdash_runner@ch-prod:9000"
    system_uri = "clickhouse://chdash_system@ch-prod:9000"
    mcp_uri    = "clickhouse://chdash_mcp:change-me@ch-prod:9000"
  }
}
```

3. Start ChDash. Connect a client (refer to [Connect a client](#connect-a-client)).

## Configuration

### The `mcp` block

| Setting | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | `true` turns MCP on. `false`: `POST /mcp` answers 404. `/api/mcp/meta` answers `{"enabled": false}`. |
| `storage_file` | none | The JSON file of the keys that you make on the MCP page. The directory must exist. ChDash creates the file on the first write. Without it, you cannot make keys on the page. |
| `manage_from_ui` | `true` | `false`: the page is read-only. Every key write answers 403 `manage_disabled`. |
| `auth_header` | `"Authorization"` | The request header that carries the key. `Authorization` takes `Bearer <key>`. Use another name when a proxy in front of ChDash already uses `Authorization` (for example `X-ChDash-Key`): that header takes the key alone, or `Bearer <key>`. The name is letters, digits and hyphens, and not one that the request needs (`Content-Type`, `Host`, `Origin`, `Accept`, `Cookie`, `Mcp-Session-Id` and others). The MCP page shows the name in its commands. |
| `max_rows` | `1000` | Rows in one result (1 to 1,000,000). |
| `max_result_bytes` | `1048576` | Bytes in one result (1 KiB to 256 MiB). ChDash counts the JSON text of the cells. |
| `query_timeout_seconds` | `30` | Time limit of one query (1 to 3600). |
| `max_sql_bytes` | `65536` | Size of the SQL of `run_query` and `explain_query` (256 bytes to 4 MiB). |
| `max_memory_bytes` | `1073741824` | `max_memory_usage` of each query (16 MiB or more). |
| `max_rows_to_read` | `0` | `max_rows_to_read` of each query. `0` means no limit. A query that reads more fails with `read_limit`. |
| `rate_limit_per_minute` | `600` | Calls per minute for each key. `0` means no limit. |
| `allowed_origins` | `[]` | Origins that may call from a browser, for example `["https://inspector.example.com"]`. Refer to [Origin check](#origin-check). |

Each value is a global cap. A key can only lower `max_rows` and `timeout_seconds`. A key can never raise them.

### The `key` block

You write one `key {}` block for each key. The block has no label.

```hcl
key {
  name            = "ci-bot"
  secret_file     = "/run/secrets/chdash-mcp-ci"   # or secret, or secret_sha256: exactly one
  hosts           = ["prod"]
  tools           = ["list_databases", "query_table"]  # or ["*"]
  databases       = ["otel", "analytics.events"]
  max_rows        = 200
  timeout_seconds = 10
}
```

| Attribute | Meaning |
| --- | --- |
| `name` | Required. Use `a-z`, `0-9`, `-` and `_`. Start with a letter or a digit. At most 32 characters. The prefix `ui_` is reserved. |
| `secret`, `secret_file`, `secret_sha256` | Give exactly one. The secret is at least 24 bytes. `secret_file` holds the secret. ChDash removes the spaces and the line ends around it. `secret_sha256` holds the SHA-256 of the secret as 64 hexadecimal characters. Then the secret is not in the configuration file, and the MCP page cannot show it. |
| `hosts` | The host of the key: the name of a `clickhouse.host` block that has `mcp_uri`. **A key reads one host at most**, so the list has one name (`hosts = ["prod"]`); to read two hosts, make two keys. `["*"]` and a list of two names are startup errors. An empty list means no host. |
| `tools` | The tools of the key, or `["*"]` for every tool that the key can hold. An empty list means no tool. |
| `databases` | The data of the key. Refer to [Data scope](#data-scope). An empty list means no data. |
| `max_rows`, `timeout_seconds` | Lower caps, from 1 up to the global value. |

The keys of the configuration are in memory. ChDash never writes them to a file. They show in the page as read-only keys (source `config`).

### The host settings

```hcl
clickhouse {
  host {
    name       = "prod"
    runner_uri = "..."
    system_uri = "..."
    mcp_uri    = "clickhouse://chdash_mcp:<password>@ch-prod:9000"
  }
}
```

- `mcp_uri` is the ClickHouse identity of MCP. It has the same form as `runner_uri`. The password of the MCP user is in this URI. There is no separate password setting.
- The shared `password_file` does not apply to MCP. The MCP password has no fallback to the credentials of the runner or the system user.

### Startup errors

ChDash stops with `config error: ...` in these cases. The message names the key or the file.

| # | Case |
| --- | --- |
| 1 | `mcp.enabled` is true, and there is no `storage_file` and no `key` block. |
| 2 | `mcp.enabled` is true, and no host has `mcp_uri`. |
| 3 | The `storage_file` is not valid JSON, or has a wrong shape, or its directory does not exist. ChDash never rewrites an invalid file. |
| 4 | Two keys have the same name or the same secret. ChDash checks the keys of the configuration and of the file together. |
| 5 | A key names a host that is not configured or has no `mcp_uri`. Or it names a tool that does not exist. |
| 6 | A key has `run_query` or `explain_query`, and its `databases` is not `["*"]`. |
| 7 | An attribute is unknown, or a key does not have exactly one of `secret`, `secret_file` and `secret_sha256`. |

ChDash also refuses a secret shorter than 24 bytes, a bad name, a bad pattern in `databases`, and a `max_rows` or `timeout_seconds` above the global value. A `mcp {}` block with `enabled = false` still checks its shape (case 7).

## The ClickHouse MCP user

Make a user for MCP. It reads data and does nothing more. Use one user for each ClickHouse server.

```sql
CREATE USER chdash_mcp IDENTIFIED WITH sha256_password BY 'change-me';

-- The data that MCP may read.
GRANT SELECT ON otel.* TO chdash_mcp;
GRANT SELECT ON analytics.events TO chdash_mcp;

-- The system tables of the schema tools.
GRANT SELECT ON system.databases TO chdash_mcp;
GRANT SELECT ON system.tables    TO chdash_mcp;
GRANT SELECT ON system.columns   TO chdash_mcp;
-- Only if a key may use run_query: small tables for generated data.
GRANT SELECT ON system.one TO chdash_mcp;
GRANT SELECT ON system.numbers TO chdash_mcp;

-- Only if a key holds the API tools (they run as this user, see "API tools"):
GRANT SELECT ON system.functions TO chdash_mcp;            -- explorer_functions
GRANT SELECT ON system.documentation TO chdash_mcp;        -- explorer_functions
```

- Grant `SELECT` and the `SHOW` rights only. A `SELECT` grant on a database includes the right to see it.
- Do not grant `FILE`, `URL`, `REMOTE`, `S3` or any other source. These sources read files or call other servers.
- Do not grant `INSERT`, `ALTER`, `CREATE`, `DROP`, `SYSTEM`, `KILL QUERY` or `ACCESS MANAGEMENT`.
- Do not grant `SELECT` on `system.users`, `system.query_log`, `system.processes` or other tables with data of other users.
- Keep the default profile of the user (`readonly = 0`). ChDash sends `readonly = 1` and the limits with each query. With `readonly = 1` in the profile, ClickHouse refuses the limits. With `readonly = 2`, ClickHouse refuses `readonly = 1`. Do not use either one.
- `tests/clickhouse-init/01-chdash-users.sql` has the user of the tests, `chdash_mcp`. It uses the same pattern.

A key can limit the user more. A key cannot give the user more.

## Key model

A key has three scopes: a host, tools and data.

### Hosts

A key reads **one host**. `hosts` has that name, or is empty (the key then reads nothing). There is no `*` and no list of hosts: a key that names several hosts would have to say which MCP user answers each call, and a client would have to guess. One key for each host is the rule. The `host` argument of a tool is optional: it is the host of the key, and a call that names another host is `host_not_allowed`.

The host must have an `mcp_uri`, and **its MCP user must be there**: a key made on the page for a host whose MCP user cannot connect is refused (`mcp_user_unavailable`), and so is a tool that this user cannot serve (`not_grantable`; refer to [The ClickHouse MCP user](#the-clickhouse-mcp-user)). A key of an older file that names several hosts keeps working as before, and the page marks it.

### Tools

| Tool | Group | Use |
| --- | --- | --- |
| `list_hosts` | schema | The host of the key and its health. |
| `list_databases` | schema | The databases that the key can see. |
| `list_tables` | schema | The tables, with engine, rows and size. Has a glob filter. |
| `describe_table` | schema | Columns, keys, engine and the CREATE statement. |
| `query_table` | read | Columns, filters, order and limit. ChDash builds the SQL. |
| `list_services` | observability | The services that sent spans (or log records) lately, with their errors. |
| `search_traces` | observability | Recent traces by their root span: service, operation, status, minimum duration. |
| `get_trace` | observability | Every span of one trace, in time order. |
| `search_logs` | observability | Recent log records: service, lowest severity, a text, a trace. |
| `list_metrics` | observability | The metrics reported lately, with their kind, unit and description. |
| `query_metric` | observability | One metric as a time series. |
| `run_query` | sql | One read-only SQL statement. |
| `explain_query` | sql | `EXPLAIN` of one SELECT: plan, pipeline, ast, syntax or estimate. |

`tools = ["*"]` means every tool that the key can hold.

The observability tools read the OpenTelemetry tables that the Observability pages read (`traces`, `logs` and `metrics` blocks of the configuration). A tool answers `not_enabled` when its signal is off. A key needs the data scope of the tables: `databases = ["otel"]` (or `*`) for the default names. A key whose scope does not include them gets `table_not_allowed`, and ChDash sends nothing to ClickHouse.

### Data scope

`databases` lists patterns. A `*` is a wildcard in each part.

| Pattern | Meaning |
| --- | --- |
| `*` | All data. Every database and table that the ClickHouse user can see. |
| `db` | The whole database `db`. |
| `db.table` | One table. |
| `db*`, `db.events_*` | Wildcards in the database part or in the table part. |

An empty list means no data. A pattern that is only `*.*` is not "all data".

**Free SQL needs all data.** `run_query` and `explain_query` cannot be limited to some tables (a view or a sub-query can read other tables). ChDash gives them only to keys with `databases = ["*"]`:

- A key that names one of them without `databases = ["*"]` is a startup error (config key) or a 400 `needs_all_data` (page key).
- A key with `tools = ["*"]` and a limited scope just does not get them.

For free SQL on a small scope, use a second host in ChDash. Give it an `mcp_uri` with a ClickHouse user that has exact grants. Then give a key `databases = ["*"]` on that host only.

The schema tools filter their output by the scope after they read it. A schema read is not cut by the row cap of the key.

### Limits and validity

- `max_rows` and `timeout_seconds` lower the global caps. They never raise them.
- A key has no switch, no expiry and no description. You make it, or you delete it: to stop a key, delete it. (A key file of an older ChDash can hold keys that were switched off. ChDash does not load them: a key that nobody wanted active does not wake up. The attributes `enabled`, `description` and `expires_at` of a `key {}` block are startup errors.)

### Two sources

| Source | Where | Change |
| --- | --- | --- |
| `config` | `key {}` blocks | Edit the configuration and restart. The page shows them read-only. |
| `ui` | The MCP page, and the `storage_file` | Create and delete on the page. |

The two sources add up. A name or a secret cannot exist twice, in either source.

### Secrets and the key file

- ChDash makes the secret of a page key: a version 4 UUID (RFC 9562, for example `3f2a9c1e-7b4d-4e8a-9a6f-5c0d2b1e7a34`: 122 random bits from the system random source). The page shows it at creation, and again whenever you ask (the eye button of the key).
- ChDash stores the SHA-256 of the secret, the secret itself and its first 8 characters (`secret_hint`). A request is authenticated by the hash, which ChDash compares in constant time. The secret is stored so that the page can show it again: whoever can read the key file can read every secret. The file has the mode 0600; put it on a private volume.
- A key of the configuration with `secret` or `secret_file` keeps its secret in memory for the same reason. A key with `secret_sha256`, or a page key from a file written before ChDash kept the secret, has no secret to show: delete the key and make a new one.
- The file has `version`: 1 and a `keys` array. Each key has `id` (`ui_` and 12 hexadecimal characters), `name`, `secret_sha256`, `secret` (optional), `secret_hint`, `hosts`, `tools`, `databases`, `max_rows`, `timeout_seconds`, `created_at` and `updated_at`.
- ChDash writes the file in an atomic way: a temporary file, `fsync`, then `rename`. The mode is 0600. If the write fails, ChDash restores its memory and the API answers 500 `storage_error`.
- If the file does not exist, ChDash creates it on the first write. If the file is not valid, ChDash stops at start and never rewrites it.
- `last_used_at` is in memory only. A restart clears it.

## Tools

Each tool has a JSON Schema in `tools/list`. A tool failure comes back as a result with `isError: true`. The text content and `structuredContent` both hold `{"error": "<code>", "message": "<sentence>"}`.

Example of a call:

```json
{"jsonrpc": "2.0", "id": 1, "method": "tools/call",
 "params": {"name": "query_table", "arguments": {
   "database": "otel", "table": "otel_logs",
   "columns": ["Timestamp", "ServiceName", "Body"],
   "filters": [{"column": "SeverityText", "op": "=", "value": "ERROR"}],
   "order_by": [{"column": "Timestamp", "direction": "desc"}],
   "limit": 20}}}
```

### The observability tools

Six tools, with no SQL to write: ChDash builds a bounded statement for each one. All of them take an optional `host`. The window is `since_minutes` (default 60, at most `max_lookback_minutes` of the `traces` block). A list has `limit` rows (default 20, at most the row cap of the key). The result of a list has `count`, `truncated` (more rows existed) and `elapsed_ms`. The answers name their fields, so a client reads `trace_id` and not a column position.

| Tool | Arguments | Result |
| --- | --- | --- |
| `list_services` | `signal` (`traces` default, or `logs`), `since_minutes` | `services`: `service`, `spans`, `errors`, `avg_ms` (for logs: `records`, `errors`). |
| `search_traces` | `service`, `operation` (a part of the span name), `status` (`Error`, `Ok`, `Unset`), `min_duration_ms`, `order` (`recent` default, or `slowest`), `since_minutes`, `limit` | `traces`: `trace_id`, `service`, `operation`, `started`, `duration_ms`, `status`. A trace is its root span (the span with no parent). |
| `get_trace` | `trace_id` (32 hexadecimal characters) | `trace_id`, `spans`: `span_id`, `parent_span_id`, `service`, `operation`, `kind`, `started`, `duration_ms`, `status`, `status_message`. The window of the trace comes from `traces.trace_index_table` when it is set. `trace_not_found` when no span matches. |
| `search_logs` | `service`, `severity` (`trace`, `debug`, `info`, `warn`, `error`: the lowest level), `contains` (not case sensitive), `trace_id`, `since_minutes`, `limit` | `records`: `time`, `service`, `severity`, `severity_number`, `trace_id`, `span_id`, `message` (cut at 2000 characters). |
| `list_metrics` | `service`, `filter` (a glob on the name), `since_minutes` | `metrics`: `kind` (`gauge`, `sum`, `histogram`), `name`, `unit`, `description`. |
| `query_metric` | `metric` (required), `kind`, `service`, `aggregation`, `step_seconds`, `since_minutes` | `series`: `time`, `value`, `points`; and `metric`, `kind`, `aggregation`, `step_seconds`. `kind` is looked up in the three tables when it is not given. Gauges and sums have `avg`, `min`, `max`, `sum` and `last`; histograms have `avg`, `sum` and `count`. Series that differ by attributes are merged in each point. `metric_not_found` when no table has the metric in the window. |

The guard rails of any query apply: the timeout, the memory and `max_rows_to_read` (`read_limit`). A window that is long on a very large table can stop on `read_limit`: shorten it.

### The API tools

Each read function of the ChDash API is a tool too, so that a client can do what the pages do: browse the Explorer, read the System page, search traces, logs and metrics, read the saved queries. The tools are in families (groups) that the page lists as permissions: **Explorer**, **System**, **Traces**, **Logs**, **Metrics**, **Library** and **Query**.

How they work:

- Every tool takes `host` (as the other tools) and `params`, an object of query parameters (`{"database": "otel", "refresh": 1}`; a list repeats the parameter: `{"status": ["Error", "Ok"]}`). A tool that is a `POST` takes `body`, a JSON object, instead. The description of each tool names the parameters that matter. A `{name}` in the route (`system_query`: `{hash}`) is a required param.
- ChDash calls its own API with the host of the call and returns the JSON answer as it is. An error of the API keeps its code and message (`invalid_metrics_range`, `unknown_host`, ...). A route that the configuration does not have gives `not_enabled`. An answer larger than `max_result_bytes` gives `result_too_large`: narrow it with a window, a filter or a limit.
- **They run as the MCP ClickHouse user, with the system user for what the pages read with it.** The pages use the users of the host: the runner (what is visible, the data) and the system user (figures, the System page, the OpenTelemetry tables). A tool calls the same routes, but the runner is `mcp_uri`:
  - **One identity for every tool:** the MCP user is the **runner**, and the system user stays what it is for the pages. The runner decides what is visible and what the data is; the system user only adds figures (sizes, parts, disks) to the objects that the runner may read, reads the System page (the state of the server) and reads the OpenTelemetry tables of Traces, Logs and Metrics, exactly as the pages do. So with an MCP user that reads two databases, `explorer_catalog` lists those two and `explorer_table` of any other table is `object_not_found`; with an MCP user that reads no `otel` table, `traces_search` still answers (the system user reads the table).
  - **The simple tools of Observability** (`list_services`, `search_traces`, `get_trace`, `search_logs`, `list_metrics`, `query_metric`) are not routes of the API: they run their own SQL, as the MCP user. They need `SELECT` on the `otel` tables for that user. They overlap with the families Traces, Logs and Metrics.
  - **Query library:** no ClickHouse user is involved (it is a file of ChDash).
  - How it works, with no second instance: for each host that has an `mcp_uri`, the configuration holds one more entry that only the tools can name (`<host>\x1fmcp`: runner = the MCP user, system user as it is, `src/mcp_identity.hpp`). A request may name it only with the internal token of the process (a random value of each start, sent by the tool wrapper in `X-ChDash-Internal`); for any other request the host is unknown (`unknown_host`). It is never listed and never health-checked. The caches are keyed by the host id, so the entries of MCP never mix with those of the pages. The answer is returned with the host id as the client named it.
  - **The grants.** The MCP user needs `SELECT` on its tables and the `SHOW` grants (the same as a runner); `SELECT` on `system.documentation` for `explorer_functions`; `SELECT` on the `otel` tables for the simple tools of Observability. The system user needs what it needs for the pages (the `otel` tables, `system.parts`, `system.data_skipping_indices`). A tool that lacks a grant answers `permission_denied` with the statement that gives it (`Give it to the MCP user: GRANT SELECT ON system.documentation TO chdash_mcp;`). At start and every 10 minutes, ChDash audits these grants with `CHECK GRANT` and says what is missing in the log (`[access] host=... The MCP user ...`) and in `GET /api/hosts` (`access.mcp_user`, `mcp_missing`, `mcp_reads_nothing`, and `system_missing` for the system user).
  - **Tools that a host can serve.** The audit knows which grants are missing; `src/mcp_grants.cpp` says which tool each one takes away: `explorer_functions` needs `system.documentation` (MCP user); `search_traces`, `get_trace`, `search_logs`, `list_metrics` and `query_metric` need their `otel` tables (MCP user); `traces_*`, `logs_*` and `metrics_*` need the `otel` tables and, for Logs and Metrics, `system.parts` and `system.data_skipping_indices` (system user, as the pages). A tool that its user cannot serve **cannot be given to a key**: the page greys it with the grant that is missing and who lacks it, and `POST /api/mcp/keys` refuses it (400 `validation`, field `tools`, reason `not_grantable`, with the `GRANT` statement in the message). A host whose MCP user cannot connect refuses the key altogether (field `hosts`, reason `mcp_user_unavailable`). The check uses the last audit of the host: it says nothing when the host has not been audited yet, and it is never made for a key of the configuration (a startup error would stop ChDash for a grant that a DBA gives a minute later) nor for keys already stored. `tools = ["*"]` is not expanded: it means every tool, and the ones that cannot be served answer `permission_denied` as before. The details of a key on the page mark the tools that it holds and that are not served.
  - **What a key reaches is what the MCP user reads, cut by the patterns of the key: the two limits add up.** The tools that read tables follow the patterns; only the tools whose answer mixes every table need `databases = ["*"]`:

    | Tool | `databases` of the key |
    | --- | --- |
    | `explorer_catalog` | Any. The answer is cut: the databases that a pattern names, the tables that a pattern allows, the summary of a database only when the key reads all of it (a summary counts every table). A `database` param that no pattern names is `database_not_allowed`. |
    | `explorer_table`, `explorer_table_data`, `explorer_graph_definition` | Any. `database` and `table` must be plain strings that a pattern allows (`table_not_allowed`, `invalid_argument` otherwise: a name is never skipped, so the API cannot read another value than the one checked). The MCP user may still refuse (`object_not_found`). |
    | `explorer_functions`, `query_library`, `format_sql`, System (`system_*`, `query_execution`) | Any. They read no table of the key (the functions, the saved queries, the formatter, the state of the server). System is read with the system user, as for the page: give it to keys that may see the whole server (the queries of every user, the disks, the replication). |
    | Traces, Logs and Metrics (`traces_*`, `logs_*`, `metrics_*`) | Any. They are read with the system user, as the pages do, so neither the grants of the MCP user nor the patterns of the key cut them: the permission is what gives the tool. A key with a narrow `databases` and the permission Logs reads every service of the logs table. |
    | The simple tools of Observability (`search_traces`, `get_trace`, `search_logs`, `list_metrics`, `query_metric`) | The patterns must **allow the `otel` tables that the tool reads** (`otel.otel_traces`, `otel.otel_logs`, the three `otel.otel_metrics_*` tables): they run SQL as the MCP user. A pattern `otel`, `otel.*` or `*` does. The page locks them until the data allows them (`needs_tables` for a key made on the page), and a call of a key that does not allow them answers `table_not_allowed`. |
    | `explorer_graph`, `explorer_storage`, `explorer_names` | `["*"]` only. Their answers mix every table (the graph, the sizes of everything, the names for completion): no pattern can cut them. |

    The detail of an allowed table can name tables that the key does not read (its CREATE statement, its dependencies). As for `query_table`, a view is read as the MCP user reads it. To know what a key reaches, the page asks `GET /api/mcp/keys/<id>/access`.
- The key's `max_rows` does not cut an API answer (the API has its own limits: `limit` params and caps). The timeout of the key and `max_result_bytes` apply. At most 4 API calls run at the same time for all keys: more get `api_unavailable` (retry).
- A tool is one row of `src/mcp_api_tools.cpp`: its name, group, title, description, method and route. The input schema, `tools/list`, the permission list of the page, the scope rule and the call come from that row, through one wrapper. To add a tool, add a row. To remove it, delete the row. Nothing else is written.

**Explorer** (The Explorer page: catalog, tables, functions, storage and lineage.)

| Tool | Route | Use |
| --- | --- | --- |
| `explorer_catalog` | `GET /api/explorer/catalog` | The databases and the tables, views and dictionaries that the Explorer shows, with engine, rows and size. |
| `explorer_table` | `GET /api/explorer/table` | Everything the Explorer knows about one table: columns, keys, engine, CREATE statement, size, parts, partitions, dependencies. |
| `explorer_table_data` | `POST /api/explorer/table/data` | A preview of the first rows of one table (the Preview tab). |
| `explorer_functions` | `GET /api/explorer/functions` | The functions of the ClickHouse server (and their aliases) with their description, syntax and category. |
| `explorer_storage` | `GET /api/explorer/storage` | How the data is spread over the databases and the tables on disk, server wide. |
| `explorer_graph` | `GET /api/explorer/graph` | The topology of the server: tables, views, materialized views, dictionaries and the links between them (lineage), with the health of replicated tables. |
| `explorer_graph_definition` | `GET /api/explorer/graph/definition` | What one object of the graph is: its definition, its sources and its targets. |
| `explorer_names` | `GET /api/meta` | The names that the SQL editor completes: databases, tables, columns and their types. |

**System** (The System page: load, disks, top queries, activity and Keeper.)

| Tool | Route | Use |
| --- | --- | --- |
| `system_overview` | `GET /api/system/overview` | The state of the server in one answer: version, uptime, memory, running queries, merges, mutations, replication, errors and the databases by size. |
| `system_series` | `GET /api/system/series` | Time series of the server (performance panels, disk growth). |
| `system_disks` | `GET /api/system/disks` | Disks, free space and the size of the databases and tables on them. |
| `system_queries` | `GET /api/system/queries` | The queries of the server grouped by their normalized text, with count, time, rows, bytes and errors. |
| `system_query` | `GET /api/system/queries/{hash}` | One group of queries by its hash: the normalized text, the runs, the slowest and the failed ones. |
| `system_activity` | `GET /api/system/activity` | What the server does now: running queries, merges, mutations, fetches. |
| `system_keeper` | `GET /api/system/keeper` | The ClickHouse Keeper (ZooKeeper) state: sessions, nodes, replication queues. |
| `query_execution` | `GET /api/query/execution` | The record of a query that ChDash ran: status, timings and profile counters. |

**Traces** (The Traces page: search, analytics, service map, spans.)

| Tool | Route | Use |
| --- | --- | --- |
| `traces_meta` | `GET /api/traces/meta` | How the trace tables look on this host (columns, version, the features that are on). |
| `traces_analytics` | `GET /api/traces/analytics` | The counts and the duration percentiles of the matching traces over time. |
| `traces_service_map` | `GET /api/traces/service_map` | The services of the matching traces and the calls between them, with counts, errors and latency. |
| `traces_heatmap` | `GET /api/traces/heatmap` | How the trace durations spread over time (counts in log-scaled latency rows). |
| `traces_deltas` | `GET /api/traces/deltas` | What the traces in a time and duration box have that the others do not (attributes that differ). |
| `traces_services` | `GET /api/traces/services` | Each service with its request count, errors and P50, P95 and P99 latency, and its endpoints. |
| `traces_services_db` | `GET /api/traces/services/db` | The database statements seen in spans (db.query.text, db.statement) with count and latency. |
| `traces_facets` | `GET /api/traces/facets` | The attribute keys of the spans in the window, most frequent first. |
| `traces_facet_values` | `GET /api/traces/facet_values` | The values of one attribute key with their counts. |
| `traces_trace` | `GET /api/traces/trace` | One whole trace: every span with its timings, status and attributes. |
| `traces_linked_from` | `GET /api/traces/linked_from` | The spans of other traces that link to one span. |
| `traces_context` | `GET /api/traces/context` | The spans that ran around one moment on the same service, host, pod or attribute. |
| `traces_span` | `GET /api/traces/span` | One span with its attributes, events and links. |
| `traces_logs` | `GET /api/traces/logs` | The log records written during one trace (or one span). |

**Logs** (The Logs page: search, histogram, patterns, context.)

| Tool | Route | Use |
| --- | --- | --- |
| `logs_meta` | `GET /api/logs/meta` | How the log table looks on this host (columns, text search mode). |
| `logs_histogram` | `GET /api/logs/histogram` | Record counts over time by severity class. |
| `logs_context` | `GET /api/logs/context` | The records around one record. |
| `logs_patterns` | `GET /api/logs/patterns` | The message templates that the matching records fall into, with counts (Drain). |
| `logs_services` | `GET /api/logs/services` | The services that wrote logs in the window, with counts. |
| `logs_facets` | `GET /api/logs/facets` | The attribute keys of the records in the window, most frequent first. |
| `logs_facet_values` | `GET /api/logs/facet_values` | The values of one field with their counts. |

**Metrics** (The Metrics page: catalog, series, exemplars.)

| Tool | Route | Use |
| --- | --- | --- |
| `metrics_meta` | `GET /api/metrics/meta` | How the metric tables look on this host (the kinds that exist). |
| `metrics_catalog` | `GET /api/metrics/catalog` | The metrics reported in the window, by service and kind, with unit and description. |
| `metrics_attributes` | `GET /api/metrics/attributes` | The attribute keys of one metric, or the values of one key. |
| `metrics_series` | `GET /api/metrics/series` | One metric as time series. |
| `metrics_exemplars` | `GET /api/metrics/exemplars` | Sample points of a metric with the trace that produced them. |

**Library** (The saved queries of the Query page.)

| Tool | Route | Use |
| --- | --- | --- |
| `query_library` | `GET /api/query-library` | The saved queries and their folders (the Query page library of the server). |

**Query** (Helpers of the Query page that read no data.)

| Tool | Route | Use |
| --- | --- | --- |
| `format_sql` | `POST /api/format` | Format SQL text like the Format button of the Query page (it reads the ClickHouse version of the host to parse it). |


### `list_hosts`

No arguments. Result: `{"hosts": [{"name": "prod", "label": "...", "healthy": true}], "count": 1}`. `healthy` is the general health of the host, from the same check as the rest of ChDash. It is `null` when not known.

### `list_databases`

Arguments: `host`, `filter` (a glob on the name). Result: `{"host", "databases": [{"name", "engine", "comment"}], "count", "truncated"}`.

### `list_tables`

Arguments: `host`, `database`, `filter` (a glob on the table name, for example `events_*`). Without `database`, the tool lists every table in scope. Result: `{"host", "tables": [{"database", "name", "engine", "total_rows", "total_bytes", "comment"}], "count", "truncated"}`. `total_rows` and `total_bytes` can be `null`. A list has at most 2000 tables. Then `truncated` is true and `hint` says how to narrow it.

### `describe_table`

Arguments: `host`, `database`, `table`. Result: `engine`, `create_table_query`, `partition_key`, `sorting_key`, `primary_key`, `sampling_key`, `total_rows`, `total_bytes`, `comment` and `columns`. Each column has `name`, `type`, `default_kind`, `default_expression`, `comment`, `in_partition_key`, `in_sorting_key`, `in_primary_key` and `in_sampling_key`.

### `query_table`

Arguments: `host`, `database`, `table`, `columns`, `filters`, `order_by`, `limit`.

- ChDash checks each column name against the real columns of the table. A name that is not in the list is an `unknown_column` error. ChDash quotes the names.
- Each filter has `column`, `op` and `value`. The operators are `=`, `!=`, `<`, `<=`, `>`, `>=`, `like`, `not_like`, `ilike`, `in`, `not_in`, `is_null` and `is_not_null`. All filters must match.
- ChDash types each value from the column type. A number column takes a number. A text, date or UUID column takes a string. A value never becomes SQL: ChDash escapes it. `like` and `ilike` work on `String` columns. `in` and `not_in` take a list of 1 to 100 values.
- `order_by` is a list of `{"column", "direction"}`. The direction is `asc` (default) or `desc`.
- `limit` is 100 by default. A limit above the cap of the key is cut to the cap. Then `truncated` is true when more rows exist.
- Without `columns`, ChDash returns every column except the wide ones. A column is wide when its average size is above 2048 bytes for each row. A column of type `AggregateFunction` is a binary state, and ChDash leaves it out too. The result lists them in `omitted_columns`: `[{"name", "type", "reason"}]` with the reason `wide` or `aggregate_state`. Name a column in `columns` to get it.

Result:

```json
{"host": "prod", "database": "otel", "table": "otel_logs",
 "columns": [{"name": "Timestamp", "type": "DateTime64(9)"}],
 "rows": [["2026-10-08 10:00:00.000000000"]], "row_count": 1,
 "limit": 20, "truncated": false, "elapsed_ms": 12}
```

A `Bool` column comes back as `true` or `false`.

### `run_query`

Arguments: `host`, `sql`. The key needs `databases = ["*"]`.

- The SQL is exactly one statement. The first word is `SELECT`, `WITH`, `SHOW`, `DESCRIBE`, `DESC`, `EXISTS` or `EXPLAIN`. One `;` at the end is fine.
- A splitter reads the SQL the way ClickHouse reads it. A `;` inside a string, a quoted name, a `$$` string or a comment is not a separator. A second statement is an error: `multiple_statements`.
- ChDash refuses `INTO OUTFILE` and the table functions that read files, URLs, remote servers and other databases (`file`, `url`, `remote`, `s3`, `mysql` and similar). The error codes are `clause_not_allowed` and `function_not_allowed`.
- A `FORMAT` clause is accepted and has no effect: the result is always JSON.
- This check is a guard rail. The security is `readonly=1` and the grants of the ClickHouse user.

Result: `host`, `columns`, `rows`, `row_count`, `truncated`, `elapsed_ms`. A `Bool` value of free SQL comes as `0` or `1`, because the native protocol sends it as `UInt8`.

### `explain_query`

Arguments: `host`, `sql` (one `SELECT` or `WITH` statement), `type` (`plan` default, `pipeline`, `ast`, `syntax` or `estimate`), `indexes` and `actions` (booleans, for `plan`). Result: `host`, `type`, `lines` (the text of the explain), `truncated`. The `estimate` type has `columns` and `rows`.

### Tool error codes

`invalid_argument`, `not_enabled`, `trace_not_found`, `metric_not_found`, `host_required`, `host_not_allowed`, `no_host`, `tool_not_allowed`, `database_not_allowed`, `table_not_allowed`, `table_not_found`, `unknown_column`, `unsupported_column_type`, `sql_too_large`, `empty_sql`, `invalid_sql`, `multiple_statements`, `statement_not_allowed`, `clause_not_allowed`, `function_not_allowed`, and from ClickHouse: `timeout`, `readonly`, `permission_denied`, `memory_limit`, `read_limit`, `not_found`, `syntax_error`, `host_unavailable`, `query_failed`. A call to a tool name that does not exist is a JSON-RPC error (-32602).

## The endpoint

`POST /mcp` with `Content-Type: application/json` and `Authorization: Bearer <key>` (or the header that `mcp.auth_header` names).

| Method | Answer |
| --- | --- |
| `initialize` | Negotiates the protocol version: `2025-06-18`, `2025-03-26` or `2024-11-05`. For an unknown version, ChDash answers `2025-06-18`. The only capability is `tools`. |
| `ping` | `{}` |
| `tools/list` | The tools that this key can use, each with its `inputSchema`. |
| `tools/call` | Runs one tool. |
| a notification | 202, no body. |
| a response from the client | 202, no body. |
| any other method | JSON-RPC error -32601. |

A batch (a JSON array) is not supported. ChDash answers 400 with the error -32600. A body that is not JSON gets 400 with -32700. A JSON-RPC error of a method (-32601, -32602) comes in a 200 answer.

| Status | Case |
| --- | --- |
| 200 | A JSON-RPC answer. A failed tool is still 200, with `isError: true`. |
| 202 | A notification or a response. |
| 400 | A bad JSON-RPC message, or an unknown `MCP-Protocol-Version`. |
| 401 | The key is missing or unknown. The answer has `WWW-Authenticate: Bearer` (only when the header is `Authorization`). All four cases have the same text. |
| 403 | The `Origin` header is not in `allowed_origins`. |
| 405 | `GET`, `DELETE`, `PUT` or `PATCH`. The answer has `Allow: POST`. |
| 413 | The body is larger than 2 times `max_sql_bytes` plus 16 KiB. |
| 415 | The `Content-Type` is not `application/json`. |
| 429 | The key sent more than `rate_limit_per_minute` calls. The answer has `Retry-After`. |

Every answer has `Cache-Control: no-store`. An HTTP error has the body `{"error": "<code>", "message": "..."}`. ChDash checks in this order: Origin, key, rate limit, then the rest. When it refuses a request before it reads the body, it closes the connection.

### Origin check

A request without an `Origin` header comes from a program (a CLI, an SDK, an IDE). ChDash accepts it. A request with an `Origin` header comes from a web page. ChDash refuses it unless the origin is in `allowed_origins`. With the default empty list, ChDash refuses every browser origin, also the origin of ChDash itself. This stops a web page from calling a local ChDash with a key that the user holds (DNS rebinding). Add an origin (for example `https://inspector.example.com`) only for a browser client that you trust.

### Rate limit

Each key has a token bucket in memory. The bucket holds `rate_limit_per_minute` calls and fills evenly during one minute. All calls count: also a `ping` or a `tools/list`.

### Guard rails of each query

ChDash sends these settings to ClickHouse with each query:

| Setting | Value |
| --- | --- |
| `readonly` | `1` |
| `max_execution_time` | the timeout of the key (at most `query_timeout_seconds`) |
| `max_result_rows`, `result_overflow_mode` | `max_rows` + 1, `break` |
| `max_result_bytes` | `max_result_bytes` (with `result_overflow_mode = break`) |
| `max_rows_to_read` | the global value, when it is not 0 |
| `max_memory_usage` | `max_memory_bytes` |
| `log_comment` | `chdash-mcp key=<id>` |

ChDash also stops reading when it has `max_rows` rows or `max_result_bytes` bytes. It then sets `truncated: true`. Use `log_comment` to find the queries of a key in `system.query_log`.

### Audit log

ChDash writes one line to its log for each call. It never writes SQL or data.

```
[mcp] key=ci-bot call=tools/call:query_table host=prod status=ok duration_ms=12 rows=20
[mcp] key=- call=request host=- status=401_unknown duration_ms=0 rows=0
```

`status` is `ok`, the tool error code, `rpc_error_<code>` or the HTTP cause (`401_unknown`, `401_missing`, `429_rate_limited`, `origin_not_allowed` and others). Page actions on keys write a line too (`keys/create`, `keys/delete`, `keys/reveal`) with the key id, never the secret.

The page that uses this API is described in [`mcp-integration-page.md`](mcp-integration-page.md).

## The page API

These routes serve the page. Each answer has `Cache-Control: no-store`. When MCP is off, `/api/mcp/meta` answers `{"enabled": false}` and every other route answers 404 `mcp_disabled`.

| Route | Use |
| --- | --- |
| `GET /api/mcp/meta` | State, endpoint, hosts, tools and limits. Each host has `mcp`: `{"user", "state": "ok" \| "unavailable" \| "unknown", "error", "reads_nothing", "unavailable_tools": [{"tool", "grants": ["SELECT ON ..."], "statement"}]}`. `state` is `ok` when the MCP user connected at the last audit, `unavailable` when it did not (then no key can read the host), `unknown` when the host was not audited. |
| `GET /api/mcp/keys` | `{"keys": [...]}`. The keys of the configuration come first. A key never has its secret here: it has `secret_available`. |
| `GET /api/mcp/keys/<id>/secret` | `{"id": "...", "secret": "<uuid>"}`. Works for both sources, also when `manage_from_ui = false`. Answer 404 `secret_unavailable` when ChDash has no secret for this key. Same guard as the write routes. |
| `GET /api/mcp/keys/<id>/access` | The data that the key reaches. For the host of the key (the entries are a list for the keys of older files that name several): `{"host", "label", "user", "status": "ok" \| "unavailable", "error", "readable_by_user", "excluded_by_key", "databases": [{"name", "table_count", "truncated", "tables": [{"name", "columns": "all" \| <n>}]}]}`. The tables are those that the **MCP ClickHouse user** may read (`CHECK GRANT`, never `SHOW GRANTS`; a column-level grant gives a count of columns), kept only when a `databases` pattern of the key matches. `readable_by_user` counts what the user reads, `excluded_by_key` what the patterns leave out. The answer is kept 60 s for each host (`?refresh=1` asks the grants again). At most 300 tables for each database and 3000 in all (`truncated`). `status = "unavailable"` with the `error` when the MCP user cannot connect. 404 `not_found` for an unknown key. A read of the page only (same guard as the secret). It never carries a secret. |
| `POST /api/mcp/keys` | Makes a key. Answer 201: `{"key": {...}, "secret": "<uuid>"}`. |
| `DELETE /api/mcp/keys/<id>` | Answer: `{"ok": true, "id": "<id>"}`. |

A key in the answers:

```json
{"id": "ui_0a1b2c3d4e5f", "name": "ci-bot", "source": "ui",
 "secret_hint": "3f2a9c1e", "secret_available": true, "hosts": ["prod"],
 "tools": ["list_databases", "query_table"], "databases": ["otel", "analytics.events"],
 "max_rows": null, "timeout_seconds": null,
 "created_at": "2026-10-08T10:00:00Z", "last_used_at": null}
```

`source` is `config` or `ui`. A key of the configuration has `id` equal to its `name`. Its `secret_hint` is empty when the secret is not known (`secret_sha256`).

The write routes use the same guard as the query library:

- `Sec-Fetch-Site` must be absent, `same-origin` or `none`. If it is absent, an `Origin` header must name this server (`Host` or `X-Forwarded-Host`).
- The body must be `application/json`.

| Status | `error` | Case |
| --- | --- | --- |
| 400 | `validation` | With `field` and `reason`: `required`, `type`, `invalid`, `too_long`, `unknown_host`, `too_many` (more than one host), `mcp_user_unavailable`, `unknown_tool`, `needs_all_data`, `not_grantable`, `duplicate`, `range` or `invalid_json`. |
| 403 | `manage_disabled` | `manage_from_ui = false`. |
| 403 | `cross_site_request` | The guard refused the request. |
| 404 | `mcp_disabled` | MCP is off. |
| 404 | `not_found` | No key has this id. |
| 404 | `secret_unavailable` | ChDash has no secret for this key (`secret_sha256`, or a file from before the secret was kept). |
| 409 | `config_key` | You cannot change a key of the configuration. |
| 409 | `storage_not_configured` | There is no `storage_file`. |
| 409 | `name_taken` | Another key (of either source) has this name. |
| 415 | `unsupported_media_type` | The body is not `application/json`. |
| 500 | `storage_error` | ChDash could not write the file. Its memory is restored. |

`/api/version` reports `features.mcp = {"enabled": true|false}`.

## Connect a client

Replace the address and the key.

Claude Code:

```bash
claude mcp add --transport http chdash https://chdash.example.com/mcp \
  --header "Authorization: Bearer <secret>"
```

A client that reads a JSON file (the form can differ in each client):

```json
{
  "mcpServers": {
    "chdash": {
      "type": "http",
      "url": "https://chdash.example.com/mcp",
      "headers": {"Authorization": "Bearer <secret>"}
    }
  }
}
```

A test with `curl`:

```bash
curl -s https://chdash.example.com/mcp \
  -H "Authorization: Bearer <secret>" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Use HTTPS when the client is not on the same machine. Put ChDash behind a reverse proxy that has TLS.

## Security limits

- ChDash has no login. Anyone who can open the MCP page can make a key. The key is bound by the grants of the ClickHouse MCP user. To reduce the risk, restrict the page with the reverse proxy or the network. Or set `manage_from_ui = false`: then only the keys of the configuration and the file exist.
- The real boundary is the ClickHouse MCP user. A key only narrows it, and the patterns of a key add to the grants of the user, never replace them. Give the user the least rights.
- A key is a secret. Whoever has it can do everything the key allows. Delete the keys that you do not use any more.
- The API tools run with the MCP ClickHouse user as the runner, and with the system user of the host for what the pages read with it. The System tools show the state of the whole server, query texts included, and the tools of Traces, Logs and Metrics read the `otel` tables with the system user: neither the grants of the MCP user nor the patterns of the key limit them, only the permission does. Give System, Traces, Logs and Metrics only to keys that may see the whole server and all its telemetry. The three Explorer tools that mix every table go only to keys with `databases = ["*"]`.
- The MCP page shows secrets. ChDash has no login, so anyone who can open the page can read every secret that ChDash knows, and make new keys. Restrict the page with the reverse proxy or the network.
- ChDash checks the SQL of `run_query` with a splitter. The splitter is a guard rail. It is not a parser of ClickHouse. `readonly=1` and the grants are the boundary.
- The scope of a key is a list of table names. Free SQL can read any table that the ClickHouse user can read. This is why only keys with `databases = ["*"]` get free SQL. Give such keys only to people that you trust with all the data of the MCP user.
- `log_comment` in `system.query_log` shows the key id. It never shows the secret.
- Use HTTPS. The key goes in a header of each request.

## Tests

- `tests/native/mcp_test.cpp` (CMake option `CHDASH_BUILD_MCP_TESTS`, target `chdash_mcp_test`): scopes, keys and the file, the rate limit, the SQL splitter and builder, the protocol with a fake backend, the tools with a fake database, and the seven startup errors with the real configuration loader.
- `tests/harness/test_mcp_contract.py`: source contracts. It runs the native binary when `MCP_TEST_BINARY` names it.
- `tests/backend-functional/test_mcp.py`: the endpoint, the scopes, `readonly`, the caps, the keys, and the startup errors with the real binary, against a real ClickHouse. `tests/README.md` has the instances and the variables.

## Decisions

The first specification of this feature had gaps. This list records what ChDash does where the specification did not say.

- **Origin.** An empty `allowed_origins` refuses every request that has an `Origin` header. It accepts a request without one. The origin of ChDash itself has no special right: a DNS rebinding attack makes the `Origin` equal to the `Host`. An origin is `scheme://host[:port]` with no path and no `*`.
- **Secrets.** The minimum is 24 bytes, for `secret` and for the content of `secret_file`. A page key is a UUID of 36 characters. Keys made before ChDash used UUIDs keep their old secret, which works as before.
- **Names.** At most 32 characters. The prefix `ui_` is reserved for key ids, and ChDash refuses it in names of both sources.
- **Lower caps.** A key `max_rows` or `timeout_seconds` above the global cap is an error: a startup error for a config key, a 400 `range` for a page key. A stored key above a lowered cap is cut to the cap at run time.
- **SQL tools.** A key that names `run_query` or `explain_query` without all data is an error. A key with `tools = ["*"]` and a limited scope gets every tool but the SQL tools and the three Explorer tools that mix every table (`explorer_graph`, `explorer_storage`, `explorer_names`); a simple tool of Observability whose `otel` tables the data does not allow answers `table_not_allowed`. A key with `tools = ["*"]` and `databases = ["*"]` gets every tool. At run time, ChDash checks the rule again for each call, also for keys of an old file.
- **All data** is exactly the entry `*`. `*.*` is a normal pattern.
- **Empty lists.** `hosts`, `tools` and `databases` can be empty. A key with an empty list can do nothing. An attribute that is missing is an empty list.
- **Hosts.** A key reads one host: `hosts = ["prod"]`. `["*"]` is `invalid` and two names are `too_many`. A page key cannot name a host without `mcp_uri` (`unknown_host`). A key of an old file can name a host that is now gone, or several: it keeps working, and the page marks it.
- **Time.** `created_at` and `last_used_at` are in UTC, with a one-second precision.
- **Page keys.** At most 1000 keys in the file.
- **Order of checks of `POST /mcp`.** Origin, key, rate limit, content type, protocol header, body size. An early refusal closes the connection.
- **Body size.** 2 times `max_sql_bytes` plus 16 KiB, because JSON escapes can double the SQL.
- **`structuredContent`.** A tool result always has `structuredContent` and the same JSON as text. Older clients read the text.
- **Not allowed or unknown tool.** A tool that exists but that the key cannot use is a tool error `tool_not_allowed`. A name that does not exist is the JSON-RPC error -32602.
- **Truncation.** `truncated` is true only when a cap cut the result. A `limit` that you chose below the cap is not a cap. `query_table` asks for one row more than the cap to know. For `run_query`, ClickHouse breaks at `max_rows` + 1 rows. A result that exactly fits is not truncated.
- **Bytes.** ChDash counts the JSON text of the cells. It also estimates the size that ClickHouse counts (a number has its width in bytes), because `max_result_bytes` with `break` cuts there. If either reaches the cap, `truncated` is true.
- **Omitted columns.** A column of the table that the ClickHouse user cannot see is not in `system.columns`, so it is not in the result and not in `omitted_columns`. `omitted_columns` lists the wide columns (more than 2048 bytes on average) and the `AggregateFunction` columns. ChDash reads the size of a column from `system.columns`. ClickHouse reports it only for wide parts. A small table with compact parts reports 0, so ChDash does not omit its columns.
- **Schema tools.** They read at most 20,000 rows of a system table and return at most 2000 tables. The row cap of the key does not apply.
- **Health.** `healthy` is the health that ChDash measures for the host with its normal check. It does not test the MCP user.
- **`FORMAT`.** ChDash uses the native protocol. The result is always JSON, so a `FORMAT` clause has no effect and is accepted.
- **Denied functions.** `file`, `url`, `remote`, `s3`, `hdfs`, `mysql`, `postgresql`, `mongodb`, `redis`, `jdbc`, `odbc`, `sqlite`, `executable`, `input`, the Azure, Iceberg, Delta Lake and Hudi readers, and their `Cluster` forms.
- **Settings order.** The settings of a query go together in one packet. ClickHouse checks each of them against the profile of the user, then applies them. `readonly=1` does not block the limits that come with it. A `SETTINGS` clause in the SQL is refused after that, so the SQL cannot change a limit.
- **Connections.** MCP queries use the shared connection pool with the `mcp_uri` of the host. The pool key includes the URI, so MCP connections never mix with runner or system connections. The receive timeout is `query_timeout_seconds` plus 15 seconds.
- **API errors.** The page API uses `{"error", "message"}` (and `field` and `reason` for validation). The check of `manage_from_ui` comes after the cross-site guard and before the validation.
- **The page.** The route `/mcp-integration` always serves `mcp.html`, also when MCP is off. The page then shows how to turn MCP on. The link in the page switcher shows only when `features.mcp.enabled` is true. The route answers 404 when `mcp.html` is missing.
- **Expiry date.** The page sends the end of the chosen day as `YYYY-MM-DDT23:59:59Z`. The API accepts a date alone (the start of that day) and a full UTC time.
