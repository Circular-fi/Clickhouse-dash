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


def test_default_compose_seeds_otel_before_source_starts():
    compose = read("tests/docker-compose.yml")
    dockerfile = read("tests/otel-fixture/Dockerfile")
    seed = read("tests/otel-fixture/seed.py")
    config = read("tests/config/CH_HOSTS.local.hcl")
    readme = read("tests/README.md")

    assert "otel_fixture:" in compose
    assert "./tests/otel-fixture/Dockerfile" in compose
    assert "condition: service_healthy" in compose
    assert "OTEL_FIXTURE_KEEPALIVE" in compose
    assert "fixture_already_present" in seed
    assert 'OTEL_FIXTURE_TRACES: "${OTEL_FIXTURE_TRACES:-10000}"' in compose
    assert "COPY examples/generate_otel_traces.py" in dockerfile
    assert "CREATE TABLE otel.otel_traces" in seed
    assert "CREATE TABLE otel.otel_traces_trace_id_ts" in seed
    assert "INSERT INTO otel.otel_traces FORMAT JSONEachRow" in seed
    assert "INSERT INTO otel.otel_traces_trace_id_ts" in seed
    assert "GROUP BY TraceId" in seed
    assert "OTEL_FIXTURE_BATCH_TRACES" in seed
    assert "path.read_bytes" not in seed
    assert "GRANT SELECT ON otel.* TO chdash_system" in seed
    assert "enabled                  = true" in config
    assert 'database                 = "otel"' in config
    assert "docker compose up -d --build" in readme
