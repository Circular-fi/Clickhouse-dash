# Security Policy

## Supported versions

Security fixes are best-effort for:

- the latest code on `main`
- the most recent tagged release

Older snapshots may not receive fixes.

## Safe deployment

ChDash has no login page. The configuration requires an `access` block. The `access` block selects the model ([docs/access.md](docs/access.md)):

- `mode = "authzen"`: An access gateway authenticates each human. It gives ChDash a signed identity token (EdDSA or ES256). ChDash verifies the token on each request to the pages and to the API. Without a valid token, ChDash returns `401`. ChDash asks an AuthZEN PDP for each action, on the service, on the host or on the database of the request. When the answer is `false`, or when the PDP does not answer, ChDash returns `403`. A run has `readonly = 1` if the user does not have `query.run.write` on its host. The pages show only the hosts on which the user holds an action. A request for another host gets the answer of a host that does not exist.
- `mode = "open"`: Everyone who can reach the port has the ClickHouse rights of the configured accounts. ChDash writes a warning at each start. Use this mode only for a server that stands alone on a closed network and serves a trusted team.

### Threat model

- **The people who reach the port** in the open mode can run SQL as the runner user of each host. They can read the system tables through the system user. When MCP is on, they can manage the MCP keys from the page. In the authzen mode, the PDP checks each of these actions for each human.
- **The access gateway and the PDP** are trusted. A token signed with one of the configured keys identifies the human. The PDP gives all the permissions. Keep the private key of the gateway and the token of the PDP secret.
- **A client that sends its own identity header** is refused. The signature check refuses a token that the client made. The reverse proxy must replace the header that a client sends. ChDash refuses a request with two copies of the header. ChDash never reads the token from a cookie or a query parameter.
- **Other web sites** that a user opens in the same browser must not use ChDash through this browser. ChDash protects against this itself. Refer to "What ChDash does" below.
- **The MCP clients** reach only `POST /mcp` with a key. A key limits the tools, the hosts and the databases. The MCP user of ClickHouse limits the data.

### What you must do

1. **Do not expose ChDash to the Internet.** Listen on a private address, or publish the port on `127.0.0.1` only (`examples/docker-compose.config.yml`).
2. **Put an access gateway in front of it** when more than one person uses it. Use `access { mode = "authzen" }` ([docs/access.md](docs/access.md)). The gateway authenticates the human and gives the identity token. The reverse proxy replaces the identity header that a client sends. The proxy must keep the `Host` header or set `X-Forwarded-Host` (the guard of the writes compares it with `Origin` for older browsers). The proxy must not replace the security headers of ChDash.
3. **Keep the PDP on a private network.** ChDash has no TLS client, so it calls the PDP with `http`. Limit the network between ChDash and the PDP to these two programs.
4. **Terminate TLS in the proxy.** ChDash serves plain HTTP. Add `Strict-Transport-Security` in the proxy.
5. **Keep ClickHouse on a private network.** ChDash talks to ClickHouse without TLS (`secure=1` is refused). Put ChDash next to ClickHouse, or use a tunnel.
6. **Give each ClickHouse account the least rights** (docs/configuration.md, "Recommended ClickHouse account separation"):
   - the runner: `SELECT` on the databases that the panel shows, `SHOW` grants, and no right to manage users. Do not give `KILL QUERY`. The panel refuses `KILL QUERY` statements, and ChDash cancels with the system user. Give write rights only when the panel must write.
   - the system user: `SELECT` on the `system` tables that the pages read and on the OpenTelemetry tables, and `KILL QUERY` for the cancel. The access audit lists the missing ones.
   - the MCP user: read only (`readonly = 1` in its profile), and `SELECT` on the data that MCP may read.
7. **Run the container with the least privilege.** Use a user that is not root, a read-only root file system, no capability and `no-new-privileges` (`examples/docker-compose.config.yml`). Keep the password files separate from the configuration. Make them readable only by this user.
8. **Keep `/metrics` internal.** It shows host names and counts, never a password. It needs no identity token, as the probes do.

