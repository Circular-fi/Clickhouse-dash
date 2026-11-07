# Access of humans

This document uses ASD-STE100 Simplified Technical English.

ChDash obeys section 11 of the MCP server contract (`mcp-server-contract/SPEC.md`, "Access of humans (AuthZEN)"). This section applies to the pages and to the API of ChDash. It does not apply to the MCP endpoint `POST /mcp`: the agents use the keys of the `mcp` block ([mcp.md](mcp.md)).

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
| `pdp.url` | (required) | The base URL of the PDP: `http://host[:port][/path]`. It has the forms `url`, `url_env` and `url_file`. Give exactly one. |
| `pdp.token_env`, `pdp.token_file` | (required) | The token of this server at the PDP. It is a secret: give exactly one of the two forms. A token in clear text (`token = "..."`) stops the start. |
| `pdp.timeout` | `500ms` | The time of one request to the PDP. From `10ms` to `1m`. |
| `pdp.cache_ttl` | `30s` | The longest time that ChDash keeps an answer of the PDP. From `0s` (no cache) to `1h`. |

These items stop the start:

- No `access` block, no `mode`, or a `mode` that is not `authzen` or `open`.
- `mode = "open"` with an `identity` block or a `pdp` block. The two contradict each other.
- `mode = "authzen"` without the `identity` block or the `pdp` block, or without one of their required keys.
- A key text that does not hold only Ed25519 or P-256 public keys, or a P-256 point that is not on the curve.
- A JWK Set with a private member (`d`), with a `kty` or `crv` that ChDash does not accept, or with two keys of the same `kid`.
- An `https` URL. ChDash has no TLS client (refer to [Deviation from AuthZEN: no TLS](#deviation-from-authzen-no-tls)).
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

These routes need no token: `/livez`, `/readyz`, `/healthz`, `/metrics`, `GET /.well-known/procurauth/actions` and `/mcp`. Keep `/metrics` on the internal network.

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

The navigation follows the document: a page whose actions are not published has no link, and `GET /api/version` lists the published actions only. A system that holds grants (the portal) keeps a grant for an action that is not published. The grant applies again when the action is published again, for example when you set `mcp.enabled = true`. ChDash reads the configuration at start: a change of these settings needs a restart.

| Action | Resource types | Routes |
|---|---|---|
| `query.run.read` | `service`, `host`, `database` | `POST /api/query/run`, `POST /api/query`, `POST /api/query/analysis`, `POST` and `GET /api/query/deep-analysis`, `GET /api/query/execution`, `POST /api/format`, `GET /api/meta` |
| `query.run.write` | `service`, `host`, `database` | The same routes. Without it, the statements of a run run with `readonly = 1`. |
| `query.export` | `service`, `host` | `POST /api/export/run`, `/api/export/stream`. An export also needs `query.run.read` or `query.run.write`. |
| `library.read` | `service` | `GET /api/query-library...` |
| `library.write` | `service` | `POST`, `PATCH` and `DELETE /api/query-library...` |
| `explorer.read` | `service`, `host`, `database` | `/api/explorer/...`, except `/api/explorer/ops/...` |
| `system.read` | `service`, `host` | `/api/system/...`, `/api/explorer/ops/...` |
| `observability.read` | `service`, `host` | `/api/traces/...`, `/api/logs/...`, `/api/metrics/...` |
| `mcp.keys.read` | `service` | `GET /api/mcp/keys`, `GET /api/mcp/keys/<id>/access`, `GET /api/mcp/access` |
| `mcp.keys.write` | `service` | `POST /api/mcp/keys`, `DELETE /api/mcp/keys/<id>`, `POST /api/mcp/keys/<id>/adopt` |
| `mcp.usage.read` | `service` | `GET /api/mcp/usage`, `GET /api/mcp/usage/overview`, `GET /api/mcp/keys/<id>/usage`, `GET /api/mcp/keys/<id>/cost` |

The shell of each page needs the action of its page (refer to [Navigation](#navigation)). These routes need a valid token and no action: the files of `/static/`, the redirects of the former addresses, `GET /api/version`, `GET /api/hosts`, `GET /api/hosts/stream`, `GET /api/health`, `GET /api/mcp/meta`, `GET /.well-known/procurauth/resources` (refer to [The route of the options](#the-route-of-the-options)), and the routes of a capability that a checked request gave: `GET /api/query/stream`, `POST /api/query/cancel` and `POST /api/query/deep-analysis/cancel`.

A route that is not in this table is refused with `403` and the action `unknown` (fail closed), and the log has the line `access.no_rule`. A path that has no route gets `404`.

When you remove or rename an action, or change its resource types, write the change in the release notes.

## Resources and hosts

ChDash 1.1.0 and later put each resource in a tree under the service (contract 11.4, decision of 2026-10-18):

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

The match tells the PDP which grants apply to a question (addendum 1 of the format, contract 11.5):

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

Rules:

- A request without `host_id` names the only host of a configuration that has one host, as the routes do.
- A `host_id` that is not a host of the configuration makes a question on the service. Thus the PDP never receives a host name that the client chose.
- A `database` that no grant can name makes a question on its host. Such a name is empty, has more than 256 bytes, is not UTF-8 or has a control character. Only a grant on the host or on the service can cover it.
- `query.export` does not take `database` since 1.1.0. ChDash 1.0.8 never asked it for a database.
- For a route that has the host in its JSON body, ChDash reads the body first. Before it reads the body, a run needs `query.run.read` or `query.run.write` on one host at least (match `node`). An export also needs `query.export` on one host at least. Without them, the answer is `403` before the body is read.

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
- One request asks the PDP 200 questions at most. When the bound is reached, the answer holds the items found so far and a `next` cursor. The answer can then have no item and a `next` value: ask again with `after`.
- The databases come from `SHOW DATABASES` with the runner account of the host. The route removes `system` and `information_schema`. ChDash keeps the list for 30 seconds. The list is the same for every human. The decisions are not in it.
- ChDash runs `SHOW DATABASES` only for a host that the human can see. A host that does not exist or that the human cannot see gives an answer with no item.
- When the PDP gives no valid answer, the route gives `503` (retryable).
- ChDash applies no other rule that removes a child.

### Upgrade from 1.0.8

- A grant of one level on a database (`<action> on service:<id>/database:<name>`) covered that database on every host. Its chain does not follow the tree any more, so it covers nothing. Give the grant again on the database of one host: `<action> on service:<id>/host:<host>/database:<name>`.
- A grant on the service does not change.
- The PDP must read `properties.ancestors`, the match of the `context` and the top-level `resource_types` of the list of actions (contract 11.4 and 11.5). Update the PDP before you update ChDash. A PDP of the 1.0.8 format does not know the hosts: with it, only the grants on the service give the same decisions.

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

For more than one question, ChDash sends one batch to `POST {pdp.url}/access/v1/evaluations`, with the subject at the top and the action and the resource of each evaluation. The answer is `{"decision": true|false}`, or `{"evaluations": [{"decision": ...}, ...]}` in the order of the questions.

Rules:

- The resource of each question follows the table of [Resources and hosts](#resources-and-hosts). The Query page and the export name no database: for them ChDash asks for the host.
- Each call has `Authorization: Bearer <pdp token>`, `X-Request-ID` (the request id of the request that asks) and a `traceparent`.
- **Fail closed.** No answer before `pdp.timeout`, a connection error, a status that is not `200`, a body that is larger than 256 KiB, and a body that is not a valid answer make each question of the call a failure. A failure is `false`, but it is not a denial: the route answers `503` (refer to [Enforcement](#enforcement)). ChDash writes the line `access.pdp_failed` and never keeps a failure. A status `401` or `403` of the PDP is also a failure: the PDP refuses the credential of ChDash.
- A decision can have a `context` object. A `context` that is not an object makes the answer not valid. ChDash reads these members of `context` (ProcurAuth 6.12, 7.3, 11.1) and ignores the other members:
  - `reason` of a `false` decision: `unknown_subject`, `invalid_resource`, `invalid_request` or `budget_exceeded`. Another value means "no permission". ChDash uses `unknown_subject`, and only this reason, to make an MCP key of that subject an orphan ([mcp.md](mcp.md#orphan-keys-and-their-adoption)).
  - `retry_after` of a `false` decision with `budget_exceeded`: a whole number of seconds, 1 or more. Without a valid `retry_after`, the answer is not valid.
  - `limits` of a `true` decision: an object of ceilings, each with a whole number from 0. Another type, a negative number, a fraction or a name two times makes the answer not valid. ChDash ignores `limits` on a `false` decision (ProcurAuth 7.6).
  - `usage.units` of a `true` decision: 0 or 1. Another value makes the answer not valid.
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
- No answer gives the reason of the PDP (ProcurAuth 10.3).
- **Ceilings.** A ceiling of `context.limits` is mandatory to understand (ProcurAuth 7.5). ChDash declares no ceiling yet. Thus a `true` answer with a ceiling is a `false` answer with no reason: the route answers `403`. The log has the line `access.ceiling_unenforceable` with the action, the resource and the name of the ceiling.
- A run without `query.run.write` on its host runs each statement with `readonly = 1`. For `GET /api/meta` with `database`, the decisions apply to that database of the host. ClickHouse then refuses a statement that changes data or settings, also a `SETTINGS` clause and `SET`. ChDash sends `readonly = 1` also when it cannot read the settings profile of the runner (fail closed). A run needs `query.run.read` or `query.run.write`: without the two, the answer is `403` with the action `query.run.read`. The same rule applies to Deep Analyze and to the statements of an export. An export also needs `query.export`: without it, the answer is `403` with the action `query.export`.
- The pages hide what the subject cannot do. `GET /api/version` gives the decisions in `features.access`, and the pages read them. The host picker of a page shows only the hosts on which the subject holds an action of that page. The query library needs `library.read` (and `library.write` to change it). `GET /api/mcp/meta` says `can_manage = false` without `mcp.keys.write`, so the MCP page shows no New key and no Delete. The pages and their links follow the rules of [Navigation](#navigation).

### Limits of a grant on one database

- A grant on a database applies to that database of one host only. The same database name on another host is another resource.
- A grant on a database applies to the Explorer route that names this database. The catalog of all the databases (`GET /api/explorer/catalog` without `database`) needs `explorer.read` on the host.
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
- An address of the Explorer in one database opens with `explorer.read` on that database of one host. The Explorer link of the header needs `explorer.read` on the service, on one host or below one host (match `subtree`).
- The root (`/`) is the Query page. A human without a query action goes to the first page of the table that the human may use. A human with no page gets the `403` page.
- In the shell that it serves, ChDash hides each link to a page that the human cannot use (`hidden` and `data-denied` on each element with `data-nav-page`). The links are hidden from the first paint. The meta element `chdash-pages` lists the pages of the human for the scripts of the page. The answer has `Cache-Control: no-store`, because it is for one human.
- A human with `mcp.usage.read` and without `mcp.keys.read` keeps the MCP entry of the header. It opens the usage.
- The links between pages follow the same rules: Open in Query (Explorer and System), a table or a database of the System page (Explorer), a trace of a result row (Observability) and Open in Usage of an MCP key.
- The pages still check each action on their routes. A link that a page hides is not a permission.

## Logs and traces

- For each decision, the log has one line `access.decision` with `request_id`, `subject`, `action`, `resource`, `match` (`node` or `subtree`), `decision`, `source` (`pdp`, `cache` or `error`), `reason` (`unknown_subject`, `invalid_resource`, `invalid_request`, `budget_exceeded`, `other`, or empty) and `failed` (`true` when the PDP gave no valid answer). The line never holds a token. `resource` is the path of the resource with the ids percent-encoded, for example `service:db/host:prod/database:analytics`.
- The access log (`http.request`) has the field `subject` (`-` when there is none).
- When the `telemetry` block is on, each call to the PDP is a CLIENT span `POST /access/v1/evaluation` or `POST /access/v1/evaluations`. Its parent is the span of the `traceparent` of the request; without one, the span starts a trace. The call sends the context of this span to the PDP (`traceparent`). Refer to [server-telemetry.md](server-telemetry.md#the-client-span-of-the-pdp).

## The MCP endpoint

`POST /mcp` needs no identity token. It keeps its keys (contract section 3, [mcp.md](mcp.md)). The API tools of MCP call the routes of the API in the process (the context of an MCP call): these calls need no identity token and ask no PDP for each route. The keys, their tools, their scope and the MCP ClickHouse user limit them.

A key of the page never has more than its creator ([mcp.md](mcp.md#keys-and-the-access-of-humans)). `mcp.keys.write` alone does not let a person make a key with a read action that the PDP refuses to that person. When a key is made, ChDash asks the PDP for the person and each action that the tools of the key use, on the host of the key (and on its databases for the tools of the data). The key keeps its creator. `tools/list` shows only the tools whose actions the creator holds (one batch for each key and each `pdp.cache_ttl`). `tools/call` asks the PDP for the actions of the called tool only. A key with no creator, or whose creator the PDP does not know (the reason `unknown_subject`), gets the `401` of a key that does not exist until a person adopts it ([mcp.md](mcp.md#orphan-keys-and-their-adoption)). A creator who gets `false` without this reason still exists: the key keeps this creator, and each tool of a refused action is refused. A key of the configuration is not checked.

## Deviation from AuthZEN: no TLS

AuthZEN requires a secure connection to the PDP. ChDash has no TLS client, so `pdp.url` must use `http`. The deployment must limit the network between ChDash and the PDP to these two programs (for example a network of the containers that only they join, or the loopback of one pod). Keep the PDP endpoints off the network of the reverse proxy.

## Signature code

The build has no OpenSSL: the release binary is a static musl executable. ChDash verifies the signatures with two small C libraries that the build fetches by commit (`src/CMakeLists.txt`): Monocypher 4.0.2 for Ed25519 and micro-ecc for P-256. ChDash only verifies signatures with public keys. `src/signature_verify.cpp` is the one place that calls these libraries.

## Tests

| Contract case | Test |
|---|---|
| U01 (no `access` block) | `tests/native/config_test.cpp` (`test_access_block`), and `test_u01_...` of `tests/backend-functional/test_access.py` when `MCP_STARTUP_CMD` is set |
| U02 to U09 | `tests/backend-functional/test_access.py`, against the compose services `chdash_access` (`tests/config/access.authzen.hcl`) and `access_pdp` (the fake PDP, `tests/otel-fixture/fake_pdp.py`) |
| U10 (the log) | `test_u10_...` of `test_access.py` when `ACCESS_LOGS_CMD` prints the log of `chdash_access` |
| U11 (the reason `unknown_subject`) | `test_an_orphan_mcp_key_is_refused_until_a_person_adopts_it` and `test_a_creator_without_permissions_keeps_the_key` of `test_access.py`; `tests/native/access_test.cpp` (the answer) and `tests/native/mcp_test.cpp` (`test_creator_access`) |

The hosts (two hosts, a grant on one host, a grant on one database of one host, the one-level grant of 1.0.8, `readonly = 1` for each host) have tests at two levels. `test_host_hierarchy` of `tests/native/access_test.cpp` uses a PDP of the tests with the prefix rule (`tests/native/access_grants.hpp`). The tests of the hosts in `test_access.py` use the fake PDP, which applies the same rule (`tests/otel-fixture/fake_pdp.py`).

`tests/native/access_test.cpp` (CMake option `CHDASH_BUILD_ACCESS_TESTS`, target `chdash_access_test`) checks the signatures against the vectors of RFC 8032, RFC 8037, RFC 6979 and RFC 7515, the PEM keys, each rule of the identity token, the rule of each route, and the client of the PDP on a fake transport (the body, the headers, the cache, fail closed, the reason `unknown_subject`). `tests/backend-functional/identity_tokens.py` signs the test tokens in pure Python, with the test keys of `tests/config/secrets/access-identity-keys.pem`.
