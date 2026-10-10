# Security Policy

## Supported versions

Security fixes are best-effort for:

- the latest code on `main`
- the most recent tagged release

Older snapshots may not receive fixes.

## Safe deployment

ChDash has no login. Everyone who can reach its port has the ClickHouse rights of the configured accounts. Deploy it as a tool for a trusted team, not as a public site.

### Threat model

- **The people who reach the port** can run SQL as the runner user of each host, read the system tables through the system user, and (when MCP is on) manage the MCP keys from the page. ChDash cannot separate them: put the separation in front of it (a proxy with a login) or in ClickHouse (one deployment for each set of rights).
- **Other web sites** that a user opens in the same browser must not use ChDash through this browser. ChDash protects against this itself (refer to "What ChDash does" below).
- **The MCP clients** reach only `POST /mcp` with a key. A key limits the tools, the hosts and the databases. The MCP user of ClickHouse limits the data.

### What you must do

1. **Do not expose ChDash to the Internet.** Listen on a private address, or publish the port on `127.0.0.1` only (`examples/docker-compose.config.yml`).
2. **Put an authenticating reverse proxy in front of it** when more than one person uses it: an SSO proxy, a VPN, or a proxy with a login. The proxy must keep the `Host` header or set `X-Forwarded-Host` (the guard of the writes compares it with `Origin` for older browsers). It must not replace the security headers of ChDash.
3. **Terminate TLS in the proxy.** ChDash serves plain HTTP. Add `Strict-Transport-Security` in the proxy.
4. **Keep ClickHouse on a private network.** ChDash talks to ClickHouse without TLS (`secure=1` is refused). Put ChDash next to ClickHouse, or use a tunnel.
5. **Give each ClickHouse account the least rights** (docs/configuration.md, "Recommended ClickHouse account separation"):
   - the runner: `SELECT` on the databases that the panel shows, `SHOW` grants, and nothing to manage users. Never `KILL QUERY` (the panel refuses `KILL QUERY` statements, and ChDash cancels with the system user). Give writes only when the panel must write.
   - the system user: `SELECT` on the `system` tables that the pages read (the access audit lists the missing ones) and on the OpenTelemetry tables, `KILL QUERY` for the cancel.
   - the MCP user: read only (`readonly = 1` in its profile), `SELECT` on the data that MCP may read.
6. **Run the container with the least privilege:** a user that is not root, a read-only root file system, no capability, `no-new-privileges` (`examples/docker-compose.config.yml`). Keep the password files apart from the configuration and readable only by this user.
7. **Keep `/metrics` internal.** It shows host names and counts, never a password.

### What ChDash does

- Each answer has a Content-Security-Policy (the inline scripts of a page are allowed by their hash, no other one runs), `frame-ancestors 'none'` and `X-Frame-Options: DENY` (no framing), `X-Content-Type-Options: nosniff` and `Referrer-Policy: same-origin` (an export token in a URL never goes to another site; the pages read the referrer of a same-site navigation).
- Every `POST`, `PUT`, `PATCH` and `DELETE` refuses a request from a page of another site, and a body that is not `application/json`, before the body is read.
- A request body has a size limit, a JSON body a depth limit, and the SQL formatter a depth and time limit.
- The identifiers that act as a capability (`query_id`, `export_id`), the signing secret of the tokens and the MCP secrets come from the system random source.
- The log never holds row data, a password, a token or a `query_id`. The URIs in the log and in `/metrics` have no password.

Refer to [docs/operations.md](docs/operations.md) for the details: the headers, the guard, the probes, the shutdown, the log and the metrics.

## Verify a release

Each release has the archives, a `SHA256SUMS` file and a build provenance attestation for each archive. GitHub keeps the attestation, not the release, so a changed archive cannot bring a matching one. The attestation names the workflow run and the commit that built the archive.

```bash
sha256sum -c SHA256SUMS --ignore-missing
gh attestation verify chdash_<version>_linux_amd64.tar.gz --repo Circular-fi/Clickhouse-dash
```

A release starts only after the tests pass on the commit that it builds. `CONTRIBUTING.md`, "Validate release builds", describes the release chain.

## Reporting a vulnerability

Please do not open a public issue for security reports.

Use GitHub private vulnerability reporting if it is enabled for this repository. If it is not available, contact the maintainers through a private channel and include:

- a clear description of the issue
- impact and affected areas
- reproduction steps or proof of concept
- any suggested mitigation

## Response goals

Maintainers will try to acknowledge valid reports quickly, assess severity, and coordinate a fix before public disclosure.
