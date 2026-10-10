# Security Policy

## Supported versions

Security fixes are best-effort for:

- the latest code on `main`
- the most recent tagged release

Older snapshots may not receive fixes.

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
