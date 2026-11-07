# Conformance with ProcurAuth

This document uses ASD-STE100 Simplified Technical English.

ChDash is a service of ProcurAuth. The ProcurAuth repository has a program, `access-conformance`, that tests a service. The program runs the cases of the series U against ChDash. ChDash is a PEP (Policy Enforcement Point), so the role is `pep`. The cases are data in the ProcurAuth repository (`conformance/cases/U`). Each case cites the paragraph of the protocol that it tests.

## How the run works

The runner acts as three parties:

- The edge. It signs the identity tokens with two test keys, Ed25519 and ES256.
- The PDP. It listens on `conformance-pdp:8181`. Each case gives a script of answers.
- The client. It sends the requests and checks the answers of ChDash.

The runner counts the questions that ChDash sends to the PDP. A case checks these questions.

The script `tests/conformance/run.sh` makes the whole set-up with Docker. Nothing is installed on the host. The script does these steps:

1. Build the runner with `scripts/cargo.sh` of the ProcurAuth repository. The program stays in a Docker volume. The script copies it.
2. Make the work directory. It holds the test keys of the runner, the public keys as a JWK Set, the credential of the PDP and the password of ClickHouse.
3. Start a ClickHouse server (the image of `tests/tls/run.sh`) in a new Docker network.
4. Start the given `chdash` binary with `tests/config/access.conformance.hcl`.
5. Run the runner in the same network, with `tests/conformance/profile.json`. The runner prints one line for each case.
6. Compare the failed cases with `tests/conformance/expected.txt`. Print the verdict.
7. Remove the containers and the network.

## Run it

Build the binary first. The script `tests/tls/run.sh` takes the same kind of binary.

```text
tests/conformance/run.sh /path/to/chdash
```

| Variable | Use |
|---|---|
| `PROCURAUTH_DIR` | The ProcurAuth repository. The default is `../procurauth` next to this repository. The script only reads it. |
| `CONFORMANCE_RUNNER` | A runner binary that you built. The script then does not build one. |
| `CONFORMANCE_EXPECTED` | Another list of expected failures. |
| `CONFORMANCE_STRICT` | Set it to `1`. The script then fails also for a case of the list that passes. |
| `CONFORMANCE_KEEP` | Set it to `1` to keep the containers and the work directory for a look at the logs. |

### Exit code

| Code | Meaning |
|---|---|
| 0 | Each failed case is in `tests/conformance/expected.txt`. |
| 1 | At least one failed case is not in the list. |
| 2 | The set-up failed: a missing tool, a start that failed, or a runner that did not run. |

A case with the result `warn` is a failure of a SHOULD rule. It never changes the exit code. A case of the list that passes is reported with the line `NOW PASS`. Remove its line from the list.

### The list of expected failures

The file `tests/conformance/expected.txt` has one case id on each line. The reason follows after `#`. A line without a reason stops the script. The runner reports are the truth: do not change a case to make it pass.

## The files

| File | Use |
|---|---|
| `tests/config/access.conformance.hcl` | The configuration of ChDash: mode `authzen`, `pdp.cache_ttl = 0s`, one host, one query library, MCP in the mode `identity`. |
| `tests/conformance/profile.json` | The profile of the runner: the identity token, the keys, the PDP listener and the operations. |
| `tests/conformance/identity-keys.json` | The public keys of the two test keys of the runner, as a JWK Set with the `kid` of the profile. |
| `tests/conformance/expected.txt` | The expected failures. |
| `tests/conformance/run.sh` | The script. |

The values of the identity token must be the same in the profile and in the configuration:

| Value | Profile | Configuration |
|---|---|---|
| Service id | `pep.service` = `chdash` | `access.identity.audience` |
| Issuer | `pep.token.iss` | `access.identity.issuer` |
| Header | `pep.token.header` | `access.identity.header` |
| Longest life | `pep.token.max_age_seconds` = 300 | `access.identity.max_age` = `5m` |
| Clock skew | `pep.token.skew_seconds` = 30 | `access.identity.clock_skew` = `30s` |

The script makes the JWK Set again from the private keys of the runner. It stops if the result is not the file `identity-keys.json`. This check finds a change of the test keys in the ProcurAuth repository.

