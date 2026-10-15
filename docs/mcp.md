# MCP integration

ChDash has a built-in MCP server. An AI client reads ClickHouse data through ChDash. The client can be Claude Desktop, Claude Code, an IDE or your own agent. No external MCP server is necessary. The client uses an access key. Each key has its own rights: one host, tools and data.

MCP is off by default. Add an `mcp {}` block to the configuration to turn it on.

## How it works

- The endpoint is `POST /mcp`. It uses the MCP "Streamable HTTP" transport. Each request gets one JSON answer. There is no stream and no session.
- The client sends `Authorization: Bearer <key>`. ChDash finds the key and checks its rights on every call. `mcp.auth_header` can change the header name (see the table of the `mcp` block).
- MCP has its own ClickHouse user. Each host has an `mcp_uri` for it. The schema, read and SQL tools use only that user. The API tools use it as the runner and keep the system user of the host for what the pages read with it (figures, the System page, the OpenTelemetry tables). ChDash never uses `runner_uri` for MCP. A host without `mcp_uri` is invisible to MCP.
- Each query runs with `readonly=1`, or with the `readonly` of the profile of the MCP user when the profile already sets it (see [The settings profile of the user](#the-settings-profile-of-the-user)). The SQL cannot change data and cannot change its own limits.
- Each query has caps on rows, bytes, time and memory. A result has `truncated: true` when a cap cut it.
- The real security boundary is the ClickHouse user. The key only narrows what that user can do.

The section **MCP integration** has two pages: **Keys** (`/mcp-integration`) manages the keys, and **Usage** (`/mcp-integration/usage`) shows what all the keys did, when the usage is on (`mcp.usage.enabled`). They show only when MCP is on. Refer to [Security limits](#security-limits) before you give a key to someone.

## Quick start

1. Make the ClickHouse user (refer to [The ClickHouse MCP user](#the-clickhouse-mcp-user)).
2. Add `mcp_uri` to a host, and an `mcp {}` block:

```hcl
mcp {
  enabled      = true
  storage_file = "/var/lib/chdash/mcp_keys.json"

  key {
    name      = "ci-bot"
    secret    = "3f2b8c1e-5d4a-4b7e-9c60-1a2b3c4d5e6f"
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
| `usage` | none | A block that turns on the usage of the keys, which is off by default: refer to [The `usage` block](#the-usage-block). |
| `auth_header` | `"Authorization"` | The request header that carries the key. `Authorization` takes `Bearer <key>`. Use another name when a proxy in front of ChDash already uses `Authorization` (for example `X-ChDash-Key`): that header takes the key alone, or `Bearer <key>`. The name is letters, digits and hyphens, and not one that the request needs (`Content-Type`, `Host`, `Origin`, `Accept`, `Cookie`, `Mcp-Session-Id` and others). The MCP page shows the name in its commands. |
| `max_rows` | `1000` | Rows in one result (1 to 1,000,000). |
| `max_result_bytes` | `1048576` | Bytes in one result (1 KiB to 256 MiB). ChDash counts the JSON text of the cells. A tool answer holds the result as text (`content[0].text`) for every client, and again in `structuredContent` for a client of protocol 2025-06-18 or later (see "Decisions"). The body of a response is up to about twice this size, and the memory of calls that run at once (`admission.mcp_max`) is a multiple of it. Keep it as low as the clients need. |
| `query_timeout_seconds` | `30` | Time limit of one query (1 to 3600). |
| `max_sql_bytes` | `65536` | Size of the SQL of `run_query` and `explain_query` (256 bytes to 4 MiB). |
| `max_memory_bytes` | `1073741824` | `max_memory_usage` of each query (16 MiB or more). |
| `max_rows_to_read` | `0` | `max_rows_to_read` of each query. `0` means no limit. A query that reads more fails with `read_limit`. |
| `rate_limit_per_minute` | `600` | Calls per minute for each key. `0` means no limit. |
| `allowed_origins` | `[]` | Origins that may call from a browser, for example `["https://inspector.example.com"]`. Refer to [Origin check](#origin-check). |

Each value is a global cap. A key can only lower `max_rows` and `timeout_seconds`. A key can never raise them.

### The `usage` block

`mcp { usage { ... } }` turns on the usage of the keys: what each key did (refer to [Usage of a key](#usage-of-a-key)). It is **off** by default. When it is off, nothing is counted (not even in memory), the routes of the usage answer 404 `not_enabled`, a key has no `last_used_at`, and the MCP pages show no usage (the ClickHouse cost of a key stays: it does not depend on it).

```hcl
mcp {
  usage {
    enabled        = true
    dir            = "/var/lib/chdash/usage"
    instance       = "chdash-0"   # default: the host name
    retention_days = 90
  }
}
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | `true` counts and keeps the usage. |
| `storage` | `"files"` | Where the usage is kept. Only `files` exists for now: one file for each instance of ChDash in `dir`. A database comes later, and this setting names the mode. Any other value is a startup error. |
| `dir` | none | The directory of the files. Required when `enabled` is true. It must exist, and ChDash must be able to create files in it. Several ChDash can share it (refer to **Several instances** in [Usage of a key](#usage-of-a-key)). |
| `instance` | the host name | The name of this ChDash in the files: 1 to 64 characters of `A-Z a-z 0-9 . _ -`. Its file is `<instance>.jsonl.zst`. Two instances that run at the same time must not share a name. When the setting is empty, ChDash uses the host name (`gethostname`) and stops when it is not a valid name: set `instance`. |
| `retention_days` | `90` | How many days of usage ChDash keeps for each key (1 to 365). The last day is kept by the minute, 5 minutes and 15 minutes, then by 3 hours (7 days or more), by 12 hours (30 days or more) and by the UTC day: refer to [Usage of a key](#usage-of-a-key). The usage of a deleted key stays as long. Give the instances that share a directory the same value. |
| `all_keys` | `false` | Lets a key read the usage of all the keys of all the instances with the MCP tool `mcp_analysis_all_usage`. The tool has two locks: this setting, and the `tools` of the key, which must name it (`["*"]` does not include it). It shows the names, ids, hosts and clients of the other keys: refer to [The analysis tools](#the-analysis-tools) before you turn it on. It never shows the ClickHouse cost of a key. The meta says whether it is on (`usage.all_keys`, and `available` of the tool). |

### The `key` block

You write one `key {}` block for each key. The block has no label.

```hcl
key {
  name            = "ci-bot"
  secret_file     = "/run/secrets/chdash-mcp-ci"   # or secret: exactly one
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
| `secret`, `secret_file` | Required: give exactly one. The secret is a UUID version 4 (like `3f2b8c1e-5d4a-4b7e-9c60-1a2b3c4d5e6f`), the format of the keys of the page: nothing else is accepted. `secret_file` holds the secret. ChDash removes the spaces and the line ends around it. A key always has a secret that the MCP page can show: `secret_sha256` (a hash alone) is not accepted any more and stops the start. |
| `hosts` | The host of the key: the name of a `clickhouse.host` block that has `mcp_uri`. **A key reads one host**, so the list has exactly one name (`hosts = ["prod"]`); to read two hosts, make two keys. `["*"]`, a list of two names and an empty list are startup errors. |
| `tools` | The tools of the key, or `["*"]` for every tool that the key can hold, but `mcp_analysis_all_usage`, which a key must name. An empty list means no tool, but the ones that every key has: `mcp_analysis_my_limits`, and `mcp_analysis_my_usage` while the usage is on (refer to [The analysis tools](#the-analysis-tools)). |
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
| 7 | An attribute is unknown, a key does not have exactly one of `secret` and `secret_file`, or it has `secret_sha256`. |
| 8 | `mcp.usage.enabled` is true, and `dir` is not set, does not exist, is not a directory, or cannot hold new files; or `instance` is not a valid name (when it is empty, the host name is not one: set `instance`); or the file of this instance (`<instance>.jsonl.zst`) is the key file or the file of a query library, is a link, or is not a usage file of this ChDash (not zstd, a line that is not valid, another `version`, a header that names another instance). ChDash never rewrites an invalid file: delete it, the usage of this instance starts again. A directory that anyone can write in, without the sticky bit, is a warning in the log (`mcp.usage_dir_writable_by_all`), not an error. |

ChDash also refuses a secret that is not a UUID version 4, a bad name, a bad pattern in `databases`, and a `max_rows` or `timeout_seconds` above the global value. A `mcp {}` block with `enabled = false` still checks its shape (case 7).

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
- A user defined in `users.xml` cannot be given a grant (ClickHouse answers `ACCESS_STORAGE_READONLY`), and its `allow_databases` leaves it no right on `system.documentation` or `system.numbers`: `explorer_functions` and the examples with `system.numbers` are refused. Make the MCP user with `CREATE USER` (it can use a profile of `users.xml`: `SETTINGS PROFILE 'readonly_settings'`) and grant it the tables listed above.
- Do not grant `INSERT`, `ALTER`, `CREATE`, `DROP`, `SYSTEM`, `KILL QUERY` or `ACCESS MANAGEMENT`.
- Do not grant `SELECT` on `system.users`, `system.query_log`, `system.processes` or other tables with data of other users.
- The profile of the user may keep the default (`readonly = 0`), or set `readonly = 2` (the usual profile of a read-only user in production), or `readonly = 1`. ChDash reads the profile of each connection and adapts what it sends: [The settings profile of the user](#the-settings-profile-of-the-user) has the rules.
- `tests/clickhouse-init/01-chdash-users.sql` has the user of the tests, `chdash_mcp`. It uses the same pattern.

A key can limit the user more. A key cannot give the user more.

## Key model

A key has three scopes: a host, tools and data.

### Hosts

A key reads **one host**. `hosts` has that name: a key without a host is refused (`required`). There is no `*` and no list of hosts: a key that names several hosts would have to say which MCP user answers each call, and a client would have to guess. One key for each host is the rule. The `host` argument of a tool is optional: it is the host of the key, and a call that names another host is `host_not_allowed`.

The host must have an `mcp_uri`, and **its MCP user must be there**: a key made on the page for a host whose MCP user cannot connect is refused (`mcp_user_unavailable`), and so is a tool that this user cannot serve (`not_grantable`; refer to [The ClickHouse MCP user](#the-clickhouse-mcp-user)). A key of an older file that names several hosts keeps working as before, and the page marks it.

### Tools

The tools are in **families** that the MCP page lists as permissions. A family has at least two tools, so that no card is a lone check box: **Data** (the hosts, the databases, the tables and the rows of a table), **Explorer**, **System**, **Observability**, **Query**, **SQL** and **MCP analysis** (the limits and the usage of the keys: refer to [The analysis tools](#the-analysis-tools); it has one tool only while the usage is off, and the page lists the tools that the server offers). Observability holds the tools of the three signals, in sections: **Traces**, **Logs** and **Metrics**, each with the pages' tools (`traces_*`, `logs_*`, `metrics_*`) and the simple tools of that signal (`search_traces`, `search_logs`, `query_metric`, ...). The page draws a section as a sub-heading of the card.

| Tool | Group | Use |
| --- | --- | --- |
| `list_hosts` | data | The host of the key and its health. |
| `list_databases` | data | The databases that the key can see. |
| `list_tables` | data | The tables, with engine, rows and size. Has a glob filter. |
| `describe_table` | data | Columns, keys, engine and the CREATE statement. |
| `query_table` | data | Columns, filters, order and limit. ChDash builds the SQL. |
| `list_services` | observability | The services that sent spans (or log records) lately, with their errors. |
| `search_traces` | observability | Recent traces by their root span: service, operation, status, minimum duration. |
| `get_trace` | observability | Every span of one trace, in time order. |
| `search_logs` | observability | Recent log records: service, lowest severity, a text, a trace. |
| `list_metrics` | observability | The metrics reported lately, with their kind, unit and description. |
| `query_metric` | observability | One metric as a time series. |
| `run_query` | sql | One read-only SQL statement. |
| `explain_query` | sql | `EXPLAIN` of one SELECT: plan, pipeline, ast, syntax or estimate. |
| `mcp_analysis_my_limits` | mcp_analysis | The limits of the key: its rate limit and what is left of it, its rows and time, and the size caps. Every key has it. |
| `mcp_analysis_my_usage` | mcp_analysis | What the key did, and with `include_cost` what its statements cost ClickHouse. Every key has it while the usage is on. |
| `mcp_analysis_all_usage` | mcp_analysis | What all the keys of all the instances did. A key must name it, and `mcp.usage.all_keys` must be on. |

`tools = ["*"]` means every tool that the key can hold, but the one that a key must name (`mcp_analysis_all_usage`). The tools that every key has are in the tools of a key whatever its list says, an empty list too. A tool that the configuration does not offer (the usage is off, or `mcp.usage.all_keys` is) is not listed, and a call to it is `not_enabled`: refer to [The analysis tools](#the-analysis-tools).

The observability tools read the OpenTelemetry tables that the Observability pages read (the `observability` block of the configuration, with the override of the host that the call names). A tool answers `not_enabled` when its signal is off. They are read with the **system user** of the host, as the pages do, so the data of the key does not matter: the permission gives the tools, like the pages' tools of the same signal. They show what the pages show and no more: `traces.service_allowlist` (the one allowlist of traces, logs and metrics) is part of every query of these tools, the six simple ones as the pages' tools (a service that it does not allow is never read, whatever the key). The names of the databases and tables come from the `observability` block, with the override of the host that the call names (`clickhouse.host { observability { ... } }`, docs/configuration.md): the tools read the tables of that host, as its pages do, and a signal that is off for the host is `not_enabled` there.

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
- A key has no switch, no expiry and no description. You make it, or you delete it: to stop a key, delete it. The attributes `enabled`, `description` and `expires_at` of a `key {}` block are startup errors.

### Two sources

| Source | Where | Change |
| --- | --- | --- |
| `config` | `key {}` blocks | Edit the configuration and restart. The page shows them read-only. |
| `ui` | The MCP page, and the `storage_file` | Create and delete on the page. |

The two sources add up. A name or a secret cannot exist twice, in either source.

### Secrets and the key file

- ChDash makes the secret of a page key: a version 4 UUID (RFC 9562, for example `3f2a9c1e-7b4d-4e8a-9a6f-5c0d2b1e7a34`: 122 random bits from the system random source). The page shows it **once**, in the answer of the create. No route and no button gives it again. A lost secret cannot be found: delete the key and make a new one.
- ChDash stores only the SHA-256 of the secret and its first 8 characters (`secret_hint`). A request is authenticated by the hash, which ChDash compares in constant time. Whoever reads the key file cannot use it to connect. The file has the mode 0600; put it on a private volume.
- A key of the configuration with `secret` or `secret_file` is hashed when ChDash reads the configuration. ChDash keeps only the hash and the hint in memory. Whoever reads the configuration (or the secret file) has the secret: the operator already has it.
- A key file that holds a secret in clear (`secret`) is not a file of this ChDash. ChDash refuses to start and never rewrites the file: delete it and make the keys again.
- The file has `version`: 1 and a `keys` array. Each key has `id` (`ui_` and 12 hexadecimal characters), `name`, `secret_sha256`, `secret_hint`, `hosts`, `tools`, `databases`, `max_rows`, `timeout_seconds`, `created_at` and `updated_at`.
- One ChDash process owns the file. ChDash reads it at start and writes it from its memory. Two instances that share the file overwrite each other's keys. ChDash does not hold the lock of the keys while it writes (`fsync`), so a slow disk does not delay the authentication of a request.
- ChDash writes the file in an atomic way: a temporary file, `fsync`, then `rename`. The mode is 0600. If the write fails, ChDash restores its memory and the API answers 500 `storage_error`.
- If the file does not exist, ChDash creates it on the first write. If the file is not valid, ChDash stops at start and never rewrites it.
- `last_used_at` comes from the usage of the key (refer to [Usage of a key](#usage-of-a-key)), from all the instances that share the usage: `null` when the usage is off. The key file never holds it.

## Tools

Each tool has a JSON Schema in `tools/list`. A tool failure comes back as a result with `isError: true`. The text content (and `structuredContent`, for a client that gets it) holds `{"error": "<code>", "message": "<sentence>"}`.

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

Six tools, with no SQL to write: ChDash builds a bounded statement for each one. Their values follow "Result values" in `docs/telemetry.md`: a count of 64 bits (`spans`, `errors`, `records`) is a string of digits. All of them take an optional `host`. The window is `since_minutes` (default 60, at most `max_lookback_minutes` of the `traces` block). A list has `limit` rows (default 20, at most the row cap of the key). The result of a list has `count`, `truncated` (more rows existed) and `elapsed_ms`. The answers name their fields, so a client reads `trace_id` and not a column position.

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

Each read function of the ChDash API is a tool too, so that a client can do what the pages do: browse the Explorer, read the System page, search traces, logs and metrics, read the saved queries. The tools are in the families **Explorer**, **System**, **Observability** (sections Traces, Logs and Metrics) and **Query** (the saved queries, the formatter and the record of a run).

How they work:

- Every tool takes `host` (as the other tools) and `params`, an object of query parameters (`{"database": "otel", "refresh": 1}`; a list repeats the parameter: `{"status": ["Error", "Ok"]}`). A tool that is a `POST` takes `body`, a JSON object, instead. The description of each tool names the parameters that matter. A `{name}` in the route (`system_query`: `{hash}`) is a required param.
- ChDash calls its own API with the host of the call and returns the JSON answer as it is. An error of the API keeps its code and message (`invalid_metrics_range`, `unknown_host`, ...). A route that the configuration does not have gives `not_enabled`. An answer larger than `max_result_bytes` gives `result_too_large`: narrow it with a window, a filter or a limit.
- **They run as the MCP ClickHouse user, with the system user for what the pages read with it.** The pages use the users of the host: the runner (what is visible, the data) and the system user (figures, the System page, the OpenTelemetry tables). A tool calls the same routes, but the runner is `mcp_uri`:
  - **One identity for every tool:** the MCP user is the **runner**, and the system user stays what it is for the pages. The runner decides what is visible and what the data is; the system user only adds figures (sizes, parts, disks) to the objects that the runner may read, reads the System page (the state of the server) and reads the OpenTelemetry tables of Traces, Logs and Metrics, exactly as the pages do. So with an MCP user that reads two databases, `explorer_catalog` lists those two and `explorer_table` of any other table is `object_not_found`; with an MCP user that reads no `otel` table, `traces_search` still answers (the system user reads the table).
  - **The simple tools of Observability** (`list_services`, `search_traces`, `get_trace`, `search_logs`, `list_metrics`, `query_metric`) are not routes of the API: they run their own bounded SQL (`readonly = 1` and the limits of the key), with the system user of the host, as the pages do. They overlap with the pages' tools of the same signal.
  - **Query library:** no ClickHouse user is involved (it is a file of ChDash).
  - How it works, with no second instance: for each host that has an `mcp_uri`, the configuration holds one more entry that only the tools can name (`<host>\x1fmcp`: runner = the MCP user, system user as it is, `src/mcp_identity.hpp`). A tool calls the handler of the route **in the process**: no second request, no socket, no second worker thread. The call runs with the context of an MCP call (`src/request_context.hpp`), which only the call itself can set. A request that comes through the port is a browser request, whatever headers it sends: for it the host is unknown (`unknown_host`). It is never listed and never health-checked. The caches are keyed by the host id, so the entries of MCP never mix with those of the pages. The answer is returned with the host id as the client named it.
  - **The grants.** The MCP user needs `SELECT` on its tables and the `SHOW` grants (the same as a runner); `SELECT` on `system.documentation` for `explorer_functions`; The system user needs what it needs for the pages (the `otel` tables, `system.parts`, `system.data_skipping_indices`). A tool that lacks a grant answers `permission_denied` with the statement that gives it (`Give it to the MCP user: GRANT SELECT ON system.documentation TO chdash_mcp;`). At start and every 10 minutes, ChDash audits these grants with `CHECK GRANT` and says what is missing in the log (`access.finding` lines: `The MCP user ...`) and in `GET /api/hosts` (`access.mcp_user`, `mcp_missing`, `mcp_reads_nothing`, and `system_missing` for the system user).
  - **Tools that a host can serve.** The audit knows which grants are missing; `src/mcp_grants.cpp` says which tool each one takes away: `explorer_functions` needs `system.documentation` (MCP user); `search_traces`, `get_trace`, `search_logs`, `list_metrics` and `query_metric` need their `otel` tables (MCP user); `traces_*`, `logs_*` and `metrics_*` need the `otel` tables and, for Logs and Metrics, `system.parts` and `system.data_skipping_indices` (system user, as the pages). A tool that its user cannot serve **cannot be given to a key**: the page greys it with the grant that is missing and who lacks it, and `POST /api/mcp/keys` refuses it (400 `validation`, field `tools`, reason `not_grantable`, with the `GRANT` statement in the message). A host whose MCP user cannot connect refuses the key altogether (field `hosts`, reason `mcp_user_unavailable`). The check uses the last audit of the host: it says nothing when the host has not been audited yet, and it is never made for a key of the configuration (a startup error would stop ChDash for a grant that a DBA gives a minute later) nor for keys already stored. `tools = ["*"]` is not expanded: it means every tool, and the ones that cannot be served answer `permission_denied` as before. The details of a key on the page mark the tools that it holds and that are not served.
  - **What a key reaches is what the MCP user reads, cut by the patterns of the key: the two limits add up.** The tools of one table or of the catalog follow the patterns. The others are read as the pages read them. Only the SQL tools need `databases = ["*"]`:

    | Tool | `databases` of the key |
    | --- | --- |
    | `explorer_catalog` | Any. The answer is cut: the databases that a pattern names, the tables that a pattern allows, the summary of a database only when the key reads all of it (a summary counts every table). A `database` param that no pattern names is `database_not_allowed`. |
    | `explorer_table`, `explorer_table_data`, `explorer_graph_definition` | Any. `database` and `table` must be plain strings that a pattern allows (`table_not_allowed`, `invalid_argument` otherwise: a name is never skipped, so the API cannot read another value than the one checked). The MCP user may still refuse (`object_not_found`). |
    | `explorer_functions`, `query_library`, `format_sql`, System (`system_*`, `query_execution`) | Any. They read no table of the key (the functions, the saved queries, the formatter, the state of the server). System is read with the system user, as for the page: give it to keys that may see the whole server (the queries of every user, the disks, the replication). |
    | Traces, Logs and Metrics (`traces_*`, `logs_*`, `metrics_*`, and the simple tools `search_traces`, `get_trace`, `search_logs`, `list_metrics`, `query_metric`, `list_services`) | Any. They are read with the system user, as the pages do: the data of the key cut nothing, and the MCP user needs no grant on the `otel` tables. A key with a narrow `databases` and the permission Logs reads every service of the logs table. |
    | `explorer_graph`, `explorer_storage`, `explorer_names` | Any. They are read as the pages read them: the MCP user decides what is visible and the system user adds the figures, so the patterns of the key cut nothing (the names, the lineage and the sizes of what the MCP user sees). |

    The detail of an allowed table can name tables that the key does not read (its CREATE statement, its dependencies). As for `query_table`, a view is read as the MCP user reads it. To know what a key reaches, the page asks `GET /api/mcp/keys/<id>/access`.
- The key's `max_rows` does not cut an API answer (the API has its own limits: `limit` params and caps). The timeout of the key and `max_result_bytes` apply. At most `admission.mcp_max` API calls (default 8) run at the same time for all keys; a call waits up to `admission.wait_ms` for a place and then answers `api_unavailable` (retry). A call stops when the client of MCP goes away or the server stops. The routes that a tool calls have the admission of the heavy work for each host as the pages have ([operations.md](operations.md#admission)).
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
| `system_query` | `GET /api/system/queries/{hash}` | One group of queries by its hash: the normalized text and the same text formatted (`normalized_formatted`, null when it cannot be), the runs, the slowest and the failed ones. |
| `system_activity` | `GET /api/system/activity` | What the server does now: running queries, merges, mutations, fetches. |
| `system_keeper` | `GET /api/system/keeper` | The ClickHouse Keeper (ZooKeeper) state: sessions, nodes, replication queues. |

**Observability · Traces** (The Traces page: search, analytics, service map, spans.)

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

**Observability · Logs** (The Logs page: search, histogram, patterns, context.)

| Tool | Route | Use |
| --- | --- | --- |
| `logs_meta` | `GET /api/logs/meta` | How the log table looks on this host (columns, text search mode). |
| `logs_histogram` | `GET /api/logs/histogram` | Record counts over time by severity class. |
| `logs_context` | `GET /api/logs/context` | The records around one record. |
| `logs_patterns` | `GET /api/logs/patterns` | The message templates that the matching records fall into, with counts (Drain). |
| `logs_services` | `GET /api/logs/services` | The services that wrote logs in the window, with counts. |
| `logs_facets` | `GET /api/logs/facets` | The attribute keys of the records in the window, most frequent first. |
| `logs_facet_values` | `GET /api/logs/facet_values` | The values of one field with their counts. |

**Observability · Metrics** (The Metrics page: catalog, series, exemplars.)

| Tool | Route | Use |
| --- | --- | --- |
| `metrics_meta` | `GET /api/metrics/meta` | How the metric tables look on this host (the kinds that exist). |
| `metrics_catalog` | `GET /api/metrics/catalog` | The metrics reported in the window, by service and kind, with unit and description. |
| `metrics_attributes` | `GET /api/metrics/attributes` | The attribute keys of one metric, or the values of one key. |
| `metrics_series` | `GET /api/metrics/series` | One metric as time series. |
| `metrics_exemplars` | `GET /api/metrics/exemplars` | Sample points of a metric with the trace that produced them. |

**Query** (The Query page: the saved queries, the SQL formatter and the record of a run.)

| Tool | Route | Use |
| --- | --- | --- |
| `query_library` | `GET /api/query-library` | One page of the saved queries and their folders (the Query page library of the server): at most 100 items with their name and place, no SQL; `parent_id` and `cursor` read more. |
| `query_execution` | `GET /api/query/execution` | The record of a query that ChDash ran: status, timings and profile counters. |

| `format_sql` | `POST /api/format` | Format SQL text like the Format button of the Query page (it reads the ClickHouse version of the host to parse it). A text that the formatter would change in meaning comes back as written, with a `warning` ([formatter.md](formatter.md)). |


### `list_hosts`

No arguments. Result: `{"hosts": [{"name": "prod", "label": "...", "healthy": true}], "count": 1}`. `healthy` is the general health of the host, from the same check as the rest of ChDash. It is `null` when not known.

### `list_databases`

Arguments: `host`, `filter` (a glob on the name). Result: `{"host", "databases": [{"name", "engine", "comment"}], "count", "truncated"}`.

### `list_tables`

Arguments: `host`, `database`, `filter` (a glob on the table name, for example `events_*`). Without `database`, the tool lists every table in scope. Result: `{"host", "tables": [{"database", "name", "engine", "total_rows", "total_bytes", "comment"}], "count", "truncated"}`. `total_rows` and `total_bytes` are strings of digits (a `UInt64`, see "Result values" in `docs/telemetry.md`) and can be `null`. A list has at most 2000 tables. Then `truncated` is true and `hint` says how to narrow it.

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
- ChDash refuses `INTO OUTFILE`, a `SETTINGS` clause (`SETTINGS name = value`: it would change the limits of the key, see [The settings profile of the user](#the-settings-profile-of-the-user)) and the table functions that read files, URLs, remote servers and other databases (`file`, `url`, `remote`, `s3`, `mysql` and similar). The error codes are `clause_not_allowed` and `function_not_allowed`. A column, an alias or a table named `settings` is not a clause (`Settings['max_threads']`, `system.settings`).
- A `FORMAT` clause is accepted and has no effect: the result is always JSON.
- This check is a guard rail. The security is `readonly` and the grants of the ClickHouse user. With a profile at `readonly = 2`, the refusal of `SETTINGS` is what keeps the limits of the key.

Result: `host`, `columns`, `rows`, `row_count`, `truncated`, `elapsed_ms`. A `Bool` value of free SQL comes as `0` or `1`, because the native protocol sends it as `UInt8`. The values follow the contract of the Query results ("Result values" in `docs/telemetry.md`): a `UInt64` or a `Decimal` is a string of its digits, NaN is `"nan"`, and a Map is a list of `[key, value]` pairs.

### `explain_query`

Arguments: `host`, `sql` (one `SELECT` or `WITH` statement), `type` (`plan` default, `pipeline`, `ast`, `syntax` or `estimate`), `indexes` and `actions` (booleans, for `plan`). Result: `host`, `type`, `lines` (the text of the explain), `truncated`. The `estimate` type has `columns` and `rows`.

### The analysis tools

The family **MCP analysis** (`mcp_analysis`) is the one of the keys themselves: a key reads its own limits, its own usage and, when the administrator allows it, the usage of all the keys. The tools run no SQL of the MCP user and take no `host`: they read the rate limit, the usage and the cost that ChDash keeps, so they need no grant of ClickHouse. They are the last three tools of the catalog.

| Tool | Who has it | When it is offered |
| --- | --- | --- |
| `mcp_analysis_my_limits` | Every key, whatever its `tools` say (an empty list too). | Always, also when the usage is off. |
| `mcp_analysis_my_usage` | Every key, whatever its `tools` say. | While the usage is on (`mcp.usage.enabled`). |
| `mcp_analysis_all_usage` | A key whose `tools` name it. `["*"]` does not include it. | While the usage is on and `mcp.usage.all_keys` is true. |

- **Three flags in the catalog.** `always` (every key has the tool), `explicit_only` (`["*"]` does not give it: the list of the key must name it) and `available` (the configuration offers it now) are in `tools[]` of `GET /api/mcp/meta`. The page draws the family from them and names none of the tools.
- **A tool that is not offered.** It is not in `tools/list`, also for a key that names it. A call to it is the tool error `not_enabled` for a key that has it (the message says the setting that is off: `mcp.usage.enabled` or `mcp.usage.all_keys`), and `tool_not_allowed` for a key that does not have it (a key is not told that a tool it lacks is off). A key can name an analysis tool before the setting is on: the name is valid, and the check is made at each call, so a configuration does not stop when the usage is turned off.
- **The two locks of `mcp_analysis_all_usage`.** The tool needs the setting `mcp.usage.all_keys` and the name in the `tools` of the key. The protocol checks the name, and the tool checks it again, so no caller reaches the usage of the other keys with a single check. `["*"]` never gives it.
- **Counted like any call.** An analysis tool counts in the usage of the key (its method is the name of the tool) and in its rate limit, and has a line in the audit log. The answer of `mcp_analysis_my_usage` does not hold the call that asks (a call is counted when it ends), and the rate limit that `mcp_analysis_my_limits` says is the one after the token of the call that asks.
- **Small answers.** Each list has a row limit (20 for the usage of a key; 20 by default and 200 at most for all the keys), and `omitted` says how many rows were left out. No series is made unless asked. An answer larger than `mcp.max_result_bytes` is `result_too_large`, as any result: ask for less (a shorter window, a filter, a smaller `limit`, no `series`).
- **Errors.** `invalid_argument` (the message says the rule), `not_enabled`, `tool_not_allowed` and `result_too_large`.
- **What the model reads.** What a tool returns goes into the context of the model of the client, and so to the provider of that model. The usage of all the keys shows the names, the ids and the hosts of the other keys, their clients (name, version) and their activity, and the names of the instances: give `mcp_analysis_all_usage` only to a key whose model may see them (refer to [Security limits](#security-limits)). The tool never shows the ClickHouse cost of another key: the cost lists the tables that the statements of a key read, which may be tables that the caller cannot read. It has no argument for it. No tool shows SQL, data, a secret or an address.

### `mcp_analysis_my_limits`

No arguments. What limits the calling key now:

```json
{"key": {"id": "ci-bot", "name": "ci-bot", "host": "prod"},
 "instance": "chdash-0",
 "rate_limit": {"per_minute": 120, "scope": "instance", "remaining": 117, "next_call_in_seconds": 0, "full_in_seconds": 2},
 "max_rows": {"value": 50, "source": "key"},
 "timeout_seconds": {"value": 5, "source": "clickhouse"},
 "max_result_bytes": {"value": 1048576, "source": "mcp"},
 "max_sql_bytes": {"value": 65536, "source": "mcp"},
 "max_memory_bytes": {"value": 1073741824, "source": "mcp"},
 "max_rows_to_read": {"value": null, "source": "mcp"}}
```

- `key` is the id, the name and the host of the key (the first host, for a key of an older file that names several).
- `instance` is the name of this ChDash in the usage (`mcp.usage.instance`), and `null` while the usage is off: an instance has a name only then.
- `rate_limit` is `mcp.rate_limit_per_minute` as the bucket of the key stands now. `scope` is always `instance`: each ChDash keeps its own bucket, so a key that reaches two instances (behind a load balancer) has two. `remaining` is the number of calls that fit now: the call that asks has taken its token, so the first call of a key that was not used shows one less than the limit. `next_call_in_seconds` is 0 while a call fits, and else the wait for the next token. `full_in_seconds` is the wait until the bucket is full again. `per_minute` and `remaining` are `null` when the limit is 0 (no limit).
- Every other member is `{"value", "source"}`. `max_rows` and `timeout_seconds` are the smaller of the limit of the key, the one of `mcp` and the one of the settings profile of the MCP user of the host of the key (`max_result_rows`, `max_execution_time`): the figures that the page shows for the host and for the key. `source` is `key` when the key lowers the cap (a key above the cap of its host has the cap of its host), and else who sets the cap of the host: `mcp`, `clickhouse` or `both` (they are equal). `max_rows` cuts the tools that build their SQL, not an API tool (refer to [The API tools](#the-api-tools)). The four other caps are those of `mcp` (`source` is `mcp`): `max_result_bytes`, `max_sql_bytes`, `max_memory_bytes` and `max_rows_to_read` (`null` is no limit). The profile of the MCP user can still cut them: ChDash reads only its rows and its time ([The settings profile of the user](#the-settings-profile-of-the-user)).

### `mcp_analysis_my_usage`

Arguments, all optional:

- `window`: `1h`, `6h`, `24h` (default), `7d`, `30d`, `90d` or `365d`, as far as `mcp.usage.retention_days` goes (the windows of [Usage of a key](#usage-of-a-key)). Another value is `invalid_argument`, and the message lists the windows that this ChDash keeps.
- `series` (default `false`): adds `series`, one point for each step of the window (`step` in seconds, and `points`: `t`, `requests`, `calls`, `errors`).
- `include_cost` (default `false`): adds `cost`, what the statements of the key cost ClickHouse (below).
- `instance`: a list of at most 20 names of instances. Only these are summed. Without it, all the instances are.

The answer is the usage of the key that `GET /api/mcp/keys/<id>/usage` gives (refer to [The page API](#the-page-api)), with each list cut to 20 rows: the key (`id`, `name`, `host`, `source`, `deleted_at`, `elsewhere`), `window`, `from`, `to`, `since`, `retention_days`, `instances` (each instance with its `status`: a file that was skipped or a conflict is seen here), `first_used_at`, `last_used_at`, `totals`, `tools` (the tool calls by tool, the most frequent first), `statuses` (the results: the errors by code), `clients` and `omitted` (how many rows of `tools`, `statuses` and `clients` were left out). Then `series` and `cost`, when asked.

```json
{"id": "ci-bot", "name": "ci-bot", "host": "prod", "source": "config", "deleted_at": null, "elsewhere": false,
 "window": "24h", "from": "2026-10-13T23:00:00Z", "to": "2026-10-14T22:46:40Z", "since": "2026-10-11T22:46:40Z", "retention_days": 90,
 "instances": [{"instance": "chdash-0", "written_at": "2026-10-14T22:46:00Z", "status": "ok", "reason": ""}],
 "first_used_at": "2026-10-14T20:46:40Z", "last_used_at": "2026-10-14T20:54:20Z",
 "totals": {"requests": 12, "calls": 10, "errors": 1, "rate_limited": 0, "rejected": 0, "duration_ms_avg": 46, "duration_ms_max": 70, "rows": 6120, "bytes": 210800},
 "tools": [{"tool": "query_table", "calls": 7, "errors": 1, "duration_ms_avg": 55, "duration_ms_max": 70, "rows": 120, "bytes": 21000}],
 "statuses": [{"status": "ok", "count": 9}, {"status": "table_not_allowed", "count": 1}],
 "clients": [{"name": "claude-code", "version": "2.1.0", "user_agent": "claude-code/2.1.0 (node)", "first_seen_at": "2026-10-14T20:46:40Z", "last_seen_at": "2026-10-14T20:54:20Z", "requests": 12}],
 "omitted": {"tools": 0, "statuses": 0, "clients": 0}}
```

**The cost.** `cost` is the cost of the page ([The ClickHouse cost of a key](#the-clickhouse-cost-of-a-key)) for the key itself: the same read with the runner account of its host, the same cache (60 seconds, shared with the page: a read by the tool and by the page in the same minute is one read) and a place of heavy work for the host. It is read only when `include_cost` is true, because it reads `system.query_log`. It has `host`, `window`, `from`, `to`, `max_lookback_hours`, `clamped`, `read_at`, `status`, `totals`, `identities`, `tools`, `tables`, `tables_truncated` and `rows_truncated`. The cost has the windows `1h`, `6h`, `24h` and `7d`: a window of the usage that is longer reads `7d`, and `cost.window` says it. The read of `system.query_log` runs outside of the call of the key (its scope has no `query_id` of the key), so it is not a statement of the key and never counts in the cost that it reads. A cost that cannot be read does not fail the call: the usage is there, and `cost` says why. It is `{"status": "not_enabled", "message"}` when `system.top_queries` is off, and `{"host", "window", "status": "unavailable", "reason", "message"}` for the reasons of the page (`no_host`, `runner_unavailable`, `not_granted`, `disabled`, `window_too_large` with a `suggested_window`, `readonly_account`, `unsupported`, `failed`) and for `busy` (no place of heavy work came in time) and `stopping`. Unlike the page, the tool gives no text of a ClickHouse error, no `GRANT` statement and no `id`: they are for the administrator, who reads them on the page. The read has the time of System > Queries (15 seconds), not the `timeout_seconds` of the key.

### `mcp_analysis_all_usage`

Arguments, all optional:

- `window`: as for `mcp_analysis_my_usage`.
- `group`: `key` (default), `method`, `client` or `instance`: what `series` is grouped by (the page also has `result` and `type`).
- `key`, `method`, `client` and `instance`: lists of at most 20 values that keep the requests that have them (the values of a list are OR, the lists are AND). The rules are those of the filters of the page ([The page API](#the-page-api)): a `key` is the id of a key, a `method` a tool or a method of the protocol, a `client` the name that a client gave, an `instance` the name of an instance. A value that was never counted is valid: it keeps nothing.
- `series` (default `false`): adds the series of the groups.
- `limit`: the rows of each list, from 1 to 200 (default 20).

The answer is the overview that `GET /api/mcp/usage/overview` gives (refer to [The page API](#the-page-api)), with every instance summed and without the series unless asked: `window`, `from`, `to`, `since`, `retention_days`, `group`, `filters`, `totals` (with `active_keys` and `keys`), `instances`, `keys`, `methods`, `results`, `types`, `clients` and `omitted`. A list has at most `limit` rows, the most requests first, and `omitted` counts the rows that were left out; the values that were chosen are always kept. A list applies every filter but its own, so the other values of its dimension stay listed. The answer never has a cost.

```json
{"window": "24h", "from": "2026-10-13T23:00:00Z", "to": "2026-10-14T22:46:40Z", "since": "2026-10-11T22:46:40Z", "retention_days": 90, "group": "key",
 "filters": {"key": [], "method": [], "client": [], "instance": [], "result": [], "type": []},
 "totals": {"requests": 16, "calls": 14, "errors": 1, "rate_limited": 0, "rejected": 0, "duration_ms_avg": 34, "duration_ms_max": 70, "rows": 6124, "bytes": 212000, "active_keys": 2, "keys": 2},
 "instances": [{"instance": "chdash-0", "status": "ok", "reason": "", "written_at": "2026-10-14T22:46:00Z", "requests": 16, "calls": 14, "errors": 1, "rate_limited": 0, "rejected": 0, "duration_ms_avg": 34, "duration_ms_max": 70, "rows": 6124, "bytes": 212000, "keys": 2}],
 "keys": [{"id": "ci-bot", "name": "ci-bot", "host": "prod", "source": "config", "deleted_at": null, "elsewhere": false, "requests": 12, "calls": 10, "errors": 1, "rate_limited": 0, "rejected": 0, "duration_ms_avg": 46, "duration_ms_max": 70, "rows": 6120, "bytes": 210800, "last_used_at": "2026-10-14T20:54:20Z"}],
 "methods": [{"method": "query_table", "kind": "call", "requests": 7, "errors": 1, "duration_ms_avg": 55, "duration_ms_max": 70, "rows": 120, "bytes": 21000, "keys": 1}],
 "results": [{"result": "ok", "count": 15, "keys": 2}, {"result": "table_not_allowed", "count": 1, "keys": 1}],
 "types": [{"type": "call", "requests": 14}, {"type": "request", "requests": 2}, {"type": "limited", "requests": 0}, {"type": "rejected", "requests": 0}],
 "clients": [{"client": "claude-code", "requests": 12, "calls": 10, "errors": 1, "rate_limited": 0, "rejected": 0, "duration_ms_avg": 46, "duration_ms_max": 70, "rows": 6120, "bytes": 210800, "keys": 1, "versions": ["2.1.0"], "last_seen_at": "2026-10-14T20:54:20Z"}],
 "omitted": {"keys": 0, "methods": 0, "results": 0, "clients": 0, "instances": 0}}
```

(The example shows one row of each list.)

### Tool error codes

`invalid_argument`, `not_enabled`, `result_too_large`, `trace_not_found`, `metric_not_found`, `host_required`, `host_not_allowed`, `no_host`, `tool_not_allowed`, `database_not_allowed`, `table_not_allowed`, `table_not_found`, `unknown_column`, `unsupported_column_type`, `sql_too_large`, `empty_sql`, `invalid_sql`, `multiple_statements`, `statement_not_allowed`, `clause_not_allowed`, `function_not_allowed`, and from ClickHouse: `timeout`, `readonly`, `permission_denied`, `memory_limit`, `read_limit`, `not_found`, `syntax_error`, `host_unavailable`, `query_failed`. A call to a tool name that does not exist is a JSON-RPC error (-32602).

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

Every answer has `Cache-Control: no-store`. An HTTP error has the body of every ChDash error, `{"error_code": "<code>", "message": "...", "retryable": ...}` ([operations.md](operations.md#errors)). ChDash checks in this order: Origin, key, rate limit, then the rest. When it refuses a request before it reads the body, it closes the connection.

### Origin check

A request without an `Origin` header comes from a program (a CLI, an SDK, an IDE). ChDash accepts it. A request with an `Origin` header comes from a web page. ChDash refuses it unless the origin is in `allowed_origins`. With the default empty list, ChDash refuses every browser origin, also the origin of ChDash itself. This stops a web page from calling a local ChDash with a key that the user holds (DNS rebinding). Add an origin (for example `https://inspector.example.com`) only for a browser client that you trust.

### Rate limit

Each key has a token bucket in memory. The bucket holds `rate_limit_per_minute` calls and fills evenly during one minute. All calls count: also a `ping` or a `tools/list`. The bucket is kept by each ChDash (an instance): a key that reaches two instances has two. A key reads what is left of its own bucket with `mcp_analysis_my_limits` (refer to [The analysis tools](#the-analysis-tools)); looking takes a token like any call, and no more.

### The settings profile of the user

The settings profile of the ClickHouse MCP user can already set `readonly` and some limits. ChDash reads the profile of each connection once (`getSetting`) and sends only what the profile allows. ClickHouse refuses every change of `readonly` when the profile has `readonly = 2` (even to 1), and every setting at all when it has `readonly = 1`.

| `readonly` in the profile | What ChDash sends |
| --- | --- |
| `0` (the default) | `readonly = 1` and the limits of the table below. |
| `2` | The limits of the table below, **not** `readonly`. The profile already stops every write. It lets a statement change its settings, and a `SETTINGS` clause in the SQL would win over the limits that ChDash sends: `run_query` and `explain_query` refuse the clause (`clause_not_allowed`), so a statement cannot change a limit. |
| `1` | **Nothing.** ClickHouse refuses any setting. The profile holds the limits (time, memory, rows to read). ChDash still caps the rows and the bytes that it returns, and sets `truncated`. The `query_id` of each statement still names its key and its tool: it is not a setting. |
| unknown (an old server without `getSetting`) | Everything, as for `0`. |

**The profile wins over the configuration.** When the profile of the user sets `max_execution_time`, `max_result_rows`, `max_result_bytes`, `max_memory_usage` or `max_rows_to_read`, ChDash does not send a value that contradicts it, and the configuration (`mcp { max_rows, query_timeout_seconds, ... }`) or a key cannot raise it. When the value of the configuration, or of a key, is **lower** than the one of the profile, the lower one is kept: a key can only lower a limit, never raise it. In short, the limit of a call is the smaller of the profile, the configuration and the key. The rows and the bytes that a call returns follow the same smaller value, and a result that reaches a cut of the profile has `truncated: true` (ClickHouse cuts there without one more row to show it). With `result_overflow_mode = break` that ChDash sends, the cut ends the result and is not an error.

**What a key can ask for.** The page and the API say the largest `max_rows` and `timeout_seconds` of each host: the smaller of the MCP configuration and the profile of the MCP user of the host (`max_result_rows`, `max_execution_time`), and which of the two it is (`mcp`, `clickhouse`, or `both` when they are equal). In the form of a new key, the two fields stop at that value as the number is typed (a larger number becomes the largest one at once), and the line under each field names who limits it. `POST /api/mcp/keys` refuses a larger value (400 `validation`, field `max_rows` or `timeout_seconds`, reason `range`) and the message says whether the MCP configuration or the ClickHouse user limits it. With one host, the form shows it as a fact and not as a choice.

The test stack has these users (`tests/clickhouse-init/01-chdash-users.sql`, `tests/config/mcp.profile.hcl`): `chdash_mcp_ro2` (`readonly = 2`, three databases), `chdash_mcp_ro2cap` (`readonly = 2`, `max_result_rows = 7`, `max_execution_time = 4`) and `chdash_mcp_ro1` (`readonly = 1`).

### Guard rails of each query

ChDash sends these settings to ClickHouse with each query (the profile of the user can remove some of them: see above):

| Setting | Value |
| --- | --- |
| `readonly` | `1`, only when the profile of the user has `readonly = 0` |
| `max_execution_time` | the timeout of the key (at most `query_timeout_seconds`) |
| `max_result_rows`, `result_overflow_mode` | `max_rows` + 1, `break` |
| `max_result_bytes` | `max_result_bytes` (with `result_overflow_mode = break`) |
| `max_rows_to_read` | the global value, when it is not 0 |
| `max_memory_usage` | `max_memory_bytes` |
| `log_comment` | `chdash-mcp key=<id>` |
| the `query_id` of the statement | `chdash-mcp/<key id>/<tool>/<uuid>`. It is a field of the statement, not a setting: it is sent with every profile (`readonly = 1` too), and no `SETTINGS` clause changes it. |

ChDash also stops reading when it has `max_rows` rows or `max_result_bytes` bytes. It then sets `truncated: true`. To find the statements of a key in `system.query_log`, use the `query_id` (`startsWith(query_id, 'chdash-mcp/<key id>/')`): `log_comment` is not sent to a profile at `readonly = 1`, and the System routes of the API tools label their statements `chdash-system`. The page reads the cost of a key this way (refer to [The ClickHouse cost of a key](#the-clickhouse-cost-of-a-key)).

### Audit log

ChDash writes one line to its log for each call (the JSON log, [operations.md](operations.md#logs)). It never writes SQL or data.

```
{"ts":"2026-10-10T12:00:00.123Z","level":"info","event":"mcp.call","key":"ci-bot","call":"tools/call:query_table","host":"prod","status":"ok","duration_ms":12,"rows":20}
{"ts":"2026-10-10T12:00:01.456Z","level":"info","event":"mcp.call","key":"-","call":"request","host":"-","status":"401_unknown","duration_ms":0,"rows":0}
```

`call` is `tools/call:<tool>` for a tool call, and the JSON-RPC method for any other message that was read (`initialize`, `tools/list`, `ping`, a notification, a method that the server does not know): the line of a JSON-RPC error names the method that failed. A method is cut at 128 bytes. `call` is `request` when there is no method to name: a message that could not be read (not JSON, a batch, no `"jsonrpc": "2.0"`, a method that is not text), a request refused before its message was read (400, 413, 415, 429), a missing or unknown key (401) and an `Origin` that is not listed (403).

`status` is `ok`, the tool error code, `rpc_error_<code>` or the HTTP cause (`401_unknown`, `401_missing`, `429_rate_limited`, `origin_not_allowed` and others). Page actions on keys write a line too (`keys/create`, `keys/delete`, and the reads `keys/access`, `keys/access-summary`, `keys/usage`, `keys/usage-summary`, `keys/usage-overview`, `keys/cost`) with the key id, never the secret.

The page that uses this API is described in [`mcp-integration-page.md`](mcp-integration-page.md).

## Usage of a key

When the usage is on (`mcp.usage.enabled`, refer to [The `usage` block](#the-usage-block)), ChDash counts what each key does, where it writes the audit line of a call: every request that came with a key, whatever its end. It never keeps SQL, data, a secret or an address. The MCP pages show it: the column **Used** and the usage in the details of a key (Keys), and the usage of all the keys, cut by key, method, client, instance, result and type (Usage), from the routes below. Several ChDash can share the usage: each one counts its own requests, and every answer sums them (refer to **Several instances**).

- **What is counted.** Each request is counted in a cell, in each tier of its key (refer to **When**). A cell has a type, a client, a method and a result, and holds the number of requests, the sum and the largest of their times, their rows and the bytes of their answers.
  - The type is `call` (a tool call: `tools/call` of a tool of the catalog), `request` (any other message that was read: `initialize`, `tools/list`, `ping`, a notification, a JSON-RPC error), `limited` (429 `rate_limited`) or `rejected` (refused before its message was read: 400, 413, 415).
  - The method of a `call` is its tool. The method of a `request` is its JSON-RPC method when it is one of the protocol: `initialize`, `ping`, `tools/list`, `tools/call` (one that failed before a tool), `response` (a response of the client), `notifications/initialized`, `notifications/cancelled`, `notifications/progress`, `notifications/roots/list_changed`, `resources/list`, `resources/read`, `resources/templates/list`, `resources/subscribe`, `resources/unsubscribe`, `prompts/list`, `prompts/get`, `completion/complete` and `logging/setLevel`. The name must match exactly, case included. Any other method is `other`, and a message that could not be read (not JSON, a batch, no `"jsonrpc": "2.0"`, a method that is not text) is `invalid`. A `limited` or `rejected` request has the method `unread`: its message was not read. ChDash never keeps a method that a client chose: a notification accepts any name, and the names would fill up for the whole retention.
  - The result is `ok`, the error code of a tool, `rpc_error_<n>` or the HTTP cause (`429_rate_limited`, `415_unsupported_media_type`, `400_unreadable`...), as `[a-z0-9_]`, at most 64 bytes.
  - The client is the name of the client that sent the request: the name that it gave in `initialize` (`clientInfo`, cut to 64 bytes), else the product of its `User-Agent` (the text before the first `/` or space: `python-httpx/0.27.0` is `python-httpx`, `curl/8.14.1` is `curl`), else `unknown`. The version is no part of the name, so an upgrade does not cut a series. A request that is not an `initialize` names no client: it counts for the client that was last seen with its `User-Agent` (refer to **The clients of a key**). A key uses at most 16 client names over its retention and ChDash keeps 4096 in all, because the name comes from the client: a name past them counts as `other` (refer to **The limits**).
  - The totals are summed from the cells. The requests are all of them. The calls are the cells of type `call`. The errors are the calls and the requests whose result is not `ok`; a refusal is not an error, `limited` and `rejected` have their own counts. The time (the sum and the largest) is the one of the tool calls: a request of the protocol has its time in its cell (the Usage page shows the latency of `initialize`), but no total counts it. The rows are those that the tools return (the tools that build their own SQL; an API tool counts 0), and the bytes are those of the answers.
  - The routes of one key give `tools`, the cells of type `call` by tool, and `statuses`, every cell but a successful request, by result (`ok` for a tool call, the error code of a tool, `429_rate_limited`, `rpc_error_32601`...).
  - A request without a key (401) or refused by its `Origin` (403) has no key to count for: the `mcp.call` line of the log is its only trace.
- **When.** Six tiers, one for the step of each window: by the minute for the last 60 minutes (`m1`), by 5 minutes for the last 6 hours (`m5`), by 15 minutes for the last 24 hours (`m15`), by 3 hours for the last 7 days (`h3`), by 12 hours for the last 30 days (`h12`) and by the UTC day for the last `mcp.usage.retention_days` days (`d1`). A request is counted in each tier that is kept. A tier is kept only when the retention reaches its window (`h3` from 7 days, `h12` from 30 days, the four others always), and nothing is kept past the retention. A window reads its own tier: nothing is summed to a larger step when an answer is made. The first and the last use of the key are kept.
- **The clients of a key.** The client names itself in `initialize` (`clientInfo`: `claude-code` 2.1.0). ChDash keeps the name, the version and the `User-Agent` of the request (printable ASCII, at most 128, 64 and 256 bytes), when it first and last saw the client, and how many requests it sent. The requests that follow (`tools/call` does not name the client) go to the client last seen with their `User-Agent`. At most 8 clients for each key: the one seen least recently goes. ChDash keeps no address. These records are the life of a client and are shown in the details of a key; the cells carry its name (above), and the Usage page takes the versions and the last sight of a client from these records.
- **A deleted key.** Its usage stays until its last day (the tier `d1`) is older than `mcp.usage.retention_days`: the page lists it under the keys. A call that was running when its key was deleted counts for the deleted key. At most 1000 deleted keys keep their usage in each instance: the oldest deletion goes first.
- **The file of an instance.** Each ChDash (an instance) counts what it sees and keeps it in a file of its own, `<dir>/<instance>.jsonl.zst`, which only it writes. The file is JSON Lines (one flat JSON object for each line, ended by a line break) compressed with zstd. Every line has its `type` and its `instance`, and the times are Unix seconds. There are four types of lines, in this order: the `header` (the first line), then for each key (by id) its `key` line, its `client` lines and its `cell` lines (by tier, then by start).

  | Line | Members, after `type` and `instance` |
  | --- | --- |
  | `header` | `format` (`chdash-mcp-usage`), `version` (1), `boot` (an id that ChDash draws at each start of the process), `since` (when this instance began to count: the first start with this file), `written_at`, `retention_days` |
  | `key` | `key` (the id), `name`, `host`, `source` (`config` or `ui`), `first_used`, `last_used`, `deleted_at` (0 when the key exists; 0 for a time that was never) |
  | `client` | `key`, `name`, `version`, `user_agent`, `first_seen`, `last_seen`, `requests`: the life of a client (refer to **The clients of a key**) |
  | `cell` | `key`, `tier` (`m1`, `m5`, `m15`, `h3`, `h12` or `d1`), `start` (the Unix time of the start of the bucket: a multiple of the step of its tier, 60, 300, 900, 10800, 43200 or 86400 seconds), `kind` (`call`, `request`, `limited` or `rejected`), `client`, `method`, `result`, `count`, `duration_ms_sum`, `duration_ms_max`, `rows`, `bytes` |

  ```
  {"type":"header","instance":"chdash-0","format":"chdash-mcp-usage","version":1,"boot":"6f0c0c1e-2a4b-4b9e-8d51-0c2f7a1d9e34","since":1790000000,"written_at":1790003600,"retention_days":90}
  {"type":"key","instance":"chdash-0","key":"ci-bot","name":"ci-bot","host":"prod","source":"config","first_used":1790000100,"last_used":1790003500,"deleted_at":0}
  {"type":"client","instance":"chdash-0","key":"ci-bot","name":"claude-code","version":"2.1.0","user_agent":"claude-code/2.1.0 (node)","first_seen":1790000100,"last_seen":1790003500,"requests":42}
  {"type":"cell","instance":"chdash-0","key":"ci-bot","tier":"d1","start":1789948800,"kind":"call","client":"claude-code","method":"query_table","result":"ok","count":40,"duration_ms_sum":1800,"duration_ms_max":210,"rows":1200,"bytes":96000}
  ```

  The `cell` line is the row of the table that a database mode will hold: it stays flat and stable. A cell takes about 150 to 200 bytes of JSON (the length of its names) before compression, which makes it 10 to 20 times smaller; the million cells that an instance keeps at most are 150 to 200 MB of JSON.
- **Writing.** ChDash writes its file every minute when a count changed (every 5 minutes when the JSON is larger than 8 MiB), and at the stop. The write is atomic: a temporary file `.<instance>.<random>.tmp` in `dir` (created with `O_EXCL`, mode 0600), the zstd stream, `fsync`, `rename` over `<instance>.jsonl.zst`, `fsync` of the directory. The rows are made in memory one entry at a time under the lock of the counts and are written once it is released, so a slow disk never delays a call. A write that fails is logged (`mcp.usage_save_failed`) and tried again a minute later; the counts stay in memory. A temporary file that a crash left is removed at the next start of this instance when it is older than an hour. A stop that takes longer than `server.shutdown_timeout_ms` loses the last minute. The file is never larger than 512 MiB of JSON (128 MiB compressed): a save past it fails like a write that fails.
- **Reading its own file.** ChDash reads the file of its instance at the start, and stops when it is not valid: a file that is not zstd, a line that is not a flat JSON object, a header that is not first (or that is not one: `format`, `version` 1, an `instance` that is the one of the file, a `boot`, a positive `since` and `written_at`, `retention_days` from 1 to 365), a line of another `instance`, a type that is not known, a client row or a cell row of a key that has no `key` line before it, a second `key` line for one id, a tier or a kind that is not known, a client that is not valid, a method that is not `[A-Za-z0-9_/]` (at most 64 bytes), a result that is not `[a-z0-9_]` (at most 64 bytes), a count that is not a whole number, a `start` that is not a multiple of the step of its tier, a bucket of a tier that is not after the one before it (the `cell` lines of one bucket share their `start`, and the `start` of a tier of a key never goes back). The message says the line and what is wrong, never its content. ChDash never rewrites an invalid file: delete it, the usage starts again. A cell that repeats another adds to it, a cell without a request is ignored, the cells past the cap of a bucket go to the overflow cell, and a client name past the 16 of its key becomes `other` (the cells that this makes equal are one cell): no request is lost. A tier that the retention no longer reaches (it was lowered) is emptied at the start, and so are the days that are older than it.
- **Several instances.** Several ChDash can share `dir`. Each one writes its own file and reads the files of the others, so `GET /api/mcp/usage`, `GET /api/mcp/keys/<id>/usage`, `GET /api/mcp/usage/overview` and `last_used_at` of the keys show the sum of all the instances. Give each instance its own name (`instance`), the same `retention_days`, and run them as the same user (the files are mode 0600). The rate limit stays per instance. A key made on the page is kept by one ChDash (its key file): another instance does not know it, and shows its usage as a key that was seen on another instance (below).
  - **What is read.** In the background, never in a request, at most once a minute (the same loop that writes the file), ChDash lists `dir` and keeps the regular files named `<instance>.jsonl.zst` (a valid name of an instance) other than its own. It opens each one with `O_NOFOLLOW`: a link or a file that is not regular is never read, and is not listed. A file is read again only when its time or its size changed. Each file is parsed whole into a state that never changes after, and the new states replace the old ones in one step: a request never waits for a read.
  - **The bounds.** A file of another instance is read only up to 128 MiB compressed, 512 MiB once decompressed (the decompression stops there, so a zstd bomb never grows), 64 KiB for a line, 10,000 keys and 2,000,000 cells, and ChDash reads at most 256 files. It reads them with the rules of the file of its own instance. A file that is past a bound or is not valid (also: another `format` or `version`, a header whose `instance` is not the name of the file) is **skipped**: nothing of it is read, one line `mcp.usage_file_skipped` is written to the log for each change of the file, and it is listed with its reason in the answers (`instances`, status `skipped`). It does not stop anything: only the file of this instance does, at the start.
  - **Merging.** An answer sums this instance and the others by cell: the counts, the sums of times, rows and bytes add up and the largest time is the largest of them. The records of the clients merge by name, version and `User-Agent` (their requests add up, the first and the last sight are the earliest and the latest; at most 8 for each key, the last seen first). For a key, `first_used_at` is the earliest and `last_used_at` the latest of the instances. A key that this instance has (its configuration or its key file) is live. A key that only other files have keeps the name that they recorded: it is shown as deleted (`deleted_at`: the latest deletion that a file says) when a file says so, and else as **seen on another instance** (`elsewhere`: true, `deleted_at`: null, with its last use as the files say). The names of the methods, the results and the clients are matched by their text across the files: the union of the names of the instances can pass the 4096 that one instance has.
  - **The instance is a dimension.** Every cell keeps the instance that it comes from. The overview takes the filter `instance` and the group `instance`, and has a facet `instances` (refer to [The page API](#the-page-api)).
  - **A conflict.** Before it writes, ChDash reads the header of its own file. When the `boot` is not the one of this process and `written_at` is less than 2 minutes old, another live process writes the same name: ChDash logs `mcp.usage_instance_conflict` (once for each change of the other process), does not write (the counts stay in memory, and the file of the other process is not touched) and reports it: the status of this instance is `conflict` in the answers. It writes again, and the status is `ok`, when the other process has not written for 2 minutes. A file that is as this process read it or wrote it (the start after a stop) is nobody's: that is no conflict.
  - **A gone instance.** Any instance removes the file of another instance whose header `written_at` and whose own modification time are both older than `retention_days` and a day (`mcp.usage_file_removed`): the instance is gone. A file that was not read as a usage file (a link, a file that is not valid, any other name) is never removed.
- **Analytics.** The files can be read as they are, without ChDash. A `cell` line is a row: the rows of a tier are the same requests as the rows of another tier at another step, so **read one tier** (`tier = 'd1'` for days, `m15` for 15 minutes) and never add tiers together. With `clickhouse local`:

  ```bash
  clickhouse local -q "
  SELECT instance, key, method, sum(count) AS requests, sum(duration_ms_sum) / sum(count) AS avg_ms
  FROM file('/var/lib/chdash/usage/*.jsonl.zst', JSONEachRow,
            'type String, instance String, key String, tier String, start UInt32, kind String, client String, method String, result String,
             count UInt64, duration_ms_sum UInt64, duration_ms_max UInt64, rows UInt64, bytes UInt64')
  WHERE type = 'cell' AND tier = 'd1' AND kind = 'call'
  GROUP BY instance, key, method ORDER BY requests DESC"
  ```

  With DuckDB (the files are heterogeneous: `union_by_name` makes one table with the columns of the four types):

  ```sql
  SELECT key, method, sum(count) AS requests
  FROM read_json('/var/lib/chdash/usage/*.jsonl.zst', format = 'newline_delimited', union_by_name = true)
  WHERE type = 'cell' AND tier = 'd1' AND kind = 'call'
  GROUP BY ALL ORDER BY requests DESC;
  ```

  The `key` and `client` lines (`type = 'key'` and `'client'`) give the name and the host of a key and the versions of a client. Read the files while ChDash runs: the rename keeps each file whole, but the totals of two files are as of two different minutes.
- **Security.** The files hold counts, the names of the keys (their ids and names), of the hosts, of the tools, of the clients and their versions and `User-Agent` text, in clear: protect the directory like the key file. They never hold SQL, data, a secret or an address. They are mode 0600 (the instances run as the same user; another user does not read them), the directory is where they are, and a directory that anyone can write in without the sticky bit is a warning in the log: anyone who can write there can plant a file for the others to read or remove a file. ChDash never follows a link, reads only regular files with a valid name, bounds what it reads, and checks every line. A file that was forged (by someone who can write in the directory) can only change the numbers that the answers show: it can never give access, and a file that is not valid is skipped. The page shows the numbers as they are: the usage is for the operator, not a proof.
- **The limits.** At most 512 cells for each bucket of a key, and a million cells for all the buckets of all the keys (a request makes a cell in each tier that is kept: up to six). A request that has no cell past these is counted in the overflow cell of its type: the client `other`, the method `other`, and the result `ok` (`other` when the request did not end ok). ChDash makes an overflow cell whatever the caps (at most 6 for a bucket, not among the 512), so no total changes: only the filters of the Usage page by method, client and result do not see the detail of what overflowed. A key uses at most 16 client names over its retention (`other` and `unknown` are not among them) and the table of names holds 4096 clients for all the keys; a name that does not fit counts as `other`. The table is made again at each start from the cells of the file, so the names that no cell uses any more are forgotten then. These caps are those of one instance; the answers match the names of the instances by their text and have no cap of names of their own.
- **Windows.** The answers sum a window, read from the tier of its step. Its last point is the one that holds the time of the answer, and its steps are aligned on UTC. `GET /api/mcp/meta` lists the windows that the retention offers (`usage.windows`) with the default one (`7d`, or `24h` when the retention is under 7 days).

  | Window | Step | Points | Tier | Offered when `retention_days` is |
  |---|---|---|---|---|
  | `1h` | 1 minute | 60 | `m1` | any |
  | `6h` | 5 minutes | 72 | `m5` | any |
  | `24h` | 15 minutes | 96 | `m15` | any |
  | `7d` | 3 hours | 56 | `h3` | 7 or more |
  | `30d` | 12 hours | 60 | `h12` | 30 or more |
  | `90d` | 1 day | 90 | `d1` | 90 or more |
  | `365d` | 1 day | 365 | `d1` | 365 |

## The ClickHouse cost of a key

The usage says what ChDash saw of a key. What its statements cost ClickHouse (rows and bytes read, CPU, memory, time, the tables) is in `system.query_log` of the host of the key, and the page reads it there when asked (**ClickHouse cost**, in the details of a key).

- **How a statement is found.** Every statement that ChDash sends for a call of a key is named `chdash-mcp/<key id>/<tool>/<uuid>` (its `query_id`): the statements of the tools that build their SQL, of the simple tools of Observability (run as the system user), and of the routes that an API tool calls (the System routes too, whose `log_comment` is `chdash-system`). The `query_id` is not a setting: a profile at `readonly = 1` gets it, and no `SETTINGS` clause changes it. A statement that a background refresh of a cache sends is not named (it serves every key), nor the probe of the settings profile of a connection; an answer that a cache already had costs nothing.
- **How it is read.** `GET /api/mcp/keys/<id>/cost` reads `system.query_log` of the host of the key with the **runner account** of the host and the bounds of System > Queries (`readonly = 2`, `system.query_log_max_rows` rows to read at most, 15 seconds, `log_comment = 'chdash-system'`): one scan of the window (`startsWith(query_id, ...)`, the prefix of the key is a bound parameter), the finished and failed first statements of each query (`is_initial_query`), grouped by the ClickHouse user and the tool. The answer is kept 60 s for each host, key and window (`refresh=1` reads again), and a read takes a place of heavy work for the host (`admission.heavy_per_host`). The MCP user never reads `query_log`. It needs `SELECT` on `system.query_log` for the runner (`GRANT SELECT ON system.query_log TO <runner>`, as System > Queries), and `system.top_queries` on: when it is off, the route answers 404 `not_enabled` and the meta lists no window.
- **Windows.** `1h`, `6h`, `24h` and `7d`, to the end of the current minute, cut to `system.query_log_max_lookback_hours` (`clamped`). `query_id` is not in the sorting key of `query_log`: a read scans every row of its window, and on a busy server a window of 7 days can pass `system.query_log_max_rows`: the answer then says `window_too_large` and suggests `24h`.
- **What it says.** The totals (statements, failed ones, the ones that ChDash stopped once it had what a call asked for: `canceled`, rows and bytes read, rows and bytes of the results, time, CPU, the peak of memory), the same by ClickHouse user (`role`: `mcp` for the MCP user of the host, `system` for its system user, `other` for anyone else) and by tool, and the 10 tables that the statements read the most.
- **What it does not say.** The statements made before ChDash named them (an older version); the last seconds (ClickHouse writes `query_log` every 7.5 seconds by default; ChDash never runs `SYSTEM FLUSH LOGS`); what `query_log` no longer keeps (its TTL); a key of the configuration deleted and made again with the same name shares its history (its id is its name). The read is the one of the server that the runner URI of the host reaches: behind a load balancer of a cluster, the statements of the key may be logged on another server.

## The page API

These routes serve the page. Each answer has `Cache-Control: no-store`. When MCP is off, `/api/mcp/meta` answers `{"enabled": false}` and every other route answers 404 `mcp_disabled`.

| Route | Use |
| --- | --- |
| `GET /api/mcp/meta` | State, endpoint, hosts, tool families, tools and limits. `tool_groups` is `[{"id", "title", "note", "sections"}]`; `tools` is the catalog, `[{"name", "group", "section", "description", "needs_all_data", "always", "explicit_only", "available"}]`: `always` is true for a tool that every key has (`mcp_analysis_my_limits`, `mcp_analysis_my_usage`), `explicit_only` for one that `["*"]` does not give (`mcp_analysis_all_usage`), and `available` says whether the configuration offers it now (the usage is on, and `mcp.usage.all_keys` for the last one): refer to [The analysis tools](#the-analysis-tools). Each host has `mcp`: `{"user", "state": "ok" \| "unavailable" \| "unknown", "error", "reads_nothing", "unavailable_tools": [{"tool", "grants": ["SELECT ON ..."], "statement"}]}`. `state` is `ok` when the MCP user connected at the last audit, `unavailable` when it did not (then no key can read the host), `unknown` when the host was not audited. `mcp.profile` is the settings profile of the MCP user (`{"known", "readonly", "max_execution_time", "max_result_rows"}`, 0 = the profile sets none) and `mcp.limits` the largest limit of a key of the host: `{"max_rows": {"value", "source"}, "timeout_seconds": {"value", "source"}}`, `source` being `mcp`, `clickhouse` or `both`. `usage` is `{"enabled", "storage", "instance", "retention_days", "windows", "default_window", "since", "cost_windows", "all_keys"}` when the usage is on (`windows` are the windows of the usage that the retention offers, `since` the earliest start of counting of the instances that are read, `cost_windows` those of the ClickHouse cost of a key), and `{"enabled": false, "cost_windows": [...]}` when it is off. |
| `GET /api/mcp/keys` | `{"keys": [...]}`. The keys of the configuration come first. A key never has its secret: ChDash keeps its hash only. It has `secret_hint` and `secret_mask`. |
| `GET /api/mcp/keys/<id>/access` | The data that the key reaches. For the host of the key (the entries are a list for the keys of older files that name several): `{"host", "label", "user", "status": "ok" \| "unavailable", "error", "readable_by_user", "excluded_by_key", "acl_truncated", "databases": [{"name", "table_count", "truncated", "tables": [{"name", "columns": "all" \| "some"}]}]}`. The tables are those that the **MCP ClickHouse user** may read (`CHECK GRANT` and zero-row probes, never `SHOW GRANTS`; `"some"` when the user reads some columns only: the columns are checked when a tool opens the table), kept only when a `databases` pattern of the key matches. `readable_by_user` counts what the user reads, `excluded_by_key` what the patterns leave out. `acl_truncated` says that a bound of the discovery stopped it (docs/configuration.md, "Caches and privileges"). The answer is the ACL of the MCP identity, kept for `explorer.acl_cache_ttl_ms` (60 s by default) and shared with the routes that run as that identity (`?refresh=1` asks the grants again). The hosts are read at the same time. At most 300 tables for each database and 3000 in all (`truncated`). `status = "unavailable"` with the `error` when the MCP user cannot connect. 404 `not_found` for an unknown key. A read of the page only (same guard as the write routes). It never carries a secret. |
| `GET /api/mcp/access` | How many databases and tables each key reaches, for the table of the page: `{"keys": [{"id", "status": "ok" \| "unavailable" \| "no_host", "host", "user", "databases", "tables", "partial_tables", "truncated", "all_data", "error"}]}`. The same data as `/api/mcp/keys/<id>/access` (the tables that the MCP user of the host of the key may read, cut by the patterns of the key), counted. The grants of a host are read once and kept for `explorer.acl_cache_ttl_ms` for all its keys (`?refresh=1` asks them again). A failure is not kept. A read of the page only (same guard as the write routes). It never carries a secret. |
| `GET /api/mcp/usage?window=7d` | What each key did in a window (default: `usage.default_window` of the meta), for the column of the page, with every instance summed: `{"window", "from", "to", "since", "retention_days", "instances": [{"instance", "written_at", "status": "ok" \| "skipped" \| "conflict", "reason"}], "keys": [{"id", "name", "host", "source", "deleted_at", "elsewhere", "requests", "calls", "errors", "rate_limited", "rejected", "first_used_at", "last_used_at"}]}`. The keys first, in the order of `GET /api/mcp/keys` (a key that was not used has zeros), then the keys that are not live here and that still have usage: the deleted ones, the last deletion first (`deleted_at` set), then the ones that only another instance knows (`elsewhere`: true, `deleted_at`: null), the last used first. `from` is the start of the window and `to` the time of the answer; `since` is when the counting starts, the earliest of the instances that are read (refer to [Usage of a key](#usage-of-a-key)). `instances` lists this instance first, then the others by name: `written_at` is when its file was last written (null if it was not), `status` is `ok`, `skipped` (its file is not valid or past a bound: it is not read, and `reason` says why) or `conflict` (this instance cannot write its file because another process writes the same name: `reason` says so). A window that the retention does not keep is 400 `validation` (field `window`, reason `invalid`). A read of the page only (same guard as the write routes). When the usage is off (`mcp.usage.enabled`), 404 `not_enabled` (the message names the setting), before the window is read. |
| `GET /api/mcp/keys/<id>/usage?window=7d` | What one key did in a window, with every instance summed: `{"id", "name", "host", "source", "deleted_at", "elsewhere", "window", "from", "to", "since", "retention_days", "instances": [...], "first_used_at", "last_used_at", "totals": {"requests", "calls", "errors", "rate_limited", "rejected", "duration_ms_avg", "duration_ms_max", "rows", "bytes"}, "series": {"step": 900, "points": [{"t", "requests", "calls", "errors"}]}, "tools": [{"tool", "calls", "errors", "duration_ms_avg", "duration_ms_max", "rows", "bytes"}], "statuses": [{"status", "count"}], "clients": [{"name", "version", "user_agent", "first_seen_at", "last_seen_at", "requests"}]}`. `instances` is the one of `GET /api/mcp/usage`. `series` has one point for each step of the window (0 when nothing happened); `step` is a number of seconds (60, 300, 900, 10800, 43200 or 86400: the step of the window); the durations are those of the tool calls (`null` without one), and the largest is the largest of the instances; `tools` (the tool calls, by tool) and `statuses` (the results of the tool calls and of every request that did not end ok) come the most frequent first; `clients` merges the records of the instances (by name, version and `User-Agent`), the last seen first, at most 8. A key that only another instance knows answers with the name that its file recorded and `elsewhere`: true (or `deleted_at` when a file says it was deleted). A deleted key answers while its usage is kept; 404 `not_found` for a key that exists nowhere. A read of the page only. When the usage is off, 404 `not_enabled`. |
| `GET /api/mcp/usage/overview?window=7d&group=method&key=<id>&method=<name>&client=<name>&instance=<name>&result=<code>&type=call` | The requests of all the keys of all the instances in a window, cut by key, method, client, instance, result and type, for the Usage page. Parameters: `window` (as `/api/mcp/usage`), `group` (what the series is grouped by: `key`, `method`, `client`, `result`, `type` or `instance`; `method` by default) and the filters `key`, `method`, `client`, `instance`, `result` and `type`, which can repeat, at most 20 values each. The values of a filter are OR, the filters are AND. A `key` is the id of a key (the name of a key of the configuration, or `ui_` and 12 hexadecimal digits), a `method` a tool or a method of the protocol (`[A-Za-z0-9_/]`, at most 64 bytes, as `list_hosts`, `logging/setLevel`, `unread`), a `client` a client name (printable ASCII, 1 to 64 bytes, no space at either end: `claude-code`, `python-httpx`, `Visual Studio Code`, and `other` and `unknown`), an `instance` the name of an instance (`[A-Za-z0-9._-]`, 1 to 64 bytes), a `result` a code (`[a-z0-9_]`, at most 64 bytes) and a `type` is `call`, `request`, `limited` or `rejected`. Answer: `{"window", "from", "to", "since", "retention_days", "instances": [{"instance", "status", "reason", "written_at", "requests", "calls", "errors", "rate_limited", "rejected", "duration_ms_avg", "duration_ms_max", "rows", "bytes", "keys"}], "group", "filters": {"key": [], "method": [], "client": [], "instance": [], "result": [], "type": []}, "totals": {"requests", "calls", "errors", "rate_limited", "rejected", "duration_ms_avg", "duration_ms_max", "rows", "bytes", "active_keys", "keys"}, "series": {"step", "t": [], "groups": [{"id", "label", "total", "requests": [], "errors": [], "calls": [], "duration_ms_sum": [], "bytes": []}], "rest": {"groups", "total", "requests": [], "errors": [], "calls": [], "duration_ms_sum": [], "bytes": []}}, "keys": [{"id", "name", "host", "source", "deleted_at", "elsewhere", "requests", "calls", "errors", "rate_limited", "rejected", "duration_ms_avg", "duration_ms_max", "rows", "bytes", "last_used_at"}], "methods": [{"method", "kind": "call" \| "request" \| "refused", "requests", "errors", "duration_ms_avg", "duration_ms_max", "rows", "bytes", "keys"}], "results": [{"result", "count", "keys"}], "types": [{"type", "requests"}], "clients": [{"client", "requests", "calls", "errors", "rate_limited", "rejected", "duration_ms_avg", "duration_ms_max", "rows", "bytes", "keys", "versions": [], "last_seen_at"}], "omitted": {"keys", "methods", "results", "clients", "instances"}}`. The figures are JSON numbers and the times ISO 8601 UTC. `totals` and `series` apply all the filters, so the bars add up to the tiles: `active_keys` counts the keys (deleted ones too, and the ones that only another instance knows) that have a request that the filters keep, `keys` the keys that exist (the keys of this instance, and the ones that only another instance knows and that nobody deleted: the count is the same whichever instance answers, and no filter changes it), and the durations are those of the tool calls (`null` without one). `series` has one point for each step of the window (`t`; `step` is a number of seconds: 60, 300, 900, 10800, 43200 or 86400): the 8 largest groups of the dimension of `group` by requests (the same total: the smaller id first), and `rest` for the others (`groups` is how many). A group is `id` and `label`: the id of a key and its name, a method, a client name, a result, a type, or an instance (the id and the label are its name). Each group, and `rest`, has the five metrics of a point, counted as the tiles are: `requests` (every request), `errors`, `calls` and `duration_ms_sum` (the tool calls only: a protocol request has no call and no time there) and `bytes` (every request); `total` is the sum of its `requests`. When the dimension of `group` is filtered, the groups are the values that were chosen, in their order (0 when nothing matches), and `rest` is 0. At each point, for each metric, the groups and `rest` add up to the point of the tiles, and the points add up to `totals` (`duration_ms_avg` is the sum of `duration_ms_sum` over the sum of `calls`, rounded). Each facet (`keys`, `methods`, `results`, `types`, `clients`, `instances`) applies all the filters but its own, so the other values of its dimension stay listed and can be added. A row is there when it has requests, and for each value that was chosen (0 when nothing matches: a key whose usage is gone is known by its id). `keys` has the keys that exist, the deleted ones (`deleted_at`) and the ones that only another instance knows (`elsewhere`: true), the most requests first. `methods` has a row for each type and method: `kind` is `call` for a tool, `request` for a method of the protocol (`other` and `invalid` too) and `refused` for `unread`; its time is the one of all its requests (the latency of `initialize`), and `keys` is how many keys have a request in it (a key that two instances have counts once). `results` covers all the requests, the successful ones of the protocol too, so its counts add up to `totals.requests` without a filter. `types` always has the four rows, in the order `call`, `request`, `limited`, `rejected`. `clients` has a row for each client name that has requests in the window, the most requests first (then by name), with the counters of a key (as `keys`); `keys` is how many keys have a request of the client, `versions` the versions (up to 5, the one seen last first) and `last_seen_at` the last sight of the clients of that name that the keys kept by the filter of the keys saw, in the instances that the filter keeps (refer to **The clients of a key**; `[]` and `null` when there is none: a client that is known by its `User-Agent` alone has no version). `instances` has a row for every instance that is known, this one first and the others by name (also an instance whose file was skipped, with its `status`, its `reason` and zeros, and an instance that was chosen and is not there: `status` is `unknown`), with the counters of the requests that the filters but its own keep and `keys`, the keys that have a request in it; `written_at` is when its file was last written (null if it was not). At most 200 rows for each of `keys`, `methods`, `results`, `clients` and `instances`: the values that were chosen are always kept, and `omitted` counts the rows that were left out. A window that the retention does not keep is 400 `validation` (field `window`, reason `invalid`). A `group` or a value that is not valid is 400 `validation` with the parameter as `field` (`group`, `key`, `method`, `client`, `instance`, `result` or `type`) and the reason `invalid`, or `too_many` past 20 values. A parameter that the route does not read is 400 `validation` with its name as `field` and the reason `unknown` (`split`, the name that `group` replaced, is one). A key, a method, a client, an instance or a result that was never counted is a valid filter: it keeps nothing. A read of the page only; it works when the keys are read-only (`manage_from_ui = false`). When the usage is off, 404 `not_enabled`. |
| `GET /api/mcp/keys/<id>/cost?window=24h` | What the statements of a key cost ClickHouse in a window (`24h` by default, or `1h`, `6h` or `7d`), read from `system.query_log` of the host of the key (refer to [The ClickHouse cost of a key](#the-clickhouse-cost-of-a-key)): `{"id", "host", "window", "from", "to", "max_lookback_hours", "clamped", "read_at", "status": "ok" \| "unavailable", "reason", "error", "statement", "suggested_window", "totals": {"statements", "failed", "canceled", "read_rows", "read_bytes", "result_rows", "result_bytes", "duration_ms", "cpu_ms", "memory_peak_bytes"}, "identities": [{"user", "role", "statements", "failed", "canceled", "read_rows", "read_bytes", "duration_ms", "cpu_ms", "memory_peak_bytes"}], "tools": [{"tool", ...the same figures}], "tables": [{"name", "statements"}], "tables_truncated", "rows_truncated"}`. The figures are JSON numbers. `status = "unavailable"` with a `reason`: `not_granted` (with the `statement` that gives the grant to the runner), `disabled` (no `query_log`), `window_too_large` (with the `suggested_window`), `readonly_account`, `runner_unavailable`, `no_host` (the host of a deleted key is gone) or `failed`; the figures are then 0. A deleted key answers while its usage is kept. 400 `validation` (field `window`) for another window, 404 `not_found` for a key that exists nowhere, 404 `not_enabled` when `system.top_queries` is off. A read of the page only. |
| `POST /api/mcp/keys` | Makes a key. Answer 201: `{"key": {...}, "secret": "<uuid>"}`. This is the only answer that carries the secret. The body has `name`, `hosts`, `tools`, `databases` and optional `max_rows` and `timeout_seconds`. A member that is not one of these answers 400 `validation` with `reason` `unknown_field` (for example `expires_at`). |
| `DELETE /api/mcp/keys/<id>` | Answer: `{"ok": true, "id": "<id>"}`. |

A key in the answers:

```json
{"id": "ui_0a1b2c3d4e5f", "name": "ci-bot", "source": "ui",
 "secret_hint": "3f2a9c1e", "secret_mask": "3f2a9c1e-••••-••••-••••-••••••••••••", "hosts": ["prod"],
 "tools": ["list_databases", "query_table"], "databases": ["otel", "analytics.events"],
 "max_rows": null, "timeout_seconds": null,
 "created_at": "2026-10-08T10:00:00Z", "last_used_at": null}
```

`source` is `config` or `ui`. A key of the configuration has `id` equal to its `name`. `secret_hint` is the first 8 characters of the secret. `secret_mask` is what the page shows: the shape of a UUID, the hint in clear and a bullet (U+2022) for every other character (all bullets when the hint is empty). It says nothing but the shape of the secret.

The write routes pass the guard of every write of ChDash ([operations.md](operations.md#the-guard-of-the-writes)), before the routing:

- `Sec-Fetch-Site` must be absent, `same-origin` or `none`. If it is absent, an `Origin` header must name this server (`Host` or `X-Forwarded-Host`).
- The body must be `application/json`.

The reads that show a secret or what a key reaches have the first rule too. `POST /mcp` is not a route of the page: it has its own rules (`allowed_origins`, the key).

| Status | `error_code` | Case |
| --- | --- | --- |
| 400 | `validation` | With `field` and `reason`: `required`, `type`, `invalid`, `too_long`, `unknown_host`, `too_many` (more than one host), `mcp_user_unavailable`, `unknown_tool`, `needs_all_data`, `not_grantable`, `duplicate`, `range`, `unknown_field` or `invalid_json`. |
| 403 | `manage_disabled` | `manage_from_ui = false`. |
| 403 | `cross_site_request` | The guard refused the request. |
| 404 | `mcp_disabled` | MCP is off. |
| 404 | `not_found` | No key has this id. |
| 404 | `not_enabled` | The usage of the keys is off (`mcp.usage.enabled`), for the routes of the usage; or `system.top_queries` is off, for the cost of a key. |
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
- The API tools run with the MCP ClickHouse user as the runner, and with the system user of the host for what the pages read with it. The System tools show the state of the whole server, query texts included, and the tools of Traces, Logs and Metrics read the `otel` tables with the system user: neither the grants of the MCP user nor the patterns of the key limit them, only the permission does. Give System, Traces, Logs and Metrics only to keys that may see the whole server and all its telemetry. Only the SQL tools go to keys with `databases = ["*"]`.
- The MCP page cannot show a secret again: ChDash does not keep it. Anyone who can open the page (ChDash has no login) can still make and delete keys. Restrict the page with the reverse proxy or the network.
- ChDash checks the SQL of `run_query` with a splitter. The splitter is a guard rail. It is not a parser of ClickHouse. `readonly` and the grants are the boundary. With a profile at `readonly = 2`, the splitter's refusal of `SETTINGS` keeps the limits of the key: give that profile `CONST` constraints on the limits that matter to you if you want ClickHouse to hold them too.
- The scope of a key is a list of table names. Free SQL can read any table that the ClickHouse user can read. This is why only keys with `databases = ["*"]` get free SQL. Give such keys only to people that you trust with all the data of the MCP user.
- `mcp_analysis_all_usage` shows the names, ids and hosts of all the keys, their clients (name, version, `User-Agent`), their activity and the names of the instances. It has two locks, `mcp.usage.all_keys` and the name of the tool in the `tools` of the key (`["*"]` does not include it), and what it returns goes to the model of the client, so to its provider: turn the setting on, and give the tool, only to keys whose model may see this. Nothing in it is a secret, SQL, data or an address. The ClickHouse cost of a key lists the tables that its statements read, which can be outside what another key reads: no tool shows the cost of another key (`mcp_analysis_my_usage` has the cost of the calling key only).
- `log_comment` and the `query_id` in `system.query_log` show the key id (and the tool). They never show the secret. Any user of ClickHouse can give its own statements a `query_id` that looks like one of a key: the cost of a key counts them, and names the user that ran them (`identities`, role `other`).
- Use HTTPS. The key goes in a header of each request.

## Tests

- `tests/native/mcp_test.cpp` (CMake option `CHDASH_BUILD_MCP_TESTS`, target `chdash_mcp_test`): scopes, keys and the file, the usage of the keys (its tiers, its clients, its files, and the instances that share a directory: merging, skipped files, conflicts, gone instances), the rate limit (and its `peek`), the SQL splitter and builder, the protocol with a fake backend (the tools of the analysis: who has them, what is offered), the tools with a fake database and a fake analysis, and the eight startup errors with the real configuration loader.
- `tests/harness/test_native_unit_tests.py` runs the native binary when `MCP_TEST_BINARY` names it. The structural rules that concern MCP (it is unreachable from the other routes and never uses the runner identity) are in `tests/harness/test_backend_code_rules.py`.
- `tests/backend-functional/test_mcp.py`: the endpoint, the scopes, `readonly`, the caps, the keys, the usage (its file, and the files of other instances that are put in the directory), the analysis tools (on the instances with the usage on and `all_keys` on, with the usage on and `all_keys` off, with the usage off, and on the hosts with a settings profile), and the startup errors with the real binary, against a real ClickHouse. `tests/README.md` has the instances and the variables.

## Decisions

The first specification of this feature had gaps. This list records what ChDash does where the specification did not say.

- **Origin.** An empty `allowed_origins` refuses every request that has an `Origin` header. It accepts a request without one. The origin of ChDash itself has no special right: a DNS rebinding attack makes the `Origin` equal to the `Host`. An origin is `scheme://host[:port]` with no path and no `*`.
- **Secrets.** A secret is a UUID version 4, for `secret`, for the content of `secret_file` and for the keys of the page. ChDash keeps the hash of a secret, never the secret, and shows a page secret once.
- **Names.** At most 32 characters. The prefix `ui_` is reserved for key ids, and ChDash refuses it in names of both sources.
- **Lower caps.** A key `max_rows` or `timeout_seconds` above the global cap is an error: a startup error for a config key, a 400 `range` for a page key. A stored key above a lowered cap is cut to the cap at run time.
- **SQL tools.** A key that names `run_query` or `explain_query` without all data is an error. A key with `tools = ["*"]` and a limited scope gets every tool but the SQL tools and `mcp_analysis_all_usage`; a simple tool of Observability whose `otel` tables the data does not allow answers `table_not_allowed`. A key with `tools = ["*"]` and `databases = ["*"]` gets every tool but `mcp_analysis_all_usage`, which a key must name. At run time, ChDash checks the rule again for each call, also for keys of an old file.
- **All data** is exactly the entry `*`. `*.*` is a normal pattern.
- **Required.** A key needs a name, a secret and a host (`hosts` has one name; an empty list or a missing attribute is `required`, a startup error for a key of the configuration). `tools` and `databases` can be empty: a key with an empty list can do nothing but read its own limits and its own usage (the tools that every key has).
- **Hosts.** A key reads one host: `hosts = ["prod"]`. `["*"]` is `invalid` and two names are `too_many`. A page key cannot name a host without `mcp_uri` (`unknown_host`). A key of an old file can name a host that is now gone, or several: it keeps working, and the page marks it.
- **Time.** `created_at` and `last_used_at` are in UTC, with a one-second precision.
- **Page keys.** At most 1000 keys in the file.
- **Order of checks of `POST /mcp`.** Origin, key, rate limit, content type, protocol header, body size. An early refusal closes the connection.
- **Body size.** 2 times `max_sql_bytes` plus 16 KiB, because JSON escapes can double the SQL.
- **`structuredContent`.** The specification of 2025-06-18 says that a tool which returns structured content should also return the serialized JSON in a text content block, for the clients that do not read `structuredContent`. Most clients of MCP show the model the text content and ignore `structuredContent`. For this reason, ChDash does not replace the text with a summary. The text is the JSON of the tool, always. `structuredContent` is the same JSON again, and ChDash sends it only when the client can read it: for a request with `MCP-Protocol-Version: 2025-06-18` (or later), and for a request without this header. A request with an older version (`2025-03-26`, `2024-11-05`) gets the text only, so its response is half the size. The endpoint has no session, so the header of each request is the protocol version. The tools declare no `outputSchema`, so no client needs `structuredContent` to validate a result. The response is written once into one buffer and moved to the answer: the copies of the result in memory are the JSON of the tool and the body of the response. The cap of the size of a result is `mcp.max_result_bytes` (1 MiB by default), and an administrator who wants a smaller body lowers it.
- **Not allowed or unknown tool.** A tool that exists but that the key cannot use is a tool error `tool_not_allowed`. A name that does not exist is the JSON-RPC error -32602.
- **Truncation.** `truncated` is true only when a cap cut the result. A `limit` that you chose below the cap is not a cap. `query_table` asks for one row more than the cap to know. For `run_query`, ClickHouse breaks at `max_rows` + 1 rows. A result that exactly fits is not truncated.
- **Bytes.** ChDash counts the JSON text of the cells. It also estimates the size that ClickHouse counts (a number has its width in bytes), because `max_result_bytes` with `break` cuts there. If either reaches the cap, `truncated` is true.
- **Omitted columns.** A column of the table that the ClickHouse user cannot see is not in `system.columns`, so it is not in the result and not in `omitted_columns`. `omitted_columns` lists the wide columns (more than 2048 bytes on average) and the `AggregateFunction` columns. ChDash reads the size of a column from `system.columns`. ClickHouse reports it only for wide parts. A small table with compact parts reports 0, so ChDash does not omit its columns.
- **Schema tools.** They read at most 20,000 rows of a system table and return at most 2000 tables. The row cap of the key does not apply.
- **Health.** `healthy` is the health that ChDash measures for the host with its normal check. It does not test the MCP user.
- **`FORMAT`.** ChDash uses the native protocol. The result is always JSON, so a `FORMAT` clause has no effect and is accepted.
- **Denied functions.** `file`, `url`, `remote`, `s3`, `hdfs`, `mysql`, `postgresql`, `mongodb`, `redis`, `jdbc`, `odbc`, `sqlite`, `executable`, `input`, the Azure, Iceberg, Delta Lake and Hudi readers, and their `Cluster` forms.
- **Settings order.** The settings of a query go together in one packet. ClickHouse checks each of them against the profile of the user, then applies them. `readonly=1` does not block the limits that come with it. A profile that has `readonly` at 1 or 2 changes what is sent: see [The settings profile of the user](#the-settings-profile-of-the-user). A `SETTINGS` clause in the SQL would win over all of them, and a profile at `readonly = 2` lets it through: the SQL tools refuse it before ClickHouse sees it (`clause_not_allowed`), so the SQL cannot change a limit. With `readonly = 1` (sent by ChDash, or in the profile) ClickHouse would refuse it too.
- **Connections.** MCP queries use the shared connection pool with the `mcp_uri` of the host. The pool key includes the URI, so MCP connections never mix with runner or system connections. The receive timeout is `query_timeout_seconds` plus 15 seconds.
- **API errors.** The page API and the guard of the writes use the one error body of ChDash: `{"error_code", "message", "retryable"}` (and `field` and `reason` for validation). The check of `manage_from_ui` comes after the cross-site guard and before the validation.
- **The usage is off by default.** Counting costs memory and a file, and the files can hold the names of keys and clients: the operator turns it on (`mcp.usage.enabled`). Off, there is no usage object: nothing is counted.
- **The analysis tools.** A key reads its own limits and usage with two tools that it needs no word to have (`always`); the usage of all the keys is a third tool that it must name (`explicit_only`: `*` never gives it) and that the configuration must allow (`mcp.usage.all_keys`): a double lock, because the answer shows the other keys. A tool that the configuration does not offer is not listed and not run (`available`): `not_enabled` for a key that has it, `tool_not_allowed` for a key that does not, so the existence of a tool is not told to a key that cannot use it. A key may name any of the three whatever the configuration says, so a configuration does not stop when the usage is turned off. They take no `host` (a key has one), their answers are bounded (a row limit, no series unless asked, `max_result_bytes`), and they are counted and rate limited like any call. The answer of `mcp_analysis_my_usage` does not hold the call that asks, and the rate limit that `mcp_analysis_my_limits` says is after its token.
- **The cost for the key itself, outside of its scope.** `include_cost` reads the page's cost of the calling key: the same read, the same 60 s cache. The read runs on the thread of `POST /mcp`, whose scope names no statement for a key (the API tools run in their own scope, which does), so the read of `system.query_log` is not a statement of the key and the key never pays for the cost that it asks. A cost that cannot be read does not fail the call (the usage is still given), and the tool says why in its own words: the text of the ClickHouse error and the `GRANT` statement of the page stay on the page.
- **An instance is a file, not a lock.** Several ChDash that share a directory never write the same file, so none waits for another and none overwrites another's counts. They read each other's files in the background and sum them in every answer. A start after a stop is not a conflict (the file that it finds is the one that the process that stopped wrote); two live processes with the same name are (the second one does not write).
- **Seen on another instance.** A key that this instance does not have (its configuration or its key file) but that a file of another instance has is shown, not hidden: as deleted when a file says so, else as `elsewhere`. A key made on the page is kept by one ChDash only, so this is how the others see it.
- **The pages.** The route `/mcp-integration` serves `mcp.html` (Keys) and `/mcp-integration/usage` serves `mcpusage.html` (Usage), each with or without a trailing slash. Both are always served, also when MCP is off: the page then shows how to turn MCP on. The link in the page switcher shows only when `features.mcp.enabled` is true. A route answers 404 when its shell file is missing.
- **Expiry date.** The page sends the end of the chosen day as `YYYY-MM-DDT23:59:59Z`. The API accepts a date alone (the start of that day) and a full UTC time.
