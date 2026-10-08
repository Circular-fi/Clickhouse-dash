# MCP integration

ChDash has a built-in MCP server. An AI client reads ClickHouse data through ChDash. The client can be Claude Desktop, Claude Code, an IDE or your own agent. No external MCP server is necessary. The client uses an access key. Each key has its own rights: hosts, tools and data.

MCP is off by default. Add an `mcp {}` block to the configuration to turn it on.

## How it works

- The endpoint is `POST /mcp`. It uses the MCP "Streamable HTTP" transport. Each request gets one JSON answer. There is no stream and no session.
- The client sends `Authorization: Bearer <key>`. ChDash finds the key and checks its rights on every call.
- MCP has its own ClickHouse user. Each host has an `mcp_uri` for it. ChDash never uses `runner_uri` or `system_uri` for MCP. A host without `mcp_uri` is invisible to MCP.
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
  description     = "Reads the logs for the CI"
  secret_file     = "/run/secrets/chdash-mcp-ci"   # or secret, or secret_sha256: exactly one
  hosts           = ["prod"]
  tools           = ["list_databases", "query_table"]  # or ["*"]
  databases       = ["otel", "analytics.events"]
  max_rows        = 200
  timeout_seconds = 10
  expires_at      = "2027-01-01T00:00:00Z"
  enabled         = true
}
```

| Attribute | Meaning |
| --- | --- |
| `name` | Required. Use `a-z`, `0-9`, `-` and `_`. Start with a letter or a digit. At most 64 characters. The prefix `ui_` is reserved. |
| `description` | Optional text (1024 bytes at most). |
| `secret`, `secret_file`, `secret_sha256` | Give exactly one. The secret is at least 24 bytes. `secret_file` holds the secret. ChDash removes the spaces and the line ends around it. `secret_sha256` holds the SHA-256 of the secret as 64 hexadecimal characters. Then the secret is not in the configuration file. |
| `hosts` | The hosts of the key: names of `clickhouse.host` blocks that have `mcp_uri`, or `["*"]` for all of them. An empty list means no host. |
| `tools` | The tools of the key, or `["*"]` for every tool that the key can hold. An empty list means no tool. |
| `databases` | The data of the key. Refer to [Data scope](#data-scope). An empty list means no data. |
| `max_rows`, `timeout_seconds` | Lower caps, from 1 up to the global value. |
| `expires_at` | Optional. `2027-01-01T00:00:00Z` or `2027-01-01` (the start of that day, UTC). After this time, the key answers 401. |
| `enabled` | `false` turns the key off. The default is `true`. |

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

ChDash also refuses a secret shorter than 24 bytes, a bad name, a bad `expires_at`, a bad pattern in `databases`, and a `max_rows` or `timeout_seconds` above the global value. A `mcp {}` block with `enabled = false` still checks its shape (case 7).

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
```

- Grant `SELECT` and the `SHOW` rights only. A `SELECT` grant on a database includes the right to see it.
- Do not grant `FILE`, `URL`, `REMOTE`, `S3` or any other source. These sources read files or call other servers.
- Do not grant `INSERT`, `ALTER`, `CREATE`, `DROP`, `SYSTEM`, `KILL QUERY` or `ACCESS MANAGEMENT`.
- Do not grant `SELECT` on `system.users`, `system.query_log`, `system.processes` or other tables with data of other users.
- Keep the default profile of the user (`readonly = 0`). ChDash sends `readonly = 1` and the limits with each query. With `readonly = 1` in the profile, ClickHouse refuses the limits. With `readonly = 2`, ClickHouse refuses `readonly = 1`. Do not use either one.
- `tests/clickhouse-init/01-chdash-users.sql` has the user of the tests, `chdash_mcp`. It uses the same pattern.

A key can limit the user more. A key cannot give the user more.

## Key model

A key has three scopes.

### Hosts

`hosts` lists the hosts that the key can use. `["*"]` means every host that has `mcp_uri`. An empty list means none. A tool call names its `host`. The name is optional when the key has exactly one host.

### Tools

