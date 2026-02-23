# clickhouse-dash

A real-time ClickHouse query dashboard with live metrics.

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
- 🛑 Query cancellation (**best effort**) without issuing a second ClickHouse query

> Note: this project is designed for ClickHouse setups where you **cannot run a second query in parallel** (same user / same connection). Metrics are collected from the **native TCP protocol callbacks**.

---

## 🏗 Architecture

```
Browser
  │
  │  POST /api/query
  │  GET  /api/query/stream?query_id=...   (SSE)
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
docker-compose up --build
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
```

---

## ⚙️ Configuration

Environment variables:

| Variable | Default | Description |
|---|---:|---|
| `CHDASH_LISTEN` | `0.0.0.0:8080` | Listen address (`host:port`) |
| `LISTEN_HOST` | `0.0.0.0` | Used if `CHDASH_LISTEN` not set |
| `LISTEN_PORT` | `8080` | Used if `CHDASH_LISTEN` not set |
| `PORT` | (none) | Fallback port (platform) |
| `STATIC_DIR` / `CHDASH_STATIC_DIR` | `./static` | Directory for `index.html`, `app.js`, `style.css`, fonts |
| `CH_URL` | (none) | `host:port` or `tcp://host:port` |
| `CH_HOST` | `clickhouse` | ClickHouse host |
| `CH_PORT` | `9000` | ClickHouse native TCP port |
| `CH_TLS` | `false` | Use TLS for native TCP |
| `CH_TLS_PORT` | `9440` | TLS native TCP port |
| `CH_USER` | `default` | ClickHouse user |
| `CH_PASS` / `CH_PASSWORD` | (empty) | ClickHouse password |
| `CH_DB` / `CH_DATABASE` | `default` | Default database |
| `RESULT_PREVIEW_ROW_LIMIT` | `500` | Max rows returned to the browser |

---

## 🔌 Endpoints

- `GET /` → serves `static/index.html`
- `GET /static/*` → static assets
- `GET /healthz` → health check (does **not** query ClickHouse while busy)
- `POST /api/query` → `{ "sql": "...", "database": "..." }` → `{ query_id, stream_url }`
- `GET /api/query/stream?query_id=...` → SSE stream (`meta`, `tick`, `done`)
- `POST /api/query/cancel` → `{ "query_id": "..." }`

---

## 📦 Release

A tag push creates GitHub release assets automatically:

- `.github/workflows/release.yml`
- Trigger: tags matching `v*`

Artifacts include the binary and (if present) `src/static/`.

---

## ✅ TODO / Roadmap 

### Query workflow

* [ ] Local query history (favorites/pin)
* [ ] SQL auto-format (button + optional format-on-run)

### UI / UX

* [ ] Frontend version badge (`vX.Y.Z` + commit)
* [ ] User + DB indicator
* [ ] Better rendering: nicer editor + pretty JSON + collapse long cells

### Data explorer

* [ ] Databases/Tables page (sizes + sort/filter)
* [ ] MV/Buffer dependency graph (click to inspect)

### Perf / Ops

* [ ] Query perf tracking (CPU/RAM/threads + top queries)
* [ ] Cluster perf overview (per-host if possible)

### Connectivity / Multi-tenancy

* [ ] Multi-DB / multi-connection
* [ ] Standard URL connection (`CH_URLs` + TLS params)

---

## 📝 License

MIT (see `LICENSE`).
