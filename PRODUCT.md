# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Plain static HTML and CSS (a little vanilla JavaScript), in `docs/`, served by GitHub Pages from the `main` branch of the same repository (`https://circular-fi.github.io/Clickhouse-dash/`). No build step, no framework, fonts self-hosted. The owner asked for the page to live in this repository as the project's home page.

## Users

Operators of ClickHouse servers: data engineers, SRE and platform engineers who run queries, watch the server and chase slow requests, often from a laptop with a ClickHouse host reachable over the native protocol. They arrive from the GitHub README or a link, decide in seconds whether this is worth downloading, and want to run it within minutes. Primary action: download the release and run it.

## Product Purpose

ClickHouse Dash is a lightweight, real-time dashboard for ClickHouse. One self-contained binary serves a web UI to write and run queries with streamed results, keep a shared query library, explore databases and tables (sizes, parts, DDL, lineage), read OpenTelemetry traces, logs and metrics stored in ClickHouse, watch the server itself, and hand AI assistants scoped access through MCP keys. Success for this page: a visitor understands what it is from the video, believes it is light and complete, and downloads `v1.0.0`.

## Positioning

A single static binary (about 6.5 MB archive, Linux and macOS, amd64 and arm64) that talks to ClickHouse over the native TCP protocol and covers query, exploration, observability, server health and MCP in one place, configured by one HCL file. Observability reads the tables that the OpenTelemetry Collector contrib ClickHouse exporter writes, with no second store.

## Operating Context

Run as `chdash --config config.hcl`, in a container image built `FROM scratch`, or under Kubernetes. Hosts are declared in HCL with a runner user and a system user. The UI is embedded in the binary; the heavy front-end work runs in WebAssembly kernels with JavaScript fallbacks. Released as GitHub release archives with SHA-256 sums and a build provenance attestation.

## Capabilities and Constraints

- Query page: streamed results, SQL formatter, live run statistics (elapsed, rows and bytes read, CPU, memory), charts, query library (folders, saved queries, history), multi-host.
- Explorer: size of every database, tables down to parts and DDL, lineage graph.
- Observability: Traces (duration heatmap, comparison of traces, waterfall, service map), Logs, Metrics, on the OpenTelemetry Collector contrib ClickHouse exporter tables (`otel_traces`, `otel_logs`, `otel_metrics_*`).
- System: live performance charts, the heaviest query shapes of `system.query_log`, disks and growth, replication and Keeper.
- MCP: access keys with their own hosts, tools and tables, read-only ClickHouse user.
- License: MIT. Version 1.0.0 is the first public release (published 2026-10-12).
- Undecided or not claimed: cluster-wide views (planned, not shipped), benchmarks, customer names, any pricing.

## Brand Commitments

- The owner wants this page very dynamic: real-time 3D and motion design, in line with Circular's infrastructure and data identity. circular.fi itself could not be read (Cloudflare bot check), so Circular's look comes from its own product surfaces in sibling repositories.

- Product name: ClickHouse Dash. Its mark is four bottom-aligned bars of a column chart (`docs/assets/logo.svg`, the same drawing as the app header and favicon).
- Publisher: Circular.fi, which builds infrastructure and data products for DeFi professionals. The owner wants the reference discreet: the text "by circular.fi" (a link to https://circular.fi) right after the name ClickHouse Dash in the navigation and a quiet line in the footer. No logo and no large mark on the page. (The Circular wave "C" logo exists in a sibling repository, but is deliberately not used.)
- Page language: English only.
- The presentation video carries music credited to Sascha Ende (CC BY 4.0); the credit must stay next to the video.

## Evidence on Hand

- `docs/media/chdash-presentation.mp4` (74 s, voice-over and music, real screen recordings of the app with sample data) and its poster `docs/media/chdash-presentation.jpg`.
- Six app screenshots in `docs/media/screen-*.jpg` (sample data, taken before the 1.0.0 header change).
- The GitHub release `v1.0.0` with four archives and `SHA256SUMS`.
- Absent: testimonials, customer logos, benchmarks, user counts. Do not invent them.

## Product Principles

- Show the product working before describing it: the video leads.
- Say what it is in plain words; no filler verbs, no invented numbers.
- Light by default: the page itself should feel as light as the binary.
- Credit what is borrowed (music, fonts, OpenTelemetry) and say what is compatible with exactly.
- Give the visitor the next step in one line: download, one config block, run.

## Accessibility & Inclusion

WCAG AA contrast at least, keyboard reachable controls for the video (sound and pause), `prefers-reduced-motion` respected (no autoplay of motion when reduced), no content that depends on hover.
