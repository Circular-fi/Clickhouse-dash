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
| `identity.audience` | (required) | The name of this server. The `aud` claim must contain it. It is also the `id` of the `service` resource and the `server` of the list of actions. |
| `identity.public_keys` | (required) | The public keys of the issuer in PEM: 1 to 16 `-----BEGIN PUBLIC KEY-----` blocks. Each key is Ed25519 (`EdDSA`) or P-256 with an uncompressed point (`ES256`). It has the forms `public_keys`, `public_keys_env` and `public_keys_file`. Give exactly one. |
| `identity.max_age` | `5m` | The longest life of a token (`exp - iat`). From `1s` to `24h`. |
| `pdp.url` | (required) | The base URL of the PDP: `http://host[:port][/path]`. It has the forms `url`, `url_env` and `url_file`. Give exactly one. |
| `pdp.token_env`, `pdp.token_file` | (required) | The token of this server at the PDP. It is a secret: give exactly one of the two forms. A token in clear text (`token = "..."`) stops the start. |
| `pdp.timeout` | `500ms` | The time of one request to the PDP. From `10ms` to `1m`. |
| `pdp.cache_ttl` | `30s` | The longest time that ChDash keeps an answer of the PDP. From `0s` (no cache) to `1h`. |

These items stop the start:

