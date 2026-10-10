# Operations: HTTP security

This page tells an operator how ChDash protects its pages and its API.

## HTTP security

### Headers

Every answer has these headers:

| Header | Value |
|---|---|
| `Content-Security-Policy` | `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'` |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `same-origin` |
| `Cross-Origin-Resource-Policy` | `same-origin` |

A page shell has a policy of its own: ChDash adds the hash (`'sha256-…'`) of each inline script of the shell to `script-src`. These scripts run, and no other inline script runs. `'wasm-unsafe-eval'` lets the pages compile the WebAssembly kernels of this server (docs/wasm.md). It does not allow `eval`. `'unsafe-inline'` in `style-src` is necessary because the pages set style attributes. A reverse proxy must not replace these headers. It can add headers, for example `Strict-Transport-Security` when it terminates TLS.

### The guard of the writes

ChDash has no login. A page of another site must not be able to use the browser of a user to change anything or to run SQL. For this reason, every `POST`, `PUT`, `PATCH` and `DELETE` (a run, a cancel, a format, an analysis, an export, the table preview, the query library, the MCP keys) passes one guard before ChDash reads the body:

- When the browser sends `Sec-Fetch-Site`, the value must be `same-origin` or `none`. Otherwise the answer is 403 `cross_site_request`.
- Without `Sec-Fetch-Site` (an older browser), an `Origin` header must name this server: the `Host` header, or the first `X-Forwarded-Host`. Otherwise the answer is 403 `cross_site_request`. A proxy that changes `Host` must set `X-Forwarded-Host`.
- A request with a body must send `Content-Type: application/json`. Otherwise the answer is 415 `unsupported_media_type`. A page of another site cannot send this type without a CORS preflight, and ChDash never allows a preflight.

A client that is not a browser (curl, a script, a test) sends neither header and passes. `POST /mcp` has its own rules (`mcp.allowed_origins`, docs/mcp.md). The routes of the MCP page that show a secret or what a key reaches (`GET .../secret`, `GET .../access`, `GET /api/mcp/access`) also refuse a cross-site request.

### Static assets

The staged shells ask for each script, stylesheet and WebAssembly kernel as `static/<file>?v=<hash>`, where the hash starts the SHA-256 of the file. ChDash answers `Cache-Control: public, max-age=31536000, immutable` only when the `?v=` value is 8 to 64 lower-case hexadecimal digits that start the SHA-256 of the bytes that it sends. Any other `?v=` gets the current bytes with `Cache-Control: no-store`. Thus a tab that a deploy left behind never binds an old address to new code in the cache of the browser. A shell and an address without `?v=` revalidate (`max-age=0, must-revalidate`). A web font is kept for a week.
