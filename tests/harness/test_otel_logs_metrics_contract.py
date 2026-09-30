import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_logs_and_metrics_blocks_are_strict_optional_hcl():
    config = read("src/config.cpp")
    header = read("src/server.hpp")

    assert '"traces", "logs", "metrics", "explorer", "analysis", "export", "clickhouse"' in config
    assert 'optional_block(root, "logs", source)' in config
    assert 'optional_block(root, "metrics", source)' in config
    assert '"enabled", "database", "table", "max_lookback_minutes", "search_limit", "body_search"}, {});' in config
    assert 'validate_object(*metrics, "metrics", {"enabled", "database", "table_prefix"}, {});' in config
    assert "logs.body_search must be token, substring, or off" in config
    assert "logs.database and logs.table cannot be empty" in config
    assert "metrics.database and metrics.table_prefix cannot be empty" in config
    # No per-signal allowlist: ServiceName filtering reuses traces.service_allowlist.
    assert '"service_allowlist", "default_lookback_minutes"' in config
    logs_block = config.split('optional_block(root, "logs", source)', 1)[1].split('optional_block(root, "analysis"', 1)[0]
    assert "service_allowlist" not in logs_block.replace("traces.service_allowlist", "")

    assert "struct LogSettings {" in header and "struct MetricSettings {" in header
    assert 'std::string table = "otel_logs";' in header
    assert 'std::string table_prefix = "otel_metrics";' in header
    assert 'std::string body_search = "token";' in header
    assert "LogSettings logs;" in header and "MetricSettings metrics;" in header


def test_meta_routes_are_registered_and_version_exposes_features():
    server = read("src/server.cpp")
    cmake = read("src/CMakeLists.txt")

    assert 'http_.Get("/api/logs/meta"' in server
    assert 'http_.Get("/api/metrics/meta"' in server
    assert 'w.Key("logs");' in server and 'w.Key("metrics");' in server
    assert 'w.Bool(cfg_.logs.enabled);' in server and 'w.Bool(cfg_.metrics.enabled);' in server
    assert 'w.String(cfg_.logs.body_search.c_str());' in server
    assert "api_otel_signals.cpp" in cmake


def test_meta_detection_reads_system_tables_only_and_is_cached():
    source = read("src/api_otel_signals.cpp")

    for table in ("system.tables", "system.columns", "system.data_skipping_indices", "system.parts"):
        assert f"FROM {table}" in source
    # Every FROM clause targets a system table: detection never scans signal rows.
    for match in re.finditer(r"FROM ([A-Za-z_.`]+)", source):
        assert match.group(1).startswith("system."), match.group(0)
    assert "constexpr auto kSignalMetaCacheTtl = std::chrono::seconds(60);" in source
    assert "refresh_requested(req)" in source
    assert "host.system_uri" in source and "runner_uri" not in source

    # Disabled and missing sources answer clearly instead of failing.
    assert '"logs_disabled"' in source and '"metrics_disabled"' in source
    assert '"logs_table_missing"' in source and '"metrics_tables_missing"' in source
    assert 'json_error(res, 404, "unknown_host"' in source
    assert "json_error(res, 500" not in source

    # Detection facts other features rely on.
    for key in ("timestamp_time_column", "trace_id_index", "body_index", "time_bounds",
                "attributes", "exemplars", "available_kinds", "service_allowlist"):
        assert f'w.Key("{key}")' in source, key
    assert '"tokenbf_v1"' in source and '"ngrambf_v1"' in source and '"text"' in source
    assert 'starts_with(column->type, "Map(")' in source
    assert 'starts_with(column->type, "JSON")' in source
    for suffix in ("_gauge", "_sum", "_histogram", "_exponential_histogram", "_summary"):
        assert f'"{suffix}"' in source


def test_example_config_and_docs_document_the_blocks():
    example = read("config.example.hcl")
    assert "logs {" in example and "metrics {" in example
    assert 'body_search          = "token"' in example
    assert 'table_prefix = "otel_metrics"' in example
    for path in ("docs/logs.md", "docs/metrics.md"):
        doc = read(path)
        assert "service_allowlist" in doc
    assert "GET /api/logs/meta" in read("docs/logs.md")
    assert "GET /api/metrics/meta" in read("docs/metrics.md")
    assert "logs {}" in read("docs/configuration.md")
    for name in ("CH_HOSTS.local.hcl", "CH_HOSTS.compose-clickhouse.hcl", "CH_HOSTS.host.docker.internal.hcl"):
        config = read(f"tests/config/{name}")
        assert "\nlogs {" in config and "\nmetrics {" in config, name


