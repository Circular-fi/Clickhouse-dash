# clickhouse-dash

A real-time ClickHouse query dashboard with live metrics.

[![CI](https://github.com/SCcagg5/Clickhouse-dash/actions/workflows/ci.yml/badge.svg)](https://github.com/SCcagg5/Clickhouse-dash/actions/workflows/ci.yml)
[![CodeQL](https://github.com/SCcagg5/Clickhouse-dash/actions/workflows/codeql.yml/badge.svg)](https://github.com/SCcagg5/Clickhouse-dash/actions/workflows/codeql.yml)
[![Release](https://github.com/SCcagg5/Clickhouse-dash/actions/workflows/release.yaml/badge.svg)](https://github.com/SCcagg5/Clickhouse-dash/actions/workflows/release.yaml)

Backend: **C++17** (clickhouse-cpp + cpp-httplib + rapidjson)  
Frontend: **Vanilla JS + Canvas**  
Transport: **Server-Sent Events (SSE)**

---

## ✨ Features

- 🔎 Execute any ClickHouse SQL query
- 📊 Real-time metrics streaming via **SSE** (`/api/query/stream`)
- ⚡ High-frequency internal samples (throttled), sent in batches with each tick
- 📈 Smooth sparklines (front)
- 📦 Single lightweight binary
- 🧠 Automatic rate derivation (rows/sec & bytes/sec)
- 🧭 Multi-host support with a UI selector (persisted in localStorage)
- 🩺 Background host health checks (TCP Ping)
- 🛑 Query cancellation via signed JWT cancel tokens + `KILL QUERY` (system user)
- 🧹 Local query history (last 100, localStorage)
- 🏷️ Version badge (from `/api/meta`)

---

## 🏗 Architecture

```
Browser
  │
  │  POST /api/query/run   (alias: POST /api/query)
  │  GET  /api/query/stream?query_id=...   (SSE)
  │  POST /api/query/cancel
  ▼
HTTP server (cpp-httplib)
  │
  ▼
ClickHouse (native TCP, clickhouse-cpp)
```

---

## 📊 Metrics model

Each `tick` SSE event is an **array** (Go-compatible layout):

```
[
  elapsedMs,
  percentCenti, percentKnown,
  readRowsTotal, readBytesTotal, totalRowsToRead,
  rowsPerSec, bytesPerSec,
  cpuCenti, cpuInstMaxCenti,
  memInstBytes|null, memPeakBytes|null,
  threadsInst, threadsPeak,
  samples|null
]
```

Where `samples` is an array of points collected between ticks:

```
[elapsedMs, readBytesTotal, cpuCenti|null, memBytes|null, threads]
```

### About CPU / RAM / Threads

These fields rely on ClickHouse **ProfileEvents**. The server tries to enable them with:

- `send_profile_events = 1`

If your ClickHouse server/role overrides this setting, CPU/RAM/Threads may stay `null/0`.

---

## 🚀 Quick start

### 1) Docker (recommended)

```
cd test
docker compose up --build
```

Open:

```
http://localhost:8080
```

### 2) Local build

Requirements: CMake >= 3.20, a C++17 compiler, Ninja.

```
cmake -S src -B build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build build --target chdash
./build/chdash
./build/chdash --version
```

The default build embeds the frontend assets into the binary. In the dev Docker image, filesystem assets are served from the image itself; there is no runtime `STATIC_DIR` override anymore.

`--version` and `-v` print the compiled version and exit without starting the server.

---

## ⚙️ Configuration

Environment variables:

| Variable | Default | Description |
|---|---:|---|
| `LISTEN_HOST` | `0.0.0.0` | HTTP listen host |
| `LISTEN_PORT` | `8080` | HTTP listen port |
| `CH_HOSTS` | (required) | Multi-host HCL config |
| `RESULT_PREVIEW_ROW_LIMIT` | `10000` | Max rows returned to the browser |

Health settings now live inside `CH_HOSTS` via an optional `health { ... }` block.

### Example `CH_HOSTS`

```hcl
health {
  interval_ms = 5000
  timeout_ms  = 800
}

clickhouse {
  host {
    name       = "local"
    runner_uri = "clickhouse://user:pass@clickhouse:9000"
    system_uri = "clickhouse://system:pass@clickhouse:9000"
  }
}
```

---

## 🔌 Endpoints

- `GET /` → serves `static/index.html`
- `GET /static/*` → static assets
- `GET /healthz` → strict health check (all configured hosts must be healthy)
- `GET /api/meta` → `{ name, version, git_sha, build_time }`
- `GET /api/hosts` → health snapshot for all hosts (polled by the UI)
- `GET /api/health` → strict JSON health (`ok=true` only if all hosts are healthy)
- `POST /api/query/run` → `{ "sql": "...", "host_id": "par1" }` → `{ query_id, cancel_token, formatted_sql, stream_url }`
  - Alias: `POST /api/query`
- `GET /api/query/stream?query_id=...` → SSE stream (`meta`, `tick`, `done`)
- `POST /api/query/cancel` → `{ "cancel_token": "..." }` → `{ "ok": true }`

---

## 📦 Release

A tag push creates GitHub release assets automatically:

- `.github/workflows/release.yaml`
- Trigger: tags matching `v*`

Artifacts include release tarballs and checksums.

---


## 🛠️ Queue worker (Rust)

A dedicated `queue` worker is now built by `.github/workflows/rust-queue-build.yml`. The workflow compiles the crate for both `x86_64-unknown-linux-gnu` (Debian/Ubuntu compatible) and `x86_64-unknown-linux-musl` (fully static) and uploads a tarball per target named `queue-<target>.tar.gz`.

### Install artifacts

1. Download the artifact that matches your target (the workflow uploads them into the release assets for each run).
2. Extract and install:

   ```bash
   curl -L https://github.com/SCcagg5/Clickhouse-dash/releases/latest/download/queue-x86_64-unknown-linux-musl.tar.gz -o /tmp/queue.tar.gz
   tar -xzf /tmp/queue.tar.gz -C /tmp
   sudo install -m755 /tmp/queue /usr/local/bin/queue
   ```

3. Inspect `queue --help` and keep a configuration file (e.g. `/etc/queue/config.toml`) ready.

### Cron usage

Deploy the worker through cron by pointing it at the config you want to run. Adjust the PATH, target, and schedule as needed:

```
PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/queue --config /etc/queue/config.toml >> /var/log/queue.log 2>&1
```

Replace the artifact name above with `queue-x86_64-unknown-linux-gnu.tar.gz` if you need the Debian-flavored build.

## ✅ TODO / Roadmap 

### Data explorer

* [ ] Databases/Tables page (sizes + sort/filter)
* [ ] MV/Buffer dependency graph 

### Perf / Ops

* [ ] Query perf tracking (CPU/RAM/threads + top queries)
* [ ] Cluster perf overview

---

## 🤝 Contributing

See `CONTRIBUTING.md` for local development, testing, and pull request guidelines.

## 🔐 Security

See `SECURITY.md` for responsible disclosure guidance.

## 💬 Support

See `SUPPORT.md` for support and issue reporting guidance.

## 📝 License

MIT (see `LICENSE`).
