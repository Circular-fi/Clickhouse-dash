# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

The page uses plain static HTML and CSS, with a little vanilla JavaScript.
The source is in the `docs/` folder.
GitHub Pages serves the page from the `main` branch of this repository.
The public URL is `https://circular-fi.github.io/Clickhouse-dash/`.

The page has no build step and no framework. Its fonts are self-hosted.
The owner asked for the page to live in this repository as the project home page.

## Users

The users are operators of ClickHouse servers. They are data engineers, SRE and platform engineers. They run queries, watch the server and investigate slow requests. They often work from a laptop, with a ClickHouse host that is reachable over the native protocol. They arrive from the GitHub README or from a link. They decide in seconds if the product is worth a download, and they want to run it within minutes.

Primary action: download the release. Then run it.

## Product Purpose

ClickHouse Dash is a lightweight, real-time dashboard for ClickHouse. One self-contained binary serves a web user interface (UI). The UI lets users write and run queries, with streamed results.

It keeps a shared query library. It explores databases and tables: sizes, parts, DDL and lineage. It reads OpenTelemetry traces, logs and metrics that ClickHouse stores. It watches the server itself. It gives AI assistants scoped access through MCP keys.

The page succeeds when a visitor understands what the product is from the video, believes it is light and complete, and downloads `v1.0.6`.

## Positioning

The product is a single static binary. The archive is about 6.5 MB, for Linux and macOS, with amd64 and arm64 builds. The binary talks to ClickHouse over the native TCP protocol. It covers query, exploration, observability, server health and MCP in one place. One HCL file configures it.

Observability reads the tables that the OpenTelemetry Collector contrib ClickHouse exporter writes. It uses no second store.

## Operating Context

The product runs as `chdash --config config.hcl`, in a container image built `FROM scratch`, or under Kubernetes. The HCL file declares each host with a runner user and a system user.

The UI is embedded in the binary. Heavy front-end work runs in WebAssembly kernels. JavaScript fallbacks exist for them.

The product is released as GitHub release archives. Each release has SHA-256 sums and a build provenance attestation.

## Capabilities and Constraints

- Query page: streamed results, SQL formatter, live run statistics (elapsed, rows and bytes read, CPU, memory), charts, query library (folders, saved queries, history), multi-host.
- Explorer: size of every database, tables down to parts and DDL, lineage graph.
- Observability: Traces (duration heatmap, comparison of traces, waterfall, service map), Logs, Metrics, on the OpenTelemetry Collector contrib ClickHouse exporter tables (`otel_traces`, `otel_logs`, `otel_metrics_*`).
- System: live performance charts, the heaviest query shapes of `system.query_log`, disks and growth, replication and Keeper.
- MCP: access keys with their own hosts, tools and tables, read-only ClickHouse user.
- License: MIT. Version 1.0.0 is the first public release (published 2026-10-12).
- Undecided or not claimed: cluster-wide views (planned, not shipped), benchmarks, customer names, any pricing.

## Brand Commitments

- The owner wants a very dynamic page. The page uses real-time 3D and motion design, in line with Circular's infrastructure and data identity. A Cloudflare bot check prevented access to the circular.fi site. The look of Circular therefore comes from its own product surfaces in sibling repositories.

- Product name: ClickHouse Dash. The mark is four bottom-aligned bars of a column chart. The file `docs/assets/logo.svg` has the same drawing as the app header and favicon.
- Publisher: Circular.fi. It builds infrastructure and data products for DeFi professionals. The owner wants a discreet reference to the publisher.
- Publisher reference: The text "by circular.fi" links to https://circular.fi. The text stands right after the name ClickHouse Dash in the navigation. It also appears as a quiet line in the footer. The page has no logo and no large mark. The Circular wave "C" logo exists in a sibling repository. The page deliberately does not use it.
- Page language: English only.
- The presentation video carries music by Sascha Ende (CC BY 4.0). The credit must stay next to the video.

## Evidence on Hand

- `docs/media/chdash-presentation.mp4`: 74 s video with voice-over and music, made from real screen recordings of the app with sample data. Poster: `docs/media/chdash-presentation.jpg`.
- Six app screenshots: `docs/media/screen-*.jpg`. They use sample data and predate the 1.0.0 header change.
- The GitHub release `v1.0.0` with four archives and `SHA256SUMS`.
- Absent: testimonials, customer logos, benchmarks, user counts. Do not invent them.

## Product Principles

- Show the product in use before you describe it. The video leads.
- Say what it is in plain words. Do not use filler verbs. Do not invent numbers.
- Light by default: the page itself must feel as light as the binary.
- Give credit for each borrowed item (music, fonts, OpenTelemetry). Say exactly what each item is compatible with.
- Give the visitor the next step in one line: download, one config block, run.

## Accessibility & Inclusion

The page meets at least WCAG AA contrast. The keyboard can reach the video controls for sound and pause. The page respects `prefers-reduced-motion`. When this preference is set, the page does not autoplay motion. No content depends on hover.
