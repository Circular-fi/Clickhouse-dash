# Query downloads and debug bundle

The Run menu exposes three explicit download modes: CSV, JSON, and Debug. The result toolbar remains a copy/download-results surface and does not expose Debug.

## Debug execution

`Run → Download Debug` executes the selected statement with profiling enabled. With multiquery enabled, every statement is run in profiling mode and gets its own diagnostic directory. The profiling modal is not opened during this download flow; the collected analysis is written to the archive instead.

The browser builds the ZIP locally from the rows already received plus metadata fetched after the run. A single-query bundle has this shape:

```text
query.zip
├── README.md
├── query.sql
├── results.csv
├── execution.csv
├── profiling.json
└── tables/
    ├── manifest.csv
    └── <database>/
        └── <table>.sql
```

`results.csv` is the only result-data representation inside a Debug bundle. `results.json` is deliberately not included; the normal Download JSON action remains separate.

`execution.csv` comes from `/api/query/execution` and ClickHouse `system.query_log`. `profiling.json` contains attempts, processor profiling, view/distributed execution metadata, availability/errors, plus both trace representations needed for debugging: `trace_compact` is the exact compact 3840-pixel temporal-LOD JSON used by the live UI and `trace_spans_original` contains the original ungrouped ClickHouse spans with their real span IDs and exact timestamps. The original spans are requested only while building a Debug archive; normal profiling UI traffic receives only the compact JSON trace.

`README.md` is generated in English at the archive root. It documents every file in the archive and the `chdash.trace.json.lod.v2` compact trace format, including dictionaries, local parent references, the 3840-pixel temporal LOD, and how exact original spans are preserved for debugging.

The `tables/` directory contains the CREATE definition of every table reported as used by the query, then recursively follows upstream dependencies. A Buffer additionally follows its downstream flush target because reading the Buffer depends on that target. Traversal is cycle-safe and capped at 256 definitions. `tables/manifest.csv` records depth, relation, parent object, and definition path.

The Debug export is strict: if required execution metadata, profiling, or a recursive table definition cannot be fetched, the download fails explicitly instead of silently emitting an incomplete diagnostic bundle.

## Multiquery Debug

With multiquery enabled, the archive is namespaced per statement:

```text
queries.zip
├── README.md
├── query-001/
│   ├── query.sql
│   ├── results.csv
│   ├── execution.csv
│   ├── profiling.json
│   └── tables/...
├── query-002/
│   └── ...
└── ...
```

A query execution error may also add `error.txt` to that statement directory before the strict diagnostic metadata collection runs.

## Normal CSV / JSON downloads

CSV and JSON downloads still execute in normal mode. JSON remains available as a standalone export and as the global multiquery copy representation; this change only removes JSON result data from the Debug ZIP.

## Security

`GET /api/query/execution` and `/api/query/analysis` resolve registered query IDs for the selected host and apply the runner-derived object-access boundary before table/database metadata is serialized. Recursive table definitions are fetched through the same Explorer table API and therefore remain subject to the same runner-derived ACL.

## ZIP implementation

Debug archives use the in-browser ZIP `STORE` writer with CRC32 and no external JavaScript dependency. The archive contains the bounded interactive result rows that were actually received by the browser; it does not fabricate rows beyond the configured preview limit.