| Tool | Group | Use |
| --- | --- | --- |
| `list_hosts` | schema | The hosts of the key and their health. |
| `list_databases` | schema | The databases that the key can see. |
| `list_tables` | schema | The tables, with engine, rows and size. Has a glob filter. |
| `describe_table` | schema | Columns, keys, engine and the CREATE statement. |
| `query_table` | read | Columns, filters, order and limit. ChDash builds the SQL. |
| `run_query` | sql | One read-only SQL statement. |
| `explain_query` | sql | `EXPLAIN` of one SELECT: plan, pipeline, ast, syntax or estimate. |

`tools = ["*"]` means every tool that the key can hold.

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
- `expires_at` ends the key. The key then has the state `expired`, and the state `expired` wins over `disabled`.
- `enabled = false` turns a key off. The key answers 401 at once.

### Two sources

| Source | Where | Change |
| --- | --- | --- |
| `config` | `key {}` blocks | Edit the configuration and restart. The page shows them read-only. |
| `ui` | The MCP page, and the `storage_file` | Create, edit, disable, rotate and delete on the page. |

The two sources add up. A name or a secret cannot exist twice, in either source.

### Secrets and the key file

- ChDash makes the secret of a page key: `chm_` and 43 URL-safe base64 characters (32 random bytes from the system random source). The page shows it once, at creation and at rotation. Nobody can read it later.
- ChDash stores the SHA-256 of the secret and its first 12 characters (`secret_hint`). The secret is never stored. ChDash compares hashes in constant time.
- **Rotate** gives a new secret. The old secret stops at once.
- The file has `version`: 1 and a `keys` array. Each key has `id` (`ui_` and 12 hexadecimal characters), `name`, `description`, `secret_sha256`, `secret_hint`, `hosts`, `tools`, `databases`, `max_rows`, `timeout_seconds`, `expires_at`, `enabled`, `created_at` and `updated_at`.
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

### `run_query`

Arguments: `host`, `sql`. The key needs `databases = ["*"]`.

- The SQL is exactly one statement. The first word is `SELECT`, `WITH`, `SHOW`, `DESCRIBE`, `DESC`, `EXISTS` or `EXPLAIN`. One `;` at the end is fine.
- A splitter reads the SQL the way ClickHouse reads it. A `;` inside a string, a quoted name, a `$$` string or a comment is not a separator. A second statement is an error: `multiple_statements`.
- ChDash refuses `INTO OUTFILE` and the table functions that read files, URLs, remote servers and other databases (`file`, `url`, `remote`, `s3`, `mysql` and similar). The error codes are `clause_not_allowed` and `function_not_allowed`.
- A `FORMAT` clause is accepted and has no effect: the result is always JSON.
- This check is a guard rail. The security is `readonly=1` and the grants of the ClickHouse user.

Result: `host`, `columns`, `rows`, `row_count`, `truncated`, `elapsed_ms`.

### `explain_query`

Arguments: `host`, `sql` (one `SELECT` or `WITH` statement), `type` (`plan` default, `pipeline`, `ast`, `syntax` or `estimate`), `indexes` and `actions` (booleans, for `plan`). Result: `host`, `type`, `lines` (the text of the explain), `truncated`. The `estimate` type has `columns` and `rows`.

### Tool error codes

`invalid_argument`, `host_required`, `host_not_allowed`, `no_host`, `tool_not_allowed`, `database_not_allowed`, `table_not_allowed`, `table_not_found`, `unknown_column`, `unsupported_column_type`, `sql_too_large`, `empty_sql`, `invalid_sql`, `multiple_statements`, `statement_not_allowed`, `clause_not_allowed`, `function_not_allowed`, and from ClickHouse: `timeout`, `readonly`, `permission_denied`, `memory_limit`, `read_limit`, `not_found`, `syntax_error`, `host_unavailable`, `query_failed`. A call to a tool name that does not exist is a JSON-RPC error (-32602).

## The endpoint

`POST /mcp` with `Content-Type: application/json` and `Authorization: Bearer <key>`.

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
| 401 | The key is missing, unknown, disabled or expired. The answer has `WWW-Authenticate: Bearer`. All four cases have the same text. |
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

