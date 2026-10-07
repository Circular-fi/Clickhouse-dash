# Query downloads and debug bundle

The Run menu has three explicit download modes: CSV, JSON and Debug. The result toolbar stays a surface to copy and download results. It does not have the Debug mode.

## Debug execution

`Run → Download Debug` runs the selected statement with profiling enabled. If multiquery is enabled, the dashboard runs every statement in profiling mode. Each statement gets its own diagnostic directory. The profiling modal does not open during this download. The dashboard writes the collected analysis to the archive instead.

The browser builds the ZIP file locally. It uses the rows that it already received and the metadata that it fetches after the run. A bundle for one query has this structure:

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

`results.csv` is the only representation of the result data in a Debug bundle. The bundle does not include `results.json` on purpose. The normal Download JSON action stays separate.

`execution.csv` comes from `/api/query/execution` and ClickHouse `system.query_log`. `profiling.json` contains these items:

- The attempts.
- The processor profiling.
- The metadata of the view and distributed execution.
- The availability and the errors.
- Two representations of the trace. Both are necessary for debugging.

The two representations of the trace are:

- `trace_compact` is the exact compact JSON of the temporal level of detail (LOD) with 3840 pixels. The live UI uses it.
- `trace_spans_original` contains the original ClickHouse spans, not grouped. The spans have their real span IDs and their exact timestamps.

The dashboard requests the original spans only while it builds a Debug archive. The normal profiling UI receives only the compact JSON trace.

The dashboard generates `README.md` in English at the root of the archive. It describes every file in the archive. It also describes the `chdash.trace.json.lod.v2` compact trace format. The description includes the dictionaries, the local parent references and the temporal LOD with 3840 pixels. It also explains how the archive keeps the exact original spans for debugging.

The `tables/` directory contains the CREATE definition of every table that the query reports as used. Then the dashboard follows the upstream dependencies recursively. A Buffer also follows its downstream flush target, because a read of the Buffer depends on that target. The traversal is safe for cycles. It stops at 256 definitions. `tables/manifest.csv` records the depth, the relation, the parent object and the definition path.

The Debug export is strict. If the dashboard cannot fetch the required execution metadata, the profiling or a recursive table definition, the download fails with an explicit error. The dashboard does not silently make an incomplete diagnostic bundle.

## Multiquery Debug

If multiquery is enabled, the archive has a separate namespace for each statement:

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

A query execution error can also add `error.txt` to the directory of that statement. This happens before the strict collection of the diagnostic metadata runs.

## Normal CSV / JSON downloads

CSV and JSON downloads run in normal mode. JSON stays available as a standalone export. It also stays available as the global multiquery copy representation. This change removes only the JSON result data from the Debug ZIP.

## Security

`GET /api/query/execution` and `/api/query/analysis` resolve the registered query IDs for the selected host. They apply the runner-derived object-access boundary before they serialize the table and database metadata. The dashboard fetches the recursive table definitions through the same Explorer table API. The same runner-derived ACL therefore applies to them.

## ZIP implementation

Debug archives use the ZIP `STORE` writer in the browser, with CRC32 and no external JavaScript dependency. The archive contains the bounded interactive result rows that the browser received. It does not create rows beyond the configured preview limit.