def test_exporter_ddl_for_logs_and_metrics_is_idempotent():
    sql = read("tests/clickhouse-init/05-otel-logs-metrics.sql")
    assert "CREATE TABLE IF NOT EXISTS otel.otel_logs" in sql
    assert "`TimestampTime` DateTime DEFAULT toDateTime(Timestamp)" in sql
    assert "PARTITION BY toDate(TimestampTime)" in sql
    assert "PRIMARY KEY (ServiceName, TimestampTime)" in sql
    assert "ORDER BY (ServiceName, TimestampTime, Timestamp)" in sql
    assert "INDEX idx_trace_id TraceId TYPE bloom_filter(0.001) GRANULARITY 1" in sql
    assert "INDEX idx_log_attr_key mapKeys(LogAttributes) TYPE bloom_filter(0.01) GRANULARITY 1" in sql
    assert "INDEX idx_body Body TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 8" in sql
    for kind in ("gauge", "sum", "histogram", "exponential_histogram", "summary"):
        assert f"CREATE TABLE IF NOT EXISTS otel.otel_metrics_{kind}" in sql
    assert sql.count("`Exemplars` Nested(") == 4
    assert "`ValueAtQuantiles` Nested(" in sql
    assert sql.count("ORDER BY (ServiceName, MetricName, Attributes, toUnixTimestamp64Nano(TimeUnix))") == 5
    code = "\n".join(line for line in sql.splitlines() if not line.lstrip().startswith("--"))
    assert "DROP " not in code and "TRUNCATE" not in code and "otel_traces" not in code
    # The fixture splits the file on statement separators: none in comments.
    assert all(";" not in line for line in sql.splitlines() if line.lstrip().startswith("--"))
    assert "05-otel-logs-metrics.sql" in read("tests/backend-functional/conftest.py")


def test_fixture_derives_logs_and_metrics_from_spans_without_touching_traces():
    seed = read("tests/otel-fixture/seed.py")
    compose = read("tests/docker-compose.yml")
    dockerfile = read("tests/otel-fixture/Dockerfile")

    assert 'OTEL_FIXTURE_LOGS: "${OTEL_FIXTURE_LOGS:-1}"' in compose
    assert 'OTEL_FIXTURE_METRICS: "${OTEL_FIXTURE_METRICS:-1}"' in compose
    assert "OTEL_FIXTURE_SIGNALS_FORCE" in compose
    assert "COPY tests/clickhouse-init/05-otel-logs-metrics.sql /fixture/05-otel-logs-metrics.sql" in dockerfile

    assert "def existing_signal_counts()" in seed
    assert "SIGNALS_COMPLETE_MARKER" in seed
    assert "reset_signal_tables((LOG_TABLE,) + METRIC_TABLES)" in seed.split("def reset_fixture_data()", 1)[1]
    signals = seed.split("def signal_table(", 1)[1].split("def main()", 1)[0]
    # Signals only read otel_traces: every write targets a logs/metrics table.
    assert "INSERT INTO otel.otel_traces" not in signals
    assert "TRUNCATE TABLE otel.otel_traces" not in signals
    assert "ALTER TABLE otel.otel_traces" not in signals
    assert "DROP TABLE" not in signals
    assert "FROM otel.otel_traces" in signals
    assert "INSERT INTO {signal_table(LOG_TABLE)}" in signals
    assert "toStartOfInterval(Timestamp, toIntervalSecond(10))" in signals
    assert "'http.server.request.duration'" in signals
    assert "'traces.span.metrics.calls'" in signals
    assert "'process.cpu.utilization'" in signals and "'queue.depth'" in signals
    assert "exception.stacktrace" in signals and "code.function" in signals and "http.route" in signals
    # Both early-return and fresh-load paths derive the signals.
    main = seed.split("def main()", 1)[1]
    assert main.count("populate_signals(") == 2
    assert "populate_signals(traces_changed=True)" in main