`status` is `ok`, the tool error code, `rpc_error_<code>` or the HTTP cause (`401_unknown`, `401_disabled`, `401_expired`, `401_missing`, `429_rate_limited`, `origin_not_allowed` and others). Page actions on keys write a line too (`keys/create`, `keys/update`, `keys/rotate`, `keys/delete`) with the key id, never the secret.

## The page API

These routes serve the page. Each answer has `Cache-Control: no-store`. When MCP is off, `/api/mcp/meta` answers `{"enabled": false}` and every other route answers 404 `mcp_disabled`.

| Route | Use |
| --- | --- |
| `GET /api/mcp/meta` | State, endpoint, hosts, tools and limits. |
| `GET /api/mcp/keys` | `{"keys": [...]}`. The keys of the configuration come first. A key never has its secret. |
| `POST /api/mcp/keys` | Makes a key. Answer 201: `{"key": {...}, "secret": "chm_..."}`. |
| `PATCH /api/mcp/keys/<id>` | Changes any field of a page key, `name` included. Answer: `{"key": {...}}`. |
| `POST /api/mcp/keys/<id>/rotate` | A new secret. Answer: `{"key": {...}, "secret": "chm_..."}`. |
| `DELETE /api/mcp/keys/<id>` | Answer: `{"ok": true, "id": "<id>"}`. |

A key in the answers:

```json
{"id": "ui_0a1b2c3d4e5f", "name": "ci-bot", "description": "", "source": "ui",
 "secret_hint": "chm_AbCdEf12", "hosts": ["prod"],
 "tools": ["list_databases", "query_table"], "databases": ["otel", "analytics.events"],
 "max_rows": null, "timeout_seconds": null, "expires_at": null, "enabled": true,
 "state": "active", "created_at": "2026-10-08T10:00:00Z", "last_used_at": null}
```

`state` is `active`, `disabled` or `expired`. `source` is `config` or `ui`. A key of the configuration has `id` equal to its `name`, and `secret_hint` is empty.

The write routes use the same guard as the query library:

- `Sec-Fetch-Site` must be absent, `same-origin` or `none`. If it is absent, an `Origin` header must name this server (`Host` or `X-Forwarded-Host`).
- The body must be `application/json`.

| Status | `error` | Case |
| --- | --- | --- |
| 400 | `validation` | With `field` and `reason`: `required`, `type`, `invalid`, `too_long`, `unknown_host`, `unknown_tool`, `needs_all_data`, `duplicate`, `range` or `invalid_json`. |
| 403 | `manage_disabled` | `manage_from_ui = false`. |
| 403 | `cross_site_request` | The guard refused the request. |
| 404 | `mcp_disabled` | MCP is off. |
| 404 | `not_found` | No key has this id. |
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
  --header "Authorization: Bearer chm_..."
```

A client that reads a JSON file (the form can differ in each client):

```json
{
  "mcpServers": {
    "chdash": {
      "type": "http",
      "url": "https://chdash.example.com/mcp",
      "headers": {"Authorization": "Bearer chm_..."}
    }
  }
}
```

A test with `curl`:

```bash
curl -s https://chdash.example.com/mcp \
  -H "Authorization: Bearer chm_..." -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Use HTTPS when the client is not on the same machine. Put ChDash behind a reverse proxy that has TLS.

## Security limits

