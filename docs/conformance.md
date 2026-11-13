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
| `CONFORMANCE_CONFIG` | The configuration of ChDash. The default is `tests/config/access.conformance.hcl`. The variants are in [The three variants](#the-three-variants). |
| `CONFORMANCE_PROFILE` | The profile of the runner. The default is `tests/conformance/profile.json`. It must match the configuration. |
| `CHDASH_APP_IMAGE` | The image that runs the `chdash` binary. The default is the image of the runner (`CHDASH_TEST_IMAGE`, `debian:trixie-slim`). A binary that the Alpine test image builds needs an Alpine image with `libstdc++`. |

### The commit of the runner

The workflow `.github/workflows/conformance.yml` checks out one fixed commit of ProcurAuth: `74f5495d74d475c2bb7fa074ff7c7f79517436fb` (main of 2026-11-13, the merge of the lot PS1 and of spec question 53). This commit has the cases of the approvals for each action (U30 and U100 to U117), the profile key `approval_calls` and the member `context.permission_only` (protocol 5.5a). The earlier pins have not. A change of the runner thus never changes the result of the job alone. To bump the commit:

1. Run `tests/conformance/run.sh` with `PROCURAUTH_DIR` on the new commit and `CONFORMANCE_STRICT=1`.
2. Update `tests/conformance/expected.txt` and the result in this document.
3. Put the full SHA of the new commit in `ref` of the step "Checkout ProcurAuth" of the workflow, and in this section.

A local run uses the commit that `PROCURAUTH_DIR` holds. Use the same commit as the workflow.

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
| `tests/config/access.conformance-full.hcl`, `tests/conformance/profile-full.json` | The variant "full". |
| `tests/config/access.conformance-lean.hcl`, `tests/conformance/profile-lean.json` | The variant "lean". |
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

### The three variants

The action document depends on the configuration (refer to [access.md](access.md#actions-and-tools)). The member `approval_calls` of the profile must name each action that the document publishes (case U111). One run cannot cover every configuration. A configuration that hides an action that no tool serves is the defect that hid in 1.4.0. So the run has three variants:

| Variant | Configuration | Published actions that differ | `approval_calls` |
|---|---|---|---|
| default | A library that no person can change, the write account, the usage with `all_keys` and one host. | `query.run.write` and `mcp.usage.read` are published. `library.write` and `observability.read` are not. | 9 actions |
| full | A writable library, the traces on (the script makes the tables of `otel`), the write account and the usage with `all_keys`. | Also `library.write` (the tool `library_write`, with the operation `import` of an empty library: it runs each time) and `observability.read` (the tool `list_services`). | 11 actions |
| lean | No write account, the usage without `all_keys`, a library that no person can change, no signal. | `query.run.write` and `mcp.usage.read` are not published: no tool serves them. | 7 actions |

Run the three of them before a release:

```text
tests/conformance/run.sh /path/to/chdash
CONFORMANCE_CONFIG=tests/config/access.conformance-full.hcl CONFORMANCE_PROFILE=tests/conformance/profile-full.json tests/conformance/run.sh /path/to/chdash
CONFORMANCE_CONFIG=tests/config/access.conformance-lean.hcl CONFORMANCE_PROFILE=tests/conformance/profile-lean.json tests/conformance/run.sh /path/to/chdash
```

### The operations of the profile

Each case uses an operation. The profile maps it to a request of ChDash:

| Operation | Request | Action and resource |
|---|---|---|
| `use_plain` | `GET /api/explorer/functions?host_id=conf` | `explorer.read` on the host `conf`. The route asks exactly one question. |
| `use_ceiling` | The same request | `explorer.read` with the ceiling `max_rows` = 1000000 (`ceiling_value`). The list of the functions obeys the ceiling, and its result does not go past this value. The case U37 tests that ChDash accepts a `true` answer with a ceiling that the action declares (ProcurAuth 7.5). A value below the number of the functions gives `403` `ceiling_exceeded` ([access.md](access.md#a-result-past-a-ceiling)). |
| `use_budget` | `POST /api/query/run` with the body `{"host_id": "conf", "sql": "SELECT 1"}` | `query.run.read` on the host `conf`, with `context.usage` ([Budgets](access.md#budgets)). The SQL is a read, so the use is `query.run.read`. |
| `use_service` | `GET /api/query-library?host_id=conf` | `library.read` on the service. |
| `list_options` | `GET /.well-known/procurauth/resources?type=host` | The route of the options (the profile has `options_type` = `host`). |
| `mcp_call_plain` | `POST /mcp`, `tools/call` of `list_databases` with the argument `host` = `conf` | `explorer.read` on the host `conf`. The profile adds the headers `Mcp-Method` and `Mcp-Name`. |
| `mcp_call_budget` | `POST /mcp`, `tools/call` of `run_query` with the arguments `host` = `conf` and `sql` = `SELECT 1` | `query.run.read` on the host `conf`, with `context.usage`. The profile adds the headers `Mcp-Method` and `Mcp-Name`. |
| `mcp_call_multi` | `POST /mcp`, `tools/call` of `export_query` with the arguments `host` = `conf` and `sql` = `SELECT 1` | `query.export` on the host `conf`, with `context.usage`. The tool needs a second permission, `query.run.read` on the host: ChDash asks it first, with `context.permission_only` and without usage ([access.md](access.md#approval-of-an-action)). The cases U96 and U97 run it. The profile adds the headers `Mcp-Method` and `Mcp-Name`. |
| `mcp_call_approval` | `POST /mcp`, `tools/call` of the tool of one action. It is not in `operations`: the member `approval_calls` has one entry for each action that a tool uses. The runner runs each case of the approvals once for each entry. It adds the control arguments (`lease_s`, `approval_ref`, `wait_s`) and changes the arguments for the variants `effect_2` and `effect_3`. | The action of the entry, on its node. ChDash asks the question without effect (17.7, step 1), and only a reason `approval_required` starts the flow ([access.md](access.md#approval-of-an-action)). |

The profile has the member `mcp` (`path` = `/mcp`, `session_budget` = `true`: the action `mcp.session` lists the budget `requests`). It has the member `approval_calls`, because each action can need an approval. It has `mcp_call_multi` (the tool `export_query` needs two permissions, so the cases U96 and U97 run). It has no `use_multi` and no tool that asks for input. The reasons are:

- ChDash has no HTTP route that is one use with two required permissions in one request. A run needs `query.run.read` or `query.run.write`: one of the two is enough, so the other action is no required permission. The route of the export has two permissions. Its use is the stream of a token that the run made. A case sends one request. The runner of the pinned commit runs U34 and U35 with `use_multi` only, so it skips them. The runner of the lot SM1 of ProcurAuth gives them a second step for `mcp_call_multi`, and they pass. The tool `export_query` has two required permissions, and the cases U96 and U97 test the rule on it too.
- ChDash has no tool that asks for input. The case U117 that uses it is skipped.

The `op` of an entry is the `op` that ChDash builds ([access.md](access.md#the-op-and-the-view)). For `run_query`, `export_query` and `run_write_query` it has `tool`, `host`, `sql`, `ch_user` and the caps of the call. The caps are `max_rows`, `max_result_bytes` and `timeout_seconds`. The write tool has `timeout_seconds` only. For another tool it has `tool`, `host` (when the call has one), `arguments` and the caps of the tool. `arguments` is the compact JSON text of the arguments, with sorted members and with the defaults of the tool. The caps are the values of `mcp.max_rows`, `mcp.max_result_bytes` and `mcp.query_timeout_seconds` (ProcurAuth 17.3a). The case U108 checks that the `view` has only JSON Pointers.

### The headers of an MCP request

The MCP server contract (section 2.5, case T03) makes ChDash refuse a `2026-07-28` request without the headers `Mcp-Method` and, for `tools/call`, `Mcp-Name`. The answer is `400` with `-32020`, before any access check. The operation `mcp_call_plain` of the profile sends the two headers. Since the ProcurAuth commit `85b695d` (2026-11-07), each MCP request that a case writes has them too. With an older runner, the 11 MCP cases U18, U23, U26, U29, U31, U88, U89, U91, U94, U95 and U98 fail for this reason only.

## Result of 2026-11-12: the three variants

The run used the static release binary of the branch `feat/alignment`, built with `tests/smoke/Dockerfile.release`, the script `tests/conformance/run.sh` and the runner of ProcurAuth at commit `74f5495` (lots S7 and PS1). Each variant ran in strict mode. The cases of the approvals are required: U30 and U100 to U117.

| Result | Default | Full | Lean |
|---|---|---|---|
| Run | 117 cases: 114 passed, 0 failed, 3 skipped | 117 cases: 114 passed, 0 failed, 3 skipped | 117 cases: 114 passed, 0 failed, 3 skipped |
| Actions with a call in `approval_calls` | 9 | 11 | 7 |
| Expected failures (`tests/conformance/expected.txt`) | none | none | none |

The cases U96 and U97 pass: the profile has `mcp_call_multi` (`export_query`). The skipped cases are these:

| Case | Reason |
|---|---|
| U34, U35 | Only with the pinned runner (`74f5495`): it needs `use_multi`. The runner of the lot SM1 runs them through `mcp_call_multi`, and they pass (see below). ChDash has no HTTP route that is one use with two required permissions in one request: the stream of an export needs a token that a run made, and a case sends one request. The rule is tested on a tool by U96 and U97. The member `context.permission_only` of the other permission (the cases U34 and U35 check it for an HTTP route) is tested by `tests/native/approval_test.cpp`, `tests/native/access_test.cpp` and `tests/backend-functional/test_approval.py`. |
| U117 | ChDash has no tool that asks for input (`mcp_call_input`). |

With the runner of the lot SM1 of ProcurAuth (branch `lot/SM1`, a local run of 2026-11-13, strict mode), each variant has 117 cases: 116 passed, 0 failed, 1 skipped. The skipped case is U117. U34 and U35 pass for the tool `export_query`. The commit of this lot is not on the main branch of ProcurAuth yet, so the workflow keeps the pin `74f5495` until the merge. After the merge, pin the merge commit, and the expected result of the three variants becomes 116 passed and 1 skipped.

The runner has no profile for the mode `keys`: the keys of the page are tested by `tests/native/approval_test.cpp` and by `tests/backend-functional/test_approval_keys.py`. The profile of 1.4.0 hid two defects. Its configuration made the library read-only and turned on the usage with `all_keys`, so U111 passed with actions that had no tool in other configurations. The variants close this gap.

The action document has one action that no entry of the profile covers only when a feature is on that the variant leaves off. The identity mode does not publish `mcp.keys.read` and `mcp.keys.write`, so these actions need no call.

## Notes

- The case U37 passed before the decision on the shared caches only because the list of functions came from the cache. With its own read, the list of more than 100 functions goes past `max_rows` = 100, and a correct PEP refuses it. The profile gives `ceiling_value` = 1000000. The ProcurAuth commit `7b13652` writes this rule of the profile: the result of `use_ceiling` must not go past `ceiling_value`.
- The cases U02, U40, U59 and U84 use `use_service`. They failed during the first run, because `GET /api/query-library` needs the parameter `host_id` (`400`). The profile has the parameter since.
- A case that the run skips does not pass. It tests nothing.
- The case U04 has no scripted answer for a question without `context.usage`. ChDash therefore asks the action of a run with `context.usage` first, and asks the other run action after it ([Budgets](access.md#budgets)).
- The effect vectors of ProcurAuth (`conformance/vectors/effect.json`) are in `tests/conformance/effect-vectors.json`. The native test `tests/native/approval_test.cpp` computes each one. `tests/conformance/run.sh` compares the file with the copy in the ProcurAuth repository and warns when they differ.
