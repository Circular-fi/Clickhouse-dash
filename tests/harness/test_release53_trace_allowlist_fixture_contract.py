import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_trace_service_allowlist_is_hcl_list_and_backend_enforced():
    hpp = read("src/hcl.hpp")
    hcl = read("src/hcl.cpp")
    config = read("src/config.cpp")
    header = read("src/server.hpp")
    api = read("src/api_traces.cpp")
    example = read("config.example.hcl")

    assert "std::vector<std::string>" in hpp
    assert "LBracket" in hcl and "RBracket" in hcl and "Comma" in hcl
    assert "service_allowlist" in header
    assert '"service_allowlist"' in config
    assert 'service_allowlist        = ["*"]' in example

    assert "service_allowlist_predicate" in api
    assert 'pattern == "*"' in api
    assert "startsWith(ServiceName" in api
    assert "endsWith(ServiceName" in api
    assert "match(ServiceName" in api
    assert '" WHERE " + visibility' in api
    assert 'quote_string(trace_id) + " AND " + visibility' in api
    assert "visible_span_ids" in api


def test_synthetic_trace_generator_makes_large_multiservice_fixture(tmp_path: Path):
    script = ROOT / "examples" / "generate_otel_traces.py"
    out = tmp_path / "fixture"
    subprocess.run(
        [sys.executable, str(script), "--traces", "3", "--min-spans", "60", "--max-spans", "90", "--seed", "53", "--output-dir", str(out)],
        check=True,
        capture_output=True,
        text=True,
    )
    manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["trace_count"] == 3
    assert 180 <= manifest["span_count"] <= 270
    assert {"test_ingest", "test_worker", "test_enrichment"}.issubset(set(manifest["services"]))
    assert all(60 <= trace["span_count"] <= 90 for trace in manifest["traces"])
    assert all(trace["service_count"] >= 8 for trace in manifest["traces"])

    rows = [json.loads(line) for line in (out / "otel_traces.jsonl").read_text(encoding="utf-8").splitlines()]
    assert rows
    required = {
        "Timestamp", "TraceId", "SpanId", "ParentSpanId", "SpanName", "SpanKind", "ServiceName",
        "Duration", "StatusCode", "StatusMessage", "SpanAttributes", "ResourceAttributes",
        "Events.Timestamp", "Events.Name", "Events.Attributes", "Links.TraceId", "Links.SpanId", "Links.Attributes",
    }
    assert required.issubset(rows[0])
    assert any(row["Events.Name"] for row in rows)
    assert any(row["Links.TraceId"] for row in rows)