### What ChDash does

- Each answer has a Content-Security-Policy. The hash of each inline script of a page lets that script run. No other script runs. Each answer has `frame-ancestors 'none'` and `X-Frame-Options: DENY`, which block the display of ChDash in a frame. Each answer has `X-Content-Type-Options: nosniff` and `Referrer-Policy: same-origin`. An export token in a URL never goes to another site. The pages read the referrer of a same-site navigation.
- ChDash refuses every `POST`, `PUT`, `PATCH` and `DELETE` request from a page of another site. It also refuses a body that is not `application/json`. It makes both checks before it reads the body.
- A request body has a size limit. A JSON body has a depth limit. The SQL formatter has a depth limit and a time limit.
- The identifiers that act as a capability (`query_id`, `export_id`) are created by the system random source. The signing secret of the tokens and the MCP secrets also come from the system random source.
- The log never holds row data, a password, a token or a `query_id`. The URIs in the log and in `/metrics` have no password.
- In the authzen mode, ChDash checks the identity token of each request to the pages and to the API. It checks the signature, `iss`, `aud`, `exp` and the life of the token. ChDash checks the action of each route with the PDP. The question names the host and the database of the request, so a grant on one host never covers another host. A PDP error denies the action (fail closed). The log holds each decision (`access.decision`). It also holds the subject of each request (`http.request`).

Refer to [docs/operations.md](docs/operations.md) for the details. The details cover the headers, the guard, the probes, the shutdown, the log and the metrics.

## Verify a release

Each release has the archives, a `SHA256SUMS` file and a build provenance attestation for each archive. GitHub keeps the attestation, not the release, so a changed archive cannot bring a matching one. The attestation names the workflow run and the commit that built the archive.

```bash
sha256sum -c SHA256SUMS --ignore-missing
gh attestation verify chdash_<version>_linux_amd64.tar.gz --repo Circular-fi/Clickhouse-dash --signer-workflow Circular-fi/Clickhouse-dash/.github/workflows/release.yaml --source-ref refs/tags/v<version> --deny-self-hosted-runners
```

Each option of the command is necessary:

- `--signer-workflow`: With `--repo` alone, the command also accepts an attestation that another workflow of the repository signed. Only the release workflow builds the archives.
- `--source-ref`: The command accepts only an attestation of a run that started from the tag of this version. Without it, the command also accepts an archive that the release workflow built from a branch.
- `--deny-self-hosted-runners`: The command accepts only an attestation from a runner that GitHub hosts. The release workflow uses only runners that GitHub hosts.

**Manual releases.** A maintainer can start the release workflow by hand (Actions > Release > Run workflow). Then the attestation gives the branch of the run as the source ref, not the tag. The page of the workflow run shows this branch. For such a release, give the branch to `--source-ref`:

```bash
gh attestation verify chdash_<version>_linux_amd64.tar.gz --repo Circular-fi/Clickhouse-dash --signer-workflow Circular-fi/Clickhouse-dash/.github/workflows/release.yaml --source-ref refs/heads/main --deny-self-hosted-runners
```

The attestation of a manual release also gives the commit of the run. If the tag existed before the run, this commit can be different from the commit of the tag. In this case, the workflow builds the commit of the tag. To compare the two commits, read the log of the job "Resolve release tag".

A release starts only after the tests pass on the commit that it builds. The section "Validate release builds" in `CONTRIBUTING.md` describes the release chain.

## Report a vulnerability

Do not open a public issue for security reports.

Use GitHub private vulnerability reporting when it is enabled for this repository. If it is not available, contact the maintainers through a private channel. Include these items in the report:

- a clear description of the issue
- impact and affected areas
- reproduction steps or proof of concept
- any suggested mitigation

## Response goals

Maintainers will try to acknowledge valid reports quickly. They will assess the severity. They will coordinate a fix before public disclosure.