The cache of the PDP answers is off. The cases give a different answer for each request, so a kept answer would hide the result. The profile has `answer_cache = false`, and the runner skips the cases that need a cache.

### The operations of the profile

Each case uses an operation. The profile maps it to a request of ChDash:

| Operation | Request | Action and resource |
|---|---|---|
| `use_plain` | `GET /api/explorer/functions?host_id=conf` | `explorer.read` on the host `conf`. The route asks exactly one question. |
| `use_ceiling` | The same request | `explorer.read` with the ceiling `max_rows`. |
| `use_budget` | `POST /api/query/run` with the body `{"host_id": "conf", "sql": "SELECT 1"}` | `query.run.read` on the host `conf`, with `context.usage` ([Budgets](access.md#budgets)). The SQL is a read, so the use is `query.run.read`. |
| `use_service` | `GET /api/query-library?host_id=conf` | `library.read` on the service. |
| `list_options` | `GET /.well-known/procurauth/resources?type=host` | The route of the options (the profile has `options_type` = `host`). |
| `mcp_call_plain` | `POST /mcp`, `tools/call` of `list_databases` with the argument `host` = `conf` | `explorer.read` on the host `conf`. The profile adds the headers `Mcp-Method` and `Mcp-Name`. |
| `mcp_call_budget` | `POST /mcp`, `tools/call` of `run_query` with the arguments `host` = `conf` and `sql` = `SELECT 1` | `query.run.read` on the host `conf`, with `context.usage`. The profile adds the headers `Mcp-Method` and `Mcp-Name`. |

The profile has the member `mcp` (`path` = `/mcp`, `session_budget` = `true`: the action `mcp.session` lists the budget `requests`). It has no `use_multi`, no `mcp_call_multi`, no tool that asks for input and no tool that waits for an approval. The reasons are:

- ChDash has no use that needs two permissions. A run needs `query.run.read` or `query.run.write`: one of the two is enough, so the other action is no required permission. The cases U34, U35, U96 and U97 refuse a use when the second permission is `false`, and they need such a use. These cases are skipped.
- ChDash has no tool that asks for input or that waits for an approval. The cases U30 and the related steps are skipped.
- The route of the export has two permissions, but its use is the stream of a token that the run made. A case sends one request, so it cannot make this use.

### The headers of an MCP request

The MCP server contract (section 2.5, case T03) makes ChDash refuse a `2026-07-28` request without the headers `Mcp-Method` and, for `tools/call`, `Mcp-Name`. The answer is `400` with `-32020`, before any access check. The operation `mcp_call_plain` of the profile sends the two headers. The MCP cases that write their own request do not send them, so they fail. These cases are in `expected.txt`. A test build that accepts a request without the two headers passes each of them (run of 2026-11-07: 79 passed, 0 failed, 20 skipped).

## Result of 2026-11-07, with the budgets

The run used the binary of the branch `wip/budgets` (the branch `feat/procurauth-1.3` and the budgets `queries`, `exports` and `requests`). The runner is the one of the ProcurAuth repository of the same day.

```text
99 cases: 83 passed, 11 failed, 5 skipped
```

| Result | Cases |
|---|---|
| Failed (expected), the request of the case has no header `Mcp-Method` | U18, U23, U26, U29, U31, U88, U89, U91, U94, U95, U98 |
| Skipped, the profile has no use with two permissions | U34, U35, U96, U97 |
| Skipped, no tool that waits for an approval | U30 |

The cases of the budgets pass: U04, U19, U21, U22, U24, U32, U33, U58, U62, U63, U67 and U68 (the HTTP route `POST /api/query/run`), and U92 and U93 (the tool `run_query`). U18 and U23 pass their step of the tool and fail their step of `tools/list` or `ping`. U95 fails at its `ping`. In these three cases, only the missing header makes the step fail: the native test `test_identity_budgets` and `test_mcp_identity.py` test the same answers with the headers.

### Notes

- The cases U02, U40, U59 and U84 use `use_service`. They failed during the first run, because `GET /api/query-library` needs the parameter `host_id` (`400`). The profile has the parameter since.
- A case that the run skips does not pass. It tests nothing.
- The case U04 has no scripted answer for a question without `context.usage`. ChDash therefore asks the action of a run with `context.usage` first, and asks the other run action after it ([Budgets](access.md#budgets)).