- No `access` block, no `mode`, or a `mode` that is not `authzen` or `open`.
- `mode = "open"` with an `identity` block or a `pdp` block. The two contradict each other.
- `mode = "authzen"` without the `identity` block or the `pdp` block, or without one of their required keys.
- A PEM text that does not hold only Ed25519 or P-256 public keys, or a P-256 point that is not on the curve.
- An `https` URL. ChDash has no TLS client (refer to [Deviation from AuthZEN: no TLS](#deviation-from-authzen-no-tls)).
- A token of the PDP that holds a space, a control character or more than 4096 bytes. The error does not show the token.

With `mode = "open"`, ChDash writes the warning `config.warning` at each start. Use the open mode only for a server alone on a closed network.

`--print-config` shows each value with its source. It shows the keys as their type and their JWK thumbprint (RFC 7638), for example `["Ed25519 kid=kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k"]`. It shows the token of the PDP as `<hidden>`. [configuration-reference.md](configuration-reference.md) is the generated list of the keys.

## Identity token

The identity token is a JWT (RFC 7519) in the compact JWS form. ChDash verifies these items on each request:

| Item | Rule |
|---|---|
| Header | `alg` is `EdDSA` (Ed25519) or `ES256` (P-256, SHA-256). A header with `crit`, or a `typ` that is not `JWT`, is refused. ChDash never fetches a key: `jku`, `x5u` and `jwk` have no effect. ChDash tries each configured key of the algorithm, so a rotation can use two keys. |
| Signature | It must be valid for one of the configured keys. |
| `iss` | It must be equal to `identity.issuer`. |
| `aud` | A text equal to `identity.audience`, or a list that contains it. |
| `iat`, `exp` | Both are required. `exp` must be after the current time, with no tolerance. `iat` can be 60 seconds in the future at most (the clock of the gateway can be in advance). `exp - iat` must not be more than `identity.max_age`. |
| `nbf` | When it is present, it can be 60 seconds in the future at most. |
| `sub` | The name of the human: 1 to 256 bytes, no control character. It is the AuthZEN subject `id`. |

ChDash accepts the token only in the configured header. It does not accept a token in a cookie or in a query parameter. Two copies of the header are refused: the reverse proxy must replace a header of the same name that the client sends.

If the token is absent or not valid, ChDash sends status `401` with `{"error_code": "unauthenticated"}`. It does not show a login page and does not redirect: the access gateway does that. The log line `access.unauthenticated` gives the reason (`missing`, `malformed`, `algorithm`, `signature`, `issuer`, `audience`, `expired`, `not_yet_valid`, `max_age`, `subject`). The answer does not give it.

ChDash keeps a verified token (its SHA-256, its subject and its `exp`) in memory until its `exp`. A token in the cache is not accepted after its `exp`.

ChDash checks the token when a request starts. A stream that started with a valid token (the result of a run, the status of the hosts, an export) continues after the `exp` of the token. The next request needs a new token.

These routes need no token: `/livez`, `/readyz`, `/healthz`, `/metrics`, `GET /.well-known/access-actions` and `/mcp`. Keep `/metrics` on the internal network.

## Actions

ChDash publishes its actions at `GET /.well-known/access-actions`, without a token:

```json
{
  "server": "db",
  "actions": [
    { "name": "query.run.read", "resource_types": ["service", "database"], "description": "..." }
  ]
}
```

`server` is `identity.audience` (`chdash` in the open mode). The list does not contain `access`.

| Action | Resource types | Routes |
|---|---|---|
| `query.run.read` | `service`, `database` | `POST /api/query/run`, `POST /api/query`, `POST /api/query/analysis`, `POST` and `GET /api/query/deep-analysis`, `GET /api/query/execution`, `POST /api/format`, `GET /api/meta` |
| `query.run.write` | `service`, `database` | The same routes. Without it, the statements of a run run with `readonly = 1`. |
| `query.export` | `service`, `database` | `POST /api/export/run`, `/api/export/stream`. An export also needs `query.run.read` or `query.run.write`. |
| `library.read` | `service` | `GET /api/query-library...` |
| `library.write` | `service` | `POST`, `PATCH` and `DELETE /api/query-library...` |
| `explorer.read` | `service`, `database` | `/api/explorer/...`, except `/api/explorer/ops/...` |
| `system.read` | `service` | `/api/system/...`, `/api/explorer/ops/...` |
| `system.kill_query` | `service` | None now. ChDash has no control that stops the queries of other users. The action is reserved for it. |
| `observability.read` | `service` | `/api/traces/...`, `/api/logs/...`, `/api/metrics/...` |
| `mcp.keys.read` | `service` | `GET /api/mcp/keys`, `GET /api/mcp/keys/<id>/access`, `GET /api/mcp/access` |
| `mcp.keys.write` | `service` | `POST /api/mcp/keys`, `DELETE /api/mcp/keys/<id>` |
| `mcp.usage.read` | `service` | `GET /api/mcp/usage`, `GET /api/mcp/usage/overview`, `GET /api/mcp/keys/<id>/usage`, `GET /api/mcp/keys/<id>/cost` |

These routes need a valid token and no action: the page shells and the files of `/static/`, the redirects of the former addresses, `GET /api/version`, `GET /api/hosts`, `GET /api/hosts/stream`, `GET /api/health`, `GET /api/mcp/meta`, and the routes of a capability that a checked request gave: `GET /api/query/stream`, `POST /api/query/cancel` and `POST /api/query/deep-analysis/cancel`.

A route that is not in this table is refused with `403` and the action `unknown` (fail closed), and the log has the line `access.no_rule`. A path that has no route gets `404`.

When you remove or rename an action, write the change in the release notes.

## Decisions

ChDash asks the PDP with AuthZEN:

```json
POST {pdp.url}/access/v1/evaluation
{
  "subject":  { "type": "user", "id": "<sub of the identity token>" },
  "action":   { "name": "system.read" },
  "resource": { "type": "service", "id": "<identity.audience>" },
  "context":  { }
}
```

For more than one question, ChDash sends one batch to `POST {pdp.url}/access/v1/evaluations`, with the subject at the top and the action and the resource of each evaluation. The answer is `{"decision": true|false}`, or `{"evaluations": [{"decision": ...}, ...]}` in the order of the questions.

Rules:

- The resource is the service (`{"type": "service", "id": <audience>}`). For an action that also takes `database`, ChDash asks for the database when the request names one database: the parameter `database` of `GET /api/meta` and of the `/api/explorer/...` routes, and the field `database` of the body of `POST /api/explorer/table/data`. The Query page and the export name no database: for them ChDash asks for the service.
- Each call has `Authorization: Bearer <pdp token>`, `X-Request-ID` (the request id of the request that asks) and a `traceparent`.
- **Fail closed.** No answer before `pdp.timeout`, a connection error, a status that is not `200`, a body that is larger than 256 KiB, and a body that is not a valid answer give the decision `false` for each question of the call. ChDash writes the line `access.pdp_failed` and never keeps a failure.
- ChDash keeps an answer of the PDP for `pdp.cache_ttl` at most. The key is the subject, the action and the resource. A change of the policy applies after `cache_ttl` at most.
- The cache holds 16384 answers and 8 MiB at most (the bytes of the keys, and a fixed part for each answer). The client chooses the `database` parameter, so a bound of bytes is necessary. When the cache is full, ChDash removes the expired answers. If the cache is still full, ChDash empties it. An answer that is larger than the whole budget is not kept. These bounds are not settings.
- ChDash sends one batch for a page: `GET /api/version` holds the decisions of the subject for all the actions on the service (`features.access`). The questions that are in the cache do not go to the PDP.

## Enforcement

- ChDash checks the decision of each route before the route runs, also when the page does not show the action.
- If the decision is `false`, ChDash sends status `403` with `{"error_code": "forbidden", "action": "<action>", "message": "The action <action> is not allowed."}`. The answer does not give the reason of the PDP.
- A run without `query.run.write` runs each statement with `readonly = 1`. ClickHouse then refuses a statement that changes data or settings, also a `SETTINGS` clause and `SET`. ChDash sends `readonly = 1` also when it cannot read the settings profile of the runner (fail closed). A run needs `query.run.read` or `query.run.write`: without the two, the answer is `403` with the action `query.run.read`. The same rule applies to Deep Analyze and to the statements of an export. An export also needs `query.export`: without it, the answer is `403` with the action `query.export`.
- The pages hide what the subject cannot do. `GET /api/version` gives the decisions in `features.access`, and the pages read them: the System page needs `system.read`, the Traces, Logs and Metrics pages need `observability.read`, the query library needs `library.read` (and `library.write` to change it), and the MCP page needs `mcp.keys.read` or `mcp.usage.read`. `GET /api/mcp/meta` says `can_manage = false` without `mcp.keys.write`, so the MCP page shows no New key and no Delete. The Explorer and the Query page stay visible: a grant on one database can let the user open it.

### Limits of a grant on one database

- A grant on a database applies to the Explorer route that names this database. The catalog of all the databases (`GET /api/explorer/catalog` without `database`) needs `explorer.read` on the service.
- Some answers name other databases than the one of the request: the storage map (`GET /api/explorer/storage`), the graph (`GET /api/explorer/graph`, a lineage crosses databases) and the names of the editor (`GET /api/meta` with `databases`, `tables` or `columns`). ChDash asks the PDP, in one batch, for the service and for each database of the answer: `explorer.read` for the storage map and the graph, `query.run.read` and `query.run.write` for the names. The answer keeps only the databases with a `true` decision on the database or on the service. A node of the graph that names no database (a shard or a replica of a cluster) stays when it links to a node that stays.
- The card of a table (`GET /api/explorer/table`) and the definition of a graph object (`GET /api/explorer/graph/definition`) can name other databases. These are the related objects (`dependencies`) and the target of a materialized view, a Buffer or a Distributed table. ChDash asks the PDP, in one batch, for `explorer.read` on the service and on each of these databases. A related object in a database without a `true` decision is removed. A target in such a database is not visible: the card gives an empty `database` and `table` in `distributed`, and the definition gives `target_visible: false` and `target: null`. The DDL text and `engine_full` stay as the runner reads them.
- The focus of the graph (`focus_database`) names its own database. Without a `true` decision on the service or on that database, the answer is `403` with the action `explorer.read`.
- The Query page names no database. Thus a grant of `query.run.read` on one database does not let the user run a query: ChDash asks for the service. The SQL of a query can name any table, so a decision for one database cannot limit what the SQL reads. The grants of the ClickHouse runner user of each host stay the limit of the data.

## Logs and traces

- For each decision, the log has one line `access.decision` with `request_id`, `subject`, `action`, `resource` (`<type>:<id>`), `decision` and `source` (`pdp`, `cache` or `error`).
- The access log (`http.request`) has the field `subject` (`-` when there is none).
- When the `telemetry` block is on, each call to the PDP is a CLIENT span `POST /access/v1/evaluation` or `POST /access/v1/evaluations`. Its parent is the span of the `traceparent` of the request; without one, the span starts a trace. The call sends the context of this span to the PDP (`traceparent`). Refer to [server-telemetry.md](server-telemetry.md#the-client-span-of-the-pdp).

## The MCP endpoint

`POST /mcp` needs no identity token. It keeps its keys (contract section 3, [mcp.md](mcp.md)). The API tools of MCP call the routes of the API in the process (the context of an MCP call): these calls need no identity token and ask no PDP for each route. The keys, their tools, their scope and the MCP ClickHouse user limit them.

A key of the page never has more than its creator ([mcp.md](mcp.md#keys-and-the-access-of-humans)). `mcp.keys.write` alone does not let a person make a key with a read action that the PDP refuses to that person. When a key is made, ChDash asks the PDP for the person and each action that the tools of the key use. The key keeps its creator. On each request of the key, ChDash asks the PDP for the creator again: when one action is `false`, the key gets the `401` of a key that does not exist. A key of the configuration is not checked.

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

`tests/native/access_test.cpp` (CMake option `CHDASH_BUILD_ACCESS_TESTS`, target `chdash_access_test`) checks the signatures against the vectors of RFC 8032, RFC 8037, RFC 6979 and RFC 7515, the PEM keys, each rule of the identity token, the rule of each route, and the client of the PDP on a fake transport (the body, the headers, the cache, fail closed). `tests/backend-functional/identity_tokens.py` signs the test tokens in pure Python, with the test keys of `tests/config/secrets/access-identity-keys.pem`.
