# Unreleased

Base: release 1.5.1. These changes are on the branch `align-2026-11`. No release has them yet. They follow the rulings of the owner on the alignment of ChDash with ProcurAuth (decisions 188 and 195 of ProcurAuth, and the rulings of 2026-11-23).

## What changed

- **An `evaluation_id` above 1024 bytes makes the answer of the PDP not valid** (ProcurAuth 17.1, decision 188). Before, ChDash accepted 4096 bytes and dropped a longer id: the call got a plain refusal. Now a route answers `503`, and an MCP call gets HTTP 503 with `-32603`.
- **A ceiling above 2^53-1 in `context.limits` makes the answer not valid** (ProcurAuth 6, decision 188). Before, ChDash accepted each whole number up to 2^64-1.
- **A reason of 17.1 for a question with `context.permission_only` makes the answer not valid** (ProcurAuth 5.5a and 10.3, MCP binding 3.7, decision 195). The PDP client applies the rule to each question of this kind. The route of an export answers `503`, not `403` with `approval_cannot_wait`. The tool `export_query` gets HTTP 503 with `-32603`. ChDash no longer has the tool error `scope_needs_approval`.
- **The other run action has `context.permission_only`.** A run asks the action of its use with `context.usage`, then the other run action to know `readonly` and the ceilings of the other class. This second question now has `context.permission_only` equal to `true` (ProcurAuth 5.5a). The PDP thus ignores `confirm` for it: a grant of `query.run.write` with `confirm` no longer gives `readonly = 1` to a read.
- **ChDash refuses a token without `kid` when the configuration has more than one key** (ProcurAuth 9.4). The reason in the log is `kid`. Before, ChDash tried each key. With one key, ChDash still verifies a token without `kid` with this key.
- **`iat`, `exp` and `nbf` are whole numbers written with digits only.** A fraction, an exponent and a sign give `401` (the reason `malformed`). Before, ChDash accepted a number with a fraction up to 9e15 and rounded it down. ChDash still refuses a token when `nbf` is later than its clock plus `identity.clock_skew`.

## Documentation

- `docs/access.md` and the comments of `src/mcp_approval.hpp` say what ChDash does with the faults of the approval API (`explanation_required`, `cannot_supersede`, `invalid_evaluation`), and that the MCP binding 5.7a adopts these maps.
- `docs/access.md` states the units of the action document: a ceiling has a plural unit (`rows`, `bytes`, `seconds`), and a budget has a singular unit (`query`, `export`, `request`). The units do not change.
- `docs/access.md`: the approval calls use the link to the PDP (an `https` URL gives them TLS). The wait of a use is the published `procurauth_usage_max_seconds` plus one second (6 seconds with the portal). The table of the keys has `pdp.insecure_link`.
- `config.example.hcl` shows the block `access.approval` and the key `mcp.unauthenticated_rate_limit_per_minute`.
- `docs/conformance.md` and the workflow `conformance.yml` give the true date (2026-11-13) and the release (1.5.1) of the last result. The ProcurAuth commit `1bdfe61` is a normal commit, not a merge commit.
- `PRODUCT.md` and the home page give the true size of an archive: about 10 MB (9.8 MB to 10.1 MB for the four archives of 1.5.1).

## Upgrade

- An edge that signs with one of several keys must put `kid` in each token. For a PEM key, the `kid` is its RFC 7638 thumbprint, which `--print-config` shows. The portal puts `kid` in each token.
- An edge must write `iat`, `exp` and `nbf` as whole numbers.
- A PDP must not give a reason of 17.1 to a question with `context.permission_only`, and must give an `evaluation_id` of 1024 bytes at most.

## Conformance

The run of `tests/conformance/run.sh` used the runner of the ProcurAuth commit `1bdfe61`, the pin that does not change in this lot. Each of the three variants ran in strict mode: 117 cases, 116 passed, 0 failed, 1 skipped (U117). The stricter rules of this lot break no case of this runner. The binary was a build of the branch with the test toolchain of `tests/Dockerfile.sanitize`, without sanitizers, not the static release binary.
