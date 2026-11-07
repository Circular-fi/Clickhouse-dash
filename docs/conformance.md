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
| `tests/config/access.conformance.hcl` | The configuration of ChDash: mode `authzen`, `pdp.cache_ttl = 0s`, one host, one query library, MCP off. |
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
| `use_service` | `GET /api/query-library?host_id=conf` | `library.read` on the service. |
| `list_options` | `GET /.well-known/procurauth/resources?type=host` | The route of the options (the profile has `options_type` = `host`). |

The profile has no `use_budget`, `use_multi` and MCP operation. The reasons are:

- ChDash lists no budget in its action document. The budget cases are skipped. A PDP can still answer `budget_exceeded`. ChDash then gives `429`.
- ChDash has no action that needs two permissions for one use, so the profile has no `use_multi`.
- MCP is off in the configuration. The MCP cases are skipped. Add the MCP operations to the profile when ChDash accepts the identity token on `/mcp`.

## Result of 2026-11-07

The run used the binary of the branch `wip/conformance` (version 1.2.2 plus the merge of the ProcurAuth work: document path, resources route, token checks, PDP failure 503). The runner is the one of the ProcurAuth repository of the same day.

```text
99 cases: 59 passed, 1 failed, 38 skipped, 1 warned
```

| Result | Cases |
|---|---|
| Failed | U37 |
| Warned | U69 |
| Skipped, no budget action | U04, U19, U21, U22, U24, U32 to U35, U58, U62, U63, U67, U68 |
| Skipped, no MCP endpoint | U18, U23, U25 to U31, U85 to U99 |

### Failed case

- U37 (paragraphs 7.3, 7.5 and 10.2). The PDP gives a ceiling that the action lists. ChDash declares no ceiling in this branch. It treats a `true` answer with a ceiling as `false`, and the route gives `403`. The case expects a success. The ceilings of ChDash fix this case. The line is in `expected.txt` until they are merged.

### Warned case

- U69 (paragraph 10.7, SHOULD). The PEP keeps its connection to the PDP open between questions. ChDash opens a new connection for each question: the runner counted four connections for four uses. This is not a failure of a MUST rule. The exit code does not change.

### Notes

- The cases U02, U40, U59 and U84 use `use_service`. They failed during the first run, because `GET /api/query-library` needs the parameter `host_id` (`400`). The profile has the parameter since.
- A case that the run skips does not pass. It tests nothing. The number of skipped cases falls when ChDash declares budgets or when the profile has MCP operations.
