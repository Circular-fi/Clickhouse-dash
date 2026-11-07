# Access of humans

This document uses ASD-STE100 Simplified Technical English.

ChDash is a service of ProcurAuth, a profile of AuthZEN 1.0 (`procurauth-protocol.md`). ProcurAuth defines the resources (section 4), the action document and the route of the options (section 5), the limits and the ceilings (sections 6 and 7), the identity token (section 9), the duties of a PEP (section 10) and the reasons (section 11). The tool `access-conformance` of ProcurAuth tests the behaviour of ChDash as a PEP ([conformance.md](conformance.md)).

The rules of the pages (the navigation and the hidden hosts) are the choice of ChDash. They follow section 11 of the MCP server contract (`mcp-server-contract/SPEC.md`, "Access of humans (AuthZEN)"). This document applies to the pages and to the API of ChDash. For the MCP endpoint `POST /mcp`, refer to [The MCP endpoint](#the-mcp-endpoint): in the mode `identity`, the identity token and the PDP decide each request, and in the mode `keys`, the agents use the keys of the `mcp` block ([mcp.md](mcp.md)).

## Principle

The access has three parts:

1. **Authentication.** An access gateway in front of ChDash identifies the human. It puts a signed identity token in a request header. The reverse proxy sends the request to ChDash. ChDash verifies the token on each request.
2. **Decision.** For each action, ChDash asks a PDP (Policy Decision Point) with the OpenID AuthZEN Authorization API 1.0. The decision depends only on the human, the action and the resource.
3. **Enforcement.** ChDash applies the decision on the server side, for each route. It does not trust the page to hide an action.

The access gateway decides only the action `access` (the entry into ChDash). ChDash decides all its other actions.

## Configuration

The `access` block is required. A file without it stops the start, so nobody gets the open mode by mistake.

```hcl
access {
  mode = "authzen"                       # "authzen" | "open"
  identity {
    header           = "X-Identity-Token"
    issuer           = "https://access.example.internal"
    audience         = "db"              # the name of this server
    public_keys_file = "/run/secrets/db_identity_keys.pem"   # or public_keys, or public_keys_env
    max_age          = "5m"
    clock_skew       = "60s"
  }
  pdp {
    url        = "http://pdp.example.internal:4182"           # or url_env, or url_file
    token_file = "/run/secrets/db_pdp_token"                  # or token_env
    timeout    = "500ms"
    cache_ttl  = "30s"
    batch_timeout     = "2s"
    usage_max_seconds = 120
  }
}
```

| Key | Default | Use |
|---|---|---|
| `mode` | (required) | `authzen`: ChDash obeys all of this document. `open`: ChDash checks no identity and no permission. |
| `identity.header` | `X-Identity-Token` | The request header that carries the token. `Cookie`, `Authorization`, `Host`, `Content-Type` and `Content-Length` are refused. |
| `identity.issuer` | (required) | The value that the `iss` claim must have. |
| `identity.audience` | (required) | The name of this server: 1 to 256 bytes of UTF-8, no control character. The `aud` claim must contain it. It is also the `id` of the `service` resource and the `server` of the list of actions. |
| `identity.public_keys` | (required) | The public keys of the issuer: PEM or a JWK Set (refer to [Public keys](#public-keys)). 1 to 16 keys. It has the forms `public_keys`, `public_keys_env` and `public_keys_file`. Give exactly one. |
| `identity.max_age` | `5m` | The longest life of a token (`exp - iat`). From `1s` to `24h`. |
| `identity.clock_skew` | `60s` | The tolerance for the clock of the issuer (refer to [Identity token](#identity-token)). From `0s` to `5m`, in whole seconds. `0s` means no tolerance. |
| `pdp.url` | (required) | The base URL of the PDP: `http[s]://host[:port][/path]`. It has the forms `url`, `url_env` and `url_file`. Give exactly one. Refer to [Transport](#transport). |
| `pdp.token_env`, `pdp.token_file` | (required) | The token of this server at the PDP. It is a secret: give exactly one of the two forms. A token in clear text (`token = "..."`) stops the start. |
| `pdp.timeout` | `500ms` | The time of one request to the PDP, from the connect to the end of the answer. From `10ms` to `1m`. |
| `pdp.cache_ttl` | `30s` | The longest time that ChDash keeps an answer of the PDP. From `0s` (no cache) to `1h`. |
| `pdp.ca_file` | the store of the system | An `https` URL only. A file of PEM certificates: the CAs that ChDash trusts for the PDP. It replaces the store of the system. |
| `pdp.verify` | `true` | An `https` URL only. `false` turns off the check of the certificate. The start then writes a `config.warning`. |
| `pdp.search` | `false` | `true` uses the Resource Search of the PDP to list databases. It needs the metadata member `search_resource_endpoint` too. Refer to [Resource Search](#resource-search). |
| `pdp.batch_timeout` | `2s` | The longest time of all the requests of one call that ChDash splits into several requests. From `10ms` to `5m`, and not less than `pdp.timeout`. Refer to [Decisions](#decisions). |
| `pdp.usage_max_seconds` | `120` | The highest `procurauth_usage_max_seconds` of the metadata of the PDP that ChDash accepts. A whole number from 1 to 3600. Refer to [Metadata of the PDP](#metadata-of-the-pdp). |

These items stop the start:

- No `access` block, no `mode`, or a `mode` that is not `authzen` or `open`.
- `mode = "open"` with an `identity` block or a `pdp` block. The two contradict each other.
- `mode = "authzen"` without the `identity` block or the `pdp` block, or without one of their required keys.
- A key text that does not hold only Ed25519 or P-256 public keys, or a P-256 point that is not on the curve.
- A JWK Set with a private member (`d`), with a `kty` or `crv` that ChDash does not accept, or with two keys of the same `kid`.
- An `https` URL in a build without the TLS client. The message names the CMake option `-DCHDASH_TLS=ON`.
- `pdp.ca_file` or `pdp.verify` with an `http` URL. They act on TLS only, so they contradict the URL.
- A `pdp.batch_timeout` below `pdp.timeout`, also the default `2s` with a `pdp.timeout` above it. The two keys contradict each other: the message names them, gives their values and tells the value to set.
- A `pdp.ca_file` that is not a readable file with at least one PEM certificate.
- A metadata document of the PDP that ChDash cannot use (refer to [Metadata of the PDP](#metadata-of-the-pdp)). The message names `access.pdp.url`. A document with `procurauth_usage_max_seconds` above `pdp.usage_max_seconds` is such a document: the message also names `access.pdp.usage_max_seconds`, the value of the metadata and the limit.
- A token of the PDP that holds a space, a control character or more than 4096 bytes. The error does not show the token.
- With `mode = "authzen"`, a `clickhouse.host` name that has more than 256 bytes or is not UTF-8. The name is the id of a host for the PDP (refer to [Resources and hosts](#resources-and-hosts)).

With `mode = "open"`, ChDash writes the warning `config.warning` at each start. Use the open mode only for a server alone on a closed network.

With `mode = "authzen"` and `server.listen_host = "0.0.0.0"`, ChDash also writes a `config.warning` at each start. This is a warning, not an error. Refer to [Network](#network).

### Public keys

`identity.public_keys` holds PEM text or a JWK Set (RFC 7517). ChDash reads the text as a JWK Set when it starts with `{`. Else it reads PEM.

- PEM: 1 to 16 `-----BEGIN PUBLIC KEY-----` blocks. Each key is Ed25519 (`Ed25519`) or P-256 with an uncompressed point (`ES256`).
- JWK Set: a JSON object with a `keys` array of 1 to 16 keys. This is the form that the portal publishes (`portal identity-public-key`).
- A JWK of type `OKP` has `crv` `Ed25519` and `x` (RFC 8037). A JWK of type `EC` has `crv` `P-256`, `x` and `y` (RFC 7518).
- A JWK has an optional `kid`. The `use` member has no effect. The `alg` member is optional. If it is present, it must be `Ed25519` (or `EdDSA`) for `OKP` and `ES256` for `EC`.
- A JWK with a private member (`d`), or with another `kty` or `crv`, stops the start. The error does not show the member value.

The `kid` of a key is the `kid` that the JWK declares. A PEM key, or a JWK without `kid`, has the RFC 7638 thumbprint of the key as `kid`. Two keys cannot have the same `kid` in a JWK Set.

`--print-config` shows each value with its source. It shows the keys as their type and their JWK thumbprint (RFC 7638), for example `["Ed25519 kid=kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k"]`. It shows the token of the PDP as `<hidden>`. [configuration-reference.md](configuration-reference.md) is the generated list of the keys.

## Identity token

The identity token is a JWT (RFC 7519) in the compact JWS form. ChDash verifies these items on each request:

| Item | Rule |
|---|---|
| Header | `alg` is `Ed25519` or `ES256` (P-256, SHA-256). The name `EdDSA` is deprecated (RFC 9864, 4.1.2): a token with it is refused. A header with `crit` is refused. `typ` is required and must be exactly `JWT` (the comparison is case-sensitive): an absent `typ`, `jwt`, `JOSE` and `at+jwt` are refused. ChDash never fetches a key: `jku`, `x5u` and `jwk` have no effect. |
| `kid` | When it is present, it must be a text, and ChDash verifies the token with the configured key of this `kid` only (refer to [Public keys](#public-keys)). A `kid` that is not a text gives `malformed`. A `kid` that no configured key has gives `kid`. When it is absent, ChDash tries each configured key of the algorithm, so a rotation can use two keys. |
| Signature | It must be valid for the selected key, or for one of the configured keys when `kid` is absent. |
| `iss` | It must be equal to `identity.issuer`. |
| `aud` | A text equal to `identity.audience`, or a list that contains it. |
| `iat`, `exp` | Both are required. ChDash refuses a token only when the current time is after `exp + identity.clock_skew`. `iat` can be `identity.clock_skew` in the future at most. `exp - iat` must not be more than `identity.max_age`: the tolerance does not change this limit. |
| `nbf` | When it is present, it can be `identity.clock_skew` in the future at most. |
| `sub` | The name of the human: 1 to 256 bytes, no control character. It is the AuthZEN subject `id`. The limit of 256 bytes and the refusal of control characters are deliberate: the `sub` goes into the PDP questions, the logs and the traces. |
| Size | The token has 16384 bytes at most (16 KiB). A longer token gives `malformed`. |

`identity.clock_skew` is `60s` by default. With `0s`, the verifier has no tolerance: it refuses a token when the current time is after `exp`, and an `iat` or `nbf` in the future.

ChDash accepts the token only in the configured header. It does not accept a token in a cookie or in a query parameter. Two copies of the header are refused: the reverse proxy must replace a header of the same name that the client sends.

If the token is absent or not valid, ChDash sends status `401` with `{"error_code": "unauthenticated"}`. It does not show a login page and does not redirect: the access gateway does that. The log line `access.unauthenticated` gives the reason (`missing`, `malformed`, `algorithm`, `kid`, `signature`, `issuer`, `audience`, `expired`, `not_yet_valid`, `max_age`, `subject`). The answer does not give it.

ChDash keeps a verified token (its SHA-256, its subject and its `exp`) in memory. A token in the cache follows the same rule as a new token: it is not accepted when the current time is after `exp + identity.clock_skew`.

ChDash checks the token when a request starts. A stream that started with a valid token (the result of a run, the status of the hosts, an export) continues after the `exp` of the token. The next request needs a new token.

These routes need no token: `/livez`, `/readyz`, `/healthz`, `/metrics`, `GET /.well-known/procurauth/actions` and `/mcp`. Keep `/metrics` on the internal network. `/mcp` checks its caller itself: with `mcp.auth_mode = "identity"`, it needs the identity token (refer to [The MCP endpoint](#the-mcp-endpoint)).

## Network

ChDash must be reachable only through the edge (the access gateway and its reverse proxy). The identity token is a bearer credential in a header. A client that reaches ChDash directly can send any token that it holds, or can use a service without an edge in front of it. Obey these rules:

- Kubernetes: write a NetworkPolicy for the pods of ChDash. Allow ingress only from the pods of the edge, and from the monitoring that reads `/metrics`. Allow egress only to the ClickHouse hosts, to the PDP and to the telemetry receiver.
- Docker Compose: put ChDash on a network that only the edge and ChDash use. Do not publish the port of ChDash on the host.
- Bind address: set `server.listen_host` to the address of the internal network, not `0.0.0.0`. The default is `0.0.0.0`, so ChDash writes a `config.warning` at start when `access.mode = "authzen"` and `server.listen_host` is `0.0.0.0`. The warning does not stop the start.
- The edge must replace the identity header that a client sends. Keep `/metrics` and `/mcp` off the public network.

## Actions

ChDash publishes its actions at `GET /.well-known/procurauth/actions`, without a token. This is the only path: the former path `/.well-known/access-actions` has no alias and gives `404`.

```json
{
  "server": "db",
  "resource_types": [
    { "name": "host",     "parent": "service", "description": "One ClickHouse server of the configuration: the name of its clickhouse.host block." },
    { "name": "database", "parent": "host",    "description": "One database of a host." }
  ],
  "actions": [
    { "name": "query.run.read", "resource_types": ["service", "host", "database"], "description": "..." }
  ],
  "resources": [
    { "path": "host:prod", "label": "Production" }
  ],
  "limits": [
    { "name": "max_rows", "label": "Most rows in the result of one run", "description": "...", "unit": "rows", "kind": "ceiling", "min": 1, "max": 1000000000000000 },
    { "name": "queries", "label": "Queries run", "description": "...", "unit": "query", "kind": "budget" }
  ]
}
```

`server` is `identity.audience` (`chdash` in the open mode). The list does not contain `access`. The top-level `resource_types` gives the tree under the service (refer to [Resources and hosts](#resources-and-hosts)). The `resource_types` of an action gives the types on which a grant for this action is valid.

The optional member `resources` has one node for each host of the configuration. Its `path` is `host:<id>` with the id percent-encoded (RFC 3986). Its `label` is the `label` of the host, or its name, cut to 60 characters. A node has no `actions` member: it takes each action that lists the type `host`. The databases are not in the document, because they change. The route of the options lists them (refer to [The route of the options](#the-route-of-the-options)). A configuration has 256 hosts at most (ProcurAuth 5.3c). More hosts stop the start with an error that names the key.

The document lists the published actions only (ProcurAuth 5.2a). An action of a feature that the configuration turns off is not in the document, and ChDash does not ask the PDP for it. This table lists all the actions. The column "Published when" gives the condition:

| Action | Published when |
|---|---|
| `query.run.read`, `query.run.write`, `query.export` | Always. |
| `explorer.read` | The Explorer is on: `explorer.browse` or the graph (`explorer.graph`). |
| `system.read` | `system.enabled` is `true`. |
| `observability.read` | The traces, the logs or the metrics are on for at least one host. |
| `library.read` | At least one `query_library` block is enabled. |
| `library.write` | At least one enabled `query_library` block has `writable = true`. |
| `mcp.keys.read`, `mcp.usage.read` | `mcp.enabled` is `true`. |
| `mcp.keys.write` | `mcp.enabled` is `true` and `mcp.keys.mode` is not `static`. |
| `mcp.session` | `mcp.enabled` is `true` and `mcp.auth_mode` is `identity`. |

The navigation follows the document: a page whose actions are not published has no link, and `GET /api/version` lists the published actions only. A system that holds grants (the portal) keeps a grant for an action that is not published. The grant applies again when the action is published again, for example when you set `mcp.enabled = true`. ChDash reads the configuration at start: a change of these settings needs a restart.

| Action | Resource types | Routes |
|---|---|---|
| `query.run.read` | `service`, `host`, `database` | `POST /api/query/run`, `POST /api/query`, `POST /api/query/analysis`, `POST` and `GET /api/query/deep-analysis`, `GET /api/query/execution`, `POST /api/format`, `GET /api/meta`. A run, and the start of Deep Analyze, take a unit of the budget `queries` ([Budgets](#budgets)). |
| `query.run.write` | `service`, `host`, `database` | The same routes. Without it, the statements of a run run with `readonly = 1`. |
| `query.export` | `service`, `host` | `POST /api/export/run`, `/api/export/stream`. An export also needs `query.run.read` or `query.run.write`. The stream asks the actions on the host of the export (refer to [The stream of an export](#the-stream-of-an-export)). The stream takes a unit of the budget `exports` ([Budgets](#budgets)). |
| `library.read` | `service` | `GET /api/query-library...` |
| `library.write` | `service` | `POST`, `PATCH` and `DELETE /api/query-library...` |
| `explorer.read` | `service`, `host`, `database` | `/api/explorer/...`, except `/api/explorer/ops/...` |
| `system.read` | `service`, `host` | `/api/system/...`, `/api/explorer/ops/...` |
| `observability.read` | `service`, `host` | `/api/traces/...`, `/api/logs/...`, `/api/metrics/...` |
| `mcp.keys.read` | `service` | `GET /api/mcp/keys`, `GET /api/mcp/keys/<id>/access`, `GET /api/mcp/access` |
| `mcp.keys.write` | `service` | `POST /api/mcp/keys`, `DELETE /api/mcp/keys/<id>`, `POST /api/mcp/keys/<id>/adopt` |
| `mcp.usage.read` | `service` | `GET /api/mcp/usage`, `GET /api/mcp/usage/overview`, `GET /api/mcp/keys/<id>/usage`, `GET /api/mcp/keys/<id>/cost` |
| `mcp.session` | `service` | `POST /mcp` in the mode `identity`: each request that calls no tool, and the tools that use no action of the pages. Each one takes a unit of the budget `requests` ([Budgets](#budgets)). |

The shell of each page needs the action of its page (refer to [Navigation](#navigation)). These routes need a valid token and no action: the files of `/static/`, the redirects of the former addresses, `GET /api/version`, `GET /api/hosts`, `GET /api/hosts/stream`, `GET /api/health`, `GET /api/mcp/meta`, `GET /.well-known/procurauth/resources` (refer to [The route of the options](#the-route-of-the-options)), and the routes of a capability that a checked request gave: `GET /api/query/stream`, `POST /api/query/cancel` and `POST /api/query/deep-analysis/cancel`.

A route that is not in this table is refused with `403` and the action `unknown` (fail closed), and the log has the line `access.no_rule`. A path that has no route gets `404`.

The member `limits` of the document declares the six ceilings and the three budgets, and each action lists the names of its limits (refer to [Limits of a grant](#limits-of-a-grant) and [Budgets](#budgets)).

When you remove or rename an action, or change its resource types, write the change in the release notes.

## Resources and hosts

ChDash 1.1.0 and later put each resource in a tree under the service (ProcurAuth 4.1 and 4.3):

```text
service (identity.audience)
└── host (the name of a clickhouse.host block, for example "local")
    └── database (one database of that host)
```

### Questions

A question names the most specific resource. `properties.ancestors` gives the chain from the service to the parent of the resource:

```json
"resource": {
  "type": "database",
  "id": "analytics",
  "properties": { "ancestors": [ { "type": "service", "id": "db" }, { "type": "host", "id": "prod" } ] }
}
```

- A question on the service has no `ancestors`.
- A question on a host has the ancestors `[service]`.
- A question on a database has the ancestors `[service, host]`.

A question can also have `"context": {"match": "subtree"}`. The default match is `"node"`. Refer to [Match](#match).

### Grants

The PDP keeps the grants (for example the portal). A grant has the form `<action> on service:<id>[/<type>:<id>]...`. Each id is percent-encoded (RFC 3986). A grant covers the resource that it names and every resource below it. Thus a grant on the service covers every host and every database, and a grant on a host covers every database of that host. ChDash does not read the grants. It sends the chain of each question, and the PDP applies the rule.

### Match

The match tells the PDP which grants apply to a question (ProcurAuth 4.4):

| Match | A grant applies when its path is | ChDash uses it for |
|---|---|---|
| `node` (the default) | the path of the resource, or a part at its start (the resource or a node above it) | every operation: each route asks `node` on its exact resource |
| `subtree` | as for `node`, or a path that starts with the path of the resource (a node below it) | only to show or hide the navigation: the visible hosts, the host pickers, the pages, and `features.access` of `GET /api/version` |

ChDash never lets an operation run on a `subtree` decision. A `subtree` question has its match in the `context` of its item. A `node` question has no `context`: the PDP takes the default. The key of the cache holds the match, so a `subtree` answer never answers a `node` question.

### The resource of each action

| Action | Resource of the question | Where ChDash finds the host and the database |
|---|---|---|
| `query.run.read`, `query.run.write` | The host of the run. The database for `GET /api/meta` with `database`. | `host_id` of the body (`POST`) or of the query (`GET`). The parameter `database` of `GET /api/meta`. |
| `query.export` | The host of the export. | `host_id` of the body. |
| `explorer.read` | The host, or the database when the request names one. The catalog, the storage map and the graph ask the match `subtree` on the host when the request names no database (refer to [Databases in the Explorer](#databases-in-the-explorer)). | The parameters `host_id` and `database`. The fields `host_id` and `database` of the body of `POST /api/explorer/table/data`. |
| `system.read` | The host. | The parameter `host_id`. |
| `observability.read` | The host. | The parameter `host_id`. |
| `library.read`, `library.write` | The service. | None: the query library is global. |
| `mcp.keys.read`, `mcp.keys.write`, `mcp.usage.read` | The service. | None: the MCP keys and their usage are global. |
| `mcp.session` | The service. | None: it is the permission to use the MCP endpoint (refer to [The MCP endpoint](#the-mcp-endpoint)). |

Rules:

- A request without `host_id` names the only host of a configuration that has one host, as the routes do.
- A `host_id` that is not a host of the configuration makes a question on the service. Thus the PDP never receives a host name that the client chose.
- A `database` that no grant can name makes a question on its host. Such a name is empty, has more than 256 bytes, is not UTF-8 or has a control character. Only a grant on the host or on the service can cover it.
- `query.export` does not take `database` since 1.1.0. ChDash 1.0.8 never asked it for a database.
- For a route that has the host in its JSON body, ChDash reads the body first. Before it reads the body, an export needs `query.export`, and `query.run.read` or `query.run.write`, on one host at least (match `node`). Without them, the answer is `403` before the body is read. A run of the Query page (`POST /api/query/run`, `POST /api/query`) and the start of Deep Analyze have no such check, because they are uses of a budget ([Budgets](#budgets)): their handler asks the PDP when it has the SQL.

### Hidden hosts

ChDash shows only the hosts on which the human holds one action at least:

- One batch asks each action that takes a host on each host of the configuration. The same batch asks each other action on the service. Each question of this batch has the match `subtree`. `GET /api/version`, `GET /api/hosts` and each page render ask the same questions, so the cache of the decisions serves them all.
- A host is visible when one decision of the batch on the host is `true`. A grant on the service, on the host or on a database of the host makes the host visible.
- `GET /api/hosts`, `GET /api/hosts/stream` and the hosts of `GET /api/mcp/meta` list only the visible hosts. The stream keeps the hosts of its start.
- The host picker of a page shows only the visible hosts on which the human holds one action of that page. For example, the System page needs `system.read` on the host.
- A request for a hidden host gets the same answer as a request for a host that does not exist: `403` with the action of the route. The answer does not tell that the host exists.
- `GET /api/health`, `/readyz` and `/metrics` still count all the hosts, as in 1.0.8. `/metrics` names the hosts: keep it on the internal network.
- The global features still name the host of each item, as in 1.0.8: the folders and the queries of the query library, and the keys of the MCP pages.

### Databases in the Explorer

The Explorer lists only the databases on which the human holds `explorer.read`:

- The catalog, the storage map and the graph (`GET /api/explorer/catalog`, `/storage` and `/graph`) have the rule `explorer.read` on the host, with the match `subtree`. A grant on the host, above it or on one of its databases lets the route run.
- The route then keeps only the readable databases. One batch asks `explorer.read` with the match `node` on the host and on each database of the answer. A decision on the host that is `true` keeps every database. Without it, a database stays when its own decision is `true`. The cache of the PDP serves these questions.
- With `pdp.search = true`, one Resource Search for `explorer.read` can replace the questions of the databases of the catalog (refer to [Resource Search](#resource-search)).
- A request that names a database (the parameter `database` of the catalog, the table card, the definition of a graph object) asks `node` on that database. A database that the human cannot read gets `403`, as before.
- The catalog, the storage map and the graph never show the name, the tables or the edges of a database that is not readable. The related objects, the targets and the SQL texts of a table card follow the same rule (they show `[HIDDEN]`).
- The list of functions names no database: it keeps the rule `explorer.read` on the host with the match `node`.

Example: a human holds only `explorer.read on service:db/host:local/database:analytics`. The host `local` is visible, and the Explorer page opens. The catalog of `local` lists the database `analytics` and its tables, and no other database. The routes of the database `analytics` of `local` work. Another database of `local` and a run on `local` get `403`: they ask `node` on their own resource.

### The route of the options

ChDash publishes `GET /.well-known/procurauth/resources` (ProcurAuth 5.6 to 5.9). A form of grants, for example the portal, uses it to show the children of a node. The route needs the identity token of the edge, like the other routes. Without a valid token it gives `401`. In the open mode the route does not exist (`404`).

| Parameter | Rule |
|---|---|
| `type` | Required. `host` (the parent is the service) or `database` (the parent is a host). |
| `parent` | Optional. The path of the node, for example `host%3Aprod`. Without it, the route lists the hosts. With it, the type must be `database`. |
| `q` | Optional. The route keeps the children whose id or label holds the text, without the case of the ASCII letters. It has 256 bytes at most. |
| `limit` | Optional. A whole number from 1. The route gives 50 items at most, and less when the answer would pass 60 KiB. |
| `after` | Optional. The value of `next` of the previous answer. Treat it as opaque text. |

Rules:

- The route decodes each `%XX` one time. It does not read `+` as a space. It reads the raw query, and it ignores a parameter that it does not know.
- A parameter that occurs two times, a value with a bad escape, a missing `type`, a bad `limit`, a bad `after`, a bad `parent`, and a `type` that is not a child of the type of the `parent` give `400`.
- The answer is `{"items": [{"id", "label", "has_children"}], "next": <cursor or null>}`. The hosts have `has_children` true. The databases have it false. The list is sorted by id without the case of the ASCII letters. The `label` has 60 characters at most. The cursor is the last id that the route examined, in base64url.
- A child is visible when the PDP gives `true`, with the match `subtree`, for one published action whose resource types hold the type of the child. For a host: each published action that takes a host. For a database: `query.run.read`, `query.run.write` and `explorer.read`. A grant on the node, above it or below it is enough. The route asks no question with a usage.
- With `pdp.search = true`, one search for each action can replace the questions of the databases (refer to [Resource Search](#resource-search)). Then the route pages the result on its own.
- One request asks the PDP 200 questions at most. When the bound is reached, the answer holds the items found so far and a `next` cursor. The answer can then have no item and a `next` value: ask again with `after`.
- The databases come from `SHOW DATABASES` with the runner account of the host. The route removes `system` and `information_schema`. ChDash keeps the list for 30 seconds. The list is the same for every human. The decisions are not in it.
- ChDash runs `SHOW DATABASES` only for a host that the human can see. A host that does not exist or that the human cannot see gives an answer with no item.
- When the PDP gives no valid answer, the route gives `503` with `pdp_unavailable` and the action `resources` (retryable). It never gives an empty list for a failure.
- ChDash applies no other rule that removes a child.

### Upgrade from 1.0.8

- A grant of one level on a database (`<action> on service:<id>/database:<name>`) covered that database on every host. Its chain does not follow the tree any more, so it covers nothing. Give the grant again on the database of one host: `<action> on service:<id>/host:<host>/database:<name>`.
- A grant on the service does not change.
- The PDP must read `properties.ancestors`, the match of the `context` and the top-level `resource_types` of the list of actions (ProcurAuth 4.1, 4.4 and 5.2). Update the PDP before you update ChDash. A PDP of the 1.0.8 format does not know the hosts: with it, only the grants on the service give the same decisions.

## Decisions

ChDash asks the PDP with AuthZEN:

```json
POST {pdp.url}/access/v1/evaluation
{
  "subject":  { "type": "user", "id": "<sub of the identity token>" },
  "action":   { "name": "system.read" },
  "resource": { "type": "host", "id": "<host>", "properties": { "ancestors": [ { "type": "service", "id": "<identity.audience>" } ] } },
  "context":  { }
}
```

For more than one question, ChDash sends a batch to `POST {pdp.url}/access/v1/evaluations`, with the subject at the top and the action and the resource of each evaluation. The answer is `{"decision": true|false}`, or `{"evaluations": [{"decision": ...}, ...]}` in the order of the questions. The paths above are the default endpoints. The metadata of the PDP can name other endpoints ([Metadata of the PDP](#metadata-of-the-pdp)).

Rules:

- The resource of each question follows the table of [Resources and hosts](#resources-and-hosts). The Query page and the export name no database: for them ChDash asks for the host.
- Each call has `Authorization: Bearer <pdp token>`, `X-Request-ID` (the request id of the request that asks) and a `traceparent`.
- **Bounded batches.** One request holds at most 100 questions. A call with more questions goes in several requests, in order. A PDP can publish a lower maximum of items and a maximum of bytes for one request (ProcurAuth 10.7a): ChDash obeys both. A request that fails gives a failure to its own questions only. When a request gets no answer (a timeout or a connection error), ChDash does not send the later requests of the call. Each of their questions is a failure. This avoids one wait for each request.
- **One deadline for a split call.** A call of several requests has one deadline, `pdp.batch_timeout` (`2s` by default), from the start of its first request. Each request waits `pdp.timeout` at most, and never past the deadline: the last request gets the time that remains. When the deadline cuts the call, ChDash sends no further request, and every question of the call is a failure, also the questions that the PDP answered and the questions that the cache answered. Thus the route answers `503`. It never allows a part of an operation on a part of the answers. The answers that came stay in the cache, so the next call asks only the rest. The log has the line `access.pdp_failed` with the cause. A call of one request has only `pdp.timeout`.
- **Fail closed.** No answer before `pdp.timeout`, a connection error, a status that is not `200`, a body that is larger than 256 KiB, and a body that is not a valid answer make each question of the call a failure. A failure is `false`, but it is not a denial: the route answers `503` (refer to [Enforcement](#enforcement)). ChDash writes the line `access.pdp_failed` and never keeps a failure. A status `401` or `403` of the PDP is also a failure: the PDP refuses the credential of ChDash. ChDash then also writes the line `access.pdp_credential_refused`.
- A decision can have a `context` object. A `context` that is not an object makes the answer not valid. ChDash reads these members of `context` (ProcurAuth 6.12, 7.3, 11.1) and ignores the other members:
  - `reason` of a `false` decision: `unknown_subject`, `invalid_resource`, `invalid_request` or `budget_exceeded`. Another value means "no permission". ChDash uses `unknown_subject`, and only this reason, to make an MCP key of that subject an orphan ([mcp.md](mcp.md#orphan-keys-and-their-adoption)).
  - `retry_after` of a `false` decision with `budget_exceeded`: a whole number of seconds, 1 or more. Without a valid `retry_after`, the answer is not valid.
  - `limits` of a `true` decision: an object of ceilings, each with a whole number from 0. Another type, a negative number, a fraction or a name two times makes the answer not valid. ChDash ignores `limits` on a `false` decision (ProcurAuth 7.6).
  - `usage.units` of a `true` decision: 0 or 1. Another value makes the answer not valid.
  - `error` of an item (AuthZEN 1.0, l.866-903): an object with `status` (a whole number) and `message` (a text). ChDash writes both in the line `access.decision` as `error_status` and `error_message` (200 bytes at most). It never sends them to the client. A form that is not this one is ignored and does not make the answer not valid.
- A member that is not valid in one evaluation makes the whole body not valid. Thus each question of the call is a failure.
- ChDash keeps the whole answer of the PDP for `pdp.cache_ttl` at most: the decision, the reason and the ceilings. The key is the subject, the action, the path of the resource (the service, the host and the database) and the match. Thus the same database name on two hosts has two answers. A change of the policy applies after `cache_ttl` at most.
- ChDash never keeps a failure, and never keeps an answer with `usage.units` above 0. It can keep an answer with `usage.units` equal to 0. It keeps a `false` answer with `budget_exceeded` for the lower of `retry_after` and `cache_ttl`.
- The cache holds 16384 answers and 8 MiB at most (the bytes of the keys and of the names of the ceilings, and a fixed part for each answer). The client chooses the `database` parameter, so a bound of bytes is necessary. When the cache is full, ChDash removes the expired answers. If the cache is still full, ChDash removes the oldest answers until the new answer fits. An answer that is larger than the whole budget is not kept. These bounds are not settings.
- ChDash sends one batch for a page: the batch of the hosts (refer to [Hidden hosts](#hidden-hosts)). `GET /api/version` gives the result in `features.access`. `actions` holds each action: `true` when the human may use it on the service, on one host or below one host. `hosts` holds the decisions of each visible host for the actions that take a host. The questions that are in the cache do not go to the PDP.

## Enforcement

- ChDash checks the decision of each route before the route runs, also when the page does not show the action.
- If the decision is `false`, ChDash sends status `403` with `{"error_code": "forbidden", "action": "<action>", "message": "The action <action> is not allowed.", "retryable": false}`.
- If the decision is `false` with the reason `budget_exceeded`, ChDash sends status `429` with `Retry-After` set to the seconds of `retry_after`. The body is `{"error_code": "too_many_requests", "action": "<action>", "retryable": true, ...}`.
- If the PDP gives no valid answer (refer to [Decisions](#decisions)), ChDash sends status `503` with `{"error_code": "pdp_unavailable", "action": "<action>", "retryable": true, ...}`. It never sends `403` for a failure. When an operation needs several decisions, a failure comes before a denial: a failed question can hide a `true` answer.
- A route that filters a list with the decisions does not filter on a failure: it answers `503`. These routes are the catalog, the storage map, the graph, the table card and the definition of the Explorer (action `explorer.read`), the names of `GET /api/meta` (action `query.run.read`), `GET /api/hosts`, `GET /api/hosts/stream` and the hosts of `GET /api/mcp/meta` (action `hosts`), `GET /api/version` (action `access`) and the route of the options (action `resources`).
- No answer gives the reason of the PDP (ProcurAuth 10.3).
- **Ceilings.** A ceiling of `context.limits` is mandatory to understand (ProcurAuth 7.5). ChDash applies the six ceilings that the document declares (refer to [Limits of a grant](#limits-of-a-grant)). A `true` answer with another ceiling is a `false` answer with no reason: the route answers `403`. The log has the line `access.ceiling_unenforceable` with the action, the resource and the name of the ceiling.
- A run without `query.run.write` on its host runs each statement with `readonly = 1`. For `GET /api/meta` with `database`, the decisions apply to that database of the host. ClickHouse then refuses a statement that changes data or settings, also a `SETTINGS` clause and `SET`. ChDash sends `readonly = 1` also when it cannot read the settings profile of the runner (fail closed). A run needs `query.run.read` or `query.run.write`: without the two, the answer is `403` with the action `query.run.read`. The same rule applies to Deep Analyze and to the statements of an export. An export also needs `query.export`: without it, the answer is `403` with the action `query.export`.
- The pages hide what the subject cannot do. `GET /api/version` gives the decisions in `features.access`, and the pages read them. The host picker of a page shows only the hosts on which the subject holds an action of that page. The query library needs `library.read` (and `library.write` to change it). `GET /api/mcp/meta` says `can_manage = false` without `mcp.keys.write`, so the MCP page shows no New key and no Delete. The pages and their links follow the rules of [Navigation](#navigation).

### Limits of a grant on one database

- A grant on a database applies to that database of one host only. The same database name on another host is another resource.
- A grant on a database applies to the Explorer route that names this database. The catalog of all the databases (`GET /api/explorer/catalog` without `database`) lists only the readable databases (refer to [Databases in the Explorer](#databases-in-the-explorer)).
- Some answers name other databases than the one of the request: the storage map (`GET /api/explorer/storage`), the graph (`GET /api/explorer/graph`, a lineage crosses databases) and the names of the editor (`GET /api/meta` with `databases`, `tables` or `columns`). ChDash asks the PDP, in one batch, for the host and for each database of the answer on that host: `explorer.read` for the storage map and the graph, `query.run.read` and `query.run.write` for the names. The answer keeps only the databases with a `true` decision on the database or on the host. A grant on the service covers the host. A node of the graph that names no database (a shard or a replica of a cluster) stays when it links to a node that stays.
- The card of a table (`GET /api/explorer/table`) and the definition of a graph object (`GET /api/explorer/graph/definition`) can name other databases. These are the related objects (`dependencies`) and the target of a materialized view, a Buffer or a Distributed table. ChDash asks the PDP, in one batch, for `explorer.read` on the host and on each of these databases of the host. A related object in a database without a `true` decision is removed. A target in such a database is not visible: the card gives an empty `database` and `table` in `distributed`, and the definition gives `target_visible: false` and `target: null`.
- Some texts of these answers also name databases. These texts are the DDL text (`ddl`), `engine_full`, the TTL and the expressions of the columns of the card, and the `select_sql` of the definition. The catalog of a database (`GET /api/explorer/catalog`) gives no DDL text and no `engine_full`. ChDash finds the databases that these texts name. It asks the PDP for them in the same batch. In a text, ChDash replaces a database without a `true` decision, and the name of its object, with `[HIDDEN]`. A name becomes `` `[HIDDEN]` ``, and a text becomes `'[HIDDEN]'`. The database of the object of the request is always readable.
- ChDash finds the name of a database in these places of a text:
  - `db.table` after `FROM`, `JOIN`, `IN`, the `TO` of a materialized view and the `AS` of `CREATE TABLE`.
  - The database and the table of the engines `Distributed`, `Buffer`, `Merge` and `Dictionary`.
  - The database and the table of the table functions `remote`, `remoteSecure`, `cluster`, `clusterAllReplicas`, `merge` and `dictionary`.
  - The `'db.name'` of `dictGet`, `dictHas`, `dictIsIn` and `joinGet`.
  - `DB` and `TABLE` in `SOURCE(CLICKHOUSE(...))` of a dictionary.
  - Every other `db.name` of a database that ChDash hides.
- ChDash does not read a SQL text inside a text, for example the `QUERY` of a dictionary source.
- The focus of the graph (`focus_database`) names its own database. Without a `true` decision on the host or on that database, the answer is `403` with the action `explorer.read`.
- The Query page names no database. Thus a grant of `query.run.read` on one database does not let the user run a query: ChDash asks for the host. The SQL of a query can name any table, so a decision for one database cannot limit what the SQL reads. The grants of the ClickHouse runner user of each host stay the limit of the data.

## Limits of a grant

A grant can carry limits (ProcurAuth section 6). ChDash declares six limits of the kind ceiling and three of the kind budget ([Budgets](#budgets)). A ceiling is the most that one use of an action can take. The portal reads the declaration in the action document and shows the form of the values. The PDP gives the value of each ceiling in `context.limits` of a `true` answer. ChDash holds no value itself.

### The six ceilings

Each ceiling has the lowest value 1, because ClickHouse reads 0 as no limit. A grant never gives 0.

| Ceiling | Unit | ClickHouse setting | What it limits |
|---|---|---|---|
| `max_rows_read` | rows | `max_rows_to_read` | The rows that one run reads from the tables. |
| `max_read_size` | bytes | `max_bytes_to_read` | The bytes that one run reads from the tables. |
| `max_rows` | rows | `max_result_rows` | The rows in the result of one run. |
| `max_result_size` | bytes | `max_result_bytes` | The bytes in the result of one run. |
| `max_duration` | seconds | `max_execution_time` | The time that one run takes. |
| `max_memory` | bytes | `max_memory_usage` | The memory that one run uses. |

The declared `max` of a ceiling is the highest bound of the configuration that carries it. A key with the value 0 stands for the highest value that its schema allows. A ceiling that no key bounds has the highest value of its schema:

| Ceiling | Keys that bound it | Highest value of the schema |
|---|---|---|
| `max_rows_read` | `query.max_rows_to_read`, `generated_queries.max_rows_to_read` | 10^15 rows |
| `max_read_size` | `query.max_bytes_to_read`, `generated_queries.max_bytes_to_read` | 10^15 bytes |
| `max_rows` | none | 10^15 rows |
| `max_result_size` | none | 1 099 511 627 776 bytes (1 TiB) |
| `max_duration` | `query.max_execution_time_s`, `export.max_execution_time_s`, `generated_queries.timeout_ms` | 604 800 seconds (7 days) |
| `max_memory` | `query.max_memory_usage`, `export.max_memory_usage`, `generated_queries.max_memory_usage` | 1 099 511 627 776 bytes (1 TiB) |

Every value is below 2^53. A reader that uses floating point numbers reads each value exactly. A value above `max` is not a fault. The value that applies is always the lowest of the ceiling, the bound of the configuration and the settings profile.

### Actions that list ceilings

| Action | Ceilings |
|---|---|
| `query.run.read`, `query.run.write`, `query.export` | All six. |
| `explorer.read` | `max_rows`, `max_rows_read`, `max_duration`, `max_memory`. |
| `system.read`, `observability.read` | `max_rows_read`, `max_rows`, `max_duration`. |
| `library.read`, `library.write`, `mcp.keys.read`, `mcp.keys.write`, `mcp.usage.read`, `mcp.session` | None. |

The same actions also list budgets: `queries` on `query.run.read` and `query.run.write`, `exports` on `query.export`, `requests` on `mcp.session`. A budget is not a ceiling: the PDP never sends it in `context.limits`.

An action lists its ceilings only when the action is published. In the mode `identity`, the MCP endpoint applies the declared ceilings of the action of each tool ([mcp.md](mcp.md#ceilings)). In the mode `keys`, an MCP key never has more than its creator. A `true` answer for the creator with a ceiling is `false` for the key.

### How ChDash applies a ceiling

1. The rule of the route asks the PDP. ChDash keeps the ceilings of the `true` answer of the action that guards the route. An export keeps the ceilings of `query.export` and of the class of its SQL.
2. One function, `apply_ceilings`, lowers the bounds of a statement. It does nothing for an internal statement ([Statements that a ceiling bounds](#statements-that-a-ceiling-bounds)). Four places call it: the run of the Query page (`QuerySession`), the statements of the pages (`request_limits`), Deep Analyze (`user_sql_limits`) and the export stream. A route that an MCP tool calls in the mode `identity` gets the ceilings of the call ([mcp.md](mcp.md#ceilings)).
3. The ceiling lowers the matching bound. The value that ClickHouse gets is the lowest of the ceiling, the bound of the configuration and the settings profile of the runner user. A ceiling never makes a bound looser.
4. A ceiling that lowers a bound also sets the overflow mode `throw` when the route sets none. The run then fails with a clear error and gives no cut result.
5. `max_memory` has no backstop in ChDash. The settings profile of the ClickHouse user enforces it, with the setting `max_memory_usage`. To limit the memory of a statement that sets its own `max_memory_usage`, use a constraint in the profile.

ClickHouse lets a `SETTINGS` clause of a statement replace the setting of the client. A profile with `readonly = 1` takes no setting at all. Thus ChDash also counts what it sees, in the run of the Query page and in the export:

| Ceiling | What ChDash counts | The error |
|---|---|---|
| `max_rows_read`, `max_read_size` | The rows and bytes of the progress packets of ClickHouse. | `query_scan_limit` |
| `max_rows` | The rows of the result blocks. A block that goes past the ceiling is not sent. | `query_result_limit` |
| `max_result_size` | The bytes of the result events that ChDash sends. In an export: the bytes of the CSV or JSON text. The count follows the sending: a run goes past the ceiling by one event (in an export, one block) at most. | `query_result_limit` |
| `max_duration` | A deadline from the start of the run. At the deadline ChDash stops the statement with the cancel path (`KILL QUERY`). | `query_timeout` |

A run that goes past a ceiling ends with an `error` event that has the code in the table and the name and the value of the ceiling. An export writes the error in `error.txt` of the archive and stops. In an export, each statement has its own counters and its own deadline.

The statements that ChDash writes for the pages (Explorer, System, Traces, Logs, Metrics, the metadata of the editor) have the same backstop, because many of them carry their own `SETTINGS` clause. Each statement counts the rows and bytes read, the rows of its result and its time. Past a ceiling it ends, and the route answers as for the ClickHouse code of the same meaning (`<page>_scan_limit` or `<page>_timeout`, [operations.md](operations.md#errors)). The pages have no backstop for `max_result_size`: its setting is the only bound there. The progress packets of ClickHouse give the rows and bytes read, so a statement that reads very little can end before a packet arrives.

The pages keep shared caches of their answers. A request with a ceiling does not use them (refer to [Shared caches and ceilings](#shared-caches-and-ceilings)).

### Shared caches and ceilings

The pages keep caches of their answers, and all the persons share them ([configuration.md](configuration.md#caches-and-privileges)). An answer that comes from a cache runs no statement, so no ceiling bounds it. Thus ChDash applies this rule (decision of 2026-11-07):

- A request with a ceiling does not read a shared cache of a page. It runs its own statements, and its ceilings bound them.
- ChDash does not keep the answer of such a request in the cache. A ceiling can cut an answer, and the cut answer must not reach another person.
- A request with a ceiling also waits for no read that another request started. Its read is its own.
- A request without a ceiling uses the caches as before. The open mode has no ceiling, so it always uses the caches.
- A request has a ceiling when the answer of the PDP for the action of its route has one in `context.limits`. A route that an MCP tool calls in the mode `identity` has the ceilings of the call.

The caches that a request with a ceiling does not use:

| Page | Caches |
|---|---|
| Explorer | The catalog (the list and the objects of a database), the table card, the graph and the storage map. Also the DDL texts and the replica counts, which these answers use. |
| System | Overview, Activity, Keeper, the series, the queries, the detail of a query, the disks and the growth of the disks. The replica counts of Activity. |
| Observability | The prefill and the facets of the traces, the facets of the logs and the catalog of the metrics. |

The caches that every request uses, because a ceiling cannot change their value:

| Cache | Why |
|---|---|
| The runner ACL, the capabilities of the System page, the metadata of the editor (`GET /api/meta`) and of the signals, the functions of the Explorer (`GET /api/explorer/functions`) | The statements are internal ([Statements that a ceiling bounds](#statements-that-a-ceiling-bounds)). No ceiling applies to them. |
| The structure of the tables of the signals (the columns of the logs table, the tables of the metrics, the map columns of the traces) | The same: these reads of the schema are internal since 1.3.0. |
| The databases of the route of the options, the cost of an MCP key | The routes have no ceiling: `GET /.well-known/procurauth/resources` asks no action with a ceiling, and `mcp.usage.read` declares none. |
| The format cache, the formatted texts of the shapes of System > Queries, the DESCRIBE plans of the runs | The value is the layout of a SQL text or the types of its columns. It holds no row of a table and no count of the server. |

A request with a ceiling costs one read of ClickHouse for each request, as a cache with no entry does. The background refresh of a cache never runs for such a request.

### Statements that a ceiling bounds

A ceiling bounds the work of the person. It does not bound the work that ChDash does for itself. ChDash marks each statement of its own as internal. An internal statement ignores every ceiling, and `apply_ceilings` does nothing for it. A statement keeps the bounds of the configuration, the deadline of the request and the settings profile of the ClickHouse user.

| Statement | The ceilings apply |
|---|---|
| The SQL of the person: the run of the Query page, an export, Deep Analyze | Yes. |
| The statements that a page runs to show data: the Explorer (catalog, graph, table card and data preview), the System page, Traces, Logs, Metrics | Yes. |
| The discovery of the ACL (`CHECK GRANT`, `SHOW`, the zero-row probes and `DESCRIBE`), for the Explorer, the System page, exports, analysis and MCP | No. |
| The probes of the capabilities of the server (the tables and the columns of `system` that the System page needs, the refreshable views of the Explorer graph) | No. |
| The reads of the schema for the editor (`GET /api/meta`: keywords, functions, databases, tables, columns) | No. |
| The read of the functions of the server for the Explorer (`GET /api/explorer/functions`, `system.functions`) | No. It is the same metadata as the functions of the editor. |
| The lookup of `system.query_log` for the execution of a run, the reads of the tables of the signals of OpenTelemetry, and `SYSTEM FLUSH LOGS` | No. |
| The reads of the structure of the tables of the signals: the columns of the logs table and its skipping indexes, the tables and the scope columns of the metrics, the map columns of the traces | No. |
| The probe of the settings profile of a connection, and the checks of the health runner | No. They have no scope of a request, so no ceiling reaches them. |

The rule is in the code. A scope of statements has the flag `internal` (`ChQueryLimits::internal`). The object `ChInternalScope` sets it for the statements that follow in the same thread. The builder of an internal statement opens this object. It never opens it for the SQL of a person or for a statement that shows data.

A low ceiling of `explorer.read` therefore lets the Explorer find the objects that the runner may read. The ceiling then bounds the data statements of the page, and the page answers with its own scan or time error (`<page>_scan_limit`). The page does not answer `503` with `acl_discovery_failed`, because a retry cannot help in that case. A `503 acl_discovery_failed` always means that ClickHouse did not answer the discovery.

### Read and write

A person can hold `query.run.read` and `query.run.write`. ChDash then gets two sets of ceilings, and it classifies the SQL of the run:

- The SQL is a write when a statement changes data, the schema, the access or the settings (`INSERT`, `CREATE`, `ALTER`, `DROP`, `SET`, `SYSTEM`, `KILL` and the other commands). The ceilings of `query.run.write` apply.
- The SQL is a read when each statement only reads (`SELECT`, `WITH ... SELECT`, `SHOW`, `DESCRIBE`, `EXISTS`, `EXPLAIN`, `CHECK`). The ceilings of `query.run.read` apply.
- When ChDash cannot tell (a statement that it does not know, or a text without a statement), the lower value of each ceiling of the two actions applies.

A `SETTINGS` clause does not change the class. A person with only one of the two actions uses the ceilings of that action. The routes that ChDash guards with `query.run.read` or `query.run.write` and that run no SQL of the person (`GET /api/meta`, `POST /api/query/analysis`) use the lower value of the two sets.

### The stream of an export

The body of `POST /api/export/stream` holds only the token of the export. It names no host. ChDash stores in the job, at `POST /api/export/run`, the ceilings, the class of the SQL and `readonly = 1`. At the stream, ChDash asks `query.run.read` and `query.run.write` again on the host of the job, without `context.usage`. These are the other permissions of the use. Then, when the stream is ready to start, ChDash asks `query.export` with `context.usage`: the stream is the use of the export ([Budgets](#budgets)). The stream applies the lower value of each ceiling of the new answers and of the stored ones. The ceilings of `query.export` come from the answer with `context.usage`. A refusal of the other permissions, a failure of the PDP and a spent budget keep the job, so the person can try again with the same token while the token lives.

### Questions of the navigation

A question of the navigation has the match `subtree`. It shows or hides a page, a host or a database, and it runs no operation. A ceiling in its answer never makes it `false`. The same is true for the questions that filter the databases of a list. Only the questions that guard an operation follow the rule of ProcurAuth 7.5.

### A ceiling that ChDash cannot apply

A `true` answer for an operation is `false` when it has a ceiling that the action does not list, a name that ChDash does not know, or a value below 1. The route answers `403` with no reason. The log has the line `access.ceiling_unenforceable`.

## Budgets

A grant can carry budgets (ProcurAuth section 6). A budget is an amount of units for one window or more. The PDP counts each budget. ChDash holds no counter. ChDash declares three budgets in the member `limits` of the action document. Each declaration has the kind `budget`, a name, a label, a description and a unit. It has no `min` and no `max`.

### The three budgets

| Budget | Unit | Listed on | ChDash takes one unit when |
|---|---|---|---|
| `queries` | query | `query.run.read`, `query.run.write` | A run of SQL is accepted: `POST /api/query/run` and `POST /api/query`. Also when the replay of Deep Analyze starts (`POST /api/query/deep-analysis`). Also at each MCP call of a tool of `query.run.read` (`run_query`, `explain_query`, `format_sql`, `explorer_names`, `query_execution`): in the mode `identity` the unit is a unit of the subject of the token, and in the mode `keys` it is a unit of the creator of the key ([MCP keys](#mcp-keys)). |
| `exports` | export | `query.export` | The download of an export starts (`POST /api/export/stream`). |
| `requests` | request | `mcp.session` | An MCP request reads no data of a host (mode `identity`): `initialize`, `ping`, `server/discover`, a notification, a method that ChDash does not know, and the tools that use `mcp.session`. |

No other action lists a budget. The pages, the Explorer, the System page, the query library and the routes of the MCP page (the keys and their usage) take no unit. A budget is listed only when its action is published: `requests` is not in the document when `mcp.session` is not.

### What is a use

A use is one run of an action for one operation (ProcurAuth section 2). A question for a display is not a use. These routes ask `query.run.read` or `query.run.write` but run no SQL of the person, so they ask without `context.usage` and take no unit: `POST /api/format`, `GET /api/meta`, `POST /api/query/analysis`, `GET /api/query/execution`, and `GET /api/query/deep-analysis` (the state of a job). MCP is different: in the two modes, each call of a tool of `query.run.read` is a use, also `explain_query` and the API tools that call these routes (decision of 2026-11-07, [MCP keys](#mcp-keys)). A request that finds a Deep Analyze job that already runs takes no unit. The questions of the navigation (the match `subtree`) take none. `GET /api/query/stream` and `POST /api/query/cancel` ask nothing: the run of `POST /api/query/run` already took its unit.

A run takes its unit at `POST /api/query/run`, not at the stream of its result. ChDash takes the unit after the checks of the shape of the body (JSON, `sql`, `host_id`, the size, the `KILL` rule) and before it looks at the host. A request that ChDash refuses later has used its unit: an unknown host, a host that is down and too many sessions. An export is different. `POST /api/export/run` only prepares the job. The unit is taken at `POST /api/export/stream`, when the download starts. An export that nobody downloads costs nothing, and a refused stream keeps the job.

### The questions

ChDash sends the question of a use as one Access Evaluation request:

```json
POST {pdp.url}/access/v1/evaluation
{
  "subject":  { "type": "user", "id": "<sub of the identity token>" },
  "action":   { "name": "query.run.read" },
  "resource": { "type": "host", "id": "<host>", "properties": { "ancestors": [ { "type": "service", "id": "<identity.audience>" } ] } },
  "context":  { "usage": { "units": 1 } }
}
```

Rules:

- **One question for each use.** ChDash never sends `context.usage` in a batch, and never with the match `subtree` (ProcurAuth 6.11). It never sends the same question without `context.usage` before this question (ProcurAuth 10.1). The other permissions of the operation go before it, without `context.usage` (ProcurAuth 5.5a).
- **A run.** ChDash classifies the SQL ([Read and write](#read-and-write)). A read is a use of `query.run.read`. A write, and an SQL that ChDash does not know, are a use of `query.run.write`. ChDash first asks the action of the use with `context.usage`. No question without `context.usage` comes before it, because the other run action is no required permission: a person needs one of the two. When the answer is `true`, ChDash asks the other run action without `context.usage`. This answer gives `readonly` and the ceilings of the other class. A failure of this second question gives `503` after the unit is taken. When the first answer is a plain `false` and the unit is not taken, ChDash asks the other action with `context.usage` (ProcurAuth 10.1). It chooses in this order and stops at the first answer. A person who holds `query.run.write` only can thus run a read. ChDash never asks a second action after an answer that took a unit, after `budget_exceeded` and after a failure.
- **An export.** The other permissions are `query.run.read` and `query.run.write` on the host of the job, without `context.usage`. The use is `query.export`, with `context.usage`.
- **MCP.** The mode `identity` sends one question with `context.usage` for each request that calls no tool (`mcp.session`), for each tool of `query.run.read` (`run_query`, `explain_query`, `format_sql`, `explorer_names`, `query_execution`, on the host or the database of the call) and for the tools that use `mcp.session`. A call without `host` runs nothing: it asks the match `subtree` without `context.usage` and takes no unit. The questions of `tools/list` have no `context.usage`. The mode `keys` sends one question with `context.usage` for the creator of the key at each call of a tool of `query.run.read` ([MCP keys](#mcp-keys)).
- **No other question.** An action that the document lists with no budget gets no `context.usage`.

The check of the rule of a run asks nothing, because the action of the use depends on the SQL. The handler of the route asks, when it has the SQL. Until then the statements of the request run with `readonly = 1` and with the lowest value of each ceiling (fail closed).

### The answers

| Answer of the PDP | What ChDash does |
|---|---|
| `true` with `context.usage.units` 1 or 0 | The use runs. The ceilings of `context.limits` apply (below). |
| `true` without `context.usage.units` | ChDash treats it as `false` with no reason: `403` (ProcurAuth 6.12). |
| `true` with a ceiling that ChDash cannot apply | `403`. The PDP took the unit: ChDash does not try another action (refer to [A ceiling that ChDash cannot apply](#a-ceiling-that-chdash-cannot-apply)). |
| `false` with the reason `budget_exceeded` and `retry_after` | `429` with `Retry-After` set to `retry_after`. The body has the code `too_many_requests`. It never shows the reason. |
| `false`, any other reason | `403`. |
| `budget_exceeded` without a whole `retry_after` of 1 or more | The answer is not valid: `503`. |
| No answer before the wait, an error, a status that is not `200`, a body that is not valid | `503` with `pdp_unavailable`. |

For an action with a budget, the ceilings of the use come from the answer with `context.usage`. The answers of the other permissions give their own ceilings to their part (ProcurAuth 5.5a, 10 step 6). For MCP: the tool error `budget_exceeded` on `tools/call`, and `429` with the code `-31429` on another request ([mcp.md](mcp.md#budgets)).

### Kept answers

The cache of the PDP (`pdp.cache_ttl`) keeps the answers to the questions with `context.usage` apart from all other answers (ProcurAuth 10.1):

- ChDash never keeps a `true` answer with `units` above 0. Each use asks the PDP.
- ChDash keeps a `true` answer with `units` equal to 0 for `pdp.cache_ttl` at most. The kept answer lets the next use of this subject, action and resource run with no question.
- ChDash keeps a `false` answer with `budget_exceeded` for the lower of `retry_after` and `pdp.cache_ttl`. The kept answer gives `429` with the seconds that remain in `Retry-After`. This value is never more than the first `retry_after`.
- ChDash keeps no other answer to a question with `context.usage`.
- A kept answer to a question without `context.usage` never starts a use. A kept answer of a use never answers a question without it.

With `pdp.cache_ttl = "0s"`, ChDash keeps nothing.

### No second try

ChDash never sends a question with `context.usage` again (ProcurAuth 10.6). The client of the PDP sends it with `post_once`: the transport does not send it again after a kept connection that the PDP closed, and ChDash does not send it after a timeout, a lost answer or a connection error. The PDP can have counted the use. The units of a lost answer stay counted, and the route answers `503`. The wait for the answer is one second more than `procurauth_usage_max_seconds` of the metadata of the PDP, and never shorter than `pdp.timeout` ([Metadata of the PDP](#metadata-of-the-pdp)). `pdp.usage_max_seconds` bounds the published time: ChDash never lowers it to fit. The log line `access.decision` of a use has `usage` true, the `units` and `retry_after`.

### Choices of ChDash

- A budget has no key in the configuration. The document declares it, and the PDP holds the amounts.
- The unit of a run is taken at `POST /api/query/run`. The Query page starts the SQL at the stream of the result. A client that posts a run and never reads its stream uses its unit. The session also uses one place until it ends.
- ChDash asks nothing about a run before its handler has the SQL: the pre-check of the hosts of the former versions is gone, because it would send the question of the use without `context.usage` first. ChDash reads the body of a person that holds a valid identity token, as it does for the other routes.
- A run that ChDash refuses after its unit (a host that is down, too many sessions) does not give the unit back. ChDash cannot undo a count of the PDP.

### MCP keys

An MCP key of the mode `keys` holds no identity token. Its creator is the person who made the key (decision of 2026-11-07). A person with a budget must not run more queries through a key than the budget gives. Thus each call of a tool of `query.run.read` by a key is one use of the creator:

- The tools are `run_query`, `explain_query`, `format_sql` (`POST /api/format`), `explorer_names` (`GET /api/meta`) and `query_execution` (`GET /api/query/execution`). Each call takes one unit of the budget `queries` of the creator. On the pages, `POST /api/format`, `GET /api/meta` and `GET /api/query/execution` take no unit. Through MCP they are calls of a tool, and each call counts. The mode `identity` applies the same rule to the subject of the token.
- The question is the question of a use ([The questions](#the-questions)): the subject is the creator, the action is `query.run.read` and the resource is the host of the call. The rules of the cache and of no second try apply.
- One call takes one unit at most. An API tool calls its route in the process, and the route asks the PDP nothing.
- A refused use gives the answers of [mcp.md](mcp.md#budgets-of-the-keys): the tool error `budget_exceeded` with `retry_after` for a spent budget, HTTP `503` for no valid answer.
- The tools of the other actions take no unit. These actions list no budget.
- ChDash keeps the state of a key for `pdp.cache_ttl`, and it gets this state from one batch without `context.usage` before it reads the body. When the state expires at a call of a tool of `query.run.read`, this batch can thus go before the question of the use in the same request: the owner accepts this exception to ProcurAuth 10.1 (decision of 2026-11-07).

## Navigation

The navigation shows only the pages that the human may use (decision of 2026-10-18). This applies to the header menu, the page tabs, the start page and each link from one page to another page. In the `open` mode, every page and every link stays.

| Page | Addresses | Action on the service, on one host or below it (one of them, match `subtree`) |
|---|---|---|
| Query | `/`, `/query` | `query.run.read`, `query.run.write` |
| Explorer | `/explorer/catalog...`, `/explorer/functions...` | `explorer.read` |
| Observability | `/observability/traces...`, `/observability/logs`, `/observability/metrics` | `observability.read` |
| System | `/system...` | `system.read` |
| MCP integration (the keys) | `/mcp-integration` | `mcp.keys.read` |
| MCP usage | `/mcp-integration/usage` | `mcp.usage.read` |

Rules:

- For each page that it serves, ChDash sends one batch to the PDP: the batch of the hosts, as for `GET /api/version`. The cache of the decisions applies, so the two batches of one page normally make one call to the PDP. An address of the Explorer that names a database (`/explorer/catalog/<database>...`) also asks for `explorer.read` on that database of each host.
- A human without the action of the page gets status `403` and a page with the name of the action and a link to each page that the human may use. This page has no script and no data of the page. The log has the line `access.page_denied`.
- When the PDP gives no valid answer for the batch of a page, ChDash sends status `503` and a page that tells the human to try again later. This page is not the `403` page, and it has no script and no data. The log has the line `access.page_unavailable`. The root (`/`) does the same. `GET /api/hosts` and the stream of the hosts answer `503` with `pdp_unavailable`.
- `GET /api/version` also answers `503` with `pdp_unavailable` and the action `access`. It never gives a list of `false` decisions for a failure. The page then keeps its links and shows `access: unavailable` in the version badge.
- An address of the Explorer in one database opens with `explorer.read` on that database of one host. The Explorer link of the header needs `explorer.read` on the service, on one host or below one host (match `subtree`).
- The root (`/`) is the Query page. A human without a query action goes to the first page of the table that the human may use. A human with no page gets the `403` page.
- In the shell that it serves, ChDash hides each link to a page that the human cannot use (`hidden` and `data-denied` on each element with `data-nav-page`). The links are hidden from the first paint. The meta element `chdash-pages` lists the pages of the human for the scripts of the page. The answer has `Cache-Control: no-store`, because it is for one human.
- A human with `mcp.usage.read` and without `mcp.keys.read` keeps the MCP entry of the header. It opens the usage.
- The links between pages follow the same rules: Open in Query (Explorer and System), a table or a database of the System page (Explorer), a trace of a result row (Observability) and Open in Usage of an MCP key.
- The pages still check each action on their routes. A link that a page hides is not a permission.

## Logs and traces

- For each decision, the log has one line `access.decision` with `request_id`, `subject`, `action`, `resource`, `match` (`node` or `subtree`), `decision`, `source` (`pdp`, `cache` or `error`), `reason` (`unknown_subject`, `invalid_resource`, `invalid_request`, `budget_exceeded`, `other`, or empty) and `failed` (`true` when the PDP gave no valid answer), and `error_status` and `error_message` when the item has a `context.error`. The line never holds a token. `resource` is the path of the resource with the ids percent-encoded, for example `service:db/host:prod/database:analytics`.
- The access log (`http.request`) has the field `subject` (`-` when there is none).
- When the `telemetry` block is on, each call to the PDP is a CLIENT span `POST /access/v1/evaluation` or `POST /access/v1/evaluations`. Its parent is the span of the `traceparent` of the request; without one, the span starts a trace. The call sends the context of this span to the PDP (`traceparent`). The path of the span is the whole path of the request. Refer to [server-telemetry.md](server-telemetry.md#the-client-span-of-the-pdp).

## The MCP endpoint

The setting `mcp.auth_mode` chooses how `POST /mcp` knows its caller. The two modes never apply together on one endpoint.

- `identity`: the caller is the subject of the identity token, in the header `identity.header`. ChDash checks the token as it does for the pages, before it reads the message. A request without a valid token gets `401` with an empty body. The PDP decides each request for this subject: `mcp.session` for a request that calls no tool, one batch with the match `subtree` for `tools/list`, and the action of the tool on the host or the database of the call for `tools/call`. The subject is opaque: it can be a person or a key of the portal. The keys of ChDash are ignored. The mode needs `access.mode = "authzen"`. Refer to [mcp.md](mcp.md#the-identity-mode).
- `keys` (the default): the text below applies.

In the mode `keys`, `POST /mcp` needs no identity token. It keeps its keys (contract section 3, [mcp.md](mcp.md)). The API tools of MCP call the routes of the API in the process (the context of an MCP call): these calls need no identity token and ask no PDP for each route. The keys, their tools, their scope and the MCP ClickHouse user limit them.

A key of the page never has more than its creator ([mcp.md](mcp.md#keys-and-the-access-of-humans)). `mcp.keys.write` alone does not let a person make a key with a read action that the PDP refuses to that person. When a key is made, ChDash asks the PDP for the person and each action that the tools of the key use, on the host of the key (and on its databases for the tools of the data). The key keeps its creator. `tools/list` shows only the tools whose actions the creator holds (one batch for each key and each `pdp.cache_ttl`). `tools/call` asks the PDP for the actions of the called tool only. A key with no creator, or whose creator the PDP does not know (the reason `unknown_subject`), gets the `401` of a key that does not exist until a person adopts it ([mcp.md](mcp.md#orphan-keys-and-their-adoption)). A creator who gets `false` without this reason still exists: the key keeps this creator, and each tool of a refused action is refused. A key of the configuration is not checked.

## Transport

The link between ChDash and the PDP carries the token of this server and each decision. ProcurAuth 10, step 4 says that the PEP MUST secure this link (AuthZEN 1.0, l.1739). ChDash secures it with TLS.

ChDash had no TLS client up to version 1.2.0. From version 1.2.1 it has one for ClickHouse (refer to [configuration.md](configuration.md#tls-to-clickhouse)). The PDP link uses the same static OpenSSL, in `src/pdp_transport.cpp`.

### https

- Use an `https` URL in `pdp.url`. The release binaries have the TLS client. A build from the source needs `-DCHDASH_TLS=ON`. A build without it stops the start with a message that names this option.
- ChDash verifies the certificate chain and the host name of the URL (RFC 6125). For an IP address in the URL, it checks the IP entries of the certificate. The lowest TLS version is 1.2.
- `pdp.ca_file` names a file of PEM certificates. It replaces the store of the system. Without it, ChDash reads the store in the directory of the OpenSSL of the build (`/etc/ssl`). ChDash never reads `SSL_CERT_FILE` or `SSL_CERT_DIR`: the configuration file is the only source.
- `pdp.verify = false` turns off the check of the chain and of the name. ChDash then writes a `config.warning` at each start. Use it only to test. `pdp.verify = false` together with `pdp.ca_file` stops the start, because the CA file is then never used.
- A request that fails in the TLS handshake is a failure of the PDP (503). The log line `access.pdp_failed` gives the cause, for example the certificate that is not valid.
- `tests/tls/pdp.sh` tests these cases with Docker: a verified chain and name, an unknown CA, a name that is not in the certificate, `verify = false`, and an `http` URL to an `https` port.

### http

An `http` URL is accepted. When the host is not `localhost`, `127.0.0.0/8` or `::1`, ChDash writes a `config.warning` at each start. It says that the token and the decisions go in clear text. Use `http` only on a network that only ChDash and the PDP reach (for example a network of the containers that only they join, or the loopback of one pod). Keep the PDP endpoints off the network of the reverse proxy.

### Connections and the deadline

- ChDash keeps up to 4 idle connections to the PDP open (ProcurAuth 10.7). A request takes an idle connection, or opens a new one. A connection with `Connection: close` or with no length is not kept.
- ChDash closes an idle connection after 5 seconds. When the metadata has `procurauth_idle_max_seconds`, it closes after half of that time.
- Each request has one deadline, `pdp.timeout`. It covers the connect, the TLS handshake, the write and the read together. The lookup of a name has no deadline of its own.
- A connection that the PDP closed while it was idle is found before the write. When a kept connection fails before the first byte of the answer, ChDash sends a question once more on a new connection, in the same deadline. It never does this for a question with `context.usage` (ProcurAuth 10.6).
- ChDash reads at most 1 MiB of an answer, and never follows a redirect.
- The PDP echoes `X-Request-ID` (AuthZEN 1.0, l.1449-1451). When it does not, or when the value is not the one that ChDash sent, ChDash writes the warning `access.pdp_request_id` (at most once each minute). The answer stays valid.

### Metadata of the PDP

At the start, ChDash reads `GET <origin>/.well-known/authzen-configuration[<path>]`. The well-known string goes between the host and the path of `pdp.url` (AuthZEN 1.0, l.1317). ChDash sends no token with this request.

- A status `404` means that the PDP has no metadata. ChDash uses the default endpoints `<pdp.url>/access/v1/evaluation` and `<pdp.url>/access/v1/evaluations`. It does not use Resource Search.
- A valid document gives the endpoints `access_evaluation_endpoint` and `access_evaluations_endpoint` (both required by ChDash), and `search_resource_endpoint` (optional). A member that ChDash does not know is ignored (AuthZEN 1.0, l.1342).
- `policy_decision_point` must be `pdp.url` (a slash at the end does not count) (AuthZEN 1.0, l.1364). Each endpoint must have the scheme, the host and the port of `pdp.url`. Thus the token goes to this origin only.
- The members `procurauth_usage_max_seconds`, `procurauth_idle_max_seconds`, `procurauth_evaluations_max_bytes` and `procurauth_evaluations_max_items` (ProcurAuth 6.9, 10.7, 10.7a) are whole numbers from 1. ChDash uses them for the idle time, the wait of a question with `context.usage` (one second more than the published time, never less than `pdp.timeout`) and the size of a request.
- `procurauth_usage_max_seconds` must not be above `pdp.usage_max_seconds` (`120` by default). Thus the wait is never longer than this limit plus one second, or `pdp.timeout` when it is longer. ChDash never lowers the published time to fit (decision of 2026-11-07). A higher value at the start stops the start. The message names `access.pdp.usage_max_seconds`, the value of the metadata and the limit. Raise the key (3600 at most), or lower the time of the PDP. A higher value in a document that ChDash reads after the start makes this document not valid: the questions fail (`503`) until a good document comes. Without the member, the wait is `pdp.timeout`. The portal 5.0.2 does not publish the member.
- A document that cannot be used stops the start. The message names `access.pdp.url` and the cause.
- A PDP that does not answer at the start does not stop the start: the portal can restart after ChDash. ChDash writes the line `access.pdp_metadata_failed`. Until it reads the metadata, each question fails (503), without a request to the PDP. ChDash tries again at a question, at most once each second.
- A good document is read again after one hour. When this fails, the old document stays in use. A document that is not valid then is not used: questions fail until a good document comes.
- The start writes `access.pdp_metadata` with the endpoints that apply.

### Resource Search

The Resource Search is an option. ChDash uses it only for the lists of databases: the route of the options (type `database`) and the catalog of the Explorer. It never uses it for a decision on one resource.

The client is `PdpClient::search_resources`. It sends the subject, the action, the type of the resource without an `id` (AuthZEN 1.0, l.1166) and the chain in `resource.properties.ancestors`. It follows `page.next_token` (l.916-960) until the token is empty. It stops after 10 pages or 1000 ids and marks the result as cut. A result of another type, a page that is not valid, or a token that comes again is a failure.

ChDash uses the search only when both conditions are true:

- The configuration has `access.pdp.search = true`. The default is `false`.
- The metadata of the PDP names `search_resource_endpoint` (l.1296-1299). Without this member, the PDP is not capable of the search, and ChDash sends the evaluations.

The first condition is there for a reason. A search that is scoped to one host is an extension. A search request in AuthZEN 1.0 has the members `subject`, `action`, `resource`, `context` and `page` (l.1157-1172). It has no scope, and `properties.ancestors` is not a member that the API defines. Issue #761 of the AuthZEN repository, which is open, proposes a scoped search. ProcurAuth 14 says that its protocol does not define it. ProcurAuth has no metadata member that announces a scoped search. So `search_resource_endpoint` alone does not say that the PDP applies the chain. Set `pdp.search = true` only for a PDP that you know applies it.

A PDP that ignores `properties.ancestors` returns the same ids for every host. ChDash handles this case: it keeps only the ids that are databases of the host (`SHOW DATABASES` with the runner account). A person who may see a database of host A is then not shown a database of the same name on host B by the search alone. Use a PDP that applies the chain when the grants differ between hosts with the same database names.

The steps for one list, for one host:

1. For each published action whose resource types hold `database`, ChDash asks the PDP one evaluation on the host with the match `node`. The route of the options uses each such action. The catalog uses `explorer.read`. The PDP applies the chain, so a grant on the host or on the service gives `true`. One `true` answer makes every database of the host visible, and ChDash sends no search. A search returns only the ids that the PDP knows, so it could not show this case.
2. Otherwise ChDash sends one search for each of these actions, with the type `database` and the ancestors `[service, host]`. The ancestors are the same as in an evaluation.
3. The result is the union of the ids of all the actions. A database that is not in the union stays hidden. ChDash does not ask the PDP again for it.
4. ChDash intersects the union with the databases that exist on the host. The route of the options pages this set on its own, with the same order, `q`, `limit` and cursor as without the search. The PDP result is a set, so a page cannot repeat or skip an id when the PDP changes the order of its answer.

A request that names a database does not use the search. It asks the PDP with an evaluation and the match `node`, as without the search.

ChDash falls back to the evaluations of each database, for this request only, in these cases:

- The search fails (no answer, a status that is not 200, a page that is not valid).
- A bound cuts the result (10 pages or 1000 ids for one action). The beginning of a set is not the set.
- A decision of step 1 fails.

For each fallback, ChDash writes the log event `access.search_fallback` with `request_id`, `host` and `reason`. A failed search never gives an empty list and never gives `503` alone: the evaluations then decide, and they give `503` when the PDP gives no valid answer (ProcurAuth 10.3). ChDash does not cache a search. At the start, `access.search_mode` tells whether the metadata announces the endpoint.

## Signature code

The code of the signatures does not use OpenSSL. ChDash verifies the signatures with two small C libraries that the build fetches by commit (`src/CMakeLists.txt`): Monocypher 4.0.2 for Ed25519 and micro-ecc for P-256. ChDash only verifies signatures with public keys. `src/signature_verify.cpp` is the one place that calls these libraries.

## Tests

The ProcurAuth runner tests ChDash as a PEP with the cases of the series U. Run it with `tests/conformance/run.sh` ([conformance.md](conformance.md)). The tests of ChDash below test the choices of ChDash and the routes that the cases do not reach.

| Behaviour | Test |
|---|---|
| A configuration without an `access` block does not start | `tests/native/config_test.cpp` (`test_access_block`), and `test_a_configuration_without_an_access_block_does_not_start` of `tests/backend-functional/test_access.py` when `MCP_STARTUP_CMD` is set |
| The identity token (status `401`) | `test_a_request_without_a_token_gets_401`, `test_a_token_that_is_not_valid_gets_401` and `test_a_token_outside_the_identity_header_gets_401` of `test_access.py`, against the compose services `chdash_access` (`tests/config/access.authzen.hcl`) and `access_pdp` (the fake PDP, `tests/otel-fixture/fake_pdp.py`) |
| The action document and its path | `test_the_actions_are_published_without_a_token` and `test_the_former_path_of_the_document_has_no_route` of `test_access.py` |
| The questions, the decisions and the failures of the PDP | `test_the_pdp_receives_the_subject_the_action_and_the_host`, `test_a_false_decision_gives_403_with_the_action_and_a_true_one_200`, `test_no_answer_or_an_error_of_the_pdp_gives_503` and `test_a_change_of_the_answer_applies_after_cache_ttl_at_most` of `test_access.py` |
| The log of the decisions | `test_the_log_has_each_decision` of `test_access.py` when `ACCESS_LOGS_CMD` prints the log of `chdash_access` |
| The identity mode of MCP (MCP binding, cases U18, U23, U25 to U31 and U85 to U99) | `tests/native/mcp_test.cpp` (`test_identity_mode`), and `tests/backend-functional/test_mcp_identity.py` against the compose service `chdash_mcp_identity` (`tests/config/mcp.identity.hcl`) |
| The budgets (ProcurAuth 6.4, 6.11, 6.12, 10.1, 10.6; MCP binding 3.4, 3.6a, 5.3, 5.4) | `tests/native/access_test.cpp` (`test_budgets_in_the_document`, `test_pdp_use`, `test_pdp_use_waits_for_the_pdp`, `test_run_use`), `tests/native/mcp_test.cpp` (`test_identity_budgets`), `tests/backend-functional/test_access.py` (the tests `test_a_run_sends_one_question_with_usage_and_no_same_question_without_it`, `test_budget_exceeded_gives_429_with_retry_after_for_a_run`, `test_a_failure_of_the_question_with_usage_gives_503_and_it_is_sent_one_time` and `test_the_stream_of_an_export_takes_the_unit_and_the_run_takes_none`), `tests/backend-functional/test_mcp_identity.py` (the tests `test_u18...` to `test_u95...` on the budgets) and the cases of the ProcurAuth runner U04, U19, U21, U22, U24, U32, U33, U58, U62, U63, U67, U68 (`tests/conformance`) |
| The budget `queries` of the creator of an MCP key of the mode `keys` (decision of 2026-11-07) | `tests/native/mcp_test.cpp` (`test_creator_budgets`): one question with `context.usage` on the host of the call for each tool of `query.run.read`, none without it, `budget_exceeded`, `503` for a failure, no unit for the other tools; `test_a_query_tool_of_an_mcp_key_takes_a_unit_of_the_budget_of_its_creator` of `test_access.py` |
| A request with a ceiling neither reads nor fills a shared cache of a page (decision of 2026-11-07) | `tests/native/cache_acl_test.cpp` (`ttl_cache_a_request_with_a_ceiling_neither_reads_nor_keeps`, `ddl_text_cache_a_request_with_a_ceiling_reads_every_text_and_keeps_none`), and `test_a_request_with_a_ceiling_neither_reads_nor_fills_the_shared_cache_of_a_page` of `test_access.py` |
| The deadline of a split batch and the limit of the wait of a use (decision of 2026-11-07) | `tests/native/pdp_transport_cases.hpp` (`test_pdp_batch_deadline`), `tests/native/access_test.cpp` (`test_pdp_usage_wait_limit`), `tests/native/config_test.cpp` (the keys `access.pdp.batch_timeout` and `access.pdp.usage_max_seconds`), and the case 10 of `tests/tls/pdp.sh` (the start stops above the limit) |
| The reason `unknown_subject` (ProcurAuth 11.1) | `test_an_orphan_mcp_key_is_refused_until_a_person_adopts_it` and `test_a_creator_without_permissions_keeps_the_key` of `test_access.py`; `tests/native/access_test.cpp` (the answer) and `tests/native/mcp_test.cpp` (`test_creator_access`) |

The hosts (two hosts, a grant on one host, a grant on one database of one host, the one-level grant of 1.0.8, `readonly = 1` for each host) have tests at two levels. `test_host_hierarchy` of `tests/native/access_test.cpp` uses a PDP of the tests with the prefix rule (`tests/native/access_grants.hpp`). The tests of the hosts in `test_access.py` use the fake PDP, which applies the same rule (`tests/otel-fixture/fake_pdp.py`).

`tests/native/access_test.cpp` (CMake option `CHDASH_BUILD_ACCESS_TESTS`, target `chdash_access_test`) checks the signatures against the vectors of RFC 8032, RFC 8037, RFC 6979 and RFC 7515, the PEM keys, each rule of the identity token, the rule of each route, and the client of the PDP on a fake transport (the body, the headers, the cache, fail closed, the reason `unknown_subject`). `tests/backend-functional/identity_tokens.py` signs the test tokens in pure Python, with the test keys of `tests/config/secrets/access-identity-keys.pem`.