- ChDash has no login. Anyone who can open the MCP page can make a key. The key is bound by the grants of the ClickHouse MCP user. To reduce the risk, restrict the page with the reverse proxy or the network. Or set `manage_from_ui = false`: then only the keys of the configuration and the file exist.
- The real boundary is the ClickHouse MCP user. A key only narrows it. Give the user the least rights.
- A key is a secret. Whoever has it can do everything the key allows. Give a short `expires_at` to keys for tests.
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
- **Secrets.** The minimum is 24 bytes, for `secret` and for the content of `secret_file`. A page key has 47 characters.
- **Names.** At most 64 characters. The prefix `ui_` is reserved for key ids, and ChDash refuses it in names of both sources.
- **Lower caps.** A key `max_rows` or `timeout_seconds` above the global cap is an error: a startup error for a config key, a 400 `range` for a page key. A stored key above a lowered cap is cut to the cap at run time.
- **SQL tools.** A key that names `run_query` or `explain_query` without all data is an error. A key with `tools = ["*"]` and a limited scope gets the other five tools. A key with `tools = ["*"]` and `databases = ["*"]` gets all seven. At run time, ChDash checks the rule again for each call, also for keys of an old file.
- **All data** is exactly the entry `*`. `*.*` is a normal pattern.
- **Empty lists.** `hosts`, `tools` and `databases` can be empty. A key with an empty list can do nothing. An attribute that is missing is an empty list.
- **Hosts.** `hosts = ["*"]` means every host with an `mcp_uri`. A page key cannot name a host without `mcp_uri` (`unknown_host`). A key of an old file can name a host that is now gone. The host is then not available.
- **Time.** `expires_at` is in UTC. A date alone means the start of that day. `created_at` and `last_used_at` have a one-second precision.
- **Page keys.** At most 1000 keys in the file. A description has at most 1024 bytes.
- **Order of checks of `POST /mcp`.** Origin, key, rate limit, content type, protocol header, body size. An early refusal closes the connection.
- **Body size.** 2 times `max_sql_bytes` plus 16 KiB, because JSON escapes can double the SQL.
- **`structuredContent`.** A tool result always has `structuredContent` and the same JSON as text. Older clients read the text.
- **Not allowed or unknown tool.** A tool that exists but that the key cannot use is a tool error `tool_not_allowed`. A name that does not exist is the JSON-RPC error -32602.
- **Truncation.** `truncated` is true only when a cap cut the result. A `limit` that you chose below the cap is not a cap. `query_table` asks for one row more than the cap to know. For `run_query`, ClickHouse breaks at `max_rows` + 1 rows. A result that exactly fits is not truncated.
- **Bytes.** ChDash counts the JSON text of the cells. It also estimates the size that ClickHouse counts (a number has its width in bytes), because `max_result_bytes` with `break` cuts there. If either reaches the cap, `truncated` is true.
- **Omitted columns.** A column of the table that the ClickHouse user cannot see is not in `system.columns`, so it is not in the result and not in `omitted_columns`. `omitted_columns` lists the wide columns (more than 2048 bytes on average) and the `AggregateFunction` columns.
- **Schema tools.** They read at most 20,000 rows of a system table and return at most 2000 tables. The row cap of the key does not apply.
- **Health.** `healthy` is the health that ChDash measures for the host with its normal check. It does not test the MCP user.
- **`FORMAT`.** ChDash uses the native protocol. The result is always JSON, so a `FORMAT` clause has no effect and is accepted.
- **Denied functions.** `file`, `url`, `remote`, `s3`, `hdfs`, `mysql`, `postgresql`, `mongodb`, `redis`, `jdbc`, `odbc`, `sqlite`, `executable`, `input`, the Azure, Iceberg, Delta Lake and Hudi readers, and their `Cluster` forms.
- **Settings order.** The settings of a query go together in one packet. ClickHouse checks each of them against the profile of the user, then applies them. `readonly=1` does not block the limits that come with it. A `SETTINGS` clause in the SQL is refused after that, so the SQL cannot change a limit.
- **Connections.** MCP queries use the shared connection pool with the `mcp_uri` of the host. The pool key includes the URI, so MCP connections never mix with runner or system connections. The receive timeout is `query_timeout_seconds` plus 15 seconds.
- **API errors.** The page API uses `{"error", "message"}` (and `field` and `reason` for validation). The check of `manage_from_ui` comes after the cross-site guard and before the validation.
- **The page.** The route `/mcp-integration` always serves `mcp.html`, also when MCP is off. The page then shows how to turn MCP on. The link in the page switcher shows only when `features.mcp.enabled` is true. The route answers 404 when `mcp.html` is missing.
- **Expiry date.** The page sends the end of the chosen day as `YYYY-MM-DDT23:59:59Z`. The API accepts a date alone (the start of that day) and a full UTC time.
