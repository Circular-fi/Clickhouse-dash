import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_otel_generator_is_domain_neutral_and_keeps_complexity(tmp_path: Path):
    script = ROOT / "examples" / "generate_otel_traces.py"
    source = script.read_text(encoding="utf-8").lower()
    for forbidden in ("solana", "slot_number", "mint_", "supply_", "pumpfun", "pump"):
        assert forbidden not in source

    out = tmp_path / "otel"
    subprocess.run(
        [sys.executable, str(script), "--traces", "3", "--min-spans", "60", "--max-spans", "90", "--seed", "54", "--output-dir", str(out)],
        check=True,
        capture_output=True,
        text=True,
    )
    manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["trace_count"] == 3
    assert 180 <= manifest["span_count"] <= 270
    assert {"edge_gateway", "processing_worker", "clickhouse_writer", "test_worker"}.issubset(manifest["services"])
    assert all(60 <= trace["span_count"] <= 90 for trace in manifest["traces"])
    assert all(trace["service_count"] >= 8 for trace in manifest["traces"])

    rows = [json.loads(line) for line in (out / "otel_traces.jsonl").read_text(encoding="utf-8").splitlines()]
    payload = json.dumps(rows).lower()
    assert "solana" not in payload
    assert any(row["Events.Name"] for row in rows)
    assert any(row["Links.TraceId"] for row in rows)


def test_otel_fixture_is_opt_in_but_test_profile_still_waits_for_it():
    compose = read("tests/docker-compose.yml")
    dockerfile = read("tests/otel-fixture/Dockerfile")
    seed = read("tests/otel-fixture/seed.py")
    config = read("tests/config/CH_HOSTS.local.hcl")
    readme = read("tests/README.md")
    init_sql = read("tests/clickhouse-init/03-otel-traces.sql")

    assert "otel_fixture:" in compose
    assert 'profiles: ["otel", "test"]' in compose
    assert "./tests/otel-fixture/Dockerfile" in compose
    source_block = compose.split("  chdash_source:", 1)[1].split("  tests:", 1)[0]
    assert "otel_fixture:" not in source_block
    tests_block = compose.split("  tests:", 1)[1].split("volumes:", 1)[0]
    assert "otel_fixture:" in tests_block
    assert "condition: service_healthy" in tests_block
    assert "OTEL_FIXTURE_KEEPALIVE" in compose
    assert "existing_fixture_counts" in seed
    assert 'OTEL_FIXTURE_TRACES: "${OTEL_FIXTURE_TRACES:-10000}"' in compose
    assert "COPY examples/generate_otel_traces.py" in dockerfile
    assert "CREATE TABLE IF NOT EXISTS otel.otel_traces" in init_sql
    assert "CREATE TABLE IF NOT EXISTS otel.otel_traces_trace_id_ts" in init_sql
    # The local main OTEL table intentionally mirrors the production exporter
    # schema; only the lightweight projection indexes below are test additions.
    assert "`Timestamp` DateTime64(9) CODEC(Delta(8), ZSTD(1))" in init_sql
    assert "`ResourceAttributes` Map(LowCardinality(String), String) CODEC(ZSTD(1))" in init_sql
    assert "INDEX idx_trace_id TraceId TYPE bloom_filter(0.001) GRANULARITY 1" in init_sql
    assert "INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1" in init_sql
    assert "INDEX idx_span_attr_key mapKeys(SpanAttributes) TYPE bloom_filter(0.01) GRANULARITY 1" in init_sql
    assert "INDEX idx_duration Duration TYPE minmax GRANULARITY 1" in init_sql
    assert "ORDER BY (ServiceName, SpanName, toDateTime(Timestamp))" in init_sql
    assert "ttl_only_drop_parts = 1" in init_sql
    assert "ORDER BY (Timestamp, TraceId, SpanId)" not in init_sql
    assert "PROJECTION IF NOT EXISTS prj_traceid INDEX TraceId TYPE basic" in init_sql
    assert "prj_timestamp" not in init_sql
    assert "PROJECTION IF NOT EXISTS prj_start INDEX Start TYPE basic" in init_sql
    assert "ensure_projection_indexes" in seed
    assert "MATERIALIZE PROJECTION" in seed
    assert "TRUNCATE TABLE otel.otel_traces" in seed
    assert "DROP TABLE IF EXISTS otel.otel_traces" not in seed
    assert "INSERT INTO otel.otel_traces FORMAT JSONEachRow" in seed
    assert "INSERT INTO otel.otel_traces_trace_id_ts" in seed
    assert "GROUP BY TraceId" in seed
    assert "OTEL_FIXTURE_BATCH_TRACES" in seed
    assert "path.read_bytes" not in seed
    assert "GRANT SELECT ON otel.* TO chdash_system" in init_sql
    assert "enabled                  = true" in config
    assert 'database                 = "otel"' in config
    assert "docker compose up -d --build" in readme
    assert "03-otel-traces.sql" in readme
    assert "prj_traceid" in readme and "prj_start" in readme
    assert "prj_timestamp" in readme and "intentionally not added" in readme
